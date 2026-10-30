"""Trade CRUD, derived values, duplicate detection and the FIFO fill engine.

The golden rule of this module: *never silently create a duplicate*.
A new row is either clearly new (created), clearly a duplicate (skipped and
reported) or doubtful (parked in the review queue for a human decision).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any, Iterable

from .db import now_iso
from .utils import (
    add_days,
    days_between,
    norm_side,
    norm_symbol,
    parse_date,
    parse_num,
    round2,
    safe_div,
    today_iso,
)

PHOTO_URL = "/api/attachments/"


# ---------------------------------------------------------------------------
# derived trade shape
# ---------------------------------------------------------------------------

def row_to_trade(row: sqlite3.Row | dict, photos: list[dict] | None = None) -> dict[str, Any]:
    t = dict(row)
    t["symbol"] = norm_symbol(t.get("symbol"))
    t["side"] = (t.get("side") or "LONG").upper()
    entry = parse_num(t.get("entry_price")) or 0.0
    qty = parse_num(t.get("quantity")) or 0.0
    exit_price = parse_num(t.get("exit_price"))
    fees = parse_num(t.get("fees")) or 0.0
    is_short = t["side"] == "SHORT"
    direction = -1 if is_short else 1
    invested = entry * qty

    closed = exit_price is not None and (t.get("exit_date") or t.get("exit_price") is not None)
    pnl = pnl_pct = r_multiple = None
    hold_days = days_between(t.get("entry_date"), t.get("exit_date"))
    if exit_price is not None:
        gross = (exit_price - entry) * qty * direction
        pnl = gross - fees
        pnl_pct = safe_div(pnl, invested, 0.0) * 100.0 if invested else None
        sl = parse_num(t.get("stop_loss"))
        if sl is not None and abs(entry - sl) > 1e-9:
            risk = abs(entry - sl) * qty
            r_multiple = round2(safe_div(pnl, risk, 0.0))
    else:
        # unrealised, using last traded price when we have one
        ltp = parse_num(t.get("ltp"))
        if ltp is not None:
            pnl = (ltp - entry) * qty * direction - fees
            pnl_pct = safe_div(pnl, invested, 0.0) * 100.0 if invested else None
        hold_days = days_between(t.get("entry_date"), today_iso())

    if exit_price is None:
        status = "OPEN"
    elif (pnl or 0) > 0:
        status = "PROFIT"
    elif (pnl or 0) < 0:
        status = "LOSS"
    else:
        status = "PROFIT"

    t.update(
        {
            "entry_price": round2(entry),
            "quantity": qty,
            "invested": round2(invested),
            "pnl": round2(pnl),
            "pnl_pct": round2(pnl_pct),
            "r_multiple": r_multiple,
            "hold_days": hold_days,
            "hold_label": hold_label(hold_days),
            "status": status,
            "closed": status != "OPEN",
            "is_short": is_short,
            "photos": photos or [],
        }
    )
    # sensible defaults for optional text fields
    for key in ("notes", "strategy", "tags", "exchange", "source"):
        t.setdefault(key, None)
    t["tags"] = t.get("tags") or ""
    t["notes"] = t.get("notes") or ""
    t["strategy"] = t.get("strategy") or ""
    t["exchange"] = t.get("exchange") or "NSE"
    return t


def hold_label(days: int | None) -> str:
    if days is None:
        return "-"
    if days <= 0:
        return "Same day"
    if days == 1:
        return "1 day"
    return f"{days} days"


# ---------------------------------------------------------------------------
# queries
# ---------------------------------------------------------------------------

def _photos_by_trade(conn: sqlite3.Connection) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for r in conn.execute("SELECT * FROM trade_photos ORDER BY id"):
        out.setdefault(r["trade_id"], []).append(
            {
                "id": r["id"],
                "filename": r["filename"],
                "url": PHOTO_URL + r["filename"],
                "caption": r["caption"],
            }
        )
    return out


def get_trade(conn: sqlite3.Connection, trade_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
    if not row:
        return None
    photos = [
        {"id": p["id"], "filename": p["filename"], "url": PHOTO_URL + p["filename"], "caption": p["caption"]}
        for p in conn.execute("SELECT * FROM trade_photos WHERE trade_id=? ORDER BY id", (trade_id,))
    ]
    return row_to_trade(row, photos)


def all_trades(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    photos = _photos_by_trade(conn)
    return [row_to_trade(r, photos.get(r["id"], [])) for r in conn.execute("SELECT * FROM trades ORDER BY entry_date, id")]


SORTS = {
    "date_desc": ("entry_date", True),
    "date_asc": ("entry_date", False),
    "pnl_desc": ("pnl", True),
    "pnl_asc": ("pnl", False),
    "pnl_pct_desc": ("pnl_pct", True),
    "pnl_pct_asc": ("pnl_pct", False),
    "hold_desc": ("hold_days", True),
    "hold_asc": ("hold_days", False),
    "r_desc": ("r_multiple", True),
    "r_asc": ("r_multiple", False),
    "symbol_asc": ("symbol", False),
    "symbol_desc": ("symbol", True),
    "qty_desc": ("quantity", True),
    "status": ("status", False),
}


def sort_trades(trades: list[dict[str, Any]], sort: str | None) -> list[dict[str, Any]]:
    key, reverse = SORTS.get(sort or "date_desc", SORTS["date_desc"])
    if key == "status":
        order = {"OPEN": 0, "PROFIT": 1, "LOSS": 2}
        return sorted(trades, key=lambda t: (order.get(t["status"], 9), t.get("entry_date") or ""), reverse=False)
    if key in ("symbol",):
        return sorted(trades, key=lambda t: (t.get(key) or ""), reverse=reverse)
    return sorted(
        trades,
        key=lambda t: (t.get(key) is None, t.get(key) if t.get(key) is not None else 0),
        reverse=reverse,
    )


def in_range(trade: dict[str, Any], start: str | None, end: str | None) -> bool:
    """Closed trades are ranged by exit date, open trades by entry date."""
    d = trade.get("exit_date") if trade.get("closed") else trade.get("entry_date")
    if not d:
        return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True


def query_trades(
    conn: sqlite3.Connection,
    status: str | None = None,
    start: str | None = None,
    end: str | None = None,
    search: str | None = None,
    sort: str | None = None,
    include_open: bool = True,
    symbol: str | None = None,
) -> list[dict[str, Any]]:
    trades = all_trades(conn)
    out = []
    search = (search or "").strip().lower()
    sym = norm_symbol(symbol) if symbol else None
    for t in trades:
        if sym and t["symbol"] != sym:
            continue
        if status and status != "all":
            if status == "open" and t["status"] != "OPEN":
                continue
            if status in ("win", "profit") and t["status"] != "PROFIT":
                continue
            if status in ("loss", "lose") and t["status"] != "LOSS":
                continue
            if status == "closed" and t["status"] == "OPEN":
                continue
        if status in ("all", None) and not include_open and t["status"] == "OPEN":
            continue
        if (start or end) and t["status"] != "OPEN":
            if not in_range(t, start, end):
                continue
        if search:
            hay = " ".join(
                str(x or "")
                for x in (t["symbol"], t["notes"], t["strategy"], t["tags"], t.get("exit_date"), t.get("entry_date"))
            ).lower()
            if search not in hay:
                continue
        out.append(t)
    return sort_trades(out, sort)


# ---------------------------------------------------------------------------
# validation + writes
# ---------------------------------------------------------------------------

class ValidationError(ValueError):
    pass


def _clean_payload(payload: dict[str, Any]) -> dict[str, Any]:
    symbol = norm_symbol(payload.get("symbol"))
    if not symbol:
        raise ValidationError("Symbol is required")
    entry_date = parse_date(payload.get("entry_date") or payload.get("date"))
    if not entry_date:
        raise ValidationError("A valid entry date is required")
    entry_price = parse_num(payload.get("entry_price"))
    qty = parse_num(payload.get("quantity"))
    if entry_price is None or entry_price < 0:
        raise ValidationError("Entry price must be a number")
    if not qty or qty <= 0:
        raise ValidationError("Quantity must be greater than zero")

    exit_date = parse_date(payload.get("exit_date"))
    exit_price = parse_num(payload.get("exit_price"))
    if exit_price is not None and exit_date is None:
        exit_date = today_iso()
    if exit_date and exit_date < entry_date:
        raise ValidationError("Exit date cannot be before entry date")

    side = (payload.get("side") or "LONG").upper()
    if side in ("BUY", "LONG"):
        side = "LONG"
    elif side in ("SELL", "SHORT"):
        side = "SHORT"

    tags = payload.get("tags")
    if isinstance(tags, (list, tuple)):
        tags = ",".join(str(x).strip() for x in tags if str(x).strip())

    rating = parse_num(payload.get("rating"))
    if rating is not None:
        rating = max(1, min(5, int(rating)))

    return {
        "symbol": symbol,
        "exchange": (str(payload.get("exchange") or "NSE")).upper()[:16],
        "side": side,
        "entry_date": entry_date,
        "entry_price": round(entry_price, 4),
        "quantity": float(qty),
        "exit_date": exit_date,
        "exit_price": round(exit_price, 4) if exit_price is not None else None,
        "stop_loss": round(parse_num(payload.get("stop_loss")), 4) if parse_num(payload.get("stop_loss")) is not None else None,
        "target": round(parse_num(payload.get("target")), 4) if parse_num(payload.get("target")) is not None else None,
        "fees": round(parse_num(payload.get("fees")) or 0.0, 2),
        "notes": (payload.get("notes") or "").strip()[:5000],
        "strategy": (payload.get("strategy") or "").strip()[:120],
        "tags": (tags or "").strip()[:300],
        "rating": rating,
        "ltp": parse_num(payload.get("ltp")),
    }


def _price_close(a: float, b: float, tol_pct: float) -> bool:
    tol = max(0.05, max(abs(a), abs(b)) * (tol_pct / 100.0))
    return abs(a - b) <= tol


def find_matches(
    conn: sqlite3.Connection,
    candidate: dict[str, Any],
    trades: list[dict[str, Any]] | None = None,
    tolerance_pct: float = 1.0,
    window_days: int = 3,
) -> dict[str, list[dict[str, Any]]]:
    """Split potentially-matching existing trades into exact duplicates and fuzzy ones."""
    trades = trades if trades is not None else all_trades(conn)
    sym = candidate["symbol"]
    qty = float(candidate["quantity"])
    price = float(candidate["entry_price"])
    date = candidate["entry_date"]
    ext = candidate.get("external_key")

    exact: list[dict[str, Any]] = []
    fuzzy: list[dict[str, Any]] = []
    for t in trades:
        if t["symbol"] != sym:
            continue
        if ext and t.get("external_key"):
            if ext == t["external_key"]:
                exact.append(t)
            continue  # different broker refs => different fills
        t_qty = float(t["quantity"])
        t_price = float(t["entry_price"])
        same_price = _price_close(price, t_price, tolerance_pct)
        same_price_exact = _price_close(price, t_price, 0.05)
        same_qty = abs(qty - t_qty) < 1e-6
        dd = days_between(date, t["entry_date"])
        same_day = dd == 0
        near = dd is not None and abs(dd) <= window_days
        if same_qty and same_price_exact and same_day:
            exact.append(t)
        elif same_qty and same_price and near:
            fuzzy.append(t)
        elif same_qty and same_price:
            fuzzy.append(t)
        elif same_qty and near:
            fuzzy.append(t)
        elif same_price and near:
            fuzzy.append(t)
    return {"exact": exact, "fuzzy": fuzzy}


def create_trade(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    source: str = "MANUAL",
    check_duplicates: bool = True,
    force: bool = False,
    settings: dict[str, Any] | None = None,
    trades: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from .db import get_settings

    settings = settings or get_settings(conn)
    clean = _clean_payload(payload)
    clean["source"] = source
    clean["external_key"] = (str(payload.get("external_key")) if payload.get("external_key") else None)
    clean["broker_ids"] = json.dumps(payload.get("broker_ids") or [])
    clean["created_at"] = now_iso()
    clean["updated_at"] = clean["created_at"]

    if check_duplicates and not force:
        found = find_matches(
            conn,
            clean,
            trades=trades,
            tolerance_pct=float(settings.get("duplicate_price_tolerance_pct", 1.0)),
            window_days=int(settings.get("duplicate_date_window_days", 3)),
        )
        if found["exact"]:
            match = found["exact"][0]
            return {
                "created": False,
                "duplicate": True,
                "trade_id": match["id"],
                "matched": _match_brief(match),
                "message": f"Already in journal as trade #{match['id']} ({match['symbol']}, {match['entry_date']})",
            }
        if found["fuzzy"]:
            item = add_review(
                conn,
                kind="DUPLICATE",
                title=f"Possible duplicate: {clean['symbol']} on {clean['entry_date']}",
                detail=(
                    f"A new {clean['quantity']:g} qty @ ₹{clean['entry_price']:g} {clean['side'].lower()} entry looks like "
                    f"trade #{found['fuzzy'][0]['id']}. Approve to skip the new row, reject to import it as a separate trade."
                ),
                payload={
                    "incoming": {**clean, "source": source},
                    "matches": [_match_brief(t) for t in found["fuzzy"][:5]],
                    "action": "skip",
                    "reject_action": "import",
                },
            )
            return {
                "created": False,
                "review": True,
                "review_id": item["id"],
                "message": f"Held for review: possible duplicate of trade #{found['fuzzy'][0]['id']}",
            }

    cols = ", ".join(clean.keys())
    marks = ", ".join("?" for _ in clean)
    cur = conn.execute(f"INSERT INTO trades({cols}) VALUES({marks})", tuple(clean.values()))
    trade_id = int(cur.lastrowid)
    return {"created": True, "trade_id": trade_id, "trade": get_trade(conn, trade_id)}


def _match_brief(t: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": t["id"],
        "symbol": t["symbol"],
        "side": t["side"],
        "entry_date": t["entry_date"],
        "entry_price": t["entry_price"],
        "quantity": t["quantity"],
        "exit_date": t.get("exit_date"),
        "exit_price": t.get("exit_price"),
        "status": t["status"],
        "pnl": t.get("pnl"),
        "source": t.get("source"),
    }


def update_trade(conn: sqlite3.Connection, trade_id: int, payload: dict[str, Any], partial: bool = True) -> dict[str, Any]:
    existing = get_trade(conn, trade_id)
    if not existing:
        raise ValidationError("Trade not found")
    merged = {**existing, **{k: v for k, v in payload.items() if k in {
        "symbol", "exchange", "side", "entry_date", "date", "entry_price", "quantity",
        "exit_date", "exit_price", "stop_loss", "target", "fees", "notes", "strategy",
        "tags", "rating", "ltp",
    }}}
    clean = _clean_payload(merged)
    clean["updated_at"] = now_iso()
    if "ltp" in payload:
        clean["ltp"] = parse_num(payload.get("ltp"))
        clean["ltp_at"] = now_iso()
    sets = ", ".join(f"{k}=?" for k in clean)
    conn.execute(f"UPDATE trades SET {sets} WHERE id=?", (*clean.values(), trade_id))
    return get_trade(conn, trade_id)


def close_trade(conn: sqlite3.Connection, trade_id: int, exit_price: float, exit_date: str | None = None, fees: float | None = None, notes: str | None = None) -> dict[str, Any]:
    trade = get_trade(conn, trade_id)
    if not trade:
        raise ValidationError("Trade not found")
    if parse_num(exit_price) is None:
        raise ValidationError("Exit price is required")
    payload: dict[str, Any] = {"exit_price": exit_price, "exit_date": exit_date or today_iso()}
    if fees is not None:
        payload["fees"] = (trade.get("fees") or 0) + (parse_num(fees) or 0)
    if notes:
        payload["notes"] = (trade.get("notes") or "") + ("\n" if trade.get("notes") else "") + notes
    return update_trade(conn, trade_id, payload)


def reopen_trade(conn: sqlite3.Connection, trade_id: int) -> dict[str, Any]:
    conn.execute("UPDATE trades SET exit_price=NULL, exit_date=NULL, updated_at=? WHERE id=?", (now_iso(), trade_id))
    return get_trade(conn, trade_id) or {}


def delete_trade(conn: sqlite3.Connection, trade_id: int) -> None:
    for p in conn.execute("SELECT filename FROM trade_photos WHERE trade_id=?", (trade_id,)):
        from .db import delete_attachment

        delete_attachment(p["filename"])
    conn.execute("DELETE FROM trade_photos WHERE trade_id=?", (trade_id,))
    conn.execute("DELETE FROM trades WHERE id=?", (trade_id,))


# ---------------------------------------------------------------------------
# review queue
# ---------------------------------------------------------------------------

def _review_sig(kind: str, payload: dict[str, Any]) -> str:
    key = json.dumps({"k": kind, "p": payload}, sort_keys=True, default=str)
    return hashlib.sha1(key.encode()).hexdigest()


def add_review(conn: sqlite3.Connection, kind: str, title: str, detail: str, payload: dict[str, Any]) -> dict[str, Any]:
    sig = _review_sig(kind, payload)
    for row in conn.execute("SELECT id, payload FROM review_items WHERE status='PENDING' AND kind=?", (kind,)):
        try:
            if json.loads(row["payload"] or "{}").get("_sig") == sig:
                return {"id": row["id"], "duplicate": True}
        except json.JSONDecodeError:
            continue
    payload = {**payload, "_sig": sig}
    cur = conn.execute(
        "INSERT INTO review_items(kind, title, detail, payload, status, created_at) VALUES(?,?,?,?,'PENDING',?)",
        (kind, title[:200], detail, json.dumps(payload, default=str), now_iso()),
    )
    return {"id": int(cur.lastrowid), "duplicate": False}


def list_reviews(conn: sqlite3.Connection, status: str = "PENDING") -> list[dict[str, Any]]:
    if status == "all":
        rows = conn.execute("SELECT * FROM review_items ORDER BY id DESC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM review_items WHERE status=? ORDER BY id DESC", (status,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.get("payload") or "{}")
        except json.JSONDecodeError:
            d["payload"] = {}
        out.append(d)
    return out


def review_count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM review_items WHERE status='PENDING'").fetchone()
    return int(row["n"] if row else 0)


def resolve_review(conn: sqlite3.Connection, review_id: int, decision: str, note: str | None = None) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM review_items WHERE id=?", (review_id,)).fetchone()
    if not row:
        raise ValidationError("Review item not found")
    if row["status"] != "PENDING":
        raise ValidationError("This item was already resolved")
    try:
        payload = json.loads(row["payload"] or "{}")
    except json.JSONDecodeError:
        payload = {}
    decision = decision.lower()
    if decision not in ("accept", "reject"):
        raise ValidationError("Decision must be accept or reject")

    kind = row["kind"]
    result: dict[str, Any] = {"kind": kind, "decision": decision}

    if kind == "DUPLICATE":
        if decision == "reject":
            incoming = payload.get("incoming") or {}
            result["created"] = create_trade(conn, incoming, source=incoming.get("source") or "MANUAL", check_duplicates=False, force=True)
    elif kind in ("PRICE_MISMATCH", "QTY_MISMATCH"):
        if decision == "accept":
            trade_id = payload.get("trade_id")
            incoming = payload.get("incoming") or {}
            patch: dict[str, Any] = {}
            if kind == "PRICE_MISMATCH":
                patch["entry_price"] = incoming.get("entry_price")
            else:
                patch["quantity"] = incoming.get("quantity")
            if patch and trade_id:
                result["trade"] = update_trade(conn, int(trade_id), patch)
    elif kind == "BROKER_CLOSED":
        if decision == "accept":
            trade_id = payload.get("trade_id")
            if trade_id:
                result["trade"] = close_trade(
                    conn,
                    int(trade_id),
                    payload.get("exit_price") or payload.get("incoming", {}).get("exit_price"),
                    payload.get("exit_date") or payload.get("incoming", {}).get("exit_date"),
                    notes="Closed from broker sync",
                )
    elif kind == "SELL_WITHOUT_BUY":
        if decision == "accept":
            incoming = payload.get("incoming") or {}
            result["created"] = create_trade(
                conn,
                {
                    "symbol": incoming.get("symbol"),
                    "entry_date": incoming.get("exec_date") or incoming.get("entry_date"),
                    "entry_price": incoming.get("price") or incoming.get("entry_price"),
                    "quantity": incoming.get("quantity"),
                    "side": "SHORT",
                    "exchange": incoming.get("exchange") or "NSE",
                    "notes": "Short entry created from unmatched sell import",
                },
                source="CSV",
                check_duplicates=False,
                force=True,
            )

    conn.execute(
        "UPDATE review_items SET status=?, resolved_at=?, resolution_note=? WHERE id=?",
        ("ACCEPTED" if decision == "accept" else "REJECTED", now_iso(), (note or "")[:1000], review_id),
    )
    result["review_id"] = review_id
    result["status"] = "ACCEPTED" if decision == "accept" else "REJECTED"
    return result


# ---------------------------------------------------------------------------
# execution log (dedupe source of truth for imported fills)
# ---------------------------------------------------------------------------

def execution_fingerprint(fill: dict[str, Any]) -> str:
    ref = fill.get("trade_ref") or fill.get("order_id")
    if ref:
        return "ref:" + hashlib.sha1(str(ref).encode()).hexdigest()
    raw = "|".join(
        [
            str(fill.get("symbol")),
            str(fill.get("side")),
            f"{float(fill.get('quantity') or 0):.4f}",
            f"{float(fill.get('price') or 0):.4f}",
            str(fill.get("exec_date")),
        ]
    )
    return "row:" + hashlib.sha1(raw.encode()).hexdigest()


def _execution_exists(conn: sqlite3.Connection, fp: str, fill: dict[str, Any]) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM executions WHERE fingerprint=?", (fp,)).fetchone()
    if row:
        return dict(row)
    # Semantic duplicate for ref-less exports (no order id / trade id). If either
    # side carries a broker reference, the references are authoritative: two
    # different order ids are two genuine fills, even at the same price.
    if fill.get("trade_ref") or fill.get("order_id"):
        return None
    rows = conn.execute(
        "SELECT * FROM executions WHERE symbol=? AND exec_date=? AND side=? AND quantity=? AND price=?",
        (fill["symbol"], fill["exec_date"], fill["side"], float(fill["quantity"]), float(fill["price"])),
    ).fetchall()
    for row in rows:
        if not row["trade_ref"] and not row["order_id"]:
            return dict(row)
    return None


def record_execution(conn: sqlite3.Connection, fill: dict[str, Any], trade_id: int | None, source: str) -> None:
    fp = execution_fingerprint(fill)
    conn.execute(
        """INSERT OR IGNORE INTO executions
           (trade_id, symbol, side, quantity, price, exec_date, trade_ref, order_id, exchange, source, fingerprint, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            trade_id,
            fill["symbol"],
            fill["side"],
            float(fill["quantity"]),
            float(fill["price"]),
            fill["exec_date"],
            fill.get("trade_ref"),
            fill.get("order_id"),
            fill.get("exchange"),
            source,
            fp,
            now_iso(),
        ),
    )


def _link_execution(conn: sqlite3.Connection, fp: str, trade_id: int) -> None:
    conn.execute("UPDATE executions SET trade_id=? WHERE fingerprint=?", (trade_id, fp))


# ---------------------------------------------------------------------------
# FIFO fill engine
# ---------------------------------------------------------------------------

def apply_fill(conn: sqlite3.Connection, fill: dict[str, Any], source: str = "CSV", settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """Import a single broker fill (BUY/SELL) using FIFO matching.

    Returns a result dict describing what happened so the importer can report
    per-row outcomes: created / closed / duplicate / review / ignored.
    """
    from .db import get_settings

    settings = settings or get_settings(conn)
    symbol = norm_symbol(fill.get("symbol"))
    side = (fill.get("side") or "").upper()
    qty = parse_num(fill.get("quantity"))
    price = parse_num(fill.get("price"))
    date = parse_date(fill.get("exec_date") or fill.get("date"))
    if not symbol or not side or not qty or qty <= 0 or price is None or price < 0 or not date:
        return {"action": "ignored", "reason": "incomplete row", "fill": fill}
    if side not in ("BUY", "SELL"):
        side = "BUY" if side in ("B", "LONG") else "SELL"

    norm = {
        "symbol": symbol,
        "side": side,
        "quantity": float(qty),
        "price": float(price),
        "exec_date": date,
        "trade_ref": (str(fill["trade_ref"]) if fill.get("trade_ref") else None),
        "order_id": (str(fill["order_id"]) if fill.get("order_id") else None),
        "exchange": fill.get("exchange"),
    }
    fp = execution_fingerprint(norm)
    existing = _execution_exists(conn, fp, norm)
    if existing:
        return {
            "action": "duplicate",
            "reason": "This fill was already imported",
            "trade_id": existing.get("trade_id"),
            "fill": norm,
        }

    exchange = (str(fill.get("exchange") or "NSE")).upper()
    fees = parse_num(fill.get("fees")) or 0.0

    if side == "BUY":
        res = create_trade(
            conn,
            {
                "symbol": symbol,
                "exchange": exchange,
                "side": "LONG",
                "entry_date": date,
                "entry_price": price,
                "quantity": qty,
                "fees": fees,
                "notes": "",
                "external_key": norm["order_id"] or norm["trade_ref"],
                "broker_ids": [x for x in (norm["order_id"], norm["trade_ref"]) if x],
            },
            source=source,
            settings=settings,
        )
        if res.get("created"):
            record_execution(conn, norm, res["trade_id"], source)
            return {"action": "opened", "trade_id": res["trade_id"], "fill": norm}
        if res.get("duplicate"):
            record_execution(conn, norm, res.get("trade_id"), source)
            return {"action": "duplicate", "reason": res.get("message"), "trade_id": res.get("trade_id"), "fill": norm}
        record_execution(conn, norm, None, source)
        return {"action": "review", "reason": res.get("message"), "review_id": res.get("review_id"), "fill": norm}

    # SELL: close oldest open long lots for this symbol (FIFO)
    lots = [
        t
        for t in all_trades(conn)
        if t["symbol"] == symbol and t["status"] == "OPEN" and t["side"] == "LONG"
    ]
    lots.sort(key=lambda t: (t["entry_date"], t["id"]))
    remaining = float(qty)
    closed: list[dict[str, Any]] = []
    for lot in lots:
        if remaining <= 1e-9:
            break
        take = min(remaining, float(lot["quantity"]))
        if take <= 1e-9:
            continue
        if take >= float(lot["quantity"]) - 1e-9:
            buyer_fees = float(lot.get("fees") or 0)
            share = buyer_fees
            close_trade(
                conn,
                lot["id"],
                exit_price=price,
                exit_date=date,
                fees=fees if (remaining - take) <= 1e-9 else 0,
            )
            conn.execute("UPDATE trades SET fees=? WHERE id=?", (round(share + (fees if (remaining - take) <= 1e-9 else 0), 2), lot["id"]))
            closed.append({"trade_id": lot["id"], "quantity": take})
        else:
            # partial close -> split the lot
            new_qty = float(lot["quantity"]) - take
            buy_fee_share = float(lot.get("fees") or 0) * (take / float(lot["quantity"]))
            conn.execute(
                "UPDATE trades SET quantity=?, fees=?, updated_at=? WHERE id=?",
                (new_qty, round(float(lot.get("fees") or 0) - buy_fee_share, 2), now_iso(), lot["id"]),
            )
            split = {
                "symbol": symbol,
                "exchange": lot["exchange"],
                "side": "LONG",
                "entry_date": lot["entry_date"],
                "entry_price": lot["entry_price"],
                "quantity": take,
                "exit_date": date,
                "exit_price": price,
                "fees": round(buy_fee_share + (fees if (remaining - take) <= 1e-9 else 0), 2),
                "notes": lot.get("notes") or "",
                "strategy": lot.get("strategy") or "",
                "tags": lot.get("tags") or "",
                "external_key": None,
                "broker_ids": [],
            }
            res = create_trade(conn, split, source=source, check_duplicates=False, force=True)
            closed.append({"trade_id": res.get("trade_id"), "quantity": take})
        remaining -= take

    record_execution(conn, norm, closed[0]["trade_id"] if closed else None, source)
    if remaining > 1e-9:
        item = add_review(
            conn,
            kind="SELL_WITHOUT_BUY",
            title=f"Unmatched sell: {symbol} × {remaining:g} on {date}",
            detail=(
                f"Sold {remaining:g} shares @ ₹{price:g} but no open buy lot was found. "
                "Approve to record it as a SHORT entry, reject to ignore this sell."
            ),
            payload={
                "incoming": {**norm, "quantity": remaining, "price": price, "exec_date": date},
                "action": "create_short",
                "reject_action": "ignore",
            },
        )
        return {
            "action": "review" if not closed else "partial_review",
            "review_id": item["id"],
            "closed": closed,
            "remaining": remaining,
            "fill": norm,
        }
    return {"action": "closed", "closed": closed, "fill": norm}
