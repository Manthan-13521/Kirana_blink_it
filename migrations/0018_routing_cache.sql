CREATE TABLE routing_cache (
  id INTEGER PRIMARY KEY CHECK(id=1),
  fingerprint TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
