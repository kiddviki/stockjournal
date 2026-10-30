/* =====================================================================
   Stats — range analysis, equity growth, symbol/month/weekday/R charts
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const F = SJ.fmt;
  const esc = SJ.escape;
  const icon = SJ.icon;

  const RANGES = [
    ["1w", "1W"], ["1m", "1M"], ["3m", "3M"], ["ytd", "YTD"],
    ["1y", "1Y"], ["5y", "5Y"], ["all", "All"], ["custom", "Custom"],
  ];

  const state = (SJ.stats = { range: null, start: "", end: "", data: null });

  const CARDS = [
    { key: "total_trades", label: "Total trades", get: (s) => ({ v: String(s.total_trades), c: "", sub: `${s.open_trades} still open` }) },
    { key: "win_rate", label: "Win rate", get: (s) => ({ v: (s.win_rate || 0).toFixed(1) + "%", c: "pos", sub: `${s.wins}W · ${s.losses}L · ${s.breakeven} flat` }) },
    { key: "profit_factor", label: "Profit factor", get: (s) => ({ v: s.profit_factor === null ? (s.total_trades ? "∞" : "—") : s.profit_factor.toFixed(2), c: s.profit_factor === null ? (s.total_trades ? "pos" : "") : s.profit_factor >= 1 ? "pos" : "neg", sub: `${F.compact(s.gross_profit)} / ${F.compact(Math.abs(s.gross_loss))}` }) },
    { key: "avg_win", label: "Average win", get: (s) => ({ v: F.signedMoney(s.avg_win), c: "pos", sub: s.avg_win_pct === null ? "—" : F.pct(s.avg_win_pct) + " avg return" }) },
    { key: "avg_loss", label: "Average loss", get: (s) => ({ v: F.signedMoney(s.avg_loss), c: "neg", sub: s.avg_loss_pct === null ? "—" : F.pct(s.avg_loss_pct) + " avg return" }) },
    { key: "largest_win", label: "Largest win", get: (s) => ({ v: F.signedMoney(s.largest_win), c: "pos", sub: `${s.largest_win_symbol || "—"} · ${s.largest_win_pct === null ? "—" : F.pct(s.largest_win_pct)}` }) },
    { key: "largest_loss", label: "Largest loss", get: (s) => ({ v: F.signedMoney(s.largest_loss), c: "neg", sub: `${s.largest_loss_symbol || "—"} · ${s.largest_loss_pct === null ? "—" : F.pct(s.largest_loss_pct)}` }) },
    { key: "avg_hold", label: "Average hold", get: (s) => ({ v: s.avg_hold === null ? "—" : s.avg_hold + " days", c: "", sub: `wins ${s.avg_win_hold === null ? "—" : s.avg_win_hold + "d"} · losses ${s.avg_loss_hold === null ? "—" : s.avg_loss_hold + "d"}` }) },
    { key: "expectancy", label: "Expectancy / trade", get: (s) => ({ v: F.signedMoney(s.expectancy), c: F.cls(s.expectancy), sub: `${F.pct(s.expectancy_pct)} of capital` }) },
    { key: "max_drawdown", label: "Max drawdown", get: (s) => ({ v: F.signedMoney(-Math.abs(s.max_drawdown || 0)), c: "neg", sub: `${(s.max_drawdown_pct || 0).toFixed(2)}% from peak` }) },
    { key: "total_r", label: "Total R", get: (s) => ({ v: s.total_r === null ? "—" : s.total_r.toFixed(2) + "R", c: F.cls(s.total_r), sub: s.avg_r === null ? "add stop-loss to track R" : `avg ${s.avg_r.toFixed(2)}R · ${s.r_count} trades` }) },
  ];

  function rangeLabel(s) {
    if (!s.start && !s.end) return "All time";
    return `${s.start ? F.date(s.start, "full") : "start"} → ${s.end ? F.date(s.end, "full") : "today"}`;
  }

  async function load() {
    const v = SJ.views.stats;
    if (!v || !v.el) return;
    const body = v.el.querySelector("#statsBody");
    if (body) body.innerHTML = `<div class="loading"><div class="spinner"></div><span>Analysing performance…</span></div>`;
    if (!state.range) state.range = (SJ.state.settings && SJ.state.settings.stats_range) || "1y";
    const qs = new URLSearchParams({ range: state.range });
    if (state.range === "custom") {
      qs.set("range", "custom");
      qs.set("start", state.start || "");
      qs.set("end", state.end || "");
    }
    try {
      const d = await SJ.api("/api/stats?" + qs.toString());
      state.data = d;
      render();
    } catch (e) {
      body.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not load stats.</strong><br>${esc(e.message)}</div></div>`;
    }
  }

  function render() {
    const v = SJ.views.stats;
    if (!v || !v.el || !state.data) return;
    const d = state.data;
    const s = d.stats;
    v.el.querySelector("#statsBody").innerHTML = shell(d);
    bind(v.el, d);
    drawCharts(d);
  }

  function shell(d) {
    const s = d.stats;
    const cfg = (SJ.state.settings && SJ.state.settings.stats_cards) || {};
    const cards = CARDS.filter((c) => cfg[c.key] !== false).map((c) => {
      const o = c.get(s);
      return `<div class="metric"><div class="k">${esc(c.label)}</div><div class="v ${o.c}">${esc(o.v)}</div><div class="s">${esc(o.sub)}</div></div>`;
    }).join("");

    return `
      <div class="page-head">
        <div class="grow">
          <h2>Performance analysis</h2>
          <p>${esc(rangeLabel(s))} · ${s.total_trades} closed trades · ${s.wins}W / ${s.losses}L</p>
        </div>
        <div class="page-actions">
          <div class="range-pills" id="statsRange">
            ${RANGES.map(([k, l]) => `<button class="range-pill ${state.range === k ? "active" : ""}" data-range="${k}">${l}</button>`).join("")}
          </div>
          <button class="btn ghost sm" id="statsCustomize">${icon("filter")} Stats</button>
        </div>
      </div>

      <div id="customRange" class="card mb" style="display:${state.range === "custom" ? "block" : "none"}">
        <div class="card-body row wrap">
          <div class="field"><label>From</label><input type="date" class="input sm" id="statStart" value="${esc(state.start)}"></div>
          <div class="field"><label>To</label><input type="date" class="input sm" id="statEnd" value="${esc(state.end)}"></div>
          <button class="btn primary sm" id="statApply" style="align-self:flex-end">Apply</button>
          <button class="btn ghost sm" id="statReset" style="align-self:flex-end">This year</button>
        </div>
      </div>

      <div class="stats-hero">
        <div class="card hero-main">
          <div class="row between" style="align-items:flex-start">
            <div>
              <div class="stat-label">Net P&amp;L · ${esc(rangeLabel(s))}</div>
              <div class="hero-pnl">
                <span class="big ${F.cls(s.net_pnl)}">${F.signedMoney(s.net_pnl, 0)}</span>
                <span class="pct ${F.cls(s.pl_pct)}">${F.pct(s.pl_pct)}</span>
              </div>
              <div class="hero-meta">
                <span>on <strong>${F.compact(s.deployed_capital)}</strong> deployed</span>
                ${s.account_pct !== null ? `<span>account return <strong class="${F.cls(s.account_pct)}">${F.pct(s.account_pct)}</strong></span>` : ""}
                <span>fees <strong>${F.money(s.fees)}</strong></span>
                <span>open P&amp;L <strong class="${F.cls(s.unrealised)}">${F.signedMoney(s.unrealised)}</strong></span>
              </div>
            </div>
            <div class="donut-wrap" id="statsDonut"></div>
          </div>
          <div class="chart mt" id="statsEquity" style="margin-bottom:-6px"></div>
        </div>
        <div class="card hero-side">
          ${kpi("Profit factor", s.profit_factor === null ? (s.total_trades ? "∞" : "—") : s.profit_factor.toFixed(2), s.profit_factor === null ? "" : F.cls(s.profit_factor - 1), "gross win ÷ gross loss")}
          ${kpi("Expectancy", F.signedMoney(s.expectancy), F.cls(s.expectancy), "avg result per trade")}
          ${kpi("Avg R", s.avg_r === null ? "—" : s.avg_r.toFixed(2) + "R", F.cls(s.avg_r), `${s.r_count} trades with stop-loss`)}
          ${kpi("Max drawdown", F.signedMoney(-Math.abs(s.max_drawdown || 0)), "neg", `${(s.max_drawdown_pct || 0).toFixed(1)}% from peak`)}
        </div>
      </div>

      <div class="metric-grid mt">${cards}</div>

      <div class="split-2 mt">
        <div class="card">
          <div class="card-head"><h3>P&amp;L by symbol</h3><div class="right"><span class="sub">${(d.symbols || []).length} symbols</span></div></div>
          <div class="card-body" id="statsSymbols"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Monthly P&amp;L</h3><div class="right"><span class="sub">last 12 months</span></div></div>
          <div class="card-body"><div class="chart" id="statsMonthly"></div></div>
        </div>
      </div>

      <div class="split-3 mt">
        <div class="card">
          <div class="card-head"><h3>Day of week</h3><div class="right"><span class="sub">by exit day</span></div></div>
          <div class="card-body"><div class="chart" id="statsWeekday"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>R multiple distribution</h3><div class="right"><span class="sub">${(d.r_distribution || {}).count || 0} trades</span></div></div>
          <div class="card-body"><div class="chart" id="statsR"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Month-by-month</h3></div>
          <div class="card-body tight" style="max-height:260px;overflow:auto">
            ${monthTable(d.monthly || [])}
          </div>
        </div>
      </div>

      <div class="split-2 mt">
        <div class="card">
          <div class="card-head"><h3>Setup performance</h3><div class="right"><span class="sub">by strategy tag</span></div></div>
          <div class="card-body tight">${strategyTable(d.strategies || [])}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Holding time</h3></div>
          <div class="card-body">
            <div class="row between mb"><span class="muted small">Winning trades</span><strong class="pos">${s.avg_win_hold === null ? "—" : s.avg_win_hold + " days"}</strong></div>
            <div class="progress-bar mb"><i style="width:${holdPct(s.avg_win_hold, s.avg_loss_hold)}%;background:var(--green)"></i></div>
            <div class="row between mb mt"><span class="muted small">Losing trades</span><strong class="neg">${s.avg_loss_hold === null ? "—" : s.avg_loss_hold + " days"}</strong></div>
            <div class="progress-bar mb"><i style="width:${100 - holdPct(s.avg_win_hold, s.avg_loss_hold)}%;background:var(--red)"></i></div>
            <div class="row between mt"><span class="muted small">Overall average</span><strong>${s.avg_hold === null ? "—" : s.avg_hold + " days"}</strong></div>
            <div class="row between mt"><span class="muted small">Best day</span><strong class="pos">${s.best_day ? F.signedMoney(s.best_day.pnl) + " · " + F.date(s.best_day.date, "day") : "—"}</strong></div>
            <div class="row between mt"><span class="muted small">Worst day</span><strong class="neg">${s.worst_day ? F.signedMoney(s.worst_day.pnl) + " · " + F.date(s.worst_day.date, "day") : "—"}</strong></div>
            <div class="row between mt"><span class="muted small">Current streak</span><strong class="${s.streak_kind === "WIN" ? "pos" : s.streak_kind === "LOSS" ? "neg" : ""}">${s.streak ? s.streak + " " + (s.streak_kind === "WIN" ? "winning" : "losing") : "—"}</strong></div>
          </div>
        </div>
      </div>
    `;
  }

  function kpi(label, value, cls, sub) {
    return `<div class="kpi"><div class="k">${esc(label)}</div><div class="v ${cls || ""}">${esc(value)}</div><div class="s">${esc(sub || "")}</div></div>`;
  }

  function holdPct(win, loss) {
    const a = Number(win) || 0, b = Number(loss) || 0;
    if (a + b === 0) return 50;
    return Math.round((a / (a + b)) * 100);
  }

  function monthTable(months) {
    if (!months.length) return `<div class="empty" style="padding:24px">No closed months yet</div>`;
    const rows = months.slice(-12).reverse().map((m) => `
      <tr>
        <td class="nowrap">${esc(m.label)}</td>
        <td class="num">${m.trades}</td>
        <td class="num">${m.win_rate}%</td>
        <td class="num ${F.cls(m.pnl)} strong">${F.signedMoney(m.pnl)}</td>
        <td class="num ${F.cls(m.pnl_pct)}">${F.pct(m.pnl_pct)}</td>
      </tr>`).join("");
    return `<table class="mini-table"><thead><tr><th>Month</th><th class="num">Trades</th><th class="num">Win%</th><th class="num">P&amp;L</th><th class="num">Return</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function strategyTable(items) {
    if (!items.length) return `<div class="empty" style="padding:24px">Tag your trades with a setup to see this</div>`;
    const rows = items.map((x) => `
      <tr>
        <td>${esc(x.strategy)}</td>
        <td class="num">${x.trades}</td>
        <td class="num">${x.win_rate}%</td>
        <td class="num ${F.cls(x.pnl)} strong">${F.signedMoney(x.pnl)}</td>
        <td class="num ${F.cls(x.avg_pnl)}">${F.signedMoney(x.avg_pnl)}</td>
      </tr>`).join("");
    return `<table class="mini-table"><thead><tr><th>Setup</th><th class="num">Trades</th><th class="num">Win%</th><th class="num">P&amp;L</th><th class="num">Avg</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function drawCharts(d) {
    const s = d.stats;
    SJ.charts.donut(document.getElementById("statsDonut"), s.win_rate, { label: "win rate" });
    SJ.charts.line(
      document.getElementById("statsEquity"),
      (s.equity_curve || []).map((p) => ({ date: p.date, value: p.equity })),
      { height: 210, format: (v) => F.signedMoney(v), empty: "Close a trade to build the equity curve" }
    );
    SJ.charts.hbar(
      document.getElementById("statsSymbols"),
      (d.symbols || []).slice(0, 10).map((x) => ({ label: x.symbol, value: x.pnl, sub: `${x.trades} trades · ${x.win_rate}% win` }))
    );
    SJ.charts.bars(
      document.getElementById("statsMonthly"),
      (d.monthly || []).slice(-12).map((m) => ({ label: m.label.slice(0, 3) + " " + m.label.slice(-2), value: m.pnl, sub: `${m.trades} trades` })),
      { height: 230, format: (v) => F.signedMoney(v) }
    );
    SJ.charts.bars(
      document.getElementById("statsWeekday"),
      (d.weekday || []).map((w) => ({ label: w.weekday, value: w.pnl, sub: `${w.trades} trades · ${w.win_rate}% win` })),
      { height: 220, format: (v) => F.signedMoney(v) }
    );
    const r = d.r_distribution || { buckets: [] };
    SJ.charts.bars(
      document.getElementById("statsR"),
      (r.buckets || []).map((b) => ({
        label: b.bucket.replace(" to ", "–"),
        value: b.count,
        color: b.bucket.startsWith("-") || b.bucket.startsWith("<") ? "var(--red)" : "var(--green)",
      })),
      { height: 220, format: (v, item) => `${v} trades` }
    );
  }

  function bind(root, d) {
    root.querySelectorAll("#statsRange .range-pill").forEach((b) => {
      b.onclick = () => {
        state.range = b.dataset.range;
        SJ.api("/api/settings", { method: "PUT", body: { stats_range: state.range } }).catch(() => {});
        if (state.range === "custom") {
          root.querySelectorAll("#statsRange .range-pill").forEach((x) => x.classList.toggle("active", x === b));
          root.querySelector("#customRange").style.display = "block";
          return;
        }
        load();
      };
    });
    const apply = root.querySelector("#statApply");
    if (apply)
      apply.onclick = () => {
        state.start = root.querySelector("#statStart").value;
        state.end = root.querySelector("#statEnd").value;
        if (!state.start || !state.end) return SJ.toast("Pick both dates", "Choose a start and end date", "warn");
        load();
      };
    const reset = root.querySelector("#statReset");
    if (reset)
      reset.onclick = () => {
        const y = new Date().getFullYear();
        state.start = `${y}-01-01`;
        state.end = F.todayISO();
        root.querySelector("#statStart").value = state.start;
        root.querySelector("#statEnd").value = state.end;
        state.range = "custom";
        load();
      };
    const customize = root.querySelector("#statsCustomize");
    if (customize) customize.onclick = customizeDialog;
  }

  function customizeDialog() {
    const cfg = (SJ.state.settings && SJ.state.settings.stats_cards) || {};
    const body = `<p class="muted small" style="margin-top:0">Pick the metrics you want to see. Saved automatically.</p>
      <div class="checks">${CARDS.map(
        (c) => `<label class="check"><input type="checkbox" name="sc" value="${c.key}" ${cfg[c.key] !== false ? "checked" : ""}> ${esc(c.label)}</label>`
      ).join("")}</div>`;
    SJ.openModal({
      title: "Customise stats",
      body,
      footer: `<button class="btn ghost" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save</button>`,
      onMount: (b, f) => {
        f.querySelector('[data-x="cancel"]').onclick = SJ.closeModal;
        f.querySelector('[data-x="save"]').onclick = async () => {
          const next = {};
          CARDS.forEach((c) => (next[c.key] = false));
          b.querySelectorAll('input[name="sc"]:checked').forEach((i) => (next[i.value] = true));
          try {
            const res = await SJ.api("/api/settings", { method: "PUT", body: { stats_cards: next } });
            SJ.state.settings = res.settings;
            SJ.closeModal();
            render();
            SJ.toast("Stats updated", "", "success");
          } catch (e) {
            SJ.toast("Could not save", e.message, "error");
          }
        };
      },
    });
  }

  SJ.STAT_CARDS = CARDS;

  SJ.views = SJ.views || {};
  SJ.views.stats = {
    title: "Stats",
    subtitle: "Win rate, profit factor, expectancy and risk over any period",
    async render(el) {
      this.el = el;
      state.start = state.start || `${new Date().getFullYear()}-01-01`;
      state.end = state.end || F.todayISO();
      el.innerHTML = `<div id="statsBody"><div class="loading"><div class="spinner"></div><span>Loading stats…</span></div></div>`;
      await load();
    },
    refresh() { return load(); },
  };
})();
