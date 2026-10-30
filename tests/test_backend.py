"""End-to-end backend tests. Run: python tests/test_backend.py"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="sjnl-"))
os.environ["STOCK_JOURNAL_DATA"] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app as app_module  # noqa: E402
from journal import db as dbmod  # noqa: E402
from journal import kite  # noqa: E402
from journal.importer import parse_csv  # noqa: E402
from journal.trades import all_trades, apply_fill, create_trade, resolve_review  # noqa: E402


def fresh_db():
    dbmod.reset_data(dbmod.connect())


class Base(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        self.conn = dbmod.connect()
        dbmod.init_db()
        dbmod.reset_data(self.conn)
        self.conn.execute("DELETE FROM settings")
        dbmod.init_db()

    def post(self, url, payload):
        return self.client.post(url, json=payload)

    def add_trade(self, **over):
        payload = {
            "symbol": "INFY",
            "entry_date": "2025-01-06",
            "entry_price": 1500,
            "quantity": 10,
            "exit_date": "2025-01-10",
            "exit_price": 1560,
            "stop_loss": 1470,
            "fees": 20,
            "notes": "test",
        }
        payload.update(over)
        return self.post("/api/trades", payload)


class TestTrades(Base):
    def test_create_and_duplicate(self):
        r = self.add_trade()
        self.assertEqual(r.status_code, 201, r.get_json())
        body = r.get_json()
        trade = body["trade"]
        self.assertEqual(trade["status"], "PROFIT")
        self.assertAlmostEqual(trade["pnl"], 580.0)
        self.assertAlmostEqual(trade["pnl_pct"], 3.87, places=1)
        self.assertEqual(trade["hold_days"], 4)
        self.assertAlmostEqual(trade["r_multiple"], 1.93, places=1)

        # exact duplicate -> skipped
        r2 = self.add_trade()
        self.assertEqual(r2.status_code, 200)
        self.assertFalse(r2.get_json()["created"])
        self.assertTrue(r2.get_json()["duplicate"])

        # near duplicate (same price/qty, 6 days apart) -> review queue
        r3 = self.add_trade(entry_date="2025-01-12", exit_date="2025-01-16")
        self.assertFalse(r3.get_json()["created"])
        self.assertTrue(r3.get_json()["review"])
        reviews = self.client.get("/api/review").get_json()["items"]
        self.assertEqual(len(reviews), 1)
        rid = reviews[0]["id"]

        # reject proposal -> import as new
        res = self.post(f"/api/review/{rid}/resolve", {"decision": "reject"}).get_json()
        self.assertEqual(res["result"]["status"], "REJECTED")
        self.assertEqual(self.client.get("/api/trades").get_json()["total"], 2)

    def test_open_trade_and_close(self):
        r = self.add_trade(exit_price=None, exit_date=None)
        tid = r.get_json()["trade"]["id"]
        self.assertEqual(r.get_json()["trade"]["status"], "OPEN")
        c = self.post(f"/api/trades/{tid}/close", {"exit_price": 1450, "exit_date": "2025-01-12"})
        self.assertEqual(c.status_code, 200)
        t = c.get_json()["trade"]
        self.assertEqual(t["status"], "LOSS")
        self.assertAlmostEqual(t["pnl"], -520.0)
        self.assertEqual(t["hold_days"], 6)

    def test_validation(self):
        for bad in (
            {},
            {"symbol": "X", "entry_date": "bad", "entry_price": 1, "quantity": 1},
            {"symbol": "X", "entry_date": "2025-01-01", "entry_price": None, "quantity": 1},
            {"symbol": "X", "entry_date": "2025-01-01", "entry_price": 1, "quantity": 0},
            {"symbol": "X", "entry_date": "2025-01-05", "entry_price": 1, "quantity": 1, "exit_date": "2025-01-01", "exit_price": 2},
        ):
            r = self.post("/api/trades", bad)
            self.assertEqual(r.status_code, 400, bad)

    def test_short_trade(self):
        r = self.add_trade(side="SHORT", entry_price=100, exit_price=90, quantity=50, stop_loss=105)
        t = r.get_json()["trade"]
        self.assertAlmostEqual(t["pnl"], 480.0)  # 500 - 20 fees
        self.assertEqual(t["status"], "PROFIT")
        self.assertAlmostEqual(t["pnl_pct"], 9.6, places=1)

    def test_edit_delete_and_photos(self):
        tid = self.add_trade().get_json()["trade"]["id"]
        r = self.client.put(f"/api/trades/{tid}", json={"notes": "updated", "rating": 5})
        self.assertEqual(r.get_json()["trade"]["notes"], "updated")
        self.assertEqual(r.get_json()["trade"]["rating"], 5)

        data = {"files": (io.BytesIO(b"\x89PNG\r\n\x1a\nfake"), "shot.png")}
        ph = self.client.post(f"/api/trades/{tid}/photos", data=data, content_type="multipart/form-data")
        self.assertEqual(ph.status_code, 200, ph.get_json())
        name = ph.get_json()["photos"][0]["filename"]
        got = self.client.get(f"/api/attachments/{name}")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(len(self.client.get(f"/api/trades/{tid}").get_json()["trade"]["photos"]), 1)

        self.assertEqual(self.client.delete(f"/api/trades/{tid}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/trades/{tid}").status_code, 404)


class TestImports(Base):
    ZERODHA = (
        "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time\n"
        "INFY,INE009A01021,2025-03-03,NSE,EQ,EQ,buy,,10,1500.50,111,9001,2025-03-03 09:20:00\n"
        "INFY,INE009A01021,2025-03-07,NSE,EQ,EQ,sell,,10,1560.00,112,9002,2025-03-07 14:10:00\n"
        "TCS,INE467B01029,2025-03-10,NSE,EQ,EQ,buy,,5,3500.00,113,9003,2025-03-10 10:00:00\n"
    )

    def test_tradebook_fills_and_reimport(self):
        data = {"file": (io.BytesIO(self.ZERODHA.encode()), "tradebook.csv")}
        prev = self.client.post("/api/import/preview", data=data, content_type="multipart/form-data").get_json()
        self.assertTrue(prev["ok"], prev)
        self.assertEqual(prev["kind"], "fills")
        self.assertEqual(prev["row_count"], 3)
        self.assertEqual(prev["simulation"]["created_trades"], 2)
        self.assertEqual(prev["simulation"]["closed"], 1)
        # preview must not write anything
        self.assertEqual(self.client.get("/api/trades").get_json()["total"], 0)

        data = {"file": (io.BytesIO(self.ZERODHA.encode()), "tradebook.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        s = res["summary"]
        self.assertEqual(s["created_trades"], 2)
        self.assertEqual(s["closed"], 1)
        trades = self.client.get("/api/trades?include_open=1").get_json()["trades"]
        self.assertEqual(len(trades), 2)
        closed = [t for t in trades if t["status"] != "OPEN"][0]
        self.assertEqual(closed["symbol"], "INFY")
        self.assertAlmostEqual(closed["entry_price"], 1500.5)
        self.assertAlmostEqual(closed["exit_price"], 1560.0)
        self.assertEqual(closed["hold_days"], 4)

        # re-import -> everything duplicate, no new rows
        data = {"file": (io.BytesIO(self.ZERODHA.encode()), "tradebook.csv")}
        res2 = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res2["summary"]["created_trades"], 0)
        self.assertEqual(res2["summary"]["duplicates"], 3)
        self.assertEqual(self.client.get("/api/trades").get_json()["total"], 2)

    def test_same_fill_with_distinct_broker_refs_is_not_a_duplicate(self):
        csv_text = (
            "symbol,trade_date,trade_type,quantity,price,trade_id,order_id\n"
            "SBIN,2025-02-03,buy,10,800,501,9001\n"
            "SBIN,2025-02-03,buy,10,800,502,9002\n"
        )
        data = {"file": (io.BytesIO(csv_text.encode()), "fills.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res["summary"]["created_trades"], 2, res)
        self.assertEqual(res["summary"]["duplicates"], 0)
        self.assertEqual(len(self.client.get("/api/trades?include_open=1").get_json()["trades"]), 2)

    def test_partial_sell_splits_lot(self):
        csv_text = (
            "date,symbol,side,quantity,price\n"
            "2025-02-03,SBIN,buy,100,800\n"
            "2025-02-10,SBIN,sell,40,850\n"
        )
        data = {"file": (io.BytesIO(csv_text.encode()), "fills.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res["summary"]["created_trades"], 1)  # the split-off closed part
        trades = self.client.get("/api/trades").get_json()["trades"]
        open_t = [t for t in trades if t["status"] == "OPEN"]
        closed = [t for t in trades if t["status"] != "OPEN"]
        self.assertEqual(len(open_t), 1)
        self.assertEqual(open_t[0]["quantity"], 60)
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["quantity"], 40)
        self.assertAlmostEqual(closed[0]["pnl"], 2000.0)

    def test_sell_without_buy_review(self):
        csv_text = "date,symbol,side,qty,price\n2025-02-03,XYZ,sell,10,500\n"
        data = {"file": (io.BytesIO(csv_text.encode()), "x.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res["summary"]["review"], 1)
        item = self.client.get("/api/review").get_json()["items"][0]
        self.assertEqual(item["kind"], "SELL_WITHOUT_BUY")
        out = self.post(f"/api/review/{item['id']}/resolve", {"decision": "accept"}).get_json()
        self.assertTrue(out["result"]["created"]["created"])
        t = self.client.get("/api/trades").get_json()["trades"][0]
        self.assertEqual(t["side"], "SHORT")
        self.assertEqual(t["status"], "OPEN")

    def test_semicolon_preamble_and_generic_headers(self):
        text = (
            "My Broker Statement\n"
            "Generated on 01-04-2025\n\n"
            "Stock Name;Transaction Type;Quantity;Trade Price;Trade Date;Brokerage\n"
            "RELIANCE;BUY;10;2,400.00;01-03-2025;12\n"
            "RELIANCE;SELL;10;2,520.00;05-03-2025;12\n"
        )
        parsed = parse_csv(text.encode(), "x.csv")
        self.assertTrue(parsed["ok"], parsed)
        self.assertEqual(parsed["delimiter"], ";")
        self.assertEqual(parsed["kind"], "fills")
        self.assertEqual(len(parsed["rows"]), 2)
        self.assertEqual(parsed["rows"][0]["price"], 2400.0)

    def test_roundtrip_export(self):
        csv_text = (
            "symbol,buy_date,buy_price,qty,sell_date,sell_price,charges,notes\n"
            "HDFCBANK,2025-01-02,1600,10,2025-01-20,1680,30,momentum trade\n"
        )
        data = {"file": (io.BytesIO(csv_text.encode()), "pnl.csv")}
        prev = self.client.post("/api/import/preview", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(prev["kind"], "roundtrip")
        data = {"file": (io.BytesIO(csv_text.encode()), "pnl.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res["summary"]["created_trades"], 1)
        t = self.client.get("/api/trades").get_json()["trades"][0]
        self.assertAlmostEqual(t["pnl"], 770.0)
        self.assertEqual(t["hold_days"], 18)
        self.assertEqual(t["notes"], "momentum trade")
        # duplicate re-import
        data = {"file": (io.BytesIO(csv_text.encode()), "pnl.csv")}
        res = self.client.post("/api/import/commit", data=data, content_type="multipart/form-data").get_json()
        self.assertEqual(res["summary"]["created_trades"], 0)
        self.assertEqual(res["summary"]["duplicates"], 1)

    def test_export_csv_roundtrip(self):
        self.add_trade()
        r = self.client.get("/api/export/csv")
        self.assertEqual(r.status_code, 200)
        text = r.data.decode()
        self.assertIn("INFY", text)
        self.assertIn("pnl_pct", text.splitlines()[0])

    def test_bad_file(self):
        data = {"file": (io.BytesIO(b"\x00\x01\x02binary"), "junk.bin")}
        r = self.client.post("/api/import/preview", data=data, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)


class TestDashboardAndStats(Base):
    def setUp(self):
        super().setUp()
        self.post("/api/sample", {"force": True})

    def test_bootstrap(self):
        b = self.client.get("/api/bootstrap").get_json()
        self.assertTrue(b["ok"])
        self.assertTrue(b["storage"]["db_path"].endswith("journal.db"))
        self.assertGreater(b["holdings"]["open_trades"], 0)

    def test_dashboard(self):
        r = self.client.get("/api/dashboard?range=all&status=all").get_json()
        self.assertIn("stats", r)
        self.assertGreater(r["stats"]["total_trades"], 0)
        self.assertGreater(len(r["trades"]), 0)
        self.assertGreater(len(r["symbols"]), 0)

        # open filter
        o = self.client.get("/api/dashboard?range=all&status=open").get_json()
        self.assertTrue(all(t["status"] == "OPEN" for t in o["trades"]))
        self.assertEqual(len(o["trades"]), o["stats"]["open_trades"])

        # profit filter
        p = self.client.get("/api/dashboard?range=all&status=profit").get_json()
        self.assertTrue(all(t["status"] == "PROFIT" for t in p["trades"]))

        # sorting
        s = self.client.get("/api/dashboard?range=all&status=all&sort=pnl_desc").get_json()
        pnls = [t["pnl"] for t in s["trades"] if t["pnl"] is not None]
        self.assertEqual(pnls, sorted(pnls, reverse=True))

    def test_stats_ranges_and_math(self):
        r = self.client.get("/api/stats?range=all").get_json()
        st = r["stats"]
        self.assertEqual(st["wins"] + st["losses"] + st["breakeven"], st["total_trades"])
        self.assertAlmostEqual(st["win_rate"] + st["loss_rate"], 100.0, places=1)
        self.assertEqual(len(st["equity_curve"]), len({p["date"] for p in r["stats"]["equity_curve"]}))
        self.assertTrue(st["profit_factor"] is None or st["profit_factor"] >= 0)
        self.assertIsNotNone(st["avg_win_hold"])
        self.assertTrue(r["weekly"] if "weekly" in r else True)
        self.assertIn("buckets", r["r_distribution"])

        one_w = self.client.get("/api/stats?range=1w").get_json()["stats"]
        self.assertEqual(one_w["start"], (__import__("datetime").date.today() - __import__("datetime").timedelta(days=7)).isoformat())

        custom = self.client.get("/api/stats?range=custom&start=2024-01-01&end=2024-12-31").get_json()["stats"]
        self.assertLessEqual(custom["total_trades"], st["total_trades"])

    def test_calendar_and_day(self):
        r = self.client.get("/api/calendar?month=2025-03").get_json()["calendar"]
        self.assertEqual(r["start"], "2025-03-01")
        self.assertEqual(r["end"], "2025-03-31")
        self.assertIn("days", r)
        if r["days"]:
            d = r["days"][0]
            day = self.client.get(f"/api/day?date={d['date']}").get_json()["day"]
            self.assertEqual(day["date"], d["date"])
            self.assertEqual(day["closed"], d["closed"])

    def test_settings_and_cash(self):
        r = self.client.put("/api/settings", json={"columns": {"fees": True}, "dashboard_range": "1y"})
        s = r.get_json()["settings"]
        self.assertTrue(s["columns"]["fees"])
        self.assertEqual(s["dashboard_range"], "1y")
        self.assertIn("date", s["columns"])

        b0 = self.client.get("/api/cash").get_json()["balance"]
        self.post("/api/cash", {"amount": 50000, "kind": "DEPOSIT", "note": "top up"})
        b1 = self.client.get("/api/cash").get_json()["balance"]
        self.assertAlmostEqual(b1, b0 + 50000)
        entries = self.client.get("/api/cash").get_json()["entries"]
        self.assertEqual(self.client.delete(f"/api/cash/{entries[0]['id']}").status_code, 200)
        self.assertAlmostEqual(self.client.get("/api/cash").get_json()["balance"], b0)

    def test_backup_restore(self):
        n = self.client.get("/api/trades").get_json()["total"]
        backup = self.client.get("/api/backup")
        self.assertEqual(backup.status_code, 200)
        payload = backup.data
        snapshot = json.loads(payload)
        self.assertEqual(len(snapshot["tables"]["trades"]), n)

        self.post("/api/reset", {"confirm": "RESET"})
        self.assertEqual(self.client.get("/api/trades").get_json()["total"], 0)
        r = self.client.post(
            "/api/restore",
            data={"file": (io.BytesIO(payload), "backup.json")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(self.client.get("/api/trades").get_json()["total"], n)

    def test_reset_clears_balance_and_cash(self):
        self.client.put("/api/settings", json={"account_balance": 250000})
        self.post("/api/cash", {"amount": 5000, "kind": "DEPOSIT", "note": "test"})
        self.assertGreater(self.client.get("/api/cash").get_json()["balance"], 0)
        self.post("/api/reset", {"confirm": "RESET"})
        cash = self.client.get("/api/cash").get_json()
        self.assertEqual(cash["balance"], 0)
        self.assertEqual(cash["entries"], [])
        settings = self.client.get("/api/settings").get_json()["settings"]
        self.assertEqual(settings["account_balance"], 0)

    def test_reset_requires_confirmation(self):
        r = self.post("/api/reset", {})
        self.assertEqual(r.status_code, 400)


class TestBrokerReconcile(Base):
    def settings(self):
        return dbmod.get_settings(self.conn)

    def test_holding_match_and_price_mismatch(self):
        settings = self.settings()
        # matching holding (same qty, close price) -> no duplicate, no review
        self.add_trade(exit_price=None, exit_date=None, entry_price=1500, quantity=10)
        summary = {"added": [], "review": [], "notes": [], "matched": 0}
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 10, "t1_quantity": 0,
             "average_price": 1501, "last_price": 1550, "pnl": 490, "product": "CNC", "isin": "INE009A01021"},
            settings,
            summary,
        )
        self.assertEqual(summary["matched"], 1)
        self.assertEqual(len(all_trades(self.conn)), 1)
        self.assertEqual(self.client.get("/api/holdings").get_json()["holdings"]["rows"][0]["symbol"], "INFY")

        # price mismatch far away -> review
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 10, "t1_quantity": 0,
             "average_price": 1400, "last_price": 1550, "pnl": 0, "product": "CNC", "isin": "INE009A01021"},
            settings,
            summary,
        )
        items = self.client.get("/api/review").get_json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "PRICE_MISMATCH")
        out = self.post(f"/api/review/{items[0]['id']}/resolve", {"decision": "accept"}).get_json()
        self.assertEqual(out["result"]["trade"]["entry_price"], 1400)

    def test_holding_new_and_qty_mismatch(self):
        settings = self.settings()
        summary = {"added": [], "review": [], "notes": [], "matched": 0}
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "SBIN", "exchange": "NSE", "quantity": 50, "t1_quantity": 0,
             "average_price": 800, "last_price": 820, "pnl": 1000, "product": "CNC", "isin": "INE062A01020"},
            settings,
            summary,
        )
        self.assertEqual(len(summary["added"]), 1)
        trades = all_trades(self.conn)
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["status"], "OPEN")

        # second sync -> matched, not duplicated
        summary2 = {"added": [], "review": [], "notes": [], "matched": 0}
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "SBIN", "exchange": "NSE", "quantity": 50, "t1_quantity": 0,
             "average_price": 800, "last_price": 825, "pnl": 1250, "product": "CNC", "isin": "INE062A01020"},
            settings,
            summary2,
        )
        self.assertEqual(summary2["matched"], 1)
        self.assertEqual(len(all_trades(self.conn)), 1)

        # qty mismatch -> review, accept adjusts qty
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "SBIN", "exchange": "NSE", "quantity": 70, "t1_quantity": 0,
             "average_price": 805, "last_price": 825, "pnl": 1400, "product": "CNC", "isin": "INE062A01020"},
            settings,
            summary2,
        )
        items = self.client.get("/api/review").get_json()["items"]
        self.assertTrue(any(i["kind"] == "QTY_MISMATCH" for i in items))
        item = [i for i in items if i["kind"] == "QTY_MISMATCH"][0]
        self.post(f"/api/review/{item['id']}/resolve", {"decision": "accept"})
        self.assertEqual(all_trades(self.conn)[0]["quantity"], 70)

    def test_multiple_lots_left_untouched(self):
        settings = self.settings()
        self.add_trade(exit_price=None, exit_date=None, entry_price=100, quantity=10, entry_date="2025-01-01")
        self.add_trade(exit_price=None, exit_date=None, entry_price=110, quantity=10, entry_date="2025-02-01")
        summary = {"added": [], "review": [], "notes": [], "matched": 0}
        kite.reconcile_holding(
            self.conn,
            {"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 20, "t1_quantity": 0,
             "average_price": 105, "last_price": 120, "pnl": 300, "product": "CNC", "isin": "X"},
            settings,
            summary,
        )
        self.assertEqual(len(all_trades(self.conn)), 2)
        self.assertTrue(any("2 open journal lots" in n for n in summary["notes"]))

    def test_positions(self):
        settings = self.settings()
        summary = {"added": [], "review": [], "notes": [], "matched": 0}
        pos = {"tradingsymbol": "NIFTY24APR24500CE", "exchange": "NFO", "product": "NRML",
               "quantity": 75, "average_price": 120, "last_price": 150, "pnl": 2250,
               "buy_quantity": 75, "sell_quantity": 0, "buy_price": 120, "sell_price": 0}
        kite.reconcile_position(self.conn, pos, settings, summary, "2025-04-01")
        self.assertEqual(len(summary["added"]), 1)
        self.assertEqual(all_trades(self.conn)[0]["side"], "LONG")

        # closed position -> realised round trip
        summary2 = {"added": [], "review": [], "notes": [], "matched": 0}
        closed = {"tradingsymbol": "BANKNIFTY24APR48000PE", "exchange": "NFO", "product": "MIS",
                  "quantity": 0, "average_price": 0, "last_price": 200, "pnl": 5000,
                  "buy_quantity": 15, "sell_quantity": 15, "buy_price": 100, "sell_price": 133.33}
        kite.reconcile_position(self.conn, closed, settings, summary2, "2025-04-01")
        self.assertEqual(len(summary2["added"]), 1)
        # run twice -> no duplicate
        kite.reconcile_position(self.conn, closed, settings, summary2, "2025-04-01")
        self.assertEqual(len(all_trades(self.conn)), 2)

    def test_orders_import_through_fifo(self):
        settings = self.settings()
        summary = {"added": [], "review": [], "closed": 0, "skipped": 0, "notes": []}
        orders = [
            {"status": "COMPLETE", "filled_quantity": 10, "average_price": 500, "order_timestamp": "2025-05-01 09:20:00",
             "tradingsymbol": "ITC", "transaction_type": "BUY", "order_id": "A1", "exchange_order_id": "E1", "exchange": "NSE"},
            {"status": "COMPLETE", "filled_quantity": 10, "average_price": 530, "order_timestamp": "2025-05-06 14:20:00",
             "tradingsymbol": "ITC", "transaction_type": "SELL", "order_id": "A2", "exchange_order_id": "E2", "exchange": "NSE"},
            {"status": "REJECTED", "filled_quantity": 0, "average_price": 0, "tradingsymbol": "ITC", "transaction_type": "BUY", "order_id": "A3"},
        ]

        class FakeClient:
            def orders(self):
                return orders

        kite.sync_orders(self.conn, FakeClient(), settings, summary)
        trades = all_trades(self.conn)
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["status"], "PROFIT")
        self.assertAlmostEqual(trades[0]["pnl"], 300.0)
        # same orders again -> all skipped
        summary2 = {"added": [], "review": [], "closed": 0, "skipped": 0, "notes": []}
        kite.sync_orders(self.conn, FakeClient(), settings, summary2)
        self.assertEqual(summary2["skipped"], 2)
        self.assertEqual(len(all_trades(self.conn)), 1)

    def test_broker_status_without_credentials(self):
        st = self.client.get("/api/broker/status").get_json()
        self.assertFalse(st["connected"])
        r = self.post("/api/broker/sync", {"mode": "all"})
        self.assertIn(r.status_code, (400, 502))
        self.assertFalse(r.get_json()["ok"])

    def test_broker_credentials_masking(self):
        r = self.post("/api/broker/credentials", {"api_key": "abc123", "api_secret": "supersecret"})
        self.assertTrue(r.get_json()["login_url"].startswith("https://kite.zerodha.com"))
        s = self.client.get("/api/settings").get_json()["settings"]
        self.assertTrue(s["broker"]["api_secret"].startswith("••"))
        # saving masked value back must not destroy the real secret
        self.post("/api/broker/credentials", {"api_key": "abc123", "api_secret": s["broker"]["api_secret"]})
        self.assertEqual(dbmod.get_settings(self.conn)["broker"]["api_secret"], "supersecret")


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
