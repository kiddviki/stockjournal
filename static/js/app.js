/* =====================================================================
   App shell: bootstrap, routing, sidebar, top bar
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const F = SJ.fmt;
  const esc = SJ.escape;
  const icon = SJ.icon;

  const VIEWS = ["dashboard", "stats", "calendar", "review", "import", "broker", "settings"];

  function currentView() {
    const h = (location.hash || "#dashboard").replace(/^#\/?/, "").split("?")[0];
    return VIEWS.includes(h) ? h : "dashboard";
  }

  async function loadBootstrap() {
    try {
      const b = await SJ.api("/api/bootstrap");
      SJ.state.bootstrap = b;
      SJ.state.settings = b.settings;
      SJ.state.reviewCount = b.review_count;
      const settings = b.settings || {};
      if (!SJ.param("theme")) {
        const local = (() => { try { return localStorage.getItem("sj-theme"); } catch (e) { return null; } })();
        SJ.applyTheme(local || settings.theme || "dark");
      }
      renderChrome(b);
      return b;
    } catch (e) {
      document.getElementById("view").innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>The journal server is not responding.</strong><br>${esc(e.message)}</div></div>`;
      return null;
    }
  }

  function renderChrome(b) {
    const h = b.holdings || {};
    const chips = document.getElementById("accountChips");
    if (chips) {
      chips.innerHTML = `
        <button class="acct-chip" data-go="settings" title="Edit cash balance"><span>Cash</span><strong>${F.compact(h.balance || 0)}</strong></button>
        <button class="acct-chip" data-go="settings" title="Holdings market value"><span>Holdings</span><strong>${F.compact(h.worth || 0)}</strong></button>
        <button class="acct-chip" data-go="settings" title="Cash + holdings"><span>Account</span><strong>${F.compact(h.account_value || 0)}</strong></button>`;
      chips.querySelectorAll("[data-go]").forEach((el) => {
        el.onclick = () => (location.hash = "#" + el.dataset.go);
      });
    }
    const so = document.getElementById("sideOpen");
    const sh = document.getElementById("sideHoldings");
    if (so) so.textContent = h.open_trades ?? "—";
    if (sh) sh.textContent = F.compact(h.worth || 0);
    const dp = document.getElementById("dataPath");
    if (dp) { dp.textContent = b.storage.data_dir; dp.title = b.storage.data_dir; }
    setBadge(b.review_count || 0);
    const dot = document.getElementById("brokerDot");
    if (dot) dot.classList.toggle("online", !!(b.broker && b.broker.connected));
  }

  function setBadge(n) {
    SJ.state.reviewCount = n;
    const badge = document.getElementById("reviewBadge");
    if (!badge) return;
    badge.textContent = n;
    badge.classList.toggle("hidden", !n);
  }

  async function refreshBadges() {
    try {
      const [r, b] = await Promise.all([SJ.api("/api/review?status=PENDING"), SJ.api("/api/broker/status")]);
      setBadge(r.pending || 0);
      const dot = document.getElementById("brokerDot");
      if (dot) dot.classList.toggle("online", !!b.connected);
      const boot = await SJ.api("/api/bootstrap");
      SJ.state.bootstrap = boot;
      SJ.state.settings = boot.settings;
      renderChrome(boot);
    } catch (e) { /* quiet */ }
  }

  function setActiveNav(view) {
    document.querySelectorAll("#nav .nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  }

  async function route() {
    const view = currentView();
    SJ.state.view = view;
    setActiveNav(view);
    const def = SJ.views[view];
    const title = def ? def.title : "Dashboard";
    document.getElementById("pageTitle").textContent = title;
    document.getElementById("pageSubtitle").textContent = def ? def.subtitle : "";
    document.title = `${title} · Stock Journal`;
    if (!def) return;
    SJ.charts.clear();
    const el = document.getElementById("view");
    el.scrollTop = 0;
    window.scrollTo({ top: 0 });
    el.innerHTML = `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`;
    try {
      await def.render(el);
      SJ.hydrateIcons(el);
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Something went wrong rendering this page.</strong><br>${esc(e.message)}</div></div>`;
    }
    document.body.classList.remove("nav-hidden");
  }

  function refreshCurrent() {
    const view = currentView();
    const def = SJ.views[view];
    if (!def) return;
    if (typeof def.refresh === "function") def.refresh();
    else route();
  }

  SJ.loadBootstrap = loadBootstrap;
  SJ.refreshBadges = refreshBadges;
  SJ.refreshCurrent = refreshCurrent;

  /* ----------------------------- wiring ----------------------------- */
  document.getElementById("nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (!btn) return;
    const v = btn.dataset.view;
    if (currentView() === v) {
      refreshCurrent();
      return;
    }
    location.hash = "#" + v;
  });

  document.getElementById("addTradeBtn").onclick = () => SJ.tradeForm(null);

  document.getElementById("refreshBtn").onclick = async () => {
    await refreshBadges();
    refreshCurrent();
    SJ.toast("Refreshed", "Latest journal data loaded", "info");
  };

  document.getElementById("menuBtn").onclick = () => {
    document.body.classList.toggle("nav-hidden");
  };

  window.addEventListener("hashchange", route);

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target.isContentEditable) return;
    if (document.getElementById("modalBackdrop").hidden === false) return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      SJ.tradeForm(null);
    }
    if (e.key === "/") {
      const search = document.getElementById("dashSearch");
      if (search) { e.preventDefault(); search.focus(); }
    }
  });

  // expose a tiny health ping so the UI can warn if the server dies
  setInterval(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error("bad");
    } catch (e) {
      SJ.toast("Server disconnected", "Restart the Stock Journal app and refresh this page.", "error");
    }
  }, 60000);

  (async function boot() {
    const b = await loadBootstrap();
    if (!b) return;
    await route();
    if (b.review_count > 0 && currentView() !== "review") {
      SJ.toast(`${b.review_count} item(s) need review`, "Open the Review tab to keep the journal clean", "warn");
    }
    if ((b.storage.db_size === 0 || !b.holdings) && currentView() === "dashboard") {
      // no-op: empty state is handled by the dashboard
    }
  })();
})();
