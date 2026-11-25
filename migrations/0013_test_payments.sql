CREATE TABLE test_payments (
  reference TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  link_id TEXT UNIQUE,
  url TEXT,
  payment_id TEXT UNIQUE,
  refund_id TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK(amount=100),
  status TEXT NOT NULL CHECK(status IN('creating','open','paid','refunding','refunded','cancelled','expired')),
  created_at INTEGER NOT NULL
);
CREATE INDEX test_payments_owner ON test_payments(owner_id,created_at DESC);
