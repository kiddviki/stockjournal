/* =====================================================================
   Dashboard — stat cards, sortable/filterable trade table, columns
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const F = SJ.fmt;
  const { esc, icon } = { esc: SJ.escape, icon: SJ.icon };

  const RANGES = [
    ["1m", "1M"], ["3m", "3M"], ["6m", "6M"], ["1y", "1Y"], ["5y", "5Y"], ["all", "All"],
  ];

  const COLUMNS = [
    { key: "date", label: "Date", sort: "date" },
    { key: "symbol", label: "Symbol", sort: "symbol" },
    { key: "status", label: "Status", sort: "status" },
    { key: "side", label: "Side" },
    { key: "quantity", label: "Qty", sort: "qty", num: true },
    { key: "entry", label: "Entry", num: true },
    { key: "exit", label: "Exit", num: true },
    { key: "ltp", label: "LTP", num: true },
    { key: "hold", label: "Hold", sort: "hold" },
    { key: "pnl", label: "P&L", sort: "pnl", num: true },
    { key: "pnl_pct", label: "P&L %", sort: "pnl_pct", num: true },
    { key: "r", label: "R", sort: "r", num: true },
    { key: "fees", label: "Fees", num: true },
    { key: "strategy", label: "Setup" },
    { key: "tags", label: "Tags" },
    { key: "notes", label: "Notes" },
    { key: "photo", label: "📷" },
    { key: "actions", label: "" },
  ];

  const state = (SJ.dash = {
    range: null,
    status: "all",
    sort: "date_desc",
    search: "",
    loaded: false,
    data: null,
  });

  function viewState() {
    if (!state.range) {
      state.range = (SJ.state.settings && SJ.state.settings.dashboard_range) || "3m";
      state.status = (SJ.state.settings && SJ.state.settings.dashboard_status) || "all";
      state.sort = (SJ.state.settings && SJ.state.settings.dashboard_sort) || "date_desc";
    }
    return state;
  }

  function rangeText(stats) {
    if (!stats) return "";
    if (!stats.start && !stats.end) return "All time";
    return `${F.date(stats.start, "full")} → ${F.date(stats.end, "full")}`;
  }

  async function load(force) {
    viewState();
    const v = SJ.views.dashboard;
    if (!v || !v.el) return;
    const wrap = v.el.querySelector("#dashBody");
    if (!state.data || force) wrap.innerHTML = `<div class="loading"><div class="spinner"></div><span>Crunching numbers…</span></div>`;
    const qs = new URLSearchParams({ range: state.range, status: state.status, sort: state.sort });
    try {
      const data = await SJ.api("/api/dashboard?" + qs.toString());
      state.data = data;
      state.loaded = true;
      render();
    } catch (e) {
      wrap.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not load the dashboard.</strong><br>${esc(e.message)}</div></div>`;
    }
  }

  function render() {
    const v = SJ.views.dashboard;
    if (!v || !v.el) return;
    const d = state.data;
    if (!d) return;
    v.el.querySelector("#dashBody").innerHTML = shell(d);
    bind(v.el, d);
    drawCharts(d);
    updateSideNumbers(d);
    updateShownCount(v.el);
  }

  function updateSideNumbers(d) {
    const h = d.holdings || {};
    const so = document.getElementById("sideOpen");
    const sh = document.getElementById("sideHoldings");
    if (so) so.textContent = d.stats.open_trades;
    if (sh) sh.textContent = F.compact(h.worth || 0);
  }

  function updateShownCount(root) {
    const label = root.querySelector("#dashCount");
    if (!label) return;
    const n = root.querySelectorAll("#dashTable tbody tr[data-id]").length;
    label.textContent = `${n} trade${n === 1 ? "" : "s"} shown`;
  }

  function shell(d) {
    const s = d.stats;
    const h = d.holdings || {};
    const acct = h.account_value || 0;
    const active = state.status;
    const cards = [
      {
        key: "win", label: "Win rate", value: (s.win_rate || 0).toFixed(1) + "%", cls: "pos",
        sub: `${s.wins}W · ${s.losses}L`, status: "profit", sort: "pnl_desc", clickable: true,
        active: active === "profit", hint: "Click to sort winning trades",
      },
      {
        key: "loss", label: "Loss rate", value: (s.loss_rate || 0).toFixed(1) + "%", cls: "neg",
        sub: `${s.losses}L · ${s.breakeven} flat`, status: "loss", sort: "pnl_asc", clickable: true,
        active: active === "loss", hint: "Click to sort losing trades",
      },
      {
        key: "avgwin", label: "Avg win", value: F.signedMoney(s.avg_win), cls: "pos",
        sub: s.avg_win_pct !== null ? F.pct(s.avg_win_pct) + " avg" : "no wins yet",
      },
      {
        key: "avgloss", label: "Avg loss", value: F.signedMoney(s.avg_loss), cls: "neg",
        sub: s.avg_loss_pct !== null ? F.pct(s.avg_loss_pct) + " avg" : "no losses yet",
      },
      {
        key: "open", label: "Open trades", value: String(s.open_trades), cls: "",
        sub: `${F.compact(s.open_invested)} deployed`, status: "open", sort: "date_desc", clickable: true,
        active: active === "open", hint: "Click to show open trades only",
      },
      {
        key: "net", label: "Net P&L", value: F.signedMoney(s.net_pnl), cls: F.cls(s.net_pnl),
        sub: `${F.pct(s.pl_pct)} on deployed`,
      },
      {
        key: "pf", label: "Profit factor", value: s.profit_factor === null ? (s.total_trades ? "∞" : "—") : s.profit_factor.toFixed(2),
        cls: s.profit_factor === null ? (s.total_trades ? "pos" : "") : s.profit_factor >= 1 ? "pos" : "neg",
        sub: `${s.total_trades} closed trades`,
      },
    ];

    const cardHtml = cards
      .map(
        (c) => `<button class="stat-card ${c.clickable ? "clickable" : ""} ${c.active ? "active" : ""}"
          ${c.clickable ? `data-status="${c.status}" data-sort="${c.sort}" title="${esc(c.hint)}"` : `tabindex="-1"`}>
          <div class="stat-label">${esc(c.label)}</div>
          <div class="stat-value ${c.cls}">${esc(c.value)}</div>
          <div class="stat-sub">${esc(c.sub)}</div>
        </button>`
      )
      .join("");

    const chips = [
      ["all", "All"],
      ["open", "Open"],
      ["profit", "Wins"],
      ["loss", "Losses"],
    ]
      .map(([k, lbl]) => {
        const activeCls = state.status === k ? `active ${k === "profit" ? "pos" : k === "loss" ? "neg" : ""}` : "";
        return `<button class="chip ${activeCls}" data-status="${k}">${lbl}</button>`;
      })
      .join("");

    return `
      <div class="page-head">
        <div class="grow">
          <h2>Performance overview</h2>
          <p>${esc(rangeText(s))} · ${s.total_trades} closed · ${s.open_trades} open</p>
        </div>
        <div class="page-actions">
          <div class="range-pills" id="dashRange">
            ${RANGES.map(([k, l]) => `<button class="range-pill ${state.range === k ? "active" : ""}" data-range="${k}">${l}</button>`).join("")}
          </div>
          <button class="btn ghost sm" id="dashCols">${icon("filter")} Columns</button>
        </div>
      </div>

      <div class="summary-strip">
        <div class="item"><span>Account value</span><strong>${F.money(acct, 0)}</strong></div>
        <div class="item"><span>Cash balance</span><strong>${F.money(h.balance || 0, 0)}</strong></div>
        <div class="item"><span>Holdings</span><strong>${F.money(h.worth || 0, 0)}</strong></div>
        <div class="item"><span>Open P&amp;L</span><strong class="${F.cls(s.unrealised)}">${F.signedMoney(s.unrealised)}</strong></div>
        <div class="item"><span>Avg hold</span><strong>${s.avg_hold === null ? "—" : s.avg_hold + "d"}</strong></div>
        <div class="item"><span>Streak</span><strong class="${s.streak_kind === "WIN" ? "pos" : s.streak_kind === "LOSS" ? "neg" : ""}">${s.streak ? s.streak + " " + (s.streak_kind === "WIN" ? "wins" : "losses") : "—"}</strong></div>
        <div class="item" style="margin-left:auto"><span>Data</span><strong class="dim">${esc(h.source || "Journal")}</strong></div>
      </div>

      <div class="stat-grid">${cardHtml}</div>

      <div class="card mt">
        <div class="toolbar">
          <div class="search-wrap">${icon("search")}<input class="input sm" id="dashSearch" placeholder="Search symbol, notes, setup…" value="${esc(state.search)}"></div>
          <div class="chips" id="dashChips">${chips}</div>
          <div class="right">
            <select class="select sm" id="dashSort" style="width:auto" title="Sort">
              <option value="date_desc"${state.sort === "date_desc" ? " selected" : ""}>Newest first</option>
              <option value="date_asc"${state.sort === "date_asc" ? " selected" : ""}>Oldest first</option>
              <option value="pnl_desc"${state.sort === "pnl_desc" ? " selected" : ""}>P&amp;L high → low</option>
              <option value="pnl_asc"${state.sort === "pnl_asc" ? " selected" : ""}>P&amp;L low → high</option>
              <option value="hold_desc"${state.sort === "hold_desc" ? " selected" : ""}>Longest hold</option>
              <option value="hold_asc"${state.sort === "hold_asc" ? " selected" : ""}>Shortest hold</option>
              <option value="r_desc"${state.sort === "r_desc" ? " selected" : ""}>R multiple high → low</option>
            </select>
            <button class="btn ghost sm" id="dashExport" title="Export journal as CSV">${icon("download")}<span class="hide-sm">Export</span></button>
          </div>
        </div>
        <div class="table-wrap" id="dashTable">${tableHtml(d.trades)}</div>
        <div class="row between" style="padding:10px 14px;border-top:1px solid var(--border-soft);font-size:11px;color:var(--muted)">
          <span id="dashCount">${d.trades.length} trades shown</span>
          <span>Click a row for full details · click a card above to sort/filter</span>
        </div>
      </div>

      <div class="split-2 mt">
        <div class="card">
          <div class="card-head"><h3>Equity curve</h3><div class="right"><span class="sub">${esc(rangeText(s))}</span></div></div>
          <div class="card-body"><div class="chart" id="dashEquity"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>P&amp;L by symbol</h3><div class="right"><span class="sub">top ${Math.min(8, (d.symbols || []).length)}</span></div></div>
          <div class="card-body" id="dashSymbols"></div>
        </div>
      </div>
    `;
  }

  function visibleColumns() {
    const cfg = (SJ.state.settings && SJ.state.settings.columns) || {};
    return COLUMNS.filter((c) => (c.key === "actions" ? true : cfg[c.key] !== false));
  }

  function tableHtml(trades) {
    const search = state.search.trim().toLowerCase();
    let rows = trades;
    if (search) {
      rows = trades.filter((t) =>
        [t.symbol, t.notes, t.strategy, t.tags, t.entry_date, t.exit_date].join(" ").toLowerCase().includes(search)
      );
    }
    const cols = visibleColumns();
    const head = cols
      .map((c) => {
        const sorted = c.sort && state.sort.startsWith(c.sort);
        const dir = state.sort.endsWith("_asc") ? "↑" : "↓";
        return `<th class="${c.num ? "num" : ""} ${c.sort ? "sortable" : ""} ${sorted ? "sorted" : ""}" ${c.sort ? `data-sortcol="${c.sort}"` : ""}>
          ${esc(c.label)}${c.sort ? `<span class="sort-ind">${sorted ? dir : "↕"}</span>` : ""}</th>`;
      })
      .join("");
    if (!rows.length) {
      return `<table class="data"><thead><tr>${head}</tr></thead><tbody><tr><td colspan="${cols.length}">
        <div class="empty"><span class="big-icon">${icon("book")}</span><strong>No trades here yet</strong>
        <p>${trades.length ? "Nothing matches your search." : "Add your first trade or import a broker CSV to get started."}</p>
        <button class="btn primary sm" data-act="add">${icon("plus")} Add trade</button></div>
      </td></tr></tbody></table>`;
    }
    const body = rows
      .map((t) => {
        const cells = cols
          .map((c) => {
            switch (c.key) {
              case "date":
                return `<td class="nowrap">${esc(F.date(t.entry_date))}${t.exit_date ? `<div class="tiny dim">→ ${esc(F.date(t.exit_date))}</div>` : ""}</td>`;
              case "symbol":
                return `<td><div class="symbol-cell"><strong>${esc(t.symbol)}</strong><span>${esc(t.exchange || "NSE")}${t.side === "SHORT" ? ' · <b class="side-tag short">SHORT</b>' : ""}${t.source && t.source !== "MANUAL" ? " · " + esc(t.source) : ""}</span></div></td>`;
              case "status":
                return `<td>${statusPill(t.status)}</td>`;
              case "side":
                return `<td><span class="side-tag ${t.side === "SHORT" ? "short" : ""}">${esc(t.side)}</span></td>`;
              case "quantity":
                return `<td class="num">${F.num(t.quantity, 4).replace(/,/g, "")}</td>`;
              case "entry":
                return `<td class="num">${F.money(t.entry_price, 2)}</td>`;
              case "exit":
                return `<td class="num">${t.exit_price !== null && t.exit_price !== undefined ? F.money(t.exit_price, 2) : '<span class="dim">—</span>'}</td>`;
              case "ltp":
                return `<td class="num">${t.ltp ? F.money(t.ltp, 2) : '<span class="dim">—</span>'}</td>`;
              case "hold":
                return `<td class="nowrap">${esc(t.hold_label)}</td>`;
              case "pnl":
                return `<td class="num ${F.cls(t.pnl)} strong">${t.pnl === null ? "—" : F.signedMoney(t.pnl)}</td>`;
              case "pnl_pct":
                return `<td class="num ${F.cls(t.pnl_pct)}">${t.pnl_pct === null ? "—" : F.pct(t.pnl_pct)}</td>`;
              case "r":
                return `<td class="num ${F.cls(t.r_multiple)}">${t.r_multiple === null ? '<span class="dim">—</span>' : esc(t.r_multiple.toFixed(2)) + "R"}</td>`;
              case "fees":
                return `<td class="num dim">${t.fees ? F.money(t.fees, 2) : "—"}</td>`;
              case "strategy":
                return `<td class="nowrap">${t.strategy ? esc(t.strategy) : '<span class="dim">—</span>'}</td>`;
              case "tags":
                return `<td>${t.tags ? t.tags.split(",").slice(0, 3).map((x) => `<span class="tag">${esc(x.trim())}</span>`).join("") : '<span class="dim">—</span>'}</td>`;
              case "notes":
                return `<td><div class="notes-cell" title="${esc(t.notes)}">${t.notes ? esc(t.notes) : '<span class="dim">—</span>'}</div></td>`;
              case "photo":
                return `<td>${(t.photos || []).length ? `<span class="thumb-dot" title="${t.photos.length} screenshot(s)">${icon("camera")}</span>` : '<span class="dim">—</span>'}</td>`;
              case "actions":
                return `<td><div class="row-actions">
                    <button class="icon-btn sm" data-act="edit" data-id="${t.id}" title="Edit">${icon("edit")}</button>
                    ${t.status === "OPEN" ? `<button class="icon-btn sm" data-act="close" data-id="${t.id}" title="Close trade">${icon("check")}</button>` : `<button class="icon-btn sm" data-act="reopen" data-id="${t.id}" title="Re-open">${icon("refresh")}</button>`}
                    <button class="icon-btn sm danger" data-act="delete" data-id="${t.id}" title="Delete">${icon("trash")}</button>
                  </div></td>`;
              default:
                return "<td></td>";
            }
          })
          .join("");
        return `<tr data-id="${t.id}" class="${t.status === "OPEN" ? "is-open" : ""}">${cells}</tr>`;
      })
      .join("");
    return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function statusPill(st) {
    return SJ.statusLabel({ status: st }) && `<span class="pill ${st === "OPEN" ? "open" : st === "PROFIT" ? "profit" : "loss"}">${st === "OPEN" ? "Open" : st === "PROFIT" ? "Profit" : "Loss"}</span>`;
  }

  function drawCharts(d) {
    const curve = (d.stats.equity_curve || []).map((p) => ({ date: p.date, value: p.equity }));
    SJ.charts.line(document.getElementById("dashEquity"), curve, {
      height: 200,
      format: (v) => F.signedMoney(v),
      empty: "Close a trade to start the equity curve",
    });
    const syms = (d.symbols || []).slice(0, 8).map((s) => ({
      label: s.symbol,
      value: s.pnl,
      sub: `${s.trades} trades · ${s.win_rate}% win`,
    }));
    SJ.charts.hbar(document.getElementById("dashSymbols"), syms);
  }

  function bind(root, d) {
    root.querySelectorAll("#dashRange .range-pill").forEach((b) => {
      b.onclick = () => {
        state.range = b.dataset.range;
        SJ.api("/api/settings", { method: "PUT", body: { dashboard_range: state.range } }).catch(() => {});
        load(true);
      };
    });

    root.querySelectorAll(".stat-card.clickable").forEach((card) => {
      card.onclick = () => {
        const st = card.dataset.status;
        if (state.status === st) {
          state.status = "all";
          state.sort = "date_desc";
        } else {
          state.status = st;
          state.sort = card.dataset.sort;
        }
        load(true);
      };
    });

    root.querySelectorAll("#dashChips .chip").forEach((chip) => {
      chip.onclick = () => {
        state.status = chip.dataset.status;
        if (state.status === "all") state.sort = "date_desc";
        else if (state.status === "profit") state.sort = "pnl_desc";
        else if (state.status === "loss") state.sort = "pnl_asc";
        else state.sort = "date_desc";
        load(true);
      };
    });

    const sortSel = root.querySelector("#dashSort");
    if (sortSel)
      sortSel.onchange = () => {
        state.sort = sortSel.value;
        load(true);
      };

    const search = root.querySelector("#dashSearch");
    if (search) {
      search.oninput = SJ.debounce(() => {
        state.search = search.value;
        const t = root.querySelector("#dashTable");
        if (t && state.data) {
          t.innerHTML = tableHtml(state.data.trades);
          updateShownCount(root);
        }
      }, 180);
    }

    root.querySelector("#dashCols").onclick = columnsDialog;
    root.querySelector("#dashExport").onclick = () => SJ.download("/api/export/csv", `stock-journal-${F.todayISO()}.csv`);

    root.querySelectorAll("th.sortable").forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sortcol;
        const isAsc = state.sort === key + "_asc";
        state.sort = isAsc ? key + "_desc" : key + "_asc";
        load(true);
      };
    });

    const table = root.querySelector("#dashTable");
    table.onclick = (e) => {
      if (e.target.closest('[data-act="add"]')) {
        SJ.tradeForm(null);
        return;
      }
      const action = e.target.closest("[data-act]");
      if (action) {
        e.stopPropagation();
        const id = Number(action.dataset.id);
        const trade = (state.data.trades || []).find((t) => t.id === id);
        if (action.dataset.act === "edit") SJ.tradeForm(id);
        else if (action.dataset.act === "close") SJ.closeTradeDialog(trade);
        else if (action.dataset.act === "reopen") SJ.reopenTrade(trade);
        else if (action.dataset.act === "delete") SJ.deleteTrade(trade);
        return;
      }
      const row = e.target.closest("tr[data-id]");
      if (row) SJ.tradeDetail(Number(row.dataset.id));
    };
  }

  function columnsDialog() {
    const cfg = (SJ.state.settings && SJ.state.settings.columns) || {};
    const body = `<p class="muted small" style="margin-top:0">Choose which columns appear in the trade table. Your choice is saved on this computer.</p>
      <div class="checks">${COLUMNS.filter((c) => c.key !== "actions")
        .map((c) => `<label class="check"><input type="checkbox" name="col" value="${c.key}" ${cfg[c.key] !== false ? "checked" : ""}> ${esc(c.label)}</label>`)
        .join("")}</div>`;
    SJ.openModal({
      title: "Customise columns",
      body,
      footer: `<button class="btn ghost" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save columns</button>`,
      onMount: (b, f) => {
        f.querySelector('[data-x="cancel"]').onclick = SJ.closeModal;
        f.querySelector('[data-x="save"]').onclick = async () => {
          const next = {};
          COLUMNS.forEach((c) => { if (c.key !== "actions") next[c.key] = false; });
          b.querySelectorAll('input[name="col"]:checked').forEach((i) => (next[i.value] = true));
          next.actions = true;
          try {
            const res = await SJ.api("/api/settings", { method: "PUT", body: { columns: next } });
            SJ.state.settings = res.settings;
            SJ.closeModal();
            load(true);
            SJ.toast("Columns updated", "", "success");
          } catch (e) {
            SJ.toast("Could not save", e.message, "error");
          }
        };
      },
    });
  }

  SJ.DASH_COLUMNS = COLUMNS;

  SJ.views = SJ.views || {};
  SJ.views.dashboard = {
    title: "Dashboard",
    subtitle: "Your trades, performance and open risk in one place",
    async render(el) {
      this.el = el;
      el.innerHTML = `<div id="dashBody"><div class="loading"><div class="spinner"></div><span>Loading your journal…</span></div></div>`;
      await load(state.loaded === false);
      state.loaded = true;
    },
    refresh() { return load(true); },
  };
})();
