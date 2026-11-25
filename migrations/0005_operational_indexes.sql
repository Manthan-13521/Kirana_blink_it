-- Keep alerts sparse so the owner overview does not scan the full catalog.
CREATE INDEX products_low_stock ON products(stock,id) WHERE active=1 AND stock<=threshold;
CREATE INDEX products_upcoming_expiry ON products(expiry,id) WHERE active=1 AND expiry IS NOT NULL;

DROP INDEX rider_orders;
CREATE INDEX rider_active_route ON orders(assigned_to,route_rank,created_at)
  WHERE assigned_to IS NOT NULL AND status IN ('ready','out_for_delivery');
CREATE INDEX rider_history ON orders(assigned_to,created_at DESC,id DESC)
  WHERE assigned_to IS NOT NULL AND fulfillment='delivery' AND status NOT IN ('rejected','cancelled');
