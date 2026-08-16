-- ETF 份额记录表（D1）
CREATE TABLE IF NOT EXISTS etf_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    name TEXT,
    date TEXT NOT NULL,
    total_share REAL,
    market_value REAL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(code, date)
);
CREATE INDEX IF NOT EXISTS idx_etf_shares_date ON etf_shares(date);
CREATE INDEX IF NOT EXISTS idx_etf_shares_code ON etf_shares(code);
