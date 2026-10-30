"""Zerodha Kite Connect integration + broker reconciliation.

Auth flow (standard Kite Connect):
    1. PUT api_key / api_secret in the Broker tab
    2. open https://kite.zerodha.com/connect/login?api_key=...&v=3
    3. after login Zerodha redirects to your app's redirect URL with
       ?request_token=...  -> paste it in the Broker tab
    4. we exchange it for an access_token (valid till ~6 AM next day)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from typing import Any, Iterable
from urllib.parse import urlencode

import requests

from .db import get_settings, log_sync, now_iso, save_settings
from .trades import (
    add_review,
    all_trades,
    apply_fill,
    create_trade,
    find_matches,
    get_trade,
    update_trade,
)
from .utils import chunked, norm_symbol, parse_num

BASE = "https://api.kite.trade"
LOGIN = "https://kite.zerodha.com/connect/login"


class KiteError(RuntimeError):
    pass


class KiteClient:
    def __init__(self, api_key: str, access_token: str, timeout: int = 25):
        if not api_key or not access_token:
            raise KiteError("Connect Zerodha first: API key and access token are required.")
        self.api_key = api_key.strip()
        self.access_token = access_token.strip()
        self.timeout = timeout

    # -- low level ---------------------------------------------------------
    def _headers(self) -> dict[str, str]:
        return {
            "X-Kite-Version": "3",
            "Authorization": f"token {self.api_key}:{self.access_token}",
        }

    def request(self, method: str, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{BASE}{path}"
        try:
            if method.upper() == "GET":
                r = requests.get(url, headers=self._headers(), params=params or {}, timeout=self.timeout)
            else:
                r = requests.post(url, headers=self._headers(), data=params or {}, timeout=self.timeout)
        except requests.RequestException as exc:
            raise KiteError(f"Network error talking to Zerodha: {exc}") from exc
        try:
            payload = r.json()
        except ValueError:
            raise KiteError(f"Unexpected response from Zerodha (HTTP {r.status_code})")
        if r.status_code >= 400 or payload.get("status") == "error":
            msg = payload.get("message") or payload.get("error_type") or f"HTTP {r.status_code}"
            if r.status_code == 403:
                msg = "Access token expired or invalid. Generate a new one in the Broker tab."
            raise KiteError(msg)
        return payload.get("data")

    # -- endpoints ---------------------------------------------------------
    def profile(self) -> dict[str, Any]:
        return self.request("GET", "/user/profile") or {}

    def holdings(self) -> list[dict[str, Any]]:
        return self.request("GET", "/portfolio/holdings") or []

    def positions(self) -> dict[str, Any]:
        return self.request("GET", "/portfolio/positions") or {}

    def orders(self) -> list[dict[str, Any]]:
        return self.request("GET", "/orders") or []

    def trades(self) -> list[dict[str, Any]]:
        return self.request("GET", "/trades") or []

    def ltp(self, instruments: list[str]) -> dict[str, float]:
        """instruments = ['NSE:INFY', 'NFO:NIFTY24APR24000CE']"""
        out: dict[str, float] = {}
        for batch in chunked(instruments, 300):
            params: list[tuple[str, str]] = [("i", i) for i in batch]
            # repeated `i` params; requests accepts a list of tuples
            url = f"{BASE}/quote/ltp"
            try:
                r = requests.get(
                    url,
                    headers=self._headers(),
                    params=params,
                    timeout=self.timeout,
                )
                payload = r.json()
            except (requests.RequestException, ValueError) as exc:
                raise KiteError(f"Quote fetch failed: {exc}") from exc
            if r.status_code >= 400 or payload.get("status") == "error":
                raise KiteError(payload.get("message") or f"Quote fetch failed (HTTP {r.status_code})")
            for key, val in (payload.get("data") or {}).items():
                lp = parse_num(val.get("last_price")) if isinstance(val, dict) else None
                if lp is not None:
                    out[key] = lp
        return out


# ---------------------------------------------------------------------------
# auth helpers
# ---------------------------------------------------------------------------

def login_url(api_key: str) -> str:
    return f"{LOGIN}?{urlencode({'api_key': api_key, 'v': 3})}"


def generate_session(api_key: str, api_secret: str, request_token: str) -> dict[str, Any]:
    checksum = hashlib.sha256((api_key + request_token + api_secret).encode()).hexdigest()
    try:
        r = requests.post(
            f"{BASE}/session/token",
            data={"api_key": api_key, "request_token": request_token, "checksum": checksum},
            headers={"X-Kite-Version": "3"},
            timeout=25,
        )
        payload = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise KiteError(f"Could not reach Zerodha: {exc}") from exc
    if r.status_code >= 400 or payload.get("status") == "error":
        raise KiteError(payload.get("message") or "Token exchange failed. The request token may have expired.")
    return payload.get("data") or {}


def client_from_settings(settings: dict[str, Any]) -> KiteClient:
    broker = (settings.get("broker") or {}) if settings else {}
    return KiteClient(broker.get("api_key", ""), broker.get("access_token", ""))


# ---------------------------------------------------------------------------
# reconciliation helpers
# ---------------------------------------------------------------------------

def _single_open_lot(trades: list[dict[str, Any]], symbol: str, side: str = "LONG") -> tuple[dict[str, Any] | None, int]:
    lots = [t for t in trades if t["symbol"] == symbol and t["status"] == "OPEN" and t["side"] == side]
    if len(lots) == 1:
        return lots[0], 1
    return (None, len(lots))


def _close_enough(a: float, b: float, tol_pct: float = 0.5) -> bool:
    return abs(a - b) <= max(0.05, max(abs(a), abs(b)) * tol_pct / 100)


def _upsert_holding(conn: sqlite3.Connection, symbol: str, exchange: str, product: str, qty: float, avg: float, last: float, pnl: float, source: str = "ZERODHA") -> None:
    conn.execute(
        """INSERT INTO holdings(symbol, exchange, product, quantity, avg_price, last_price, pnl, source, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(symbol, exchange, product, source)
           DO UPDATE SET quantity=excluded.quantity, avg_price=excluded.avg_price,
                         last_price=excluded.last_price, pnl=excluded.pnl, updated_at=excluded.updated_at""",
        (symbol, exchange, product, qty, avg, last, pnl, source, now_iso()),
    )


def _attach_broker_ref(conn: sqlite3.Connection, trade: dict[str, Any], ref: str) -> None:
    try:
        refs = json.loads(trade.get("broker_ids") or "[]")
    except (json.JSONDecodeError, TypeError):
        refs = []
    if ref not in refs:
        refs.append(ref)
        conn.execute("UPDATE trades SET broker_ids=?, updated_at=? WHERE id=?", (json.dumps(refs), now_iso(), trade["id"]))


def reconcile_holding(conn: sqlite3.Connection, h: dict[str, Any], settings: dict[str, Any], summary: dict[str, Any]) -> None:
    symbol = norm_symbol(h.get("tradingsymbol"))
    if not symbol:
        return
    exchange = (h.get("exchange") or "NSE").upper()
    qty = (parse_num(h.get("quantity")) or 0) + (parse_num(h.get("t1_quantity")) or 0)
    avg = parse_num(h.get("average_price")) or 0.0
    last = parse_num(h.get("last_price")) or 0.0
    pnl = parse_num(h.get("pnl")) or 0.0
    product = h.get("product") or "CNC"
    if qty <= 0:
        return

    _upsert_holding(conn, symbol, exchange, product, qty, avg, last, pnl)

    trades = all_trades(conn)
    lot, lot_count = _single_open_lot(trades, symbol, "LONG")
    ref = f"holding:{symbol}:{h.get('isin') or exchange}"

    if lot_count > 1:
        summary["notes"].append(f"{symbol}: {lot_count} open journal lots - left untouched (merge them manually for exact sync)")
        return
    if lot is None:
        if not settings.get("auto_create_new_from_broker", True):
            summary["notes"].append(f"{symbol}: holding not in journal (auto-create disabled)")
            return
        res = create_trade(
            conn,
            {
                "symbol": symbol,
                "exchange": exchange,
                "side": "LONG",
                "entry_date": dt.date.today().isoformat(),
                "entry_price": avg,
                "quantity": qty,
                "notes": "Imported from Zerodha holdings",
                "external_key": ref,
                "broker_ids": [ref, f"isin:{h.get('isin')}"] if h.get("isin") else [ref],
                "ltp": last,
            },
            source="ZERODHA",
            check_duplicates=False,
            force=True,
            settings=settings,
        )
        summary["added"].append({"symbol": symbol, "quantity": qty, "entry_price": avg, "trade_id": res.get("trade_id"), "kind": "holding"})
        return

    _attach_broker_ref(conn, lot, ref)
    conn.execute("UPDATE trades SET ltp=?, ltp_at=? WHERE id=?", (last, now_iso(), lot["id"]))
    tol = float(settings.get("duplicate_price_tolerance_pct", 1.0))

    if abs(float(lot["quantity"]) - qty) < 1e-6 and _close_enough(float(lot["entry_price"]), avg, tol):
        summary["matched"] += 1
        return

    if abs(float(lot["quantity"]) - qty) < 1e-6:
        item = add_review(
            conn,
            kind="PRICE_MISMATCH",
            title=f"{symbol}: broker avg ₹{avg:g} vs journal ₹{lot['entry_price']:g}",
            detail=(
                f"Zerodha holdings show {qty:g} @ ₹{avg:g} but your open trade #{lot['id']} has entry ₹{lot['entry_price']:g}. "
                "Approve to use Zerodha's average price, reject to keep the journal value."
            ),
            payload={
                "trade_id": lot["id"],
                "incoming": {"entry_price": avg, "quantity": qty, "symbol": symbol},
                "broker": "holding",
                "action": "update_entry_price",
            },
        )
        summary["review"].append({"symbol": symbol, "kind": "PRICE_MISMATCH", "review_id": item["id"]})
        return

    item = add_review(
        conn,
        kind="QTY_MISMATCH",
        title=f"{symbol}: broker qty {qty:g} vs journal {lot['quantity']:g}",
        detail=(
            f"Zerodha shows {qty:g} shares but open trade #{lot['id']} has {lot['quantity']:g}. "
            "Approve to update the journal quantity to the broker quantity, reject to keep it."
        ),
        payload={
            "trade_id": lot["id"],
            "incoming": {"entry_price": avg, "quantity": qty, "symbol": symbol},
            "broker": "holding",
            "action": "update_quantity",
        },
    )
    summary["review"].append({"symbol": symbol, "kind": "QTY_MISMATCH", "review_id": item["id"]})


def reconcile_position(conn: sqlite3.Connection, p: dict[str, Any], settings: dict[str, Any], summary: dict[str, Any], today: str) -> None:
    symbol = norm_symbol(p.get("tradingsymbol"))
    if not symbol:
        return
    qty = parse_num(p.get("quantity")) or 0
    buy_qty = parse_num(p.get("buy_quantity")) or 0
    sell_qty = parse_num(p.get("sell_quantity")) or 0
    exchange = (p.get("exchange") or "NFO").upper()
    product = p.get("product") or "NRML"
    last = parse_num(p.get("last_price")) or 0.0
    pnl = parse_num(p.get("pnl")) or 0.0

    # a fully squared-off position for the day -> record the realised round trip
    if abs(qty) < 1e-9 and buy_qty > 0 and sell_qty > 0:
        ref = f"posclosed:{today}:{symbol}:{product}"
        exists = conn.execute("SELECT id FROM trades WHERE external_key=? OR broker_ids LIKE ?", (ref, f"%{ref}%")).fetchone()
        if not exists:
            bp = parse_num(p.get("buy_price")) or 0.0
            sp = parse_num(p.get("sell_price")) or 0.0
            q = min(buy_qty, sell_qty)
            if bp and sp and q:
                res = create_trade(
                    conn,
                    {
                        "symbol": symbol,
                        "exchange": exchange,
                        "entry_date": today,
                        "exit_date": today,
                        "entry_price": bp,
                        "exit_price": sp,
                        "quantity": q,
                        "notes": f"Closed {product} position from Zerodha",
                        "external_key": ref,
                        "broker_ids": [ref],
                    },
                    source="ZERODHA",
                    check_duplicates=True,
                    settings=settings,
                )
                if res.get("created"):
                    summary["added"].append({"symbol": symbol, "trade_id": res.get("trade_id"), "kind": "closed-position"})
                elif res.get("review"):
                    summary["review"].append({"symbol": symbol, "kind": "DUPLICATE", "review_id": res.get("review_id")})
        return

    if abs(qty) < 1e-9:
        return
    side = "LONG" if qty > 0 else "SHORT"
    avg = parse_num(p.get("average_price")) or 0.0
    qty_abs = abs(qty)
    ref = f"position:{symbol}:{product}:{side}"

    _upsert_holding(conn, symbol, exchange, product, qty_abs, avg, last, pnl, source=f"ZERODHA-{product}")
    trades = all_trades(conn)
    lot, lot_count = _single_open_lot(trades, symbol, side)
    if lot_count > 1:
        summary["notes"].append(f"{symbol}: {lot_count} open {side} lots - left untouched")
        return
    if lot is None:
        if not settings.get("auto_create_new_from_broker", True):
            summary["notes"].append(f"{symbol}: position not in journal (auto-create disabled)")
            return
        res = create_trade(
            conn,
            {
                "symbol": symbol,
                "exchange": exchange,
                "side": side,
                "entry_date": today,
                "entry_price": avg,
                "quantity": qty_abs,
                "notes": f"Imported from Zerodha {product} position",
                "external_key": ref,
                "broker_ids": [ref],
                "ltp": last,
            },
            source="ZERODHA",
            check_duplicates=False,
            force=True,
            settings=settings,
        )
        summary["added"].append({"symbol": symbol, "quantity": qty_abs, "entry_price": avg, "trade_id": res.get("trade_id"), "kind": "position"})
        return

    _attach_broker_ref(conn, lot, ref)
    conn.execute("UPDATE trades SET ltp=?, ltp_at=? WHERE id=?", (last, now_iso(), lot["id"]))
    tol = float(settings.get("duplicate_price_tolerance_pct", 1.0))
    if abs(float(lot["quantity"]) - qty_abs) < 1e-6 and _close_enough(float(lot["entry_price"]), avg, tol):
        summary["matched"] += 1
        return
    item = add_review(
        conn,
        kind="PRICE_MISMATCH" if abs(float(lot["quantity"]) - qty_abs) < 1e-6 else "QTY_MISMATCH",
        title=f"{symbol}: Zerodha position differs from journal",
        detail=(
            f"Zerodha {product} position: {qty_abs:g} @ ₹{avg:g}. Journal trade #{lot['id']}: "
            f"{lot['quantity']:g} @ ₹{lot['entry_price']:g}. Approve to copy the broker values, reject to keep yours."
        ),
        payload={
            "trade_id": lot["id"],
            "incoming": {"entry_price": avg, "quantity": qty_abs, "symbol": symbol},
            "broker": product,
            "action": "update_position",
        },
    )
    summary["review"].append(
        {
            "symbol": symbol,
            "kind": "PRICE_MISMATCH" if abs(float(lot["quantity"]) - qty_abs) < 1e-6 else "QTY_MISMATCH",
            "review_id": item["id"],
        }
    )


def sync_orders(conn: sqlite3.Connection, client: KiteClient, settings: dict[str, Any], summary: dict[str, Any], date_filter: str | None = None) -> None:
    orders = client.orders()
    for o in orders:
        if (o.get("status") or "").upper() != "COMPLETE":
            continue
        filled = parse_num(o.get("filled_quantity")) or 0
        price = parse_num(o.get("average_price")) or 0
        if filled <= 0 or price <= 0:
            continue
        ts = str(o.get("order_timestamp") or "")[:10]
        if date_filter and ts != date_filter:
            continue
        fill = {
            "symbol": norm_symbol(o.get("tradingsymbol")),
            "side": "BUY" if (o.get("transaction_type") or "").upper() == "BUY" else "SELL",
            "quantity": filled,
            "price": price,
            "exec_date": ts or dt.date.today().isoformat(),
            "order_id": o.get("order_id"),
            "trade_ref": o.get("exchange_order_id"),
            "exchange": o.get("exchange"),
        }
        res = apply_fill(conn, fill, source="ZERODHA", settings=settings)
        action = res.get("action")
        if action == "opened":
            summary["added"].append({"symbol": fill["symbol"], "side": fill["side"], "quantity": filled, "entry_price": price, "trade_id": res.get("trade_id"), "kind": "order"})
        elif action == "closed":
            summary["closed"] += 1
        elif action == "partial_review":
            summary["closed"] += 1
            summary["review"].append({"symbol": fill["symbol"], "kind": "SELL_WITHOUT_BUY", "review_id": res.get("review_id")})
        elif action == "review":
            summary["review"].append({"symbol": fill["symbol"], "kind": "DUPLICATE", "review_id": res.get("review_id")})
        elif action == "duplicate":
            summary["skipped"] += 1


def refresh_ltp(conn: sqlite3.Connection, client: KiteClient) -> dict[str, Any]:
    open_trades = [t for t in all_trades(conn) if t["status"] == "OPEN"]
    if not open_trades:
        return {"updated": 0, "errors": []}
    instruments = []
    mapping: dict[str, list[dict[str, Any]]] = {}
    for t in open_trades:
        inst = f"{t.get('exchange') or 'NSE'}:{t['symbol']}"
        instruments.append(inst)
        mapping.setdefault(inst, []).append(t)
    quotes = client.ltp(instruments)
    updated = 0
    for inst, trades in mapping.items():
        price = quotes.get(inst)
        if price is None:
            continue
        for t in trades:
            conn.execute("UPDATE trades SET ltp=?, ltp_at=? WHERE id=?", (price, now_iso(), t["id"]))
            updated += 1
    return {"updated": updated, "errors": []}


def sync_all(conn: sqlite3.Connection, mode: str = "all") -> dict[str, Any]:
    settings = get_settings(conn)
    client = client_from_settings(settings)
    summary: dict[str, Any] = {
        "started_at": now_iso(),
        "mode": mode,
        "added": [],
        "closed": 0,
        "matched": 0,
        "skipped": 0,
        "review": [],
        "notes": [],
        "errors": [],
        "holdings": 0,
        "positions": 0,
        "ltp_updated": 0,
    }
    today = dt.date.today().isoformat()

    if mode in ("all", "orders"):
        try:
            sync_orders(conn, client, settings, summary)
        except KiteError as exc:
            summary["errors"].append(f"orders: {exc}")

    if mode in ("all", "holdings"):
        try:
            holdings = client.holdings()
            summary["holdings"] = len(holdings)
            conn.execute("DELETE FROM holdings WHERE source='ZERODHA'")
            for h in holdings:
                reconcile_holding(conn, h, settings, summary)
        except KiteError as exc:
            summary["errors"].append(f"holdings: {exc}")

    if mode in ("all", "positions"):
        try:
            positions = client.positions()
            net = positions.get("net") or []
            summary["positions"] = len(net)
            for p in net:
                reconcile_position(conn, p, settings, summary, today)
        except KiteError as exc:
            summary["errors"].append(f"positions: {exc}")

    if mode in ("all", "ltp"):
        try:
            ltp = refresh_ltp(conn, client)
            summary["ltp_updated"] = ltp.get("updated", 0)
        except KiteError as exc:
            summary["errors"].append(f"ltp: {exc}")

    # persist sync meta
    broker = dict(settings.get("broker") or {})
    broker["last_sync"] = now_iso()
    broker["last_sync_summary"] = json.dumps(summary, default=str)[:4000]
    save_settings(conn, {"broker": broker})
    log_sync(conn, "zerodha", "ok" if not summary["errors"] else "partial", summary)
    return summary
