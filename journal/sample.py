"""Deterministic sample data so the dashboard is explorable before real trades."""
from __future__ import annotations

import datetime as dt
import random

from .db import get_settings, save_settings
from .utils import today_iso
from .trades import create_trade

SYMBOLS = [
    ("RELIANCE", 2400, 2950),
    ("TCS", 3400, 4100),
    ("INFY", 1400, 1750),
    ("HDFCBANK", 1450, 1780),
    ("SBIN", 620, 860),
    ("TATAMOTORS", 780, 1080),
    ("ITC", 400, 470),
    ("LT", 2900, 3800),
    ("AXISBANK", 950, 1240),
    ("BAJFINANCE", 6200, 7400),
    ("MARUTI", 10500, 12900),
    ("SUNPHARMA", 1150, 1520),
    ("ADANIENT", 2400, 3200),
    ("WIPRO", 420, 560),
    ("HINDUNILVR", 2350, 2700),
]
STRATEGIES = ["Breakout", "Pullback", "VCP", "Gap & Go", "Trend follow", "Swing"]
TAGS = ["A+ setup", "earnings", "momentum", "reversal", "sector play", "mistake"]
NOTES = [
    "Entered on volume expansion above the pivot.",
    "Waited for the retest of the breakout level, tight stop.",
    "Slightly early entry; position size kept small.",
    "Trailed the stop under the 20 EMA.",
    "Booked partial at 1R, rode the rest.",
    "Choppy market, kept this one small.",
    "Earnings gap held, added on the second day.",
    "Followed the plan and exited on the close below VWAP.",
]


def generate_sample(conn, force: bool = False) -> dict:
    settings = get_settings(conn)
    existing = conn.execute("SELECT COUNT(*) AS n FROM trades").fetchone()["n"]
    if existing and not force:
        return {"loaded": False, "message": f"{existing} trades already exist"}

    rng = random.Random(11)
    today = dt.date.fromisoformat(today_iso())
    created = 0
    start = today - dt.timedelta(days=540)

    for _ in range(72):
        symbol, lo, hi = rng.choice(SYMBOLS)
        entry_day = start + dt.timedelta(days=rng.randint(0, 500))
        if entry_day > today - dt.timedelta(days=2):
            entry_day = today - dt.timedelta(days=rng.randint(2, 20))
        entry = round(rng.uniform(lo, hi), 2)
        qty = rng.choice([5, 10, 15, 20, 25, 30, 40, 50, 75, 100])
        hold = rng.choice([0, 1, 2, 2, 3, 3, 4, 5, 7, 9, 12, 15, 21])
        exit_day = entry_day + dt.timedelta(days=hold)
        if exit_day > today:
            exit_day = today
        is_win = rng.random() < 0.56
        move = rng.uniform(0.012, 0.085) if is_win else -rng.uniform(0.008, 0.045)
        exit_price = round(entry * (1 + move), 2)
        if exit_day == today and rng.random() < 0.55:
            continue  # leave a bunch of trades open
        stop = round(entry * (1 - rng.uniform(0.015, 0.035)), 2)
        fees = round(entry * qty * 0.0004 + rng.uniform(2, 18), 2)
        payload = {
            "symbol": symbol,
            "exchange": "NSE",
            "side": "LONG",
            "entry_date": entry_day.isoformat(),
            "entry_price": entry,
            "quantity": qty,
            "exit_date": exit_day.isoformat() if exit_day else None,
            "exit_price": exit_price,
            "stop_loss": stop,
            "target": round(entry * (1 + rng.uniform(0.05, 0.12)), 2),
            "fees": fees,
            "notes": rng.choice(NOTES),
            "strategy": rng.choice(STRATEGIES),
            "tags": rng.choice(TAGS),
            "rating": rng.randint(2, 5),
        }
        create_trade(conn, payload, source="SAMPLE", check_duplicates=False, force=True, settings=settings)
        created += 1

    # a few open positions that look like they came from Zerodha
    for symbol, lo, hi, qty in [("RELIANCE", 2700, 2900, 25), ("INFY", 1500, 1680, 40), ("SBIN", 720, 810, 100), ("TATAMOTORS", 900, 1020, 50), ("ITC", 430, 460, 200)]:
        entry_day = today - dt.timedelta(days=rng.randint(1, 25))
        entry = round(rng.uniform(lo, hi), 2)
        create_trade(
            conn,
            {
                "symbol": symbol,
                "entry_date": entry_day.isoformat(),
                "entry_price": entry,
                "quantity": qty,
                "stop_loss": round(entry * 0.96, 2),
                "notes": "Open swing position",
                "strategy": rng.choice(STRATEGIES),
                "tags": "open,swing",
                "ltp": round(entry * rng.uniform(0.97, 1.06), 2),
                "source": "SAMPLE",
            },
            source="SAMPLE",
            check_duplicates=False,
            force=True,
            settings=settings,
        )
        created += 1

    if not existing and not float(settings.get("account_balance") or 0):
        conn.execute(
            "INSERT INTO cash_ledger(date, kind, amount, note, created_at) VALUES(?,?,?,?,?)",
            (today.isoformat(), "DEPOSIT", 200000.0, "Sample starting capital", today.isoformat()),
        )
        save_settings(conn, {"account_balance": 200000.0})
    return {"loaded": True, "created": created}
