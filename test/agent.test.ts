import { describe, it, expect } from 'vitest';
import { decide, MODEL, newSession, send } from '../lib/agent';
import { memoryStore } from '../lib/store';
import { runTool, ToolError, toolDefinitions } from '../lib/tools';

const seed = {
  products: [
    { sku: 'MUG-01', title: 'Stoneware Mug', priceCents: 1800, costCents: 600, onHand: 4, reorderPoint: 10 },
    { sku: 'TEE-M', title: 'Logo Tee M', priceCents: 2500, costCents: 900, onHand: 80, reorderPoint: 20 },
  ],
  sales: [
    { day: '2024-06-01', sku: 'MUG-01', units: 10, revenueCents: 18000 },
    { day: '2024-06-02', sku: 'TEE-M', units: 4, revenueCents: 10000 },
    { day: '2024-06-02', sku: 'MUG-01', units: 2, revenueCents: 3600 },
  ],
};

let n = 0;
const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', id: `tu_${++n}`, name, input });
const text = (t: string) => ({ type: 'text', text: t });

/** Scripted model: each create() returns the next response; records requests. */
function fakeClient(script: { stop_reason: string; content: any[] }[]) {
  const requests: any[] = [];
  return {
    requests,
    client: { beta: { messages: { create: async (req: any) => { requests.push(structuredClone(req)); const r = script.shift(); if (!r) throw new Error('script exhausted'); return { ...r, model: MODEL }; } } } } as any,
  };
}

const deps = (client: any, store: any) => ({ client, store, actor: 'merchant:alice', today: '2024-06-10' });

describe('MerchantPilot agent', () => {
  it('answers with read tools and sends a well-formed request', async () => {
    const { store } = memoryStore(seed);
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [text('Checking sales.'), toolUse('get_sales_summary', { from: '2024-06-01', to: '2024-06-07', group_by: 'sku' })] },
      { stop_reason: 'end_turn', content: [text('Mugs led with $216.00.')] },
    ]);
    const s = newSession('s1', 'm1');
    const r = await send(s, 'What sold best last week?', deps(client, store));
    expect(r).toEqual({ status: 'done', text: 'Mugs led with $216.00.' });
    const req = requests[0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.fallbacks).toBe('default');
    expect(req.output_config).toEqual({ effort: 'medium' });
    expect(req.tool_choice).toBeUndefined();
    expect(req.tools.every((t: any) => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    const toolResult = requests[1].messages.at(-1).content[0];
    expect(JSON.parse(toolResult.content).rows[0]).toEqual({ sku: 'MUG-01', units: 12, revenue: '$216.00' });
  });

  it('pauses on a write, resumes after approval, and audits', async () => {
    const { store, products, auditLog } = memoryStore(seed);
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('update_price', { sku: 'TEE-M', new_price_cents: 2800, reason: 'Sells out at current price' })] },
      { stop_reason: 'end_turn', content: [text('Done — the tee is now $28.00.')] },
    ]);
    const s = newSession('s2', 'm1');
    const r1 = await send(s, 'Raise the tee price a bit', deps(client, store));
    expect(r1).toMatchObject({ status: 'awaiting_approval', toolName: 'update_price', summary: 'Change TEE-M price to $28.00: Sells out at current price' });
    expect(products[1].priceCents).toBe(2500); // nothing happened yet
    expect(requests).toHaveLength(1);
    await expect(send(s, 'another message', deps(client, store))).rejects.toThrow(/pending/);

    const r2 = await decide(s, true, deps(client, store));
    expect(r2).toEqual({ status: 'done', text: 'Done — the tee is now $28.00.' });
    expect(products[1].priceCents).toBe(2800);
    expect(auditLog[0]).toMatchObject({ actor: 'merchant:alice', action: 'price.updated' });
  });

  it('a decline goes back to the model as an error tool_result and nothing changes', async () => {
    const { store, discounts } = memoryStore(seed);
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('create_discount', { code: 'MUGS20', percent_off: 20, skus: ['MUG-01'], ends_at: '2024-06-30' })] },
      { stop_reason: 'end_turn', content: [text('OK, no discount.')] },
    ]);
    const s = newSession('s3', 'm1');
    await send(s, 'Run a mug promo', deps(client, store));
    await decide(s, false, deps(client, store), 'too generous');
    const last = requests[1].messages.at(-1).content[0];
    expect(last).toMatchObject({ is_error: true, content: 'The merchant declined this change: too generous' });
    expect(discounts).toHaveLength(0);
  });

  it('parallel calls: reads run, write waits, all results return in one user message', async () => {
    const { store } = memoryStore(seed);
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [
        toolUse('list_low_stock', {}),
        toolUse('create_discount', { code: 'TEES10', percent_off: 10, skus: ['TEE-M'], ends_at: '2024-07-01' }),
        toolUse('search_products', { query: 'mug' }),
      ] },
      { stop_reason: 'end_turn', content: [text('Mugs are low; tee promo created.')] },
    ]);
    const s = newSession('s4', 'm1');
    expect((await send(s, 'Low stock? And promote tees.', deps(client, store))).status).toBe('awaiting_approval');
    await decide(s, true, deps(client, store));
    const results = requests[1].messages.at(-1).content;
    expect(results.map((r: any) => r.type)).toEqual(['tool_result', 'tool_result', 'tool_result']);
    expect(JSON.parse(results[0].content)[0].sku).toBe('MUG-01');
    expect(results[1].content).toMatch(/TEES10/);
    expect(JSON.parse(results[2].content)[0].margin_pct).toBe(66.7);
  });

  it('guardrails reject unsafe writes even after approval', async () => {
    const { store, products } = memoryStore(seed);
    const ctx = { store, merchantId: 'm1', actor: 'x', today: '2024-06-10' };
    await expect(runTool('update_price', { sku: 'MUG-01', new_price_cents: 500, reason: 'x' }, ctx)).rejects.toThrow(/30%|below cost/);
    await expect(runTool('update_price', { sku: 'MUG-01', new_price_cents: 1500, reason: 'x' }, ctx)).resolves.toMatch(/\$15\.00/);
    await expect(runTool('create_discount', { code: 'BIG', percent_off: 90, skus: ['MUG-01'], ends_at: '2024-07-01' }, ctx)).rejects.toBeInstanceOf(ToolError);
    await expect(runTool('create_discount', { code: 'PAST1', percent_off: 10, skus: ['MUG-01'], ends_at: '2024-06-01' }, ctx)).rejects.toThrow(/future/);
    await expect(runTool('create_discount', { code: 'NOPE1', percent_off: 10, skus: ['XX'], ends_at: '2024-07-01' }, ctx)).rejects.toThrow(/unknown SKUs/);
    expect(products[0].priceCents).toBe(1500);
  });

  it('tool errors become is_error results the model can recover from', async () => {
    const { store } = memoryStore(seed);
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('get_sales_summary', { from: '2024-06-09', to: '2024-06-01', group_by: 'day' })] },
      { stop_reason: 'end_turn', content: [text('Those dates are reversed.')] },
    ]);
    await send(newSession('s5', 'm1'), 'sales?', deps(client, store));
    expect(requests[1].messages.at(-1).content[0]).toMatchObject({ is_error: true, content: 'from is after to' });
  });

  it('stops safely on refusal and on runaway loops', async () => {
    const { store } = memoryStore(seed);
    const refuse = fakeClient([{ stop_reason: 'refusal', content: [] }]);
    expect(await send(newSession('s6', 'm1'), 'x', deps(refuse.client, store))).toEqual({ status: 'stopped', reason: 'refused' });
    const looping = fakeClient(Array.from({ length: 20 }, () => ({ stop_reason: 'tool_use', content: [toolUse('list_low_stock', {})] })));
    expect((await send(newSession('s7', 'm1'), 'x', deps(looping.client, store))).status).toBe('stopped');
  });

  it('every tool definition is strict-compatible', () => {
    for (const t of toolDefinitions as any[]) {
      expect(Object.keys(t.input_schema.properties).sort()).toEqual([...t.input_schema.required].sort());
    }
  });
});
