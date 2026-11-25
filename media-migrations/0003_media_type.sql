ALTER TABLE media ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/webp' CHECK(mime IN('image/webp','image/jpeg'));
