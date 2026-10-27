-- D1 (SQLite) 資料表。與 Node 版 server/db.js 的結構一致,另加 rate_limits(失敗次數限制用)。
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  edit_roles     TEXT NOT NULL DEFAULT '[]',
  view_roles     TEXT NOT NULL DEFAULT '[]',
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  recovery_code  TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  first_ts INTEGER NOT NULL
);
