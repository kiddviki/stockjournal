#!/usr/bin/env python3
"""Stock Journal — a local-first trading journal with CSV import + Zerodha sync.

Run:  python app.py            (opens http://127.0.0.1:8765 in your browser)
      python app.py --port 9000 --no-browser
"""
from __future__ import annotations

import argparse
import csv
import io
import ipaddress
import json
import mimetypes
import os
import socket
import sqlite3
import sys
import uuid
import webbrowser
from pathlib import Path
from typing import Any

from flask import Flask, Response, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from journal import analytics
from journal.db import (
    ATTACH_DIR,
    BACKUP_DIR,
    DATA_DIR,
    DB_PATH,
    ROOT_DIR,
    backup_file,
    connect,
    delete_attachment,
    ensure_dirs,
    export_snapshot,
    get_settings,
    import_snapshot,
    init_db,
    log_sync,
    now_iso,
    reset_data,
    save_settings,
    storage_info,
)
from journal.importer import import_parsed, parse_csv, parse_xlsx
from journal.kite import (
    KiteError,
    client_from_settings,
    generate_session,
    login_url,
    sync_all,
)
from journal.trades import (
    PHOTO_URL,
    ValidationError,
    all_trades,
    close_trade,
    create_trade,
    delete_trade,
    get_trade,
    list_reviews,
    query_trades,
    reopen_trade,
    resolve_review,
    review_count,
    update_trade,
)
from journal.utils import month_bounds, norm_symbol, parse_date, parse_num, resolve_range, safe_div, today_iso

APP_VERSION = "1.0.0"
MAX_UPLOAD = 30 * 1024 * 1024  # 30 MB
ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def static_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "static"  # type: ignore[attr-defined]
    return ROOT_DIR / "static"


app = Flask(__name__, static_folder=str(static_dir()), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD
app.json.sort_keys = False


# ---------------------------------------------------------------------------
# db per request
# ---------------------------------------------------------------------------

def db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def _close_db(exc: BaseException | None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.errorhandler(ValidationError)
def _validation_error(exc: ValidationError):
    return jsonify({"ok": False, "error": str(exc)}), 400


@app.errorhandler(KiteError)
def _kite_error(exc: KiteError):
    return jsonify({"ok": False, "error": str(exc)}), 502


@app.errorhandler(RequestEntityTooLarge)
def _too_large(exc):
    return jsonify({"ok": False, "error": "File is too large (max 30 MB)."}), 413


@app.errorhandler(HTTPException)
def _http_error(exc: HTTPException):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": exc.description}), exc.code
    return exc


@app.errorhandler(Exception)
def _unexpected(exc: Exception):
    app.logger.exception("Unhandled error")
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    raise exc


@app.after_request
def _no_cache(resp: Response) -> Response:
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def ok(payload: dict[str, Any] | None = None, **kwargs):
    body = {"ok": True}
    if payload:
        body.update(payload)
    body.update(kwargs)
    return jsonify(body)


def body_json() -> dict[str, Any]:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _account_balance(conn) -> float:
    settings = get_settings(conn)
    return float(parse_num(settings.get("account_balance")) or 0.0)


def _holdings_summary(conn) -> dict[str, Any]:
    rows = [
        {
            "symbol": r["symbol"],
            "exchange": r["exchange"],
            "product": r["product"],
            "quantity": r["quantity"],
            "avg_price": r["avg_price"],
            "last_price": r["last_price"],
            "pnl": r["pnl"],
            "source": r["source"],
            "updated_at": r["updated_at"],
        }
        for r in conn.execute("SELECT * FROM holdings ORDER BY symbol")
        if (r["quantity"] or 0) > 0
    ]
    broker_worth = round(sum((r["quantity"] or 0) * (r["last_price"] or 0) for r in rows), 2)
    broker_invested = round(sum((r["quantity"] or 0) * (r["avg_price"] or 0) for r in rows), 2)

    open_trades = [t for t in all_trades(conn) if t["status"] == "OPEN"]
    journal_worth = round(
        sum((t.get("ltp") or t["entry_price"]) * t["quantity"] for t in open_trades), 2
    )
    journal_invested = round(sum(t["entry_price"] * t["quantity"] for t in open_trades), 2)

    using_broker = bool(rows)
    worth = broker_worth if using_broker else journal_worth
    invested = broker_invested if using_broker else journal_invested
    balance = _account_balance(conn)
    return {
        "rows": rows,
        "broker_worth": broker_worth,
        "broker_invested": broker_invested,
        "journal_worth": journal_worth,
        "journal_invested": journal_invested,
        "worth": worth,
        "invested": invested,
        "unrealised": round(worth - invested, 2),
        "unrealised_pct": round(safe_div(worth - invested, invested, 0.0) * 100, 2),
        "balance": balance,
        "account_value": round(balance + worth, 2),
        "open_trades": len(open_trades),
        "source": "Zerodha" if using_broker else "Journal",
    }


def _parse_upload():
    file = request.files.get("file")
    if not file or not file.filename:
        raise ValidationError("Choose a CSV/XLSX file to import")
    raw = file.read()
    if not raw:
        raise ValidationError("The uploaded file is empty")
    name = file.filename
    if name.lower().endswith((".xlsx", ".xls")):
        parsed = parse_xlsx(raw)
    else:
        parsed = parse_csv(raw, name)
    if not parsed.get("ok"):
        raise ValidationError(parsed.get("error") or "Could not read that file")
    return name, parsed


# ---------------------------------------------------------------------------
# bootstrap / basic
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    return ok({"version": APP_VERSION, "time": now_iso(), "data_dir": str(DATA_DIR)})


@app.get("/api/bootstrap")
def bootstrap():
    conn = db()
    settings = get_settings(conn, mask_secrets=True)
    broker = settings.get("broker") or {}
    try:
        last_summary = json.loads(broker.get("last_sync_summary") or "{}")
    except json.JSONDecodeError:
        last_summary = {}
    return ok(
        {
            "version": APP_VERSION,
            "settings": settings,
            "review_count": review_count(conn),
            "holdings": _holdings_summary(conn),
            "storage": storage_info(),
            "broker": {
                "connected": bool(broker.get("access_token")),
                "api_key": broker.get("api_key", ""),
                "user_id": broker.get("user_id", ""),
                "connected_at": broker.get("connected_at", ""),
                "last_sync": broker.get("last_sync", ""),
                "last_sync_summary": last_summary,
            },
            "today": today_iso(),
            "server_time": now_iso(),
        }
    )


# ---------------------------------------------------------------------------
# trades
# ---------------------------------------------------------------------------

@app.get("/api/trades")
def api_trades():
    conn = db()
    status = request.args.get("status")
    start, end = resolve_range(
        request.args.get("range") or "custom",
        request.args.get("start"),
        request.args.get("end"),
    )
    trades = query_trades(
        conn,
        status=status,
        start=start,
        end=end,
        search=request.args.get("search"),
        sort=request.args.get("sort"),
        symbol=request.args.get("symbol"),
        include_open=request.args.get("include_open", "1") != "0",
    )
    total = len(trades)
    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        offset = 0
    try:
        limit = int(request.args.get("limit", 0))
    except ValueError:
        limit = 0
    if limit > 0:
        trades = trades[offset : offset + limit]
    return ok({"trades": trades, "total": total, "offset": offset, "limit": limit})


@app.post("/api/trades")
def api_create_trade():
    conn = db()
    payload = body_json()
    res = create_trade(conn, payload, source=payload.get("source") or "MANUAL")
    status = 201 if res.get("created") else 200
    return jsonify({"ok": True, **res}), status


@app.get("/api/trades/<int:trade_id>")
def api_get_trade(trade_id: int):
    trade = get_trade(db(), trade_id)
    if not trade:
        return jsonify({"ok": False, "error": "Trade not found"}), 404
    return ok({"trade": trade})


@app.put("/api/trades/<int:trade_id>")
def api_update_trade(trade_id: int):
    trade = update_trade(db(), trade_id, body_json())
    return ok({"trade": trade})


@app.delete("/api/trades/<int:trade_id>")
def api_delete_trade(trade_id: int):
    delete_trade(db(), trade_id)
    return ok({"deleted": trade_id})


@app.post("/api/trades/<int:trade_id>/close")
def api_close_trade(trade_id: int):
    payload = body_json()
    trade = close_trade(
        db(),
        trade_id,
        payload.get("exit_price"),
        payload.get("exit_date"),
        payload.get("fees"),
        payload.get("notes"),
    )
    return ok({"trade": trade})


@app.post("/api/trades/<int:trade_id>/reopen")
def api_reopen_trade(trade_id: int):
    return ok({"trade": reopen_trade(db(), trade_id)})


@app.post("/api/trades/<int:trade_id>/photos")
def api_upload_photo(trade_id: int):
    conn = db()
    trade = get_trade(conn, trade_id)
    if not trade:
        return jsonify({"ok": False, "error": "Trade not found"}), 404
    files = request.files.getlist("files") or request.files.getlist("file")
    if not files:
        raise ValidationError("No image selected")
    saved = []
    for f in files:
        if not f or not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_IMAGE_EXT:
            raise ValidationError(f"Unsupported image type: {ext or f.filename}")
        name = f"{uuid.uuid4().hex}{ext}"
        (ATTACH_DIR / name).write_bytes(f.read())
        cur = conn.execute(
            "INSERT INTO trade_photos(trade_id, filename, caption, created_at) VALUES(?,?,?,?)",
            (trade_id, name, (request.form.get("caption") or "")[:300], now_iso()),
        )
        saved.append({"id": cur.lastrowid, "filename": name, "url": PHOTO_URL + name})
    return ok({"photos": saved, "trade": get_trade(conn, trade_id)})


@app.delete("/api/trades/<int:trade_id>/photos/<int:photo_id>")
def api_delete_photo(trade_id: int, photo_id: int):
    conn = db()
    row = conn.execute("SELECT * FROM trade_photos WHERE id=? AND trade_id=?", (photo_id, trade_id)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "Photo not found"}), 404
    delete_attachment(row["filename"])
    conn.execute("DELETE FROM trade_photos WHERE id=?", (photo_id,))
    return ok({"trade": get_trade(conn, trade_id)})


@app.get("/api/attachments/<path:filename>")
def api_attachment(filename: str):
    safe = Path(filename).name
    path = ATTACH_DIR / safe
    if not path.exists() or path.suffix.lower() not in ALLOWED_IMAGE_EXT:
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_from_directory(ATTACH_DIR, safe, mimetype=mimetypes.guess_type(safe)[0] or "application/octet-stream")


# ---------------------------------------------------------------------------
# dashboard / stats / calendar
# ---------------------------------------------------------------------------

@app.get("/api/dashboard")
def api_dashboard():
    conn = db()
    settings = get_settings(conn)
    start, end = resolve_range(request.args.get("range") or settings.get("dashboard_range") or "3m")
    trades = all_trades(conn)
    status = request.args.get("status") or "all"
    sort = request.args.get("sort") or "date_desc"
    stats = analytics.compute_stats(trades, start, end, _account_balance(conn))

    filtered = query_trades(conn, status=status, start=start, end=end, sort=sort)
    symbol_bars = analytics.symbol_breakdown(trades, start, end)
    return ok(
        {
            "range": request.args.get("range") or settings.get("dashboard_range") or "3m",
            "start": start,
            "end": end,
            "status": status,
            "sort": sort,
            "trades": filtered,
            "stats": stats,
            "symbols": symbol_bars,
            "holdings": _holdings_summary(conn),
            "monthly": analytics.monthly_breakdown(trades, 12),
        }
    )


@app.get("/api/stats")
def api_stats():
    conn = db()
    settings = get_settings(conn)
    start, end = resolve_range(
        request.args.get("range") or settings.get("stats_range") or "1y",
        request.args.get("start"),
        request.args.get("end"),
    )
    trades = all_trades(conn)
    stats = analytics.compute_stats(trades, start, end, _account_balance(conn))
    return ok(
        {
            "start": start,
            "end": end,
            "stats": stats,
            "symbols": analytics.symbol_breakdown(trades, start, end),
            "monthly": analytics.monthly_breakdown(trades, 60),
            "weekday": analytics.weekday_breakdown(trades, start, end),
            "strategies": analytics.strategy_breakdown(trades, start, end),
            "r_distribution": analytics.r_distribution(trades, start, end),
        }
    )


@app.get("/api/calendar")
def api_calendar():
    conn = db()
    month = request.args.get("month") or today_iso()[:7]
    try:
        month_bounds(month)
    except ValueError:
        raise ValidationError("Month must look like 2025-04")
    data = analytics.calendar_month(all_trades(conn), month)
    data["holdings"] = _holdings_summary(conn)
    return ok({"calendar": data})


@app.get("/api/day")
def api_day():
    conn = db()
    day = parse_date(request.args.get("date")) or today_iso()
    return ok({"day": analytics.day_detail(all_trades(conn), day)})


# ---------------------------------------------------------------------------
# review queue
# ---------------------------------------------------------------------------

@app.get("/api/review")
def api_review():
    conn = db()
    status = request.args.get("status", "PENDING")
    return ok({"items": list_reviews(conn, status), "pending": review_count(conn)})


@app.post("/api/review/<int:review_id>/resolve")
def api_resolve_review(review_id: int):
    payload = body_json()
    result = resolve_review(db(), review_id, payload.get("decision", ""), payload.get("note"))
    return ok({"result": result, "pending": review_count(db())})


# ---------------------------------------------------------------------------
# import / export / backup
# ---------------------------------------------------------------------------

@app.post("/api/import/preview")
def api_import_preview():
    conn = db()
    name, parsed = _parse_upload()
    # simulate the import inside a transaction, then roll it back
    simulated: dict[str, Any]
    try:
        conn.execute("BEGIN")
        simulated = import_parsed(conn, parsed, get_settings(conn))
    except Exception as exc:
        simulated = {"error": f"{type(exc).__name__}: {exc}"}
    finally:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
    return ok(
        {
            "file": name,
            "kind": parsed.get("kind"),
            "delimiter": parsed.get("delimiter"),
            "header_row": parsed.get("header_row"),
            "mapping": parsed.get("mapping"),
            "row_count": parsed.get("row_count"),
            "skipped": parsed.get("skipped"),
            "problems": parsed.get("problems"),
            "preview": parsed.get("preview"),
            "columns": parsed.get("columns_detected"),
            "simulation": simulated,
        }
    )


@app.post("/api/import/commit")
def api_import_commit():
    conn = db()
    name, parsed = _parse_upload()
    summary = import_parsed(conn, parsed, get_settings(conn))
    log_sync(conn, "csv", "ok", {"file": name, **{k: v for k, v in summary.items() if k != "details"}})
    summary["review_pending"] = review_count(conn)
    return ok({"summary": summary, "file": name})


@app.get("/api/export/csv")
def api_export_csv():
    conn = db()
    trades = all_trades(conn)
    cols = [
        "id", "symbol", "exchange", "side", "status", "entry_date", "entry_price", "quantity",
        "exit_date", "exit_price", "stop_loss", "target", "fees", "hold_days", "pnl", "pnl_pct",
        "r_multiple", "strategy", "tags", "notes", "source", "created_at", "updated_at",
    ]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    for t in trades:
        writer.writerow({k: t.get(k) for k in cols})
    stamp = now_iso()[:10]
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="stock-journal-{stamp}.csv"'},
    )


@app.get("/api/backup")
def api_backup():
    conn = db()
    snapshot = export_snapshot(conn)
    path = backup_file(conn)
    payload = json.dumps(snapshot, indent=2, default=str)
    return Response(
        payload,
        mimetype="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{path.name}"',
            "X-Backup-Path": str(path),
        },
    )


@app.post("/api/restore")
def api_restore():
    file = request.files.get("file")
    if not file or not file.filename:
        raise ValidationError("Choose a JSON backup file")
    try:
        snapshot = json.loads(file.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValidationError("That file is not a valid JSON backup")
    if not isinstance(snapshot, dict) or "tables" not in snapshot:
        raise ValidationError("This does not look like a Stock Journal backup")
    counts = import_snapshot(db(), snapshot, replace=request.form.get("replace", "1") != "0")
    return ok({"restored": counts, "review_count": review_count(db())})


@app.post("/api/sample")
def api_sample():
    from journal.sample import generate_sample

    res = generate_sample(db(), force=body_json().get("force", False))
    return ok({"sample": res, "holdings": _holdings_summary(db())})


@app.post("/api/reset")
def api_reset():
    if body_json().get("confirm") != "RESET":
        raise ValidationError('Send {"confirm": "RESET"} to erase all journal data')
    reset_data(db())
    return ok({"reset": True})


# ---------------------------------------------------------------------------
# settings / cash / holdings
# ---------------------------------------------------------------------------

SETTINGS_ALLOWED = {
    "account_balance", "starting_balance", "currency", "theme", "dashboard_range", "stats_range",
    "dashboard_status", "dashboard_sort", "duplicate_price_tolerance_pct", "duplicate_date_window_days",
    "breakeven_pct", "auto_create_new_from_broker", "broker", "columns", "photo_columns",
    "stats_cards", "page_size",
}


@app.get("/api/settings")
def api_get_settings():
    return ok({"settings": get_settings(db(), mask_secrets=True)})


@app.put("/api/settings")
def api_put_settings():
    conn = db()
    payload = body_json()
    patch = {k: v for k, v in payload.items() if k in SETTINGS_ALLOWED}
    if not patch:
        raise ValidationError("No valid settings supplied")
    current = get_settings(conn)
    if "broker" in patch and isinstance(patch["broker"], dict):
        merged = dict(current.get("broker") or {})
        for key, val in patch["broker"].items():
            if key in ("api_secret", "access_token") and isinstance(val, str) and "••" in val:
                continue  # masked placeholder, keep stored secret
            merged[key] = val
        patch["broker"] = merged
    for key in ("columns", "stats_cards"):
        if key in patch and isinstance(patch[key], dict):
            merged = dict(current.get(key) or {})
            merged.update(patch[key])
            patch[key] = merged
    settings = save_settings(conn, patch)
    return ok({"settings": get_settings(conn, mask_secrets=True)})


@app.get("/api/cash")
def api_cash():
    conn = db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM cash_ledger ORDER BY date DESC, id DESC")]
    total_deposits = sum(r["amount"] for r in rows if r["kind"] == "DEPOSIT")
    total_withdrawals = sum(r["amount"] for r in rows if r["kind"] == "WITHDRAW")
    return ok(
        {
            "entries": rows,
            "deposits": round(total_deposits, 2),
            "withdrawals": round(total_withdrawals, 2),
            "balance": _account_balance(conn),
        }
    )


@app.post("/api/cash")
def api_add_cash():
    conn = db()
    payload = body_json()
    amount = parse_num(payload.get("amount"))
    kind = str(payload.get("kind") or "DEPOSIT").upper()
    if not amount or amount <= 0:
        raise ValidationError("Amount must be greater than zero")
    if kind not in ("DEPOSIT", "WITHDRAW", "ADJUST"):
        raise ValidationError("Kind must be DEPOSIT, WITHDRAW or ADJUST")
    date = parse_date(payload.get("date")) or today_iso()
    note = str(payload.get("note") or "")[:300]
    conn.execute(
        "INSERT INTO cash_ledger(date, kind, amount, note, created_at) VALUES(?,?,?,?,?)",
        (date, kind, round(amount, 2), note, now_iso()),
    )
    settings = get_settings(conn)
    balance = float(parse_num(settings.get("account_balance")) or 0.0)
    if kind == "WITHDRAW":
        balance -= amount
    else:
        balance += amount
    save_settings(conn, {"account_balance": round(balance, 2)})
    return ok({"balance": round(balance, 2)})


@app.delete("/api/cash/<int:entry_id>")
def api_delete_cash(entry_id: int):
    conn = db()
    row = conn.execute("SELECT * FROM cash_ledger WHERE id=?", (entry_id,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "Entry not found"}), 404
    delta = -row["amount"] if row["kind"] == "WITHDRAW" else row["amount"]
    conn.execute("DELETE FROM cash_ledger WHERE id=?", (entry_id,))
    settings = get_settings(conn)
    balance = float(parse_num(settings.get("account_balance")) or 0.0)
    save_settings(conn, {"account_balance": round(balance - delta, 2)})
    return ok({"balance": round(balance - delta, 2)})


@app.get("/api/holdings")
def api_holdings():
    conn = db()
    return ok({"holdings": _holdings_summary(conn)})


# ---------------------------------------------------------------------------
# broker
# ---------------------------------------------------------------------------

@app.get("/api/broker/status")
def api_broker_status():
    conn = db()
    broker = (get_settings(conn).get("broker") or {})
    try:
        last_summary = json.loads(broker.get("last_sync_summary") or "{}")
    except json.JSONDecodeError:
        last_summary = {}
    return ok(
        {
            "connected": bool(broker.get("access_token")),
            "api_key": broker.get("api_key", ""),
            "api_key_masked": (broker.get("api_key") or "")[:4] + "…" if broker.get("api_key") else "",
            "user_id": broker.get("user_id", ""),
            "connected_at": broker.get("connected_at", ""),
            "last_sync": broker.get("last_sync", ""),
            "last_sync_summary": last_summary,
            "login_url": login_url(broker.get("api_key") or "") if broker.get("api_key") else "",
        }
    )


@app.post("/api/broker/credentials")
def api_broker_credentials():
    conn = db()
    payload = body_json()
    api_key = str(payload.get("api_key") or "").strip()
    api_secret = str(payload.get("api_secret") or "").strip()
    if not api_key:
        raise ValidationError("API key is required")
    current = get_settings(conn).get("broker") or {}
    broker = dict(current)
    key_changed = api_key != current.get("api_key")
    broker["api_key"] = api_key
    if api_secret and "••" not in api_secret:
        broker["api_secret"] = api_secret
    if key_changed:
        broker["access_token"] = ""
        broker["connected_at"] = ""
        broker["user_id"] = ""
    save_settings(conn, {"broker": broker})
    return ok({"login_url": login_url(api_key), "connected": bool(broker.get("access_token"))})


@app.get("/api/broker/login-url")
def api_broker_login_url():
    conn = db()
    broker = get_settings(conn).get("broker") or {}
    if not broker.get("api_key"):
        raise ValidationError("Save your API key first")
    return ok({"login_url": login_url(broker["api_key"])})


@app.post("/api/broker/session")
def api_broker_session():
    conn = db()
    payload = body_json()
    request_token = str(payload.get("request_token") or "").strip()
    if not request_token:
        raise ValidationError("Paste the request_token from the Zerodha redirect URL")
    broker = dict(get_settings(conn).get("broker") or {})
    api_key = broker.get("api_key")
    api_secret = broker.get("api_secret")
    if not api_key or not api_secret:
        raise ValidationError("API key and API secret are required before connecting")
    data = generate_session(api_key, api_secret, request_token)
    broker["access_token"] = data.get("access_token", "")
    broker["user_id"] = data.get("user_id", "")
    broker["connected_at"] = now_iso()
    save_settings(conn, {"broker": broker})
    log_sync(conn, "zerodha-auth", "ok", {"user_id": broker["user_id"]})
    return ok({"connected": True, "user_id": broker["user_id"]})


@app.post("/api/broker/disconnect")
def api_broker_disconnect():
    conn = db()
    broker = dict(get_settings(conn).get("broker") or {})
    broker.update({"access_token": "", "connected_at": "", "user_id": ""})
    save_settings(conn, {"broker": broker})
    return ok({"connected": False})


@app.post("/api/broker/sync")
def api_broker_sync():
    conn = db()
    mode = body_json().get("mode") or "all"
    if mode not in ("all", "orders", "holdings", "positions", "ltp"):
        raise ValidationError("Unknown sync mode")
    summary = sync_all(conn, mode)
    summary["review_pending"] = review_count(conn)
    return ok({"summary": summary, "holdings": _holdings_summary(conn)})


@app.post("/api/broker/test")
def api_broker_test():
    conn = db()
    client = client_from_settings(get_settings(conn))
    profile = client.profile()
    return ok({"profile": {k: profile.get(k) for k in ("user_id", "user_name", "email", "broker")}})


# ---------------------------------------------------------------------------
# launcher
# ---------------------------------------------------------------------------

def _free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 40)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Stock Journal")
    parser.add_argument("--port", type=int, default=8765, help="preferred port (default 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (keep 127.0.0.1 for local use)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("--data-dir", help="folder for the journal database and screenshots")
    args = parser.parse_args()

    if args.data_dir:
        import journal.db as dbmod

        dbmod.DATA_DIR = Path(args.data_dir).expanduser().resolve()
        dbmod.ATTACH_DIR = dbmod.DATA_DIR / "attachments"
        dbmod.BACKUP_DIR = dbmod.DATA_DIR / "backups"
        dbmod.DB_PATH = dbmod.DATA_DIR / "journal.db"
        globals().update(
            {
                "DATA_DIR": dbmod.DATA_DIR,
                "ATTACH_DIR": dbmod.ATTACH_DIR,
                "BACKUP_DIR": dbmod.BACKUP_DIR,
                "DB_PATH": dbmod.DB_PATH,
            }
        )

    ensure_dirs()
    init_db()
    port = _free_port(args.port) if args.host in ("127.0.0.1", "localhost") else args.port
    url = f"http://{args.host}:{port}"
    print("=" * 64)
    print("  Stock Journal  —  local trading journal")
    print(f"  Open: {url}")
    print(f"  Data: {DATA_DIR}")
    print("  Press Ctrl+C to stop")
    print("=" * 64)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    app.run(host=args.host, port=port, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
