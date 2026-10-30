"""SQLite storage for the stock journal.

Everything lives in one portable folder (default: <app>/data):

    data/journal.db      -> all trades, settings, review queue, broker cache
    data/attachments/    -> trade screenshots
    data/backups/        -> exported JSON snapshots
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

APP_NAME = "StockJournal"


def _app_root() -> Path:
    if getattr(sys, "frozen", False):  # PyInstaller executable
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT_DIR = _app_root()
DATA_DIR = Path(os.environ.get("STOCK_JOURNAL_DATA") or (ROOT_DIR / "data")).expanduser().resolve()
ATTACH_DIR = DATA_DIR / "attachments"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "journal.db"

_write_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT    NOT NULL,
    exchange        TEXT    DEFAULT 'NSE',
    side            TEXT    DEFAULT 'LONG',          -- LONG | SHORT
    entry_date      TEXT    NOT NULL,                -- YYYY-MM-DD
    entry_price     REAL    NOT NULL,
    quantity        REAL    NOT NULL,
    exit_date       TEXT,
    exit_price      REAL,
    stop_loss       REAL,
    target          REAL,
    fees            REAL    DEFAULT 0,
    notes           TEXT,
    strategy        TEXT,
    tags            TEXT,
    rating          INTEGER,                          -- 1..5 stars
    source          TEXT    DEFAULT 'MANUAL',         -- MANUAL | CSV | ZERODHA | SAMPLE
    external_key    TEXT,
    broker_ids      TEXT,                             -- JSON array of broker refs
    ltp             REAL,                             -- last traded price cache
    ltp_at          TEXT,
    created_at      TEXT,
    updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol   ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_entry    ON trades(entry_date);
CREATE INDEX IF NOT EXISTS idx_trades_exit     ON trades(exit_date);
CREATE INDEX IF NOT EXISTS idx_trades_external ON trades(external_key);

CREATE TABLE IF NOT EXISTS executions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id    INTEGER,
    symbol      TEXT    NOT NULL,
    side        TEXT    NOT NULL,                     -- BUY | SELL
    quantity    REAL    NOT NULL,
    price       REAL    NOT NULL,
    exec_date   TEXT    NOT NULL,
    trade_ref   TEXT,
    order_id    TEXT,
    exchange    TEXT,
    source      TEXT,
    fingerprint TEXT    UNIQUE,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS review_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    detail          TEXT,
    payload         TEXT,                             -- JSON
    status          TEXT    DEFAULT 'PENDING',        -- PENDING | ACCEPTED | REJECTED
    created_at      TEXT,
    resolved_at     TEXT,
    resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_ledger (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    date   TEXT NOT NULL,
    kind   TEXT NOT NULL,                             -- DEPOSIT | WITHDRAW | ADJUST
    amount REAL NOT NULL,
    note   TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS holdings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    exchange    TEXT,
    product     TEXT,
    quantity    REAL,
    avg_price   REAL,
    last_price  REAL,
    pnl         REAL,
    source      TEXT DEFAULT 'ZERODHA',
    updated_at  TEXT,
    UNIQUE(symbol, exchange, product, source)
);

CREATE TABLE IF NOT EXISTS trade_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id   INTEGER NOT NULL,
    filename   TEXT NOT NULL,
    caption    TEXT,
    created_at TEXT,
    FOREIGN KEY(trade_id) REFERENCES trades(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT,
    source  TEXT,
    status  TEXT,
    summary TEXT
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "account_balance": 0.0,
    "starting_balance": 0.0,
    "currency": "INR",
    "theme": "dark",
    "dashboard_range": "3m",
    "stats_range": "1y",
    "dashboard_status": "all",
    "dashboard_sort": "date_desc",
    "duplicate_price_tolerance_pct": 1.0,
    "duplicate_date_window_days": 3,
    "breakeven_pct": 0.05,
    "auto_create_new_from_broker": True,
    "broker": {
        "api_key": "",
        "api_secret": "",
        "access_token": "",
        "user_id": "",
        "connected_at": "",
        "last_sync": "",
        "last_sync_summary": "",
    },
    "columns": {
        "date": True,
        "symbol": True,
        "status": True,
        "side": False,
        "quantity": True,
        "entry": True,
        "exit": True,
        "ltp": False,
        "hold": True,
        "pnl": True,
        "pnl_pct": True,
        "r": True,
        "fees": False,
        "strategy": False,
        "tags": False,
        "notes": True,
        "photo": True,
        "actions": True,
    },
    "photo_columns": True,
    "stats_cards": {
        "net_pnl": True,
        "win_rate": True,
        "profit_factor": True,
        "total_trades": True,
        "avg_win": True,
        "avg_loss": True,
        "largest_win": True,
        "largest_loss": True,
        "avg_hold": True,
        "expectancy": True,
        "max_drawdown": True,
        "total_r": True,
    },
    "page_size": 50,
}


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def init_db() -> None:
    ensure_dirs()
    with _write_lock:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            conn.execute("BEGIN")
            for key, val in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
                    (key, json.dumps(val)),
                )
            conn.execute("COMMIT")
            _migrate(conn)
        finally:
            conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns that may be missing on older databases."""
    wanted = {
        "trades": {
            "ltp": "REAL",
            "ltp_at": "TEXT",
            "external_key": "TEXT",
            "broker_ids": "TEXT",
            "rating": "INTEGER",
        }
    }
    for table, cols in wanted.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


# ---------------------------------------------------------------------------
# settings helpers
# ---------------------------------------------------------------------------

def get_settings(conn: sqlite3.Connection, mask_secrets: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(json.dumps(DEFAULT_SETTINGS))
    for row in conn.execute("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            out[row["key"]] = row["value"]
    if mask_secrets:
        out = _mask(out)
    return out


def save_settings(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, Any]:
    with _write_lock:
        for key, value in patch.items():
            current = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            if key == "broker" and isinstance(value, dict):
                merged = get_settings(conn).get("broker", {})
                merged.update(value)
                # never overwrite a stored secret with a masked placeholder
                for secret in ("api_secret", "access_token"):
                    if merged.get(secret) in ("", None) or str(merged.get(secret, "")).startswith("••"):
                        pass
                value = merged
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )
    return get_settings(conn)


def _mask(settings: dict[str, Any]) -> dict[str, Any]:
    b = settings.get("broker") or {}
    for secret in ("api_secret", "access_token"):
        if b.get(secret):
            b[secret] = "••••••" + str(b[secret])[-4:]
    settings["broker"] = b
    return settings


def log_sync(conn: sqlite3.Connection, source: str, status: str, summary: Any) -> None:
    conn.execute(
        "INSERT INTO sync_log(ts, source, status, summary) VALUES(?,?,?,?)",
        (now_iso(), source, status, json.dumps(summary, default=str)),
    )


# ---------------------------------------------------------------------------
# backup / restore
# ---------------------------------------------------------------------------

def now_iso() -> str:
    import datetime as dt

    return dt.datetime.now().replace(microsecond=0).isoformat()


def export_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    def rows(table: str) -> list[dict[str, Any]]:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]

    return {
        "app": APP_NAME,
        "version": 1,
        "exported_at": now_iso(),
        "tables": {
            "trades": rows("trades"),
            "executions": rows("executions"),
            "review_items": rows("review_items"),
            "cash_ledger": rows("cash_ledger"),
            "holdings": rows("holdings"),
            "trade_photos": rows("trade_photos"),
            "settings": rows("settings"),
            "sync_log": rows("sync_log"),
        },
    }


def import_snapshot(conn: sqlite3.Connection, snapshot: dict[str, Any], replace: bool = True) -> dict[str, int]:
    tables = snapshot.get("tables") or {}
    counts: dict[str, int] = {}
    with _write_lock:
        conn.execute("BEGIN")
        try:
            if replace:
                for t in ("trade_photos", "executions", "review_items", "trades", "holdings", "cash_ledger", "sync_log"):
                    conn.execute(f"DELETE FROM {t}")
            for table, items in tables.items():
                if table not in {
                    "trades",
                    "executions",
                    "review_items",
                    "cash_ledger",
                    "holdings",
                    "trade_photos",
                    "settings",
                    "sync_log",
                }:
                    continue
                if not isinstance(items, list):
                    continue
                n = 0
                for item in items:
                    item = {k: v for k, v in item.items() if isinstance(k, str)}
                    if not item:
                        continue
                    cols = ", ".join(item.keys())
                    marks = ", ".join("?" for _ in item)
                    if table == "settings":
                        sql = f"INSERT INTO settings({cols}) VALUES({marks}) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                    elif table == "executions":
                        sql = f"INSERT OR IGNORE INTO executions({cols}) VALUES({marks})"
                    elif table == "holdings":
                        sql = f"INSERT OR REPLACE INTO holdings({cols}) VALUES({marks})"
                    else:
                        sql = f"INSERT INTO {table}({cols}) VALUES({marks})"
                    conn.execute(sql, tuple(item.values()))
                    n += 1
                counts[table] = n
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return counts


def backup_file(conn: sqlite3.Connection) -> Path:
    ensure_dirs()
    snapshot = export_snapshot(conn)
    path = BACKUP_DIR / f"journal-backup-{now_iso().replace(':', '-')}.json"
    path.write_text(json.dumps(snapshot, indent=2, default=str), encoding="utf-8")
    return path


def reset_data(conn: sqlite3.Connection) -> None:
    with _write_lock:
        conn.execute("BEGIN")
        try:
            for t in ("trade_photos", "executions", "review_items", "trades", "holdings", "cash_ledger", "sync_log"):
                conn.execute(f"DELETE FROM {t}")
            # Balances are journal data too: without this the dashboard would keep
            # showing a capital figure (and account %) for an empty journal.
            conn.execute("DELETE FROM settings WHERE key IN ('account_balance', 'starting_balance')")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    # Keep broker credentials, but forget the last sync so the status matches
    # the now-empty sync log.
    broker = dict(get_settings(conn).get("broker") or {})
    if broker.get("last_sync") or broker.get("last_sync_summary"):
        broker["last_sync"] = ""
        broker["last_sync_summary"] = ""
        save_settings(conn, {"broker": broker})
    if ATTACH_DIR.exists():
        for f in ATTACH_DIR.iterdir():
            if f.is_file():
                f.unlink(missing_ok=True)


def delete_attachment(filename: str) -> None:
    if not filename:
        return
    p = (ATTACH_DIR / filename).resolve()
    if ATTACH_DIR.resolve() in p.parents and p.exists():
        p.unlink(missing_ok=True)


def storage_info() -> dict[str, Any]:
    ensure_dirs()
    size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
    photos = len(list(ATTACH_DIR.glob("*"))) if ATTACH_DIR.exists() else 0
    return {
        "data_dir": str(DATA_DIR),
        "db_path": str(DB_PATH),
        "db_size": size,
        "attachments": photos,
        "backups": len(list(BACKUP_DIR.glob("*.json"))) if BACKUP_DIR.exists() else 0,
    }


def copy_backup(src: Path) -> Path:
    ensure_dirs()
    dest = BACKUP_DIR / src.name
    shutil.copy2(src, dest)
    return dest
