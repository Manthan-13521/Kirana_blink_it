CREATE TABLE service_budget (
  service TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  used INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX push_account ON push_subscriptions(account_id,created_at DESC);
