/* =====================================================================
   Calendar — monthly P&L heatmap with day drill-down
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const F = SJ.fmt;
  const esc = SJ.escape;
  const icon = SJ.icon;

  const state = (SJ.calendar = { month: null, data: null });

  function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  async function load() {
    const v = SJ.views.calendar;
    if (!v || !v.el) return;
    const body = v.el.querySelector("#calBody");
    if (!state.month) state.month = currentMonth();
    body.innerHTML = `<div class="loading"><div class="spinner"></div><span>Loading calendar…</span></div>`;
    try {
      const d = await SJ.api("/api/calendar?month=" + encodeURIComponent(state.month));
      state.data = d.calendar;
      render();
    } catch (e) {
      body.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not load the calendar.</strong><br>${esc(e.message)}</div></div>`;
    }
  }

  function render() {
    const v = SJ.views.calendar;
    if (!v || !v.el || !state.data) return;
    const c = state.data;
    v.el.querySelector("#calBody").innerHTML = shell(c);
    bind(v.el, c);
  }

  function shell(c) {
    const byDate = {};
    (c.days || []).forEach((d) => (byDate[d.date] = d));
    const [y, m] = state.month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const offset = (first.getDay() + 6) % 7; // Monday-first
    const today = F.todayISO();

    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(`<div class="cal-cell out"></div>`);
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${state.month}-${String(day).padStart(2, "0")}`;
      const d = byDate[iso];
      const has = d && (d.closed || d.open_entries);
      const classes = ["cal-cell"];
      if (iso === today) classes.push("today");
      if (!has) classes.push("no-data");
      let inner = `<div class="cal-top"><span class="cal-daynum">${day}</span>${d && d.open_entries ? `<span class="tiny dim" title="${d.open_entries} open position(s) entered">• open</span>` : ""}</div>`;
      if (d && d.closed) {
        inner += `<div class="cal-pnl ${F.cls(d.pnl)}">${F.signedMoney(d.pnl)}</div>`;
        inner += `<div class="cal-bars">${bars(d.wins, d.losses)}</div>`;
        inner += `<div class="cal-meta">
            <span><i class="dot" style="background:var(--green)"></i>${d.wins}W</span>
            <span><i class="dot" style="background:var(--red)"></i>${d.losses}L</span>
            <span>${d.closed} trade${d.closed === 1 ? "" : "s"}</span>
          </div>`;
      } else if (d && d.open_entries) {
        inner += `<div class="tiny dim" style="margin-top:2px">${d.open_entries} new open position${d.open_entries === 1 ? "" : "s"}</div>`;
      }
      cells.push(`<div class="${classes.join(" ")}" ${has ? `data-date="${iso}"` : ""}>${inner}</div>`);
    }
    while (cells.length % 7 !== 0) cells.push(`<div class="cal-cell out"></div>`);

    const monthPnlClass = F.cls(c.total_pnl);
    return `
      <div class="page-head">
        <div class="grow">
          <h2>Trade calendar</h2>
          <p>Daily P&amp;L, wins and losses — click any day to see its trades</p>
        </div>
        <div class="page-actions">
          <button class="btn ghost sm" id="calPrev" title="Previous month">${icon("arrowLeft")}</button>
          <button class="btn sm" id="calToday">Today</button>
          <input type="month" class="input sm" id="calMonth" value="${esc(state.month)}" style="width:auto">
          <button class="btn ghost sm" id="calNext" title="Next month">${icon("arrowRight")}</button>
        </div>
      </div>

      <div class="card">
        <div class="cal-toolbar">
          <div class="cal-month">${esc(F.month(state.month))}</div>
          <div class="row" style="gap:6px">
            <span class="pill ${c.total_pnl > 0 ? "profit" : c.total_pnl < 0 ? "loss" : "neutral"}">${F.signedMoney(c.total_pnl)}</span>
            ${c.best_day ? `<span class="tiny dim">best ${F.signedMoney(c.best_day.pnl)} on ${F.date(c.best_day.date, "day")}</span>` : ""}
          </div>
          <div class="right" style="margin-left:auto;display:flex;gap:14px;flex-wrap:wrap;font-size:12px">
            <span class="muted">${c.trading_days} trading days</span>
            <span>${c.trades} closed</span>
            <span class="pos">${c.wins} wins</span>
            <span class="neg">${c.losses} losses</span>
          </div>
        </div>
        <div class="cal-summary">
          <div class="item"><span>Month P&amp;L</span><strong class="${monthPnlClass}">${F.signedMoney(c.total_pnl)}</strong></div>
          ${c.worst_day ? `<div class="item"><span>Worst day</span><strong class="neg">${F.signedMoney(c.worst_day.pnl)} · ${F.date(c.worst_day.date, "day")}</strong></div>` : ""}
          <div class="item" style="margin-left:auto"><span>${(c.days || []).length} active days</span></div>
        </div>
        <div class="cal-grid">
          ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
          ${cells.join("")}
        </div>
        <div class="cal-legend">
          <span><i style="background:var(--green)"></i>profit day</span>
          <span><i style="background:var(--red)"></i>loss day</span>
          <span><i style="background:var(--accent)"></i>today</span>
          <span style="margin-left:auto">Click a day for the trade breakdown</span>
        </div>
      </div>

      <div class="split-2 mt">
        <div class="card">
          <div class="card-head"><h3>Daily P&amp;L this month</h3></div>
          <div class="card-body"><div class="chart" id="calChart"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Month at a glance</h3></div>
          <div class="card-body">
            ${monthStats(c)}
          </div>
        </div>
      </div>`;
  }

  function bars(wins, losses) {
    const w = Math.min(4, wins || 0);
    const l = Math.min(4, losses || 0);
    let out = "";
    for (let i = 0; i < w; i++) out += `<i style="height:${8 + i * 2}px;opacity:${0.5 + i * 0.12}"></i>`;
    for (let i = 0; i < l; i++) out += `<i class="loss" style="height:${8 + i * 2}px;opacity:${0.5 + i * 0.12}"></i>`;
    return out;
  }

  function monthStats(c) {
    const days = (c.days || []).filter((d) => d.closed);
    const winDays = days.filter((d) => d.pnl > 0).length;
    const lossDays = days.filter((d) => d.pnl < 0).length;
    const avg = days.length ? c.total_pnl / days.length : 0;
    const bestStreak = longestStreak(days.map((d) => d.pnl));
    return `<div class="kv" style="grid-template-columns:1fr auto;gap:9px 16px;font-size:12.5px">
      <dt>Winning days</dt><dd class="pos strong">${winDays}</dd>
      <dt>Losing days</dt><dd class="neg strong">${lossDays}</dd>
      <dt>Day win rate</dt><dd>${winDays + lossDays ? ((winDays / (winDays + lossDays)) * 100).toFixed(1) + "%" : "—"}</dd>
      <dt>Average day</dt><dd class="${F.cls(avg)}">${F.signedMoney(avg)}</dd>
      <dt>Best day</dt><dd class="pos">${c.best_day ? F.signedMoney(c.best_day.pnl) : "—"}</dd>
      <dt>Worst day</dt><dd class="neg">${c.worst_day ? F.signedMoney(c.worst_day.pnl) : "—"}</dd>
      <dt>Longest win streak</dt><dd>${bestStreak || 0} days</dd>
      <dt>Total closed trades</dt><dd>${c.trades}</dd>
    </div>`;
  }

  function longestStreak(pnls) {
    let best = 0, cur = 0;
    pnls.forEach((p) => {
      if (p > 0) { cur++; best = Math.max(best, cur); } else cur = 0;
    });
    return best;
  }

  function bind(root, c) {
    root.querySelector("#calPrev").onclick = () => { state.month = F.addMonths(state.month, -1); load(); };
    root.querySelector("#calNext").onclick = () => { state.month = F.addMonths(state.month, 1); load(); };
    root.querySelector("#calToday").onclick = () => { state.month = currentMonth(); load(); };
    root.querySelector("#calMonth").onchange = (e) => {
      if (!e.target.value) return;
      state.month = e.target.value;
      load();
    };
    root.querySelectorAll(".cal-cell[data-date]").forEach((cell) => {
      cell.onclick = () => openDay(cell.dataset.date);
    });

    const chartEl = root.querySelector("#calChart");
    const days = (c.days || []).filter((d) => d.closed);
    SJ.charts.bars(
      chartEl,
      days.map((d) => ({ label: String(Number(d.date.slice(-2))), value: d.pnl, sub: `${d.closed} trades` })),
      { height: 220, format: (v) => F.signedMoney(v), empty: "No closed trades this month" }
    );
  }

  async function openDay(date) {
    let day;
    try {
      const res = await SJ.api("/api/day?date=" + encodeURIComponent(date));
      day = res.day;
    } catch (e) {
      return SJ.toast("Could not load day", e.message, "error");
    }
    const rows = (day.trades || []).map(tradeRow).join("");
    const openRows = (day.open_entries || []).map(tradeRow).join("");
    const body = `
      <div class="summary-strip" style="margin-bottom:14px">
        <div class="item"><span>Net P&amp;L</span><strong class="${F.cls(day.pnl)}">${F.signedMoney(day.pnl)}</strong></div>
        <div class="item"><span>Closed</span><strong>${day.closed}</strong></div>
        <div class="item"><span>Wins</span><strong class="pos">${day.wins}</strong></div>
        <div class="item"><span>Losses</span><strong class="neg">${day.losses}</strong></div>
      </div>
      ${day.trades.length ? `<div class="card"><div class="table-wrap" style="max-height:none">${table(day.trades)}</div></div>` : `<div class="empty" style="padding:28px">${icon("calendar")}<strong>No trades closed</strong><p>Nothing was booked on this day.</p></div>`}
      ${day.open_entries.length ? `<h3 class="mt" style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted)">Opened on this day (still open)</h3><div class="card mt"><div class="table-wrap" style="max-height:none">${table(day.open_entries)}</div></div>` : ""}
    `;
    SJ.openModal({ title: F.date(date, "long"), body, wide: true, footer: `<button class="btn ghost" data-x="close">Close</button>` , onMount: (b, f) => {
      f.querySelector('[data-x="close"]').onclick = SJ.closeModal;
      b.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.onclick = () => { SJ.closeModal(); SJ.tradeDetail(Number(tr.dataset.id)); };
      });
    }});
  }

  function tradeRow(t) {
    return `<tr data-id="${t.id}"><td>${esc(t.symbol)}</td><td>${F.signedMoney(t.pnl)}</td></tr>`;
  }

  function table(trades) {
    const rows = trades
      .map(
        (t) => `<tr data-id="${t.id}" style="cursor:pointer">
          <td><div class="symbol-cell"><strong>${esc(t.symbol)}</strong><span>${esc(t.exchange)}</span></div></td>
          <td>${t.status === "OPEN" ? '<span class="pill open">Open</span>' : t.status === "PROFIT" ? '<span class="pill profit">Profit</span>' : '<span class="pill loss">Loss</span>'}</td>
          <td class="num">${F.num(t.quantity, 4).replace(/,/g, "")}</td>
          <td class="num">${F.money(t.entry_price, 2)}</td>
          <td class="num">${t.exit_price === null ? "—" : F.money(t.exit_price, 2)}</td>
          <td>${esc(t.hold_label)}</td>
          <td class="num ${F.cls(t.pnl)} strong">${F.signedMoney(t.pnl)}</td>
          <td class="num ${F.cls(t.pnl_pct)}">${F.pct(t.pnl_pct)}</td>
        </tr>`
      )
      .join("");
    return `<table class="data"><thead><tr><th>Symbol</th><th>Status</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Exit</th><th>Hold</th><th class="num">P&amp;L</th><th class="num">P&amp;L %</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  SJ.views = SJ.views || {};
  SJ.views.calendar = {
    title: "Calendar",
    subtitle: "Month-by-month trading results with day-level detail",
    async render(el) {
      this.el = el;
      el.innerHTML = `<div id="calBody"><div class="loading"><div class="spinner"></div><span>Loading calendar…</span></div></div>`;
      await load();
    },
    refresh() { return load(); },
  };
})();
