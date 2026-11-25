CREATE INDEX completed_events_recent ON order_events(created_at,order_id) WHERE status='completed';
CREATE INDEX rider_unreconciled ON orders(assigned_to,total)
  WHERE payment_status='cash_collected' AND reconciled=0 AND fulfillment='delivery';
