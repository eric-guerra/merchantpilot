import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { MerchantStore } from './store';

type Tool = Anthropic.Beta.Messages.BetaTool;

/** Read tools run immediately; write tools pause the agent until the merchant approves in the UI. */
export const WRITE_TOOLS = new Set(['update_price', 'create_discount']);

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inputSchemas = {
  get_sales_summary: z.object({ from: isoDay, to: isoDay, group_by: z.enum(['sku', 'day']) }),
  search_products: z.object({ query: z.string() }),
  list_low_stock: z.object({}),
  update_price: z.object({ sku: z.string(), new_price_cents: z.number().int().positive(), reason: z.string() }),
  create_discount: z.object({
    code: z.string().regex(/^[A-Z0-9]{4,20}$/),
    percent_off: z.number().int().min(1).max(50),
    skus: z.array(z.string()).min(1),
    ends_at: isoDay,
  }),
} as const;

export type ToolName = keyof typeof inputSchemas;

const strictObject = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const toolDefinitions: Tool[] = [
  {
    name: 'get_sales_summary',
    description: 'Revenue and units sold for a date range (inclusive), grouped by SKU or by day. Use for any question about sales, best sellers or trends.',
    strict: true,
    input_schema: strictObject({
      from: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to: { type: 'string', description: 'End date YYYY-MM-DD' },
      group_by: { type: 'string', enum: ['sku', 'day'] },
    }, ['from', 'to', 'group_by']),
  },
  {
    name: 'search_products',
    description: 'Find products by SKU or words in the title. Returns price, cost, margin and stock on hand.',
    strict: true,
    input_schema: strictObject({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'list_low_stock',
    description: 'Products at or below their reorder point.',
    strict: true,
    input_schema: strictObject({}, []),
  },
  {
    name: 'update_price',
    description: 'Change a product price. Requires the merchant to approve before it takes effect. Changes over 30% or below cost are rejected.',
    strict: true,
    input_schema: strictObject({
      sku: { type: 'string' },
      new_price_cents: { type: 'integer' },
      reason: { type: 'string', description: 'One sentence the merchant will see when approving' },
    }, ['sku', 'new_price_cents', 'reason']),
  },
  {
    name: 'create_discount',
    description: 'Create a percent-off discount code for specific SKUs until an end date. Requires merchant approval. Max 50% off.',
    strict: true,
    input_schema: strictObject({
      code: { type: 'string', description: 'Uppercase letters/digits, 4-20 chars' },
      percent_off: { type: 'integer' },
      skus: { type: 'array', items: { type: 'string' } },
      ends_at: { type: 'string', description: 'YYYY-MM-DD' },
    }, ['code', 'percent_off', 'skus', 'ends_at']),
  },
];

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export class ToolError extends Error {}

/**
 * Execute a tool. Inputs are validated with zod even though the tools are strict: business rules
 * (price change limits, below-cost) live here, in code the model can't talk its way around.
 */
export async function runTool(name: string, rawInput: unknown, ctx: { store: MerchantStore; merchantId: string; actor: string; today: string }): Promise<string> {
  const schema = inputSchemas[name as ToolName];
  if (!schema) throw new ToolError(`unknown tool ${name}`);
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) throw new ToolError(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const input = parsed.data as any;
  const { store, merchantId } = ctx;

  switch (name as ToolName) {
    case 'get_sales_summary': {
      if (input.from > input.to) throw new ToolError('from is after to');
      const rows = await store.sales(merchantId, input.from, input.to);
      const groups = new Map<string, { units: number; revenueCents: number }>();
      for (const r of rows) {
        const k = input.group_by === 'sku' ? r.sku : r.day;
        const g = groups.get(k) ?? { units: 0, revenueCents: 0 };
        g.units += r.units; g.revenueCents += r.revenueCents;
        groups.set(k, g);
      }
      // Days chronologically; SKUs by revenue (best sellers first). Sort on cents, format after.
      const entries = [...groups].sort(([ka, a], [kb, b]) => input.group_by === 'day' ? ka.localeCompare(kb) : b.revenueCents - a.revenueCents);
      const list = entries.slice(0, 50).map(([key, g]) => ({ [input.group_by]: key, units: g.units, revenue: money(g.revenueCents) }));
      const total = rows.reduce((s, r) => s + r.revenueCents, 0);
      return JSON.stringify({ from: input.from, to: input.to, total_revenue: money(total), rows: list });
    }
    case 'search_products': {
      const q = input.query.toLowerCase();
      const hits = (await store.products(merchantId)).filter((p) => p.sku.toLowerCase() === q || p.title.toLowerCase().includes(q)).slice(0, 20);
      return JSON.stringify(hits.map((p) => ({ sku: p.sku, title: p.title, price: money(p.priceCents), cost: money(p.costCents),
        margin_pct: Math.round(((p.priceCents - p.costCents) / p.priceCents) * 1000) / 10, on_hand: p.onHand })));
    }
    case 'list_low_stock': {
      const low = (await store.products(merchantId)).filter((p) => p.onHand <= p.reorderPoint);
      return JSON.stringify(low.map((p) => ({ sku: p.sku, title: p.title, on_hand: p.onHand, reorder_point: p.reorderPoint })));
    }
    case 'update_price': {
      const p = (await store.products(merchantId)).find((x) => x.sku === input.sku);
      if (!p) throw new ToolError(`no product ${input.sku}`);
      const change = (input.new_price_cents - p.priceCents) / p.priceCents;
      if (Math.abs(change) > 0.3) throw new ToolError(`price change of ${Math.round(change * 100)}% exceeds the 30% limit; ask the merchant to change it in the admin`);
      if (input.new_price_cents < p.costCents) throw new ToolError(`new price ${money(input.new_price_cents)} is below cost ${money(p.costCents)}`);
      await store.setPrice(merchantId, input.sku, input.new_price_cents, ctx.actor);
      await store.audit(merchantId, ctx.actor, 'price.updated', { sku: input.sku, from: p.priceCents, to: input.new_price_cents, reason: input.reason });
      return `Price for ${input.sku} changed from ${money(p.priceCents)} to ${money(input.new_price_cents)}.`;
    }
    case 'create_discount': {
      if (input.ends_at <= ctx.today) throw new ToolError('ends_at must be in the future');
      const known = new Set((await store.products(merchantId)).map((p) => p.sku));
      const unknown = input.skus.filter((s: string) => !known.has(s));
      if (unknown.length) throw new ToolError(`unknown SKUs: ${unknown.join(', ')}`);
      await store.createDiscount(merchantId, { code: input.code, percentOff: input.percent_off, skus: input.skus, endsAt: input.ends_at, createdBy: ctx.actor });
      await store.audit(merchantId, ctx.actor, 'discount.created', input);
      return `Discount ${input.code} (${input.percent_off}% off ${input.skus.length} SKU(s)) is live until ${input.ends_at}.`;
    }
  }
}

/** Human-readable summary of a pending write for the approval card. */
export function describePending(name: string, input: any): string {
  if (name === 'update_price') return `Change ${input.sku} price to ${money(input.new_price_cents)}: ${input.reason}`;
  if (name === 'create_discount') return `Create code ${input.code}: ${input.percent_off}% off ${input.skus?.join(', ')} until ${input.ends_at}`;
  return name;
}
