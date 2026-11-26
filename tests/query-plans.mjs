import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
for (const file of readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(resolve('migrations', file), 'utf8'))
}
db.exec(readFileSync('tests/workload-seed.sql', 'utf8'))
db.exec(`
  WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
  INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
    subtotal,fees,total,tax,billing_json,created_at,updated_at,assigned_to,slot_start,slot_end)
  SELECT 'plan-'||i,CASE WHEN i%3=0 THEN 'demo-owner' ELSE 'demo-customer' END,
    'plan-'||i,'fixture',CASE WHEN i%3=0 THEN 'pos' ELSE 'online' END,
    CASE WHEN i%3=0 THEN 'counter' WHEN i%3=1 THEN 'pickup' ELSE 'delivery' END,
    'completed','cash','cash_collected',5000,0,5000,0,'{}',1800000000+i,1800000000+i,
    CASE WHEN i%3=2 THEN 'demo-rider' END,1700000000+i*3600,1700003600+i*3600 FROM n;
  ANALYZE;
`)
const refined = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='products_low_stock'").get())
const additional = refined ? {
  'low stock': ["SELECT id,name,stock,threshold FROM products INDEXED BY products_low_stock WHERE active=1 AND stock<=threshold ORDER BY stock,id LIMIT 20",[]],
  'expiry alerts': ["SELECT id,name,expiry FROM products WHERE active=1 AND expiry IS NOT NULL AND expiry<=date(?,'unixepoch','+7 day') ORDER BY expiry,id LIMIT 20",[1800000000]],
  'rider history': ["SELECT id,status FROM orders WHERE assigned_to=? AND fulfillment='delivery' AND status NOT IN('rejected','cancelled') ORDER BY created_at DESC,id DESC LIMIT 41",['demo-rider']],
} : {
  'inventory alerts': ["SELECT id,name,stock,threshold FROM products WHERE active=1 AND (stock<=threshold OR expiry<=date(?,'unixepoch','+7 day')) ORDER BY stock LIMIT 20",[1800000000]],
  'rider history': ["SELECT id,status FROM orders WHERE assigned_to=? AND fulfillment='delivery' AND status NOT IN('rejected','cancelled') ORDER BY CASE WHEN status IN('completed','failed') THEN 1 ELSE 0 END,route_rank,id LIMIT 41",['demo-rider']],
}
const queries = {
  'public category cursor': ["SELECT id,name,price FROM products WHERE active=1 AND category=? AND id>? AND (expiry IS NULL OR expiry>=date('now','+330 minutes')) ORDER BY id LIMIT 24",['pantry','load-0010']],
  'public all products cursor': ["SELECT id,name FROM products INDEXED BY products_active_id WHERE active=1 AND id>? ORDER BY id LIMIT 13",['load-0010']],
  'two-token prefix search': ["SELECT products.id,name FROM search_prefixes AS match CROSS JOIN products ON products.id=match.product_id WHERE match.prefix=? AND match.product_id>? AND active=1 AND EXISTS (SELECT 1 FROM search_prefixes extra WHERE extra.product_id=products.id AND extra.prefix=?) ORDER BY match.product_id LIMIT 13",['1012','','benchmark']],
  'catalog stock read for quote': ["SELECT * FROM products WHERE id IN (?,?,?,?,?,?) AND active=1",['milk','rice','load-0115','load-0211','load-0001','load-0190']],
  'product media retention': ["SELECT image FROM products WHERE image IN (?,?)",['/media/example','/media/another']],
  'variant pack lookup': ["SELECT id,step FROM products WHERE variant_group=? AND active=1 AND variant_group<>'' AND (expiry IS NULL OR expiry>=date('now','+330 minutes')) ORDER BY step,id LIMIT 24",['test pack']],
  'reserved inventory lookup': ["SELECT SUM(i.quantity) FROM orders o JOIN order_items i ON i.order_id=o.id AND i.product_id=? WHERE o.stocked=1 AND o.status IN ('awaiting_payment','placed','accepted','packing','ready','out_for_delivery')",['milk']],
  'basket rehydration': ["SELECT p.id, p.price FROM carts JOIN json_each(carts.items) j JOIN products p ON p.id=json_extract(j.value,'$.id') WHERE carts.account_id=? AND carts.updated_at>?",['demo-customer',1800000000]],
  'active rider cash collection': ["SELECT SUM(total) FROM orders WHERE assigned_to=? AND fulfillment='delivery' AND payment_status='cash_collected' AND reconciled=0",['demo-rider']],
  'completion activity since midnight': ["SELECT status FROM order_events INDEXED BY completed_events_recent WHERE status='completed' AND created_at>=?",[1800015000]],
  'session lookup': ["SELECT accounts.id,role,name,phone FROM sessions JOIN accounts ON accounts.id=sessions.account_id WHERE hash=? AND expires_at>? AND active=1",['fixture',1800000000]],
  'provider checkout callback': ['SELECT order_id,expires_at FROM order_checkout_payments WHERE provider_order_id=? AND mode=? AND payment_id IS NULL',['order_fixture','live']],
  'outstanding refund amount': ["SELECT SUM(amount) FROM order_provider_refunds WHERE order_id=? AND status<>'processed'",['plan-1']],
  'due refund processing': ["SELECT r.id,COALESCE(n.payment_id,l.payment_id) FROM order_provider_refunds r LEFT JOIN order_checkout_payments n ON n.order_id=r.order_id AND n.payment_id IS NOT NULL LEFT JOIN order_payment_links l ON l.order_id=r.order_id AND l.payment_id IS NOT NULL WHERE r.status<>'processed' AND r.failed_at IS NULL AND (n.mode='test' OR n.mode IS NULL AND l.payment_id IS NOT NULL) AND r.next_attempt<=? ORDER BY r.next_attempt,r.id LIMIT 4",[1800000000]],
  'Google workspace lookup': ['SELECT a.id,a.role FROM google_identities g JOIN accounts a ON a.id=g.account_id WHERE g.subject=? AND g.workspace=?',['fixture','shop']],
  'owned saved address': ['SELECT id FROM addresses WHERE id=? AND account_id=?',['demo-address','demo-customer']],
  'checkout replay lookup': ['SELECT id,request_fingerprint FROM orders WHERE account_id=? AND request_key=?',['demo-customer','plan-1']],
  'slot admission': ["SELECT COUNT(*) FROM orders WHERE channel='online' AND fulfillment=? AND slot_start>=? AND slot_start<? AND slot_end>? AND slot_retained=1",['delivery',1799990000,1800000000,1799999000]],
  'daily owner summary': ['SELECT COUNT(*) total, SUM(total) gross FROM orders WHERE created_at>=?',[1800015000]],
  'completed sales report': ["SELECT date(created_at+19800,'unixepoch') day,channel,fulfillment,payment_method,COUNT(*),SUM(total) FROM orders WHERE status='completed' AND created_at>=? GROUP BY day,channel,fulfillment,payment_method ORDER BY day DESC",[1800015000]],
  'customer order cursor': ["SELECT id,status FROM orders WHERE account_id=? AND channel='online' AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 41",['demo-customer',1800019000,'plan-19000']],
  'owner queue by state': ['SELECT id,status FROM orders WHERE status=? ORDER BY created_at DESC,id DESC LIMIT 41',['placed']],
  'assigned rider queue': ["SELECT id,route_rank,address_json,status FROM orders WHERE assigned_to=? AND status IN ('ready','out_for_delivery') ORDER BY route_rank,created_at LIMIT 30",['demo-rider']],
  'owned order detail': ['SELECT * FROM orders WHERE id=?',['plan-1']],
  'order tracking version': ['SELECT o.status,(SELECT id FROM order_events WHERE order_id=o.id ORDER BY id DESC LIMIT 1) FROM orders o WHERE o.id=?',['plan-1']],
  'order item lines': ['SELECT * FROM order_items WHERE order_id=? ORDER BY product_id',['plan-1']],
  'order event timeline': ['SELECT status,note,created_at FROM order_events WHERE order_id=? ORDER BY id',['plan-1']],
  'case queue': ["SELECT cases.*,orders.total FROM cases JOIN orders ON orders.id=cases.order_id WHERE cases.status='open' ORDER BY cases.created_at DESC LIMIT 50",[]],
  'cumulative refunds': ['SELECT SUM(amount) FROM refunds WHERE order_id=?',['plan-1']],
  'stock history': ['SELECT id,quantity,reason FROM stock_events WHERE product_id=? ORDER BY id DESC LIMIT 50',['milk']],
  'stale session purge': ['SELECT hash FROM sessions WHERE expires_at<? LIMIT 200',[1800000000]],
  'expired payment sweep': ["SELECT id FROM orders WHERE status='awaiting_payment' AND created_at<? LIMIT 25",[1800000000]],
  ...additional,
}
const plans={}
for (const [name,[query,args]] of Object.entries(queries)) {
  plans[name]=db.prepare('EXPLAIN QUERY PLAN '+query).all(...args).map(x=>x.detail)
}
console.log(JSON.stringify(plans,null,2))
if(refined) {
  for(const [name,index] of Object.entries({
    'low stock':'products_low_stock','expiry alerts':'products_upcoming_expiry','rider history':'rider_history',
    'due refund processing':'provider_refund_due',
    'product media retention':'products_media_reference','active rider cash collection':'rider_unreconciled','public all products cursor':'products_active_id','two-token prefix search':'PRIMARY KEY','public category cursor':'products_category','slot admission':'slot_usage','customer order cursor':'orders_owner','order tracking version':'order_timeline',
  })) {
    if(!plans[name].some(detail=>detail.includes(index))||plans[name].some(detail=>detail.includes('TEMP B-TREE'))) {
      throw new Error(`${name} did not use ${index} without a sort`)
    }
  }
}
db.close()
