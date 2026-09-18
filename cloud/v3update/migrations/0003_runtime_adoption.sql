-- Privacy-safe editor release adoption.
--
-- One bounded row per anonymous installation + build. The editor sends a
-- machine-local random UUID, but the Worker stores only a domain-separated
-- SHA-256 hash. No account, IP, prompt, code, filename, provider, model, key,
-- or response content is accepted by the endpoint or stored here.
CREATE TABLE IF NOT EXISTS runtime_install_state (
	installation_hash   TEXT NOT NULL,
	commit_id            TEXT NOT NULL,
	product_version      TEXT NOT NULL,
	platform             TEXT NOT NULL,
	quality              TEXT NOT NULL,
	first_seen           INTEGER NOT NULL,
	last_seen            INTEGER NOT NULL,
	launched_at          INTEGER,
	runtime_ready_at     INTEGER,
	ai_first_attempt_at  INTEGER,
	ai_first_success_at  INTEGER,
	ai_last_failure_at   INTEGER,
	last_failure_code    TEXT,
	event_count          INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (installation_hash, commit_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_state_last_seen
	ON runtime_install_state (last_seen);

CREATE INDEX IF NOT EXISTS idx_runtime_state_build
	ON runtime_install_state (commit_id, product_version, last_seen);
