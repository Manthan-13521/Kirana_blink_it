CREATE TABLE order_checkout_payments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  provider_order_id TEXT UNIQUE,
  payment_id TEXT UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  expires_at INTEGER NOT NULL,
  captured_at INTEGER,
  next_create_at INTEGER NOT NULL DEFAULT 0,
  failed_at INTEGER
);
ALTER TABLE order_provider_refunds ADD COLUMN failed_at INTEGER;
