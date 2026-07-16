# MerchantPilot

Portfolio reference implementation of a 2025 project, built to show an AI assistant inside a commerce admin dashboard. Merchants ask "what sold best last week?", "what's running low?", "put the mugs on a 15% promo through Sunday". The assistant answers from live store data and proposes changes, which the merchant approves with one click.

**Stack:** Next.js 14 (app router, route handlers, middleware), TypeScript, Anthropic TypeScript SDK (Claude Opus 5.5, tool use), PostgreSQL (`pg`), zod.

## Agent design (`lib/agent.ts`, `lib/tools.ts`)
- **Tools:**
  - Read: `get_sales_summary`, `search_products`, `list_low_stock`.
  - Write: `update_price`, `create_discount`.
  - All tools are `strict: true` JSON schemas (`additionalProperties: false`). `tool_choice` stays `auto`, because forced tool choice isn't supported on Opus 5.5.
- **Human approval for every write:**
  - Reads run immediately. The first write call stops the loop and is saved as **pending**, together with the tool results gathered so far and any parallel calls still to run.
  - The merchant's Approve or Decline comes later, on a separate HTTP request, and resumes the run.
  - A decline goes back to the model as an `is_error` tool result, so it can respond sensibly.
  - All results for one assistant turn are returned in **a single user message**, which keeps parallel tool use working.
  - This is why the project uses a manual loop rather than the SDK tool runner: the run has to suspend, persist and resume across requests.
- **Guardrails in code, not in the prompt:**
  - zod revalidates every input.
  - Price changes are capped at ±30% and can't go below cost.
  - Discounts are capped at 50%, must end in the future, and may reference only known SKUs.
  - Every applied change is written to `audit_log` with the acting user.
- **Request shape:**
  - `claude-opus-5-5`, adaptive thinking (its default), `effort: "medium"` set explicitly.
  - **Server-side fallbacks** on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
  - `refusal`, `max_tokens` and `pause_turn` are handled. A 12-step cap stops runaway loops.
  - SDK errors map to HTTP: `RateLimitError` → 429, other `APIError` → 502.
- **Sessions:** stored in Postgres (`agent_sessions`) and loaded `FOR UPDATE`, so two tabs can't advance the same run. They're scoped to the merchant, so a session id from another merchant never loads.
- **Identity:** `middleware.ts` discards any client-sent `x-auth-*` headers and sets them only from the admin app's HMAC-signed session cookie.

## Run and test
```bash
npm install
npm test          # 8 tests with a scripted fake client: request shape, read flow, pause → approve → resume, decline,
                  # parallel reads + write in one turn, guardrails, tool errors, refusal and loop cap
npm run typecheck && npm run build
psql -f schema.sql && ANTHROPIC_API_KEY=... SESSION_SECRET=... npm run dev
```
