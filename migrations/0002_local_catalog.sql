INSERT INTO settings VALUES(1,'Neighbourhood Kirana','Fresh is closer.','Banjara Hills, Hyderabad','040 555 0101','Road No. 12, Banjara Hills, Hyderabad','500001,500028,500034,500033,500082',17.4116,78.4220,6,9,21,25,60,8,25,2900,49900,0,1,0,'','Only eligible unopened or defective items may be returned. Contact the shop through your order.','#193c32',1,1);
INSERT INTO accounts(id,role,name,phone) VALUES
 ('demo-customer','customer','Aarav','9000000001'), ('demo-owner','owner','Meera','9000000002'),
 ('demo-rider','rider','Ravi','9000000003'), ('demo-staff','staff','Dev','9000000004');
INSERT INTO categories VALUES
 ('fresh','Fruits & vegetables','/catalog/01.webp',1),
 ('dairy','Dairy, bread & eggs','/catalog/05.webp',2),
 ('pantry','Atta, rice & dal','/catalog/09.webp',3),
 ('snacks','Snacks & drinks','/catalog/16.webp',4),
 ('home','Home essentials','/catalog/15.webp',5);
INSERT INTO synonyms VALUES ('tamatar','tomato'),('pyaaz','onion'),('pyaz','onion'),('aloo','potato'),('doodh','milk'),('anda','egg'),('chawal','rice'),('dal','dal'),('dhaniya','coriander'),('kela','banana'),('atta','flour');
INSERT INTO products(id,sku,name,brand,description,category,subcategory,unit,step,price,mrp,stock,threshold,image,featured,updated_at) VALUES
 ('tomato','FR-101','Vine Tomatoes','Market fresh','Juicy tomatoes with a bright, fresh flavour.','fresh','Vegetables','g',500,3200,4000,35000,5000,'/catalog/01.webp',1,0),
 ('onion','FR-102','Red Onions','Market fresh','A kitchen staple for slow cooking and everyday tadka.','fresh','Vegetables','g',500,2800,3400,55000,7000,'/catalog/02.webp',1,0),
 ('banana','FR-103','Robusta Bananas','Market fresh','Naturally sweet, ripened bananas.','fresh','Fruit','pc',6,4900,5900,180,24,'/catalog/03.webp',1,0),
 ('coriander','FR-104','Fresh Coriander','Market fresh','A fragrant finishing touch for everyday meals.','fresh','Herbs','g',100,1200,1600,12000,1000,'/catalog/04.webp',1,0),
 ('milk','DA-201','Farm Toned Milk','Daily Dairy','Toned milk for tea, coffee and breakfast.','dairy','Milk','ml',500,3100,3400,36000,5000,'/catalog/05.webp',1,0),
 ('egg','DA-202','Country Brown Eggs','Daily Dairy','Fresh brown eggs, hand sorted.','dairy','Eggs','pc',6,7800,9000,210,24,'/catalog/06.webp',1,0),
 ('bread','DA-203','Whole Wheat Bread','Daily Bakery','A soft, sliced whole wheat loaf.','dairy','Bakery','g',400,5200,5800,16000,2400,'/catalog/07.webp',1,0),
 ('paneer','DA-204','Fresh Malai Paneer','Daily Dairy','Soft paneer for curries, grills and wraps.','dairy','Cheese','g',200,9500,10500,11000,1000,'/catalog/08.webp',1,0),
 ('rice','PA-301','Aged Basmati Rice','Kirana pantry','Fragrant long-grain rice with a light texture.','pantry','Rice','g',1000,14900,16900,72000,8000,'/catalog/09.webp',0,0),
 ('dal','PA-302','Unpolished Toor Dal','Kirana pantry','Split pigeon peas for home-cooked dals.','pantry','Pulses','g',500,8900,9900,50000,4000,'/catalog/10.webp',0,0),
 ('flour','PA-303','Stoneground Wheat Atta','Kirana pantry','Whole wheat flour milled for soft rotis.','pantry','Flour','g',1000,6200,7000,48000,5000,'/catalog/11.webp',0,0),
 ('orange','FR-105','Nagpur Oranges','Market fresh','Juicy citrus for snacks and fresh juice.','fresh','Fruit','g',500,5400,6500,20000,3000,'/catalog/12.webp',0,0),
 ('potato','FR-106','Golden Potatoes','Market fresh','All-purpose potatoes for roasting and curries.','fresh','Vegetables','g',500,2900,3600,33000,4500,'/catalog/13.webp',0,0),
 ('tea','SN-401','Assam Breakfast Tea','Kirana pantry','A full-bodied tea for your morning chai.','snacks','Beverages','g',250,12900,14900,10000,1500,'/catalog/14.webp',0,0),
 ('cleaner','HM-501','Lime Surface Cleaner','Home care','A fresh lime everyday surface cleaner.','home','Cleaning','ml',500,9800,11900,22000,2500,'/catalog/15.webp',0,0),
 ('chips','SN-402','Classic Salted Chips','Pantry snacks','Crisp golden potato chips with sea salt.','snacks','Snacks','g',90,4200,5000,8100,900,'/catalog/16.webp',0,0);
WITH RECURSIVE tokens(product_id,rest,term) AS (
 SELECT id, lower(name || ' ' || brand || ' ' || subcategory) || ' ', '' FROM products
 UNION ALL
 SELECT product_id, substr(rest,instr(rest,' ')+1), substr(rest,1,instr(rest,' ')-1) FROM tokens WHERE rest<>''
) INSERT OR IGNORE INTO search_terms SELECT term,product_id FROM tokens WHERE term<>'';
INSERT INTO addresses VALUES ('demo-address','demo-customer','Home','Aarav','9000000001','Flat 302, Road No. 12','Banjara Hills','Near the community park','500034',17.41235,78.42890,0);
