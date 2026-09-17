-- D1 schema for vergabe-api (SQLite)
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,              -- notice_id-version
  notice_id TEXT NOT NULL,
  version TEXT,
  published TEXT NOT NULL,          -- YYYY-MM-DD (pubDay of the export)
  issue_date TEXT,
  kind TEXT,                        -- competition | result | planning | change | other
  notice_type TEXT,                 -- eForms notice-type code (cn-standard, can-standard, ...)
  subtype TEXT,
  changed_notice TEXT,
  procedure TEXT,                   -- open | restricted | neg-w-call | ...
  legal_basis TEXT,                 -- vgv | vob | uvgo | sektvo | ...
  regulatory_domain TEXT,
  nature TEXT,                      -- works | services | supplies
  title TEXT,
  description TEXT,
  cpv_main TEXT,
  cpv_additional TEXT,              -- JSON array
  buyer_name TEXT,
  buyer_type TEXT,
  buyer_city TEXT,
  buyer_postal TEXT,
  buyer_nuts TEXT,
  buyer_country TEXT,
  buyer_website TEXT,
  place_nuts TEXT,
  place_city TEXT,
  estimated_value REAL,
  currency TEXT,
  deadline_date TEXT,
  deadline_time TEXT,
  deadline_kind TEXT,               -- tender | participation
  documents_url TEXT,
  submission_url TEXT,
  lots TEXT,                        -- JSON array
  lot_count INTEGER,
  winners TEXT,                     -- JSON array of organisation names
  total_awarded REAL,
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_published ON notices(published);
CREATE INDEX IF NOT EXISTS idx_notices_cpv ON notices(cpv_main);
CREATE INDEX IF NOT EXISTS idx_notices_nuts ON notices(place_nuts);
CREATE INDEX IF NOT EXISTS idx_notices_deadline ON notices(deadline_date);
CREATE INDEX IF NOT EXISTS idx_notices_kind_pub ON notices(kind, published);

CREATE TABLE IF NOT EXISTS days (
  day TEXT PRIMARY KEY,
  notices INTEGER,
  competition INTEGER,
  result INTEGER,
  planning INTEGER,
  change INTEGER,
  loaded_at TEXT
);

-- request counters per day/path/status (no IPs, no user agents); written fire-and-forget by the worker
CREATE TABLE IF NOT EXISTS hits (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, status)
);
