import { Pool } from 'pg';
import type { Session } from './agent';
import type { MerchantStore } from './store';

const g = globalThis as unknown as { pool?: Pool };
export const pool = g.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== 'production') g.pool = pool;

export const pgStore: MerchantStore = {
  async products(m) {
    const r = await pool.query('SELECT sku, title, price_cents, cost_cents, on_hand, reorder_point FROM products WHERE merchant_id = $1', [m]);
    return r.rows.map((x) => ({ sku: x.sku, title: x.title, priceCents: x.price_cents, costCents: x.cost_cents, onHand: x.on_hand, reorderPoint: x.reorder_point }));
  },
  async sales(m, from, to) {
    const r = await pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, sku, SUM(units)::int AS units, SUM(revenue_cents)::int AS revenue_cents
       FROM order_lines WHERE merchant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day, sku`, [m, from, to]);
    return r.rows.map((x) => ({ day: x.day, sku: x.sku, units: x.units, revenueCents: x.revenue_cents }));
  },
  async setPrice(m, sku, price) {
    await pool.query('UPDATE products SET price_cents = $3, updated_at = now() WHERE merchant_id = $1 AND sku = $2', [m, sku, price]);
  },
  async createDiscount(m, d) {
    await pool.query('INSERT INTO discounts (merchant_id, code, percent_off, skus, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [m, d.code, d.percentOff, d.skus, d.endsAt, d.createdBy]);
  },
  async audit(m, actor, action, detail) {
    await pool.query('INSERT INTO audit_log (merchant_id, actor, action, detail) VALUES ($1,$2,$3,$4)', [m, actor, action, JSON.stringify(detail)]);
  },
};

/** Sessions are loaded with FOR UPDATE inside a transaction so two tabs can't advance the same run. */
export async function withSession<T>(id: string, merchantId: string, fn: (s: Session) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT messages, pending FROM agent_sessions WHERE id = $1 AND merchant_id = $2 FOR UPDATE', [id, merchantId]);
    const s: Session = r.rows[0]
      ? { id, merchantId, messages: r.rows[0].messages, pending: r.rows[0].pending }
      : { id, merchantId, messages: [], pending: null };
    const out = await fn(s);
    await c.query(
      `INSERT INTO agent_sessions (id, merchant_id, messages, pending, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (id) DO UPDATE SET messages = EXCLUDED.messages, pending = EXCLUDED.pending, updated_at = now()
       WHERE agent_sessions.merchant_id = EXCLUDED.merchant_id`,
      [id, merchantId, JSON.stringify(s.messages), s.pending ? JSON.stringify(s.pending) : null]);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
