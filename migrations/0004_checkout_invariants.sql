ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER order_slot_guard;
CREATE TRIGGER order_slot_guard BEFORE INSERT ON orders WHEN NEW.channel='online'
BEGIN
  SELECT CASE WHEN (SELECT accepting FROM settings WHERE id=1)=0 THEN RAISE(ABORT,'store_paused') END;
  SELECT CASE WHEN (SELECT revision FROM settings WHERE id=1)<>NEW.config_revision THEN RAISE(ABORT,'catalog_changed') END;
  SELECT CASE WHEN NEW.slot_start IS NULL OR NEW.slot_end IS NULL OR NEW.slot_end<=NEW.slot_start THEN RAISE(ABORT,'invalid_slot') END;
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM orders WHERE channel='online' AND fulfillment=NEW.fulfillment
        AND slot_start>=NEW.slot_start-10800 AND slot_start<NEW.slot_end AND slot_end>NEW.slot_start AND slot_retained=1) >=
    (SELECT CASE WHEN NEW.fulfillment='delivery' THEN delivery_capacity ELSE pickup_capacity END FROM settings WHERE id=1)
  THEN RAISE(ABORT,'slot_full') END;
END;

DROP TRIGGER item_reserve;
CREATE TRIGGER item_reserve AFTER INSERT ON order_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id AND active=1
    AND (expiry IS NULL OR expiry>=date('now','+330 minutes'))
    AND price=NEW.price AND step=NEW.step AND tax_bps=NEW.tax_bps
    AND NEW.quantity % step=0 AND NEW.quantity / step BETWEEN min_steps AND max_steps)
    THEN RAISE(ABORT,'catalog_changed') END;
  INSERT INTO stock_events(product_id,quantity,reason,order_id,actor,created_at)
    SELECT NEW.product_id,-NEW.quantity,CASE WHEN channel='pos' THEN 'counter_sale' ELSE 'order_reserve' END,id,account_id,created_at
    FROM orders WHERE id=NEW.order_id;
END;
