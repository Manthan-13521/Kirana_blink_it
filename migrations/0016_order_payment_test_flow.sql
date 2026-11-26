ALTER TABLE sessions ADD COLUMN staging_checkout TEXT;

CREATE TABLE order_payment_links (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  link_id TEXT UNIQUE,
  url TEXT,
  payment_id TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  captured_at INTEGER
);

CREATE TABLE order_provider_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  case_id TEXT UNIQUE REFERENCES cases(id),
  actor TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK(amount>0),
  status TEXT NOT NULL CHECK(status IN('queued','submitted','processed')),
  provider_id TEXT UNIQUE,
  next_attempt INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX provider_refund_due ON order_provider_refunds(next_attempt,id) WHERE status<>'processed';
CREATE INDEX provider_refund_order ON order_provider_refunds(order_id);
