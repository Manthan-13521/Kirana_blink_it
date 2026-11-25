CREATE TABLE refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  case_id TEXT REFERENCES cases(id), amount INTEGER NOT NULL CHECK(amount>0),
  actor TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL
);
CREATE INDEX refunds_order ON refunds(order_id);
CREATE TRIGGER refund_limit BEFORE INSERT ON refunds
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM orders
    WHERE id=NEW.order_id AND payment_status IN('paid','cash_collected')
      AND NEW.amount <= total-COALESCE((SELECT SUM(amount) FROM refunds WHERE order_id=NEW.order_id),0))
    THEN RAISE(ABORT,'refund_limit') END;
END;
CREATE TRIGGER refund_status AFTER INSERT ON refunds
BEGIN
  UPDATE orders SET payment_status='refunded', updated_at=NEW.created_at
  WHERE id=NEW.order_id AND total=(SELECT SUM(amount) FROM refunds WHERE order_id=NEW.order_id);
END;
CREATE TABLE invites (
  hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('staff','rider')), expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX invites_expiry ON invites(expires_at);
CREATE TABLE media_jobs (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  action TEXT NOT NULL CHECK(action IN ('publish','remove')),
  status TEXT NOT NULL CHECK(status IN ('pending','published','failed')),
  previous_url TEXT, image_url TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX media_jobs_recent ON media_jobs(product_id,created_at DESC);
CREATE TABLE push_preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
