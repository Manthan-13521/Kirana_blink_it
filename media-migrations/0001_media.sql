CREATE TABLE media (
  id TEXT PRIMARY KEY,
  payload BLOB NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 32768),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX media_expiry ON media(expires_at) WHERE expires_at IS NOT NULL;
