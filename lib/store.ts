// Merchant data the agent's tools read and write. Postgres in production (lib/pgStore.ts), in-memory in tests.

export interface Product { sku: string; title: string; priceCents: number; costCents: number; onHand: number; reorderPoint: number }
export interface SaleRow { day: string; sku: string; units: number; revenueCents: number }
export interface Discount { code: string; percentOff: number; skus: string[]; endsAt: string; createdBy: string }

export interface MerchantStore {
  products(merchantId: string): Promise<Product[]>;
  sales(merchantId: string, from: string, to: string): Promise<SaleRow[]>;
  setPrice(merchantId: string, sku: string, priceCents: number, actor: string): Promise<void>;
  createDiscount(merchantId: string, d: Discount): Promise<void>;
  audit(merchantId: string, actor: string, action: string, detail: unknown): Promise<void>;
}

export function memoryStore(seed: { products: Product[]; sales: SaleRow[] }) {
  const products = seed.products.map((p) => ({ ...p }));
  const discounts: Discount[] = [];
  const auditLog: { actor: string; action: string; detail: unknown }[] = [];
  const store: MerchantStore = {
    async products() { return products.map((p) => ({ ...p })); },
    async sales(_m, from, to) { return seed.sales.filter((s) => s.day >= from && s.day <= to); },
    async setPrice(_m, sku, priceCents) { products.find((p) => p.sku === sku)!.priceCents = priceCents; },
    async createDiscount(_m, d) { discounts.push(d); },
    async audit(_m, actor, action, detail) { auditLog.push({ actor, action, detail }); },
  };
  return { store, products, discounts, auditLog };
}
