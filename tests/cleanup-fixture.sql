INSERT INTO orders(id,account_id,request_key,request_fingerprint,channel,fulfillment,status,payment_method,payment_status,
    subtotal,fees,total,tax,billing_json,slot_start,slot_end,created_at,updated_at)
VALUES ('old-mock','demo-customer','seed-mock-unresolved','fixture','online','pickup','awaiting_payment','online','unpaid',
  3100,0,3100,0,'{}',1700000000,1700001800,1700000000,1700000000),
 ('open-cash','demo-customer','seed-cash-unresolved','fixture','online','pickup','placed','cash','cash_due',
  3100,0,3100,0,'{}',1700086400,1700088200,1700086400,1700086400);
INSERT INTO order_items(order_id,product_id,sku,name,unit,step,quantity,price,line_total,tax,tax_bps,hsn)
SELECT 'old-mock',id,sku,name,unit,step,step,price,price,0,tax_bps,hsn FROM products WHERE id='milk';
INSERT INTO carts(account_id,items,updated_at) VALUES ('demo-customer','[{"id":"milk","steps":1}]',1700000000);
INSERT INTO sessions(hash,account_id,expires_at) VALUES ('expired-test-session','demo-customer',1700000000);
INSERT INTO invites(hash,role,expires_at) VALUES ('expired-test-invite','rider',1700000000);
INSERT INTO notices(account_id,order_id,message,created_at) VALUES ('demo-customer','open-cash','Temporary notice',1700000000);
