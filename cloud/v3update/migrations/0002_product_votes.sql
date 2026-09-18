-- Anonymous product votes. The editor installation UUID is SHA-256 hashed in the
-- Worker before storage; no account, prompt, filename, or IP is stored here.
CREATE TABLE IF NOT EXISTS product_votes (
	survey_id  TEXT NOT NULL,
	voter_hash TEXT NOT NULL,
	choice     TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (survey_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS idx_product_votes_survey_choice
	ON product_votes (survey_id, choice);
