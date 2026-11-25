CREATE INDEX products_active_id ON products(active,id);
CREATE INDEX products_subcategory ON products(active,subcategory,id);
CREATE INDEX products_category_subcategory ON products(active,category,subcategory,id);

-- Maintain a bounded autocomplete index in product ID order, including Unicode terms.
CREATE TABLE search_prefixes (
  prefix TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY(prefix,product_id)
) WITHOUT ROWID;
CREATE INDEX search_prefixes_product ON search_prefixes(product_id);
WITH RECURSIVE lengths(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM lengths WHERE n<12)
INSERT OR IGNORE INTO search_prefixes(prefix,product_id)
SELECT substr(term,1,n),product_id FROM search_terms JOIN lengths ON n<=length(term);

CREATE TRIGGER search_prefix_insert AFTER INSERT ON search_terms BEGIN
  INSERT OR IGNORE INTO search_prefixes(prefix,product_id)
  SELECT substr(NEW.term,1,n),NEW.product_id
  FROM (WITH RECURSIVE lengths(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM lengths WHERE n<12) SELECT n FROM lengths)
  WHERE n<=length(NEW.term);
END;
