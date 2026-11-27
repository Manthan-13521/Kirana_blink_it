-- Apply only in an empty kirana-rollover-qa-* synthetic database.
INSERT INTO settings (id, name, tagline, locality, phone, address, pin_codes, latitude, longitude, radius_km,
  open_hour, close_hour, preparation, window_minutes, delivery_capacity, pickup_capacity, delivery_fee,
  free_delivery, minimum_order, accepting, policy, brand_color, enable_online)
VALUES (1, 'Rollover QA Store', '', 'Synthetic', '', 'Synthetic', '500034', 17.41, 78.42, 3,
  8, 20, 15, 60, 4, 4, 0, 0, 0, 1, '', '#155D35', 0);
INSERT INTO accounts (id, role, name) VALUES ('rollover-qa-customer', 'customer', 'Synthetic shopper');
INSERT INTO categories (id, label) VALUES ('rollover-qa', 'Synthetic catalog');
INSERT INTO products (id, sku, name, category, unit, step, price, mrp, stock, updated_at)
VALUES ('rollover-qa-item', 'ROLLOVER-QA', 'Synthetic pantry pack', 'rollover-qa', 'pc', 1, 1000, 1000, 20, 1700000000);
INSERT INTO orders (
  id, account_id, request_key, request_fingerprint, channel, fulfillment, status, payment_method, payment_status,
  subtotal, fees, total, tax, slot_start, slot_end, slot_retained, billing_json, reconciled, created_at, updated_at, config_revision
) VALUES (
  'rollover-qa-paid', 'rollover-qa-customer', 'rollover-qa-1', 'qa', 'online', 'pickup', 'completed', 'online', 'paid',
  1000, 0, 1000, 0, 1700000000, 1700003600, 0, '{"name":"Rollover QA Store","buyer":"Synthetic shopper"}',
  1, 1700000000, 1700000010, (SELECT revision FROM settings WHERE id=1)
), (
  'rollover-qa-active', 'rollover-qa-customer', 'rollover-qa-2', 'qa', 'online', 'pickup', 'placed', 'cash', 'cash_due',
  1000, 0, 1000, 0, 1800000000, 1800003600, 1, '{"name":"Rollover QA Store","buyer":"Synthetic shopper"}',
  0, 1800000000, 1800000000, (SELECT revision FROM settings WHERE id=1)
);
INSERT INTO order_items (order_id, product_id, sku, name, unit, step, quantity, price, line_total, tax, tax_bps, hsn)
SELECT id, 'rollover-qa-item', 'ROLLOVER-QA', 'Synthetic pantry pack', 'pc', 1, 1, 1000, 1000, 0, 0, '' FROM orders;
INSERT INTO order_checkout_payments (order_id, provider_order_id, payment_id, mode, expires_at, captured_at)
VALUES ('rollover-qa-paid', 'order_syntheticrollover1', 'pay_syntheticrollover1', 'test', 1700003600, 1700000010);
INSERT INTO order_events (order_id, status, created_at)
SELECT id, status, updated_at FROM orders;
UPDATE settings SET accepting=0;
