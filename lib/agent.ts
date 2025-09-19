import Anthropic from '@anthropic-ai/sdk';
import type { MerchantStore } from './store';
import { describePending, runTool, ToolError, toolDefinitions, WRITE_TOOLS } from './tools';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 12;

export const SYSTEM = `You are MerchantPilot, an assistant inside a store's admin dashboard. You help the merchant \
understand sales, find products, spot stock problems, and make pricing or promotion changes.

Use the tools to look things up rather than guessing; quote figures exactly as the tools return them. \
When a request implies a change (a price update or a discount), propose it with the write tool and a one-line reason; \
the merchant approves or declines each change in the UI, so you don't need to ask for confirmation in text first. \
If a tool returns an error, explain it plainly and suggest what the merchant can do instead. Keep answers short.`;

/** Persisted between HTTP requests (Postgres `agent_sessions`), so a run can wait for approval. */
export interface Session {
  id: string;
  merchantId: string;
  messages: MessageParam[];
  pending: { toolUse: ToolUseBlock; summary: string; otherResults: ToolResult[]; remaining: ToolUseBlock[] } | null;
}

export type TurnResult =
  | { status: 'done'; text: string }
  | { status: 'awaiting_approval'; summary: string; toolName: string }
  | { status: 'stopped'; reason: string };

export interface AgentDeps {
  client: Pick<Anthropic, 'beta'>;
  store: MerchantStore;
  actor: string;
  today: string;
}

function request(messages: MessageParam[], today: string) {
  return {
    model: MODEL,
    max_tokens: 16000,
    system: `${SYSTEM}\n\nToday is ${today}.`,
    tools: toolDefinitions,
    messages,
    // Opus 5.5 thinks adaptively by default; effort defaults to medium, set explicitly.
    output_config: { effort: 'medium' as const },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  };
}

async function execute(tu: ToolUseBlock, deps: AgentDeps, merchantId: string): Promise<ToolResult> {
  try {
    const content = await runTool(tu.name, tu.input, { store: deps.store, merchantId, actor: deps.actor, today: deps.today });
    return { type: 'tool_result', tool_use_id: tu.id, content };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    return { type: 'tool_result', tool_use_id: tu.id, content: e.message, is_error: true };
  }
}

/**
 * Run tool calls for one assistant turn in order. Reads execute; the first write stops the loop and is
 * saved as pending, along with results gathered so far and the calls still to run after it.
 */
async function runTools(session: Session, calls: ToolUseBlock[], deps: AgentDeps, results: ToolResult[] = []): Promise<TurnResult | null> {
  for (let i = 0; i < calls.length; i++) {
    const tu = calls[i];
    if (WRITE_TOOLS.has(tu.name)) {
      session.pending = { toolUse: tu, summary: describePending(tu.name, tu.input), otherResults: results, remaining: calls.slice(i + 1) };
      return { status: 'awaiting_approval', summary: session.pending.summary, toolName: tu.name };
    }
    results.push(await execute(tu, deps, session.merchantId));
  }
  // All results for one assistant turn go back in a single user message.
  session.messages.push({ role: 'user', content: results });
  return null;
}

async function loop(session: Session, deps: AgentDeps): Promise<TurnResult> {
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await deps.client.beta.messages.create(request(session.messages, deps.today));
    if (res.stop_reason === 'refusal') return { status: 'stopped', reason: 'refused' };
    if (res.stop_reason === 'max_tokens') return { status: 'stopped', reason: 'response too long' };
    session.messages.push({ role: 'assistant', content: res.content as any });
    if (res.stop_reason === 'pause_turn') continue;
    const calls = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) {
      const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
      return { status: 'done', text };
    }
    const r = await runTools(session, calls, deps);
    if (r) return r;
  }
  return { status: 'stopped', reason: `stopped after ${MAX_STEPS} steps` };
}

export async function send(session: Session, userText: string, deps: AgentDeps): Promise<TurnResult> {
  if (session.pending) throw new Error('approve or decline the pending change first');
  session.messages.push({ role: 'user', content: userText });
  return loop(session, deps);
}

/** Merchant clicked Approve / Decline on the pending change. */
export async function decide(session: Session, approved: boolean, deps: AgentDeps, note?: string): Promise<TurnResult> {
  const p = session.pending;
  if (!p) throw new Error('nothing pending');
  session.pending = null;
  const result: ToolResult = approved
    ? await execute(p.toolUse, deps, session.merchantId)
    : { type: 'tool_result', tool_use_id: p.toolUse.id, content: `The merchant declined this change${note ? `: ${note}` : '.'}`, is_error: true };
  const r = await runTools(session, p.remaining, deps, [...p.otherResults, result]);
  if (r) return r;
  return loop(session, deps);
}

export function newSession(id: string, merchantId: string): Session {
  return { id, merchantId, messages: [], pending: null };
}
