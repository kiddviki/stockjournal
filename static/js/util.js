/* =====================================================================
   Shared helpers: API, formatting, icons, modal, toast
   ===================================================================== */
(function () {
  "use strict";

  const SJ = (window.SJ = window.SJ || {});
  SJ.state = { settings: null, bootstrap: null, view: "dashboard", reviewCount: 0 };

  /* ----------------------------- icons ----------------------------- */
  const P = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    chart: '<path d="M3 20h18"/><path d="M6 16V9"/><path d="M11 16V4"/><path d="M16 16v-5"/><path d="M21 16v-8"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>',
    plug: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 01-12 0V9z"/><path d="M12 18v3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 005 8.9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 3v6h-6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/>',
    camera: '<path d="M4 7h3l2-2h6l2 2h3v13H4z"/><circle cx="12" cy="13" r="3.4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<path d="M12 3l9 17H3L12 3z"/><path d="M12 9v5"/><circle cx="12" cy="17.2" r=".8" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>',
    xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5z"/>',
    eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r=".9" fill="currentColor"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5L5 20"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4L10 14"/><path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5"/>',
    star: '<path d="M12 3l2.7 5.7 6.3.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.3-.9L12 3z"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><path d="M8 21v-7h8v7"/>',
    play: '<path d="M7 4l13 8-13 8V4z"/>',
    sync: '<path d="M4 12a8 8 0 0113.7-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 01-13.7 5.7L4 16"/><path d="M4 20v-4h4"/>',
    bell: '<path d="M18 9a6 6 0 10-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a1.8 1.8 0 003 0"/>',
    logout: '<path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
    up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tag: '<path d="M20 12l-8 8-8-8V4h8l8 8z"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/>',
    book: '<path d="M4 4h12a4 4 0 014 4v12H8a4 4 0 01-4-4V4z"/><path d="M4 16a4 4 0 014-4h12"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 01-8 0V4z"/><path d="M8 5H4v2a4 4 0 004 4M16 5h4v2a4 4 0 01-4 4"/><path d="M12 13v4M9 21h6M10 17h4l1 4H9l1-4z"/>',
    flame: '<path d="M12 22c4 0 7-2.7 7-6.5 0-4.5-4-6.5-4-10.5-2 1-3 3-3 5 0 1.5-1 2-1.5 1C9 9 9 7 9.5 5.5 6.5 7.5 5 10 5 13.5 5 18 8 22 12 22z"/>',
  };

  function icon(name, cls) {
    const body = P[name] || P.info;
    return `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  SJ.icon = icon;

  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      if (el.dataset.iconDone === "1") return;
      el.innerHTML = icon(el.dataset.icon);
      el.dataset.iconDone = "1";
    });
  }
  SJ.hydrateIcons = hydrateIcons;

  /* ----------------------------- formatting ----------------------------- */
  const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
  const int = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

  function fmtMoney(n, decimals) {
    if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "—";
    n = Number(n);
    const abs = Math.abs(n);
    const d = decimals !== undefined ? decimals : abs >= 1000 ? 0 : 2;
    const body = abs.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
    return (n < 0 ? "-₹" : "₹") + body;
  }

  function fmtSignedMoney(n, decimals) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    const s = fmtMoney(n, decimals);
    return Number(n) > 0 ? "+" + s : s;
  }

  function fmtNum(n, decimals) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    const d = decimals !== undefined ? decimals : 2;
    return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d });
  }

  function fmtPct(n, decimals) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    const d = decimals !== undefined ? decimals : 2;
    return (Number(n) > 0 ? "+" : "") + Number(n).toFixed(d) + "%";
  }

  function fmtCompact(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e7) return sign + "₹" + (abs / 1e7).toFixed(abs >= 1e8 ? 0 : 2) + "Cr";
    if (abs >= 1e5) return sign + "₹" + (abs / 1e5).toFixed(abs >= 1e6 ? 0 : 2) + "L";
    if (abs >= 1e3) return sign + "₹" + (abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + "k";
    return sign + "₹" + int.format(abs);
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function parseISO(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function fmtDate(iso, style) {
    const d = parseISO(iso);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    if (style === "long") return `${DOW[d.getDay()]}, ${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (style === "full") return `${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (style === "day") return `${dd} ${MONTHS[d.getMonth()]}`;
    return `${dd} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  }

  function fmtMonth(ym) {
    const d = parseISO(ym + "-01");
    if (!d) return ym;
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function addMonths(ym, delta) {
    const d = parseISO(ym + "-01");
    d.setMonth(d.getMonth() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function cls(n) {
    if (n === null || n === undefined) return "";
    return Number(n) > 0 ? "pos" : Number(n) < 0 ? "neg" : "flat";
  }

  function pnlArrow(n) {
    if (n === null || n === undefined) return "";
    return Number(n) > 0 ? icon("up") : Number(n) < 0 ? icon("down") : "";
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms || 250);
    };
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  SJ.debounce = debounce;
  SJ.qs = qs;
  SJ.qsa = qsa;

  function statusPill(status) {
    const s = String(status || "").toLowerCase();
    if (s === "open") return '<span class="pill open">Open</span>';
    if (s === "profit") return '<span class="pill profit">Profit</span>';
    if (s === "loss") return '<span class="pill loss">Loss</span>';
    return `<span class="pill neutral">${esc(status || "—")}</span>`;
  }

  function trendClass(status) {
    if (status === "PROFIT") return "pos";
    if (status === "LOSS") return "neg";
    if (status === "OPEN") return "open";
    return "";
  }

  /* ----------------------------- API ----------------------------- */
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || "GET", headers: {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (opts.form) init.body = opts.form;
    if (opts.signal) init.signal = opts.signal;
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new ApiError("Could not reach the journal server. Is it still running?", 0, null);
    }
    const ct = res.headers.get("content-type") || "";
    let data;
    if (ct.includes("application/json")) data = await res.json();
    else data = await res.text();
    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && (data.error || data.message)) || `Request failed (${res.status})`;
      throw new ApiError(msg, res.status, data);
    }
    return data;
  }
  SJ.api = api;
  SJ.ApiError = ApiError;

  async function download(path, filename) {
    const res = await fetch(path);
    if (!res.ok) throw new ApiError("Download failed", res.status, null);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  SJ.download = download;

  /* ----------------------------- toast ----------------------------- */
  function toast(title, msg, type) {
    const wrap = qs("#toasts");
    const el = document.createElement("div");
    el.className = "toast " + (type || "info");
    const ico = type === "success" ? "check" : type === "error" ? "xcircle" : type === "warn" ? "alert" : "info";
    el.innerHTML = `<span class="t-ico">${icon(ico)}</span><div class="t-body"><strong>${esc(title)}</strong>${msg ? `<span>${esc(msg)}</span>` : ""}</div>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .25s, transform .25s";
      el.style.opacity = "0";
      el.style.transform = "translateX(10px)";
      setTimeout(() => el.remove(), 260);
    }, type === "error" ? 6500 : 4200);
  }
  SJ.toast = toast;

  /* ----------------------------- modal ----------------------------- */
  let modalStack = [];
  function openModal(cfg) {
    const backdrop = qs("#modalBackdrop");
    const modal = qs("#modal");
    const body = qs("#modalBody");
    const foot = qs("#modalFoot");
    qs("#modalTitle").innerHTML = cfg.title || "";
    body.innerHTML = cfg.body || "";
    foot.innerHTML = cfg.footer || "";
    modal.className = "modal" + (cfg.wide ? " wide" : "") + (cfg.narrow ? " narrow" : "");
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    modalStack = [{ cfg }];
    qs("#modalClose").onclick = () => closeModal();
    backdrop.onclick = (e) => { if (e.target === backdrop && cfg.dismissable !== false) closeModal(); };
    hydrateIcons(body);
    hydrateIcons(foot);
    if (cfg.onMount) cfg.onMount(body, foot);
    setTimeout(() => {
      const first = body.querySelector("input:not([type=hidden]), select, textarea");
      if (first) first.focus({ preventScroll: true });
    }, 60);
    return { body, foot, modal };
  }
  function closeModal() {
    qs("#modalBackdrop").hidden = true;
    qs("#modalBody").innerHTML = "";
    qs("#modalFoot").innerHTML = "";
    document.body.style.overflow = "";
    modalStack = [];
  }
  SJ.openModal = openModal;
  SJ.closeModal = closeModal;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!qs("#lightbox").hidden) { qs("#lightbox").hidden = true; return; }
      if (!qs("#modalBackdrop").hidden) closeModal();
    }
  });

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const cfg = typeof opts === "string" ? { message: opts } : opts || {};
      openModal({
        title: cfg.title || "Please confirm",
        narrow: true,
        body: `<p style="margin:0;color:var(--text-2);font-size:13px">${cssSafe(cfg.message || "Are you sure?")}</p>`,
        footer: `<button class="btn ghost" data-x="no">${esc(cfg.cancel || "Cancel")}</button>
                 <button class="btn ${cfg.danger ? "danger" : "primary"}" data-x="yes">${esc(cfg.confirm || "Confirm")}</button>`,
        onMount: (b, f) => {
          f.querySelector('[data-x="no"]').onclick = () => { closeModal(); resolve(false); };
          f.querySelector('[data-x="yes"]').onclick = () => { closeModal(); resolve(true); };
        },
      });
    });
  }
  SJ.confirm = confirmDialog;

  function cssSafe(html) {
    // allow only <b>, <br>, <span class="..."> in small messages
    return String(html)
      .replace(/&/g, "&amp;")
      .replace(/<(?!\/?(b|br|strong|em|span|div|small)\b)/gi, "&lt;");
  }

  /* ----------------------------- lightbox ----------------------------- */
  SJ.lightbox = function (src) {
    const lb = qs("#lightbox");
    qs("#lightboxImg").src = src;
    lb.hidden = false;
  };
  qs("#lightbox").addEventListener("click", () => (qs("#lightbox").hidden = true));

  /* ----------------------------- form helpers ----------------------------- */
  function readForm(form) {
    const out = {};
    qsa("input, select, textarea", form).forEach((el) => {
      if (!el.name) return;
      if (el.type === "checkbox") out[el.name] = el.checked;
      else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
      else if (el.type === "file") return;
      else out[el.name] = el.value;
    });
    return out;
  }
  SJ.readForm = readForm;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
    try { localStorage.setItem("sj-theme", theme); } catch (e) {}
  }
  SJ.applyTheme = applyTheme;

  function storedTheme() {
    try { return localStorage.getItem("sj-theme") || null; } catch (e) { return null; }
  }

  /* ----------------------------- misc ----------------------------- */
  function stars(rating, editable) {
    const r = Number(rating) || 0;
    let html = `<span class="stars${editable ? " editable" : ""}" data-rating="${r}">`;
    for (let i = 1; i <= 5; i++) html += `<span class="${i <= r ? "on" : ""}" data-star="${i}">★</span>`;
    return html + "</span>";
  }
  SJ.stars = stars;

  function statusLabel(t) {
    return t.status === "OPEN" ? "open" : t.status === "PROFIT" ? "profit" : "loss";
  }
  SJ.statusLabel = statusLabel;

  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }
  SJ.param = param;

  SJ.fmt = {
    money: fmtMoney, signedMoney: fmtSignedMoney, num: fmtNum, pct: fmtPct,
    compact: fmtCompact, date: fmtDate, month: fmtMonth, todayISO, cls, esc, addMonths,
  };
  SJ.escape = esc;

  hydrateIcons(document);
  const t = storedTheme();
  if (t) applyTheme(t);
})();
