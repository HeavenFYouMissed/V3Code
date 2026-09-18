-- v3update analytics — download + install tracking.
-- Written non-blocking (ctx.waitUntil) from the worker; a failure here NEVER
-- affects serving a download. Raw IP is stored deliberately (Daniel's own infra,
-- for the download/IP reference count he asked for).

-- One row per successful download byte-serve (GET 200/206). Resumes/segments show
-- up as is_range=1 rows; dedup to "downloads" with COUNT(DISTINCT ip||filename||day).
CREATE TABLE IF NOT EXISTS downloads (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	ts        INTEGER NOT NULL,            -- epoch ms
	ip        TEXT,                        -- cf-connecting-ip
	country   TEXT,                        -- request.cf.country
	city      TEXT,                        -- request.cf.city
	platform  TEXT,                        -- darwin-x64 / win32-x64-user / linux-x64 ...
	quality   TEXT,                        -- stable / insiders
	filename  TEXT,
	src       TEXT,                        -- ?src= tag (site / twitter / hn / ...)
	referer   TEXT,
	ua        TEXT,
	is_range  INTEGER NOT NULL DEFAULT 0   -- 1 = partial/resume (206)
);
CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads (ts);
CREATE INDEX IF NOT EXISTS idx_downloads_src ON downloads (src);
CREATE INDEX IF NOT EXISTS idx_downloads_platform ON downloads (platform);

-- One row per unique running install, upserted on every update poll. This is the
-- "active installs" reference — how many machines actually run the app — without
-- unbounded growth (hourly polls just bump last_seen/hits in place).
CREATE TABLE IF NOT EXISTS install_pings (
	ip          TEXT NOT NULL,
	platform    TEXT NOT NULL,
	quality     TEXT,
	commit_id   TEXT NOT NULL,             -- running build's commit
	country     TEXT,
	first_seen  INTEGER NOT NULL,
	last_seen   INTEGER NOT NULL,
	hits        INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (ip, platform, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_pings_last_seen ON install_pings (last_seen);
