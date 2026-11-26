ALTER TABLE products ADD COLUMN variant_group TEXT NOT NULL DEFAULT '';
CREATE INDEX products_variants ON products(variant_group,step,id) WHERE active=1 AND variant_group<>'';
