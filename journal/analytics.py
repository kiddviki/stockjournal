"""Statistics, equity curve, symbol breakdown and calendar aggregation."""
from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Any, Iterable

from .trades import in_range, row_to_trade, sort_trades
from .utils import month_bounds, parse_num, safe_div

OPEN_STATUSES = {"OPEN"}


def _closed(trades: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [t for t in trades if t["status"] != "OPEN"]


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def compute_stats(
    trades: list[dict[str, Any]],
    start: str | None = None,
    end: str | None = None,
    account_balance: float | None = None,
) -> dict[str, Any]:
    """Full stats block for a date range.

    Closed trades are filtered on exit date; open trades are never hidden so
    unrealised P&L stays visible (they are reported separately).
    """
    closed = _closed(trades)
    in_range_closed = [t for t in closed if in_range(t, start, end)]
    open_trades = [t for t in trades if t["status"] == "OPEN"]

    wins = [t for t in in_range_closed if (t.get("pnl") or 0) > 0]
    losses = [t for t in in_range_closed if (t.get("pnl") or 0) < 0]
    breakeven = [t for t in in_range_closed if (t.get("pnl") or 0) == 0]

    net_pnl = round(sum(t.get("pnl") or 0 for t in in_range_closed), 2)
    gross_profit = round(sum(t.get("pnl") or 0 for t in wins), 2)
    gross_loss = round(sum(t.get("pnl") or 0 for t in losses), 2)
    deployed = sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in in_range_closed)
    fees = round(sum(t.get("fees") or 0 for t in in_range_closed), 2)

    win_rate = safe_div(len(wins), len(wins) + len(losses), 0.0) * 100
    loss_rate = safe_div(len(losses), len(wins) + len(losses), 0.0) * 100
    decided = len(wins) + len(losses)
    win_rate = round(win_rate, 1) if decided else 0.0
    loss_rate = round(100 - win_rate, 1) if decided else 0.0

    avg_win = _mean([t["pnl"] for t in wins])
    avg_loss = _mean([t["pnl"] for t in losses])
    avg_win_pct = _mean([t["pnl_pct"] for t in wins if t.get("pnl_pct") is not None])
    avg_loss_pct = _mean([t["pnl_pct"] for t in losses if t.get("pnl_pct") is not None])

    largest_win = max(wins, key=lambda t: t["pnl"]) if wins else None
    largest_loss = min(losses, key=lambda t: t["pnl"]) if losses else None

    wins_hold = [t["hold_days"] for t in wins if t.get("hold_days") is not None]
    losses_hold = [t["hold_days"] for t in losses if t.get("hold_days") is not None]
    all_hold = [t["hold_days"] for t in in_range_closed if t.get("hold_days") is not None]

    profit_factor = round(safe_div(gross_profit, abs(gross_loss), 0.0), 2) if gross_loss else None
    expectancy = round((win_rate / 100) * (avg_win or 0) + (loss_rate / 100) * (avg_loss or 0), 2) if decided else 0.0

    r_values = [t["r_multiple"] for t in in_range_closed if t.get("r_multiple") is not None]
    total_r = round(sum(r_values), 2) if r_values else None
    avg_r = round(safe_div(sum(r_values), len(r_values), 0.0), 2) if r_values else None

    # equity curve (closed trades, chronological)
    ordered = sorted(
        in_range_closed,
        key=lambda t: (t.get("exit_date") or t.get("entry_date") or "", t["id"]),
    )
    curve: list[dict[str, Any]] = []
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    max_dd_pct = 0.0
    for t in ordered:
        cum += t.get("pnl") or 0
        peak = max(peak, cum)
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
            max_dd_pct = safe_div(dd, peak, 0.0) * 100 if peak > 0 else 0.0
        curve.append(
            {
                "date": t.get("exit_date") or t.get("entry_date"),
                "pnl": round(cum, 2),
                "trade_pnl": round(t.get("pnl") or 0, 2),
                "trade_id": t["id"],
                "symbol": t["symbol"],
            }
        )

    # collapse to one point per date (last value of the day)
    daily: dict[str, float] = {}
    for p in curve:
        daily[p["date"]] = p["pnl"]
    equity_curve = [{"date": d, "equity": v} for d, v in sorted(daily.items())]

    # daily p&l for calendar / best-worst day
    day_pnl: dict[str, float] = defaultdict(float)
    for t in in_range_closed:
        d = t.get("exit_date")
        if d:
            day_pnl[d] += t.get("pnl") or 0
    best_day = max(day_pnl.items(), key=lambda kv: kv[1]) if day_pnl else None
    worst_day = min(day_pnl.items(), key=lambda kv: kv[1]) if day_pnl else None

    # streaks
    streak = 0
    streak_kind = None
    for t in ordered:
        pnl = t.get("pnl") or 0
        kind = "WIN" if pnl > 0 else ("LOSS" if pnl < 0 else "FLAT")
        if kind == "FLAT":
            continue
        if kind == streak_kind:
            streak += 1
        else:
            streak_kind = kind
            streak = 1

    unrealised = round(sum(t.get("pnl") or 0 for t in open_trades), 2)
    unrealised_pct = round(
        safe_div(
            unrealised,
            sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in open_trades),
            0.0,
        )
        * 100,
        2,
    )

    return {
        "start": start,
        "end": end,
        "total_trades": len(in_range_closed),
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": len(breakeven),
        "win_rate": win_rate,
        "loss_rate": loss_rate,
        "net_pnl": net_pnl,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "fees": fees,
        "pl_pct": round(safe_div(net_pnl, deployed, 0.0) * 100, 2) if deployed else 0.0,
        "account_pct": round(safe_div(net_pnl, account_balance, 0.0) * 100, 2) if account_balance else None,
        "deployed_capital": round(deployed, 2),
        "profit_factor": profit_factor,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_pct": avg_win_pct,
        "avg_loss_pct": avg_loss_pct,
        "avg_trade": _mean([t.get("pnl") or 0 for t in in_range_closed]),
        "largest_win": largest_win.get("pnl") if largest_win else None,
        "largest_win_pct": largest_win.get("pnl_pct") if largest_win else None,
        "largest_win_symbol": largest_win.get("symbol") if largest_win else None,
        "largest_win_id": largest_win.get("id") if largest_win else None,
        "largest_loss": largest_loss.get("pnl") if largest_loss else None,
        "largest_loss_pct": largest_loss.get("pnl_pct") if largest_loss else None,
        "largest_loss_symbol": largest_loss.get("symbol") if largest_loss else None,
        "largest_loss_id": largest_loss.get("id") if largest_loss else None,
        "avg_hold": _mean([float(x) for x in all_hold]),
        "avg_win_hold": _mean([float(x) for x in wins_hold]),
        "avg_loss_hold": _mean([float(x) for x in losses_hold]),
        "expectancy": expectancy,
        "expectancy_pct": round(safe_div(expectancy, _mean([t.get("invested") or 0 for t in in_range_closed]), 0.0) * 100, 2)
        if in_range_closed
        else 0.0,
        "total_r": total_r,
        "avg_r": avg_r,
        "r_count": len(r_values),
        "max_drawdown": round(max_dd, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "best_day": {"date": best_day[0], "pnl": round(best_day[1], 2)} if best_day else None,
        "worst_day": {"date": worst_day[0], "pnl": round(worst_day[1], 2)} if worst_day else None,
        "streak": streak,
        "streak_kind": streak_kind,
        "open_trades": len(open_trades),
        "open_invested": round(sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in open_trades), 2),
        "unrealised": unrealised,
        "unrealised_pct": unrealised_pct,
        "equity_curve": equity_curve,
        "best_trade": _trade_brief(max(in_range_closed, key=lambda t: t["pnl"], default=None)),
        "worst_trade": _trade_brief(min(in_range_closed, key=lambda t: t["pnl"], default=None)),
    }


def _trade_brief(t: dict[str, Any] | None) -> dict[str, Any] | None:
    if not t:
        return None
    return {"id": t["id"], "symbol": t["symbol"], "pnl": t.get("pnl"), "pnl_pct": t.get("pnl_pct")}


def symbol_breakdown(trades: list[dict[str, Any]], start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    closed = [t for t in _closed(trades) if in_range(t, start, end)]
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in closed:
        groups[t["symbol"]].append(t)
    out = []
    for symbol, items in groups.items():
        pnl = round(sum(t.get("pnl") or 0 for t in items), 2)
        wins = sum(1 for t in items if (t.get("pnl") or 0) > 0)
        invested = sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in items)
        out.append(
            {
                "symbol": symbol,
                "trades": len(items),
                "wins": wins,
                "losses": sum(1 for t in items if (t.get("pnl") or 0) < 0),
                "win_rate": round(safe_div(wins, len(items), 0.0) * 100, 1),
                "pnl": pnl,
                "pnl_pct": round(safe_div(pnl, invested, 0.0) * 100, 2) if invested else 0.0,
                "avg_hold": _mean([float(t["hold_days"]) for t in items if t.get("hold_days") is not None]),
            }
        )
    return sorted(out, key=lambda x: x["pnl"], reverse=True)


def monthly_breakdown(trades: list[dict[str, Any]], months: int = 24) -> list[dict[str, Any]]:
    closed = _closed(trades)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in closed:
        d = t.get("exit_date") or t.get("entry_date")
        if d:
            groups[d[:7]].append(t)
    keys = sorted(groups.keys())[-months:]
    out = []
    for key in keys:
        items = groups[key]
        pnl = round(sum(t.get("pnl") or 0 for t in items), 2)
        wins = sum(1 for t in items if (t.get("pnl") or 0) > 0)
        losses = sum(1 for t in items if (t.get("pnl") or 0) < 0)
        invested = sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in items)
        out.append(
            {
                "month": key,
                "label": dt.date.fromisoformat(key + "-01").strftime("%b %Y"),
                "pnl": pnl,
                "trades": len(items),
                "wins": wins,
                "losses": losses,
                "win_rate": round(safe_div(wins, wins + losses, 0.0) * 100, 1),
                "pnl_pct": round(safe_div(pnl, invested, 0.0) * 100, 2) if invested else 0.0,
            }
        )
    return out


def calendar_month(trades: list[dict[str, Any]], month: str) -> dict[str, Any]:
    start, end = month_bounds(month)
    days: dict[str, dict[str, Any]] = {}

    def bucket(day: str) -> dict[str, Any]:
        return days.setdefault(
            day,
            {
                "date": day,
                "pnl": 0.0,
                "closed": 0,
                "wins": 0,
                "losses": 0,
                "open_entries": 0,
                "invested": 0.0,
                "trade_ids": [],
            },
        )

    for t in trades:
        if t["status"] != "OPEN" and t.get("exit_date") and start <= t["exit_date"] <= end:
            b = bucket(t["exit_date"])
            b["pnl"] += t.get("pnl") or 0
            b["closed"] += 1
            b["invested"] += t.get("invested") or 0
            b["trade_ids"].append(t["id"])
            if (t.get("pnl") or 0) > 0:
                b["wins"] += 1
            elif (t.get("pnl") or 0) < 0:
                b["losses"] += 1
        if t["status"] == "OPEN" and t.get("entry_date") and start <= t["entry_date"] <= end:
            b = bucket(t["entry_date"])
            b["open_entries"] += 1
            b["trade_ids"].append(t["id"])

    out_days = []
    for day in sorted(days):
        b = days[day]
        b["pnl"] = round(b["pnl"], 2)
        b["invested"] = round(b["invested"], 2)
        b["pnl_pct"] = round(safe_div(b["pnl"], b["invested"], 0.0) * 100, 2) if b["invested"] else 0.0
        out_days.append(b)

    total_pnl = round(sum(d["pnl"] for d in out_days), 2)
    return {
        "month": month,
        "start": start,
        "end": end,
        "days": out_days,
        "total_pnl": total_pnl,
        "trading_days": len([d for d in out_days if d["closed"]]),
        "wins": sum(d["wins"] for d in out_days),
        "losses": sum(d["losses"] for d in out_days),
        "trades": sum(d["closed"] for d in out_days),
        "best_day": max(out_days, key=lambda d: d["pnl"], default=None) if out_days else None,
        "worst_day": min(out_days, key=lambda d: d["pnl"], default=None) if out_days else None,
    }


def day_detail(trades: list[dict[str, Any]], day: str) -> dict[str, Any]:
    closed = [t for t in trades if t.get("exit_date") == day]
    opened = [t for t in trades if t.get("entry_date") == day and t["status"] == "OPEN"]
    pnl = round(sum(t.get("pnl") or 0 for t in closed), 2)
    wins = sum(1 for t in closed if (t.get("pnl") or 0) > 0)
    losses = sum(1 for t in closed if (t.get("pnl") or 0) < 0)
    return {
        "date": day,
        "pnl": pnl,
        "trades": sort_trades(closed, "pnl_desc"),
        "open_entries": sort_trades(opened, "pnl_desc"),
        "wins": wins,
        "losses": losses,
        "closed": len(closed),
    }


def weekday_breakdown(trades: list[dict[str, Any]], start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    """Performance by day-of-week of the exit (when the trade was booked)."""
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for t in _closed(trades):
        d = t.get("exit_date")
        if not d or not in_range(t, start, end):
            continue
        try:
            groups[dt.date.fromisoformat(d).weekday()].append(t)
        except ValueError:
            continue
    out = []
    for wd in range(7):
        items = groups.get(wd) or []
        if not items:
            continue
        pnl = round(sum(t.get("pnl") or 0 for t in items), 2)
        wins = sum(1 for t in items if (t.get("pnl") or 0) > 0)
        losses = sum(1 for t in items if (t.get("pnl") or 0) < 0)
        out.append(
            {
                "weekday": names[wd],
                "pnl": pnl,
                "trades": len(items),
                "wins": wins,
                "losses": losses,
                "win_rate": round(safe_div(wins, wins + losses, 0.0) * 100, 1),
                "avg_pnl": _mean([t.get("pnl") or 0 for t in items]),
            }
        )
    return out


def strategy_breakdown(trades: list[dict[str, Any]], start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in _closed(trades):
        if not in_range(t, start, end):
            continue
        groups[(t.get("strategy") or "").strip() or "Unassigned"].append(t)
    out = []
    for name, items in groups.items():
        pnl = round(sum(t.get("pnl") or 0 for t in items), 2)
        wins = sum(1 for t in items if (t.get("pnl") or 0) > 0)
        losses = sum(1 for t in items if (t.get("pnl") or 0) < 0)
        invested = sum((t.get("entry_price") or 0) * (t.get("quantity") or 0) for t in items)
        out.append(
            {
                "strategy": name,
                "trades": len(items),
                "wins": wins,
                "losses": losses,
                "win_rate": round(safe_div(wins, wins + losses, 0.0) * 100, 1),
                "pnl": pnl,
                "pnl_pct": round(safe_div(pnl, invested, 0.0) * 100, 2) if invested else 0.0,
                "avg_pnl": _mean([t.get("pnl") or 0 for t in items]),
            }
        )
    return sorted(out, key=lambda x: x["pnl"], reverse=True)


def r_distribution(trades: list[dict[str, Any]], start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """Histogram of R multiples for trades that had a stop loss."""
    buckets = [
        ("< -2R", float("-inf"), -2),
        ("-2R to -1R", -2, -1),
        ("-1R to 0", -1, 0),
        ("0 to 1R", 0, 1),
        ("1R to 2R", 1, 2),
        ("2R to 3R", 2, 3),
        ("> 3R", 3, float("inf")),
    ]
    values = [t["r_multiple"] for t in _closed(trades) if in_range(t, start, end) and t.get("r_multiple") is not None]
    out = []
    for label, lo, hi in buckets:
        count = sum(1 for v in values if lo <= v < hi)
        out.append({"bucket": label, "count": count})
    return {"buckets": out, "count": len(values), "avg": _mean([float(v) for v in values])}
