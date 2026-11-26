ALTER TABLE oauth_requests ADD COLUMN return_checkout INTEGER NOT NULL DEFAULT 0 CHECK(return_checkout IN (0,1));
ALTER TABLE oauth_requests ADD COLUMN invite_hash TEXT;
ALTER TABLE invites ADD COLUMN target_email_hash TEXT;
ALTER TABLE google_identities ADD COLUMN invited INTEGER NOT NULL DEFAULT 0 CHECK(invited IN (0,1));
