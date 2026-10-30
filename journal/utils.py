"""Small helpers shared across the app: numbers, dates, symbols, money."""
from __future__ import annotations

import datetime as dt
import math
import re
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# numbers
# ---------------------------------------------------------------------------

_EMPTY = {"", "-", "--", "na", "n/a", "nan", "none", "null", "nil"}


def parse_num(value: Any, default: float | None = None) -> float | None:
    """Parse numbers coming from CSV/XLSX-ish sources.

    Handles: 1,234.56 | 1.2e3 | ₹1,234 | (123.45) | 12.5% | +45 | -45
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return default
        return float(value)
    s = str(value).strip()
    if s.lower() in _EMPTY:
        return default
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    s = (
        s.replace(",", "")
        .replace("₹", "")
        .replace("$", "")
        .replace("\u00a0", "")
        .replace(" ", "")
        .replace("%", "")
        .replace("+", "")
    )
    # trailing CR / currency codes like "1234.50 INR"
    s = re.sub(r"[A-Za-z]+$", "", s)
    try:
        n = float(s)
    except ValueError:
        return default
    return -n if neg else n


def round2(n: float | None) -> float | None:
    if n is None:
        return None
    return round(float(n) + 0.0, 2)


def safe_div(a: float | None, b: float | None, default: float = 0.0) -> float:
    if a is None or b in (None, 0):
        return default
    try:
        return float(a) / float(b)
    except (ZeroDivisionError, TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# dates
# ---------------------------------------------------------------------------

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d-%m-%y",
    "%d/%m/%y",
    "%d %b %Y",
    "%d-%b-%Y",
    "%d %B %Y",
    "%d-%b-%y",
    "%b %d, %Y",
    "%B %d, %Y",
    "%d.%m.%Y",
    "%Y%m%d",
    "%m/%d/%Y",
    "%m-%d-%Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%d-%m-%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d/%m/%Y %H:%M",
)


def parse_date(value: Any, dayfirst: bool = True) -> str | None:
    """Return ISO date string (YYYY-MM-DD) or None.

    Indian broker exports are day-first by default; if a value is unambiguously
    month-first (e.g. 13/04/2024) we still resolve it because %d fails there.
    """
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    s = str(value).strip()
    if not s or s.lower() in _EMPTY:
        return None
    s = s.replace("\u00a0", " ").strip()
    # Excel serial number (e.g. 45383)
    if re.fullmatch(r"\d{5}(\.\d+)?", s):
        n = float(s)
        if 20000 <= n <= 80000:
            base = dt.date(1899, 12, 30)
            return (base + dt.timedelta(days=int(n))).isoformat()
    # Strip timezone-ish tails such as "GMT+0530"
    s = re.sub(r"\s*(GMT|UTC)[+-]?\d{0,4}$", "", s, flags=re.I).strip()
    formats = _DATE_FORMATS if dayfirst else tuple(reversed(_DATE_FORMATS))
    for fmt in formats:
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    # Try to salvage "2024-04-01 09:15:00.123456"
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", s)
    if m:
        d, mo, y = m.groups()
        y = int(y)
        if y < 100:
            y += 2000
        try:
            return dt.date(y, int(mo), int(d)).isoformat()
        except ValueError:
            return None
    return None


def today_iso() -> str:
    return dt.date.today().isoformat()


def days_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        a = dt.date.fromisoformat(str(start)[:10])
        b = dt.date.fromisoformat(str(end)[:10])
    except ValueError:
        return None
    return (b - a).days


def add_days(iso: str, days: int) -> str:
    return (dt.date.fromisoformat(iso) + dt.timedelta(days=days)).isoformat()


def month_bounds(month: str) -> tuple[str, str]:
    """'2024-04' -> ('2024-04-01', '2024-04-30')."""
    y, m = (int(x) for x in month.split("-")[:2])
    first = dt.date(y, m, 1)
    nxt = dt.date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return first.isoformat(), (nxt - dt.timedelta(days=1)).isoformat()


def resolve_range(name: str | None, start: str | None = None, end: str | None = None) -> tuple[str | None, str | None]:
    """Resolve a preset range name into (start_iso, end_iso)."""
    name = (name or "all").lower()
    today = dt.date.today()
    if name in ("custom", "range"):
        return (parse_date(start) if start else None, parse_date(end) if end else None)
    if name in ("all", "all_time", "max", ""):
        return (None, None)
    if name == "1w":
        return ((today - dt.timedelta(days=7)).isoformat(), today.isoformat())
    if name == "1m":
        return ((today - dt.timedelta(days=30)).isoformat(), today.isoformat())
    if name == "3m":
        return ((today - dt.timedelta(days=91)).isoformat(), today.isoformat())
    if name == "6m":
        return ((today - dt.timedelta(days=182)).isoformat(), today.isoformat())
    if name == "1y":
        return ((today - dt.timedelta(days=365)).isoformat(), today.isoformat())
    if name == "5y":
        return ((today - dt.timedelta(days=1826)).isoformat(), today.isoformat())
    if name == "ytd":
        return (dt.date(today.year, 1, 1).isoformat(), today.isoformat())
    if name == "mtd":
        return (dt.date(today.year, today.month, 1).isoformat(), today.isoformat())
    return (None, None)


# ---------------------------------------------------------------------------
# symbols / sides
# ---------------------------------------------------------------------------

_EXCHANGE_PREFIX = re.compile(r"^(NSE|BSE|NFO|BFO|MCX|CDS|BCD|NSEFO|NSECDS):", re.I)


def norm_symbol(value: Any) -> str:
    s = str(value or "").strip().upper()
    if not s:
        return ""
    s = _EXCHANGE_PREFIX.sub("", s)
    s = s.replace(" ", "")
    for suffix in ("-EQ", "-BE", "-BZ", "-BL", "-ST", "-SM", "-IL"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    return s


def norm_side(value: Any) -> str | None:
    s = str(value or "").strip().upper()
    if not s:
        return None
    if s in ("B", "BUY", "BOUGHT", "LONG", "BOUGHT(S)"):
        return "BUY"
    if s in ("S", "SELL", "SOLD", "SHORT", "SOLD(S)"):
        return "SELL"
    if s in ("PROFIT", "WIN", "W"):
        return "PROFIT"
    if s in ("LOSS", "L", "LOOSE"):
        return "LOSS"
    if s in ("OPEN", "O", "PENDING", "HOLD", "HOLDING"):
        return "OPEN"
    return None


def pct(part: float | None, whole: float | None) -> float | None:
    if part is None or whole in (None, 0):
        return None
    return (float(part) / float(whole)) * 100.0


def fmt_qty(q: float | None) -> str:
    if q is None:
        return "-"
    return str(int(q)) if float(q).is_integer() else f"{q:g}"


def chunked(seq: Iterable, size: int):
    buf = []
    for item in seq:
        buf.append(item)
        if len(buf) == size:
            yield buf
            buf = []
    if buf:
        yield buf
