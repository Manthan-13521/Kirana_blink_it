-- Checkout and the availability picker both read the previous slot end.
DROP INDEX slot_usage;
CREATE INDEX slot_usage ON orders(fulfillment,slot_start,slot_end)
  WHERE slot_retained=1 AND channel='online';
