WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4984)
INSERT INTO products(id,sku,name,brand,description,category,subcategory,unit,step,price,mrp,stock,threshold,updated_at)
SELECT 'load-'||printf('%04d',i),'BENCH-'||printf('%04d',i),'Benchmark Grocery '||printf('%04d',i),
  'Load fixture','Synthetic benchmark product','pantry','Shelf staples','pc',1,3900+(i%45)*100,9900,1000,10,0 FROM n;
INSERT INTO search_terms
  SELECT 'benchmark',id FROM products WHERE id LIKE 'load-%'
  UNION ALL SELECT substr(id,6),id FROM products WHERE id LIKE 'load-%';
UPDATE settings SET open_hour=0, close_hour=24, preparation=0, delivery_capacity=8, pickup_capacity=160 WHERE id=1;
