ALTER TABLE settings ADD COLUMN enable_delivery INTEGER NOT NULL DEFAULT 1 CHECK(enable_delivery IN (0,1));
ALTER TABLE settings ADD COLUMN enable_pickup INTEGER NOT NULL DEFAULT 1 CHECK(enable_pickup IN (0,1));

DROP TRIGGER order_slot_guard;
CREATE TRIGGER order_slot_guard BEFORE INSERT ON orders WHEN NEW.channel='online'
BEGIN
  SELECT CASE
    WHEN accepting=0 OR (enable_delivery=0 AND enable_pickup=0) THEN RAISE(ABORT,'store_paused')
    WHEN (NEW.fulfillment='delivery' AND enable_delivery=0) OR
         (NEW.fulfillment='pickup' AND enable_pickup=0) THEN RAISE(ABORT,'fulfillment_unavailable')
    WHEN revision<>NEW.config_revision THEN RAISE(ABORT,'catalog_changed')
  END FROM settings WHERE id=1;
  SELECT CASE WHEN NEW.slot_start IS NULL OR NEW.slot_end IS NULL OR NEW.slot_end<=NEW.slot_start THEN RAISE(ABORT,'invalid_slot') END;
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM orders WHERE channel='online' AND fulfillment=NEW.fulfillment
        AND slot_start>=NEW.slot_start-10800 AND slot_start<NEW.slot_end AND slot_end>NEW.slot_start AND slot_retained=1) >=
    (SELECT CASE WHEN NEW.fulfillment='delivery' THEN delivery_capacity ELSE pickup_capacity END FROM settings WHERE id=1)
  THEN RAISE(ABORT,'slot_full') END;
END;
