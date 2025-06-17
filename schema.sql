CREATE TABLE products (
  merchant_id TEXT NOT NULL, sku TEXT NOT NULL, title TEXT NOT NULL,
  price_cents INT NOT NULL CHECK (price_cents > 0), cost_cents INT NOT NULL,
  on_hand INT NOT NULL, reorder_point INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, sku)
);
CREATE TABLE order_lines (merchant_id TEXT NOT NULL, day DATE NOT NULL, sku TEXT NOT NULL, units INT NOT NULL, revenue_cents INT NOT NULL);
CREATE INDEX ON order_lines (merchant_id, day);
CREATE TABLE discounts (
  merchant_id TEXT NOT NULL, code TEXT NOT NULL, percent_off INT NOT NULL CHECK (percent_off BETWEEN 1 AND 50),
  skus TEXT[] NOT NULL, ends_at DATE NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, code)
);
CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, merchant_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, messages JSONB NOT NULL, pending JSONB, updated_at TIMESTAMPTZ NOT NULL
);
