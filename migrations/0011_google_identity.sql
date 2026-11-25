CREATE TABLE oauth_requests (
  state TEXT PRIMARY KEY,
  binding TEXT NOT NULL,
  verifier TEXT NOT NULL,
  workspace TEXT NOT NULL CHECK(workspace IN('shop','owner','rider')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);
CREATE TABLE google_identities (
  subject TEXT NOT NULL,
  workspace TEXT NOT NULL CHECK(workspace IN('shop','owner','rider')),
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  PRIMARY KEY(subject,workspace)
) WITHOUT ROWID;
