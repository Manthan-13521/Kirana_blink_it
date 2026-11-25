PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  name TEXT NOT NULL, tagline TEXT NOT NULL, locality TEXT NOT NULL,
  phone TEXT NOT NULL, address TEXT NOT NULL, pin_codes TEXT NOT NULL,
  latitude REAL NOT NULL, longitude REAL NOT NULL, radius_km REAL NOT NULL,
  open_hour INTEGER NOT NULL, close_hour INTEGER NOT NULL, preparation INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL, delivery_capacity INTEGER NOT NULL, pickup_capacity INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL, free_delivery INTEGER NOT NULL, minimum_order INTEGER NOT NULL,
  accepting INTEGER NOT NULL DEFAULT 1 CHECK (accepting IN (0,1)), registered INTEGER NOT NULL DEFAULT 0,
  gstin TEXT NOT NULL DEFAULT '', policy TEXT NOT NULL, brand_color TEXT NOT NULL,
  enable_cod INTEGER NOT NULL DEFAULT 1, enable_online INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('customer','owner','staff','rider')),
  name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX one_active_rider ON accounts(role) WHERE role='rider' AND active=1;
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE addresses (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL, recipient TEXT NOT NULL, phone TEXT NOT NULL,
  line1 TEXT NOT NULL, locality TEXT NOT NULL, landmark TEXT NOT NULL, pin TEXT NOT NULL,
  latitude REAL, longitude REAL, created_at INTEGER NOT NULL
);
CREATE INDEX address_owner ON addresses(account_id,created_at);
CREATE TABLE carts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), items TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX carts_expiry ON carts(updated_at);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, image TEXT, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL REFERENCES categories(id), subcategory TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL CHECK(unit IN ('g','ml','pc')), step INTEGER NOT NULL CHECK(step>0),
  price INTEGER NOT NULL CHECK(price>0), mrp INTEGER NOT NULL CHECK(mrp>=price),
  stock INTEGER NOT NULL CHECK(stock>=0), threshold INTEGER NOT NULL DEFAULT 0 CHECK(threshold>=0),
  min_steps INTEGER NOT NULL DEFAULT 1 CHECK(min_steps>=1), max_steps INTEGER NOT NULL DEFAULT 20 CHECK(max_steps>=min_steps),
  tax_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_bps BETWEEN 0 AND 2800),
  hsn TEXT NOT NULL DEFAULT '', image TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN(0,1)), expiry TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX products_category ON products(active,category,id);
CREATE INDEX products_featured ON products(active,featured DESC,id);
CREATE TABLE search_terms (
  term TEXT NOT NULL COLLATE NOCASE, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY(term,product_id)
) WITHOUT ROWID;
CREATE INDEX search_product ON search_terms(product_id);
CREATE TABLE synonyms (term TEXT PRIMARY KEY, canonical TEXT NOT NULL);

CREATE TABLE orders (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  request_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('online','pos')),
  fulfillment TEXT NOT NULL CHECK(fulfillment IN ('delivery','pickup','counter')),
  status TEXT NOT NULL CHECK(status IN ('awaiting_payment','placed','accepted','packing','ready','out_for_delivery','completed','cancelled','rejected','failed')),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('online','cash','counter_upi')),
  payment_status TEXT NOT NULL CHECK(payment_status IN ('unpaid','paid','cash_due','cash_collected','refunded','void')),
  subtotal INTEGER NOT NULL CHECK(subtotal>=0), fees INTEGER NOT NULL CHECK(fees>=0), total INTEGER NOT NULL CHECK(total=subtotal+fees),
  tax INTEGER NOT NULL CHECK(tax>=0), slot_start INTEGER, slot_end INTEGER,
  address_json TEXT, billing_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  assigned_to TEXT REFERENCES accounts(id), route_rank INTEGER NOT NULL DEFAULT 0,
  slot_retained INTEGER NOT NULL DEFAULT 1 CHECK(slot_retained IN (0,1)),
  stocked INTEGER NOT NULL DEFAULT 1 CHECK(stocked IN (0,1)), reconciled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CONSTRAINT order_idempotency UNIQUE(account_id,request_key)
);
CREATE INDEX orders_owner ON orders(account_id,created_at DESC,id DESC);
CREATE INDEX orders_recent ON orders(created_at DESC,id DESC);
CREATE INDEX orders_status ON orders(status,created_at DESC,id DESC);
CREATE INDEX rider_orders ON orders(assigned_to,status,route_rank,created_at);
CREATE INDEX slot_usage ON orders(fulfillment,slot_start) WHERE slot_retained=1 AND channel='online';
CREATE INDEX unresolved_payment ON orders(created_at) WHERE status='awaiting_payment';

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, step INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity>0),
  price INTEGER NOT NULL CHECK(price>0), line_total INTEGER NOT NULL CHECK(line_total>0),
  tax INTEGER NOT NULL CHECK(tax>=0), tax_bps INTEGER NOT NULL, hsn TEXT NOT NULL,
  PRIMARY KEY(order_id,product_id)
) WITHOUT ROWID;

CREATE TABLE stock_events (
  id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity!=0), reason TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id), actor TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL
);
CREATE INDEX stock_history ON stock_events(product_id,id DESC);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX order_timeline ON order_events(order_id,id);
CREATE TABLE cases (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('cancel','return','refund','support')),
  reason TEXT NOT NULL, response TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','declined','resolved')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_open_case ON cases(order_id,kind) WHERE status='open';
CREATE INDEX cases_queue ON cases(status,created_at DESC);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY, actor TEXT NOT NULL REFERENCES accounts(id), action TEXT NOT NULL,
  subject TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX audit_recent ON audit(id DESC);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  order_id TEXT REFERENCES orders(id), message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX notices_owner ON notices(account_id,id DESC);
CREATE INDEX notices_cleanup ON notices(created_at);

CREATE TRIGGER order_slot_guard BEFORE INSERT ON orders WHEN NEW.channel='online'
BEGIN
  SELECT CASE WHEN (SELECT accepting FROM settings WHERE id=1)=0 THEN RAISE(ABORT,'store_paused') END;
  SELECT CASE WHEN NEW.slot_start IS NULL OR NEW.slot_end IS NULL OR NEW.slot_end<=NEW.slot_start THEN RAISE(ABORT,'invalid_slot') END;
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM orders WHERE channel='online' AND fulfillment=NEW.fulfillment
        AND slot_start=NEW.slot_start AND slot_retained=1) >=
    (SELECT CASE WHEN NEW.fulfillment='delivery' THEN delivery_capacity ELSE pickup_capacity END FROM settings WHERE id=1)
  THEN RAISE(ABORT,'slot_full') END;
END;

CREATE TRIGGER stock_event_apply AFTER INSERT ON stock_events
BEGIN
  UPDATE products SET stock=stock+NEW.quantity WHERE id=NEW.product_id AND stock+NEW.quantity>=0;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'insufficient_stock') END;
END;

CREATE TRIGGER item_reserve AFTER INSERT ON order_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id AND active=1
    AND price=NEW.price AND step=NEW.step AND tax_bps=NEW.tax_bps
    AND NEW.quantity % step=0 AND NEW.quantity / step BETWEEN min_steps AND max_steps)
    THEN RAISE(ABORT,'catalog_changed') END;
  INSERT INTO stock_events(product_id,quantity,reason,order_id,actor,created_at)
    SELECT NEW.product_id,-NEW.quantity,CASE WHEN channel='pos' THEN 'counter_sale' ELSE 'order_reserve' END,id,account_id,created_at
    FROM orders WHERE id=NEW.order_id;
END;

CREATE TRIGGER order_restock AFTER UPDATE OF stocked ON orders WHEN OLD.stocked=1 AND NEW.stocked=0
BEGIN
  INSERT INTO stock_events(product_id,quantity,reason,order_id,actor,created_at)
    SELECT product_id,quantity,'order_release',NEW.id,NEW.account_id,NEW.updated_at FROM order_items WHERE order_id=NEW.id;
END;

CREATE TRIGGER order_event_new AFTER INSERT ON orders
BEGIN
  INSERT INTO order_events(order_id,status,created_at) VALUES(NEW.id,NEW.status,NEW.created_at);
END;
CREATE TRIGGER order_event_change AFTER UPDATE OF status ON orders WHEN NEW.status<>OLD.status
BEGIN
  INSERT INTO order_events(order_id,status,created_at) VALUES(NEW.id,NEW.status,NEW.updated_at);
  INSERT INTO notices(account_id,order_id,message,created_at)
    SELECT NEW.account_id,NEW.id,'Order ' || UPPER(substr(NEW.id,1,8)) || ' · ' || replace(NEW.status,'_',' '),NEW.updated_at
    WHERE NEW.channel='online';
END;
