/* =====================================================================
   Tiny dependency-free SVG charts (line, bars, donut, horizontal bars)
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const { esc, compact, date: fmtDate } = { esc: SJ.escape, compact: SJ.fmt.compact, date: SJ.fmt.date };

  const registry = [];
  function register(fn) {
    registry.push(fn);
    fn();
  }
  function clear() {
    registry.length = 0;
  }
  window.addEventListener(
    "resize",
    SJ.debounce(() => {
      registry.forEach((fn) => {
        try { fn(); } catch (e) { /* ignore */ }
      });
    }, 180)
  );

  function emptyState(msg) {
    return `<div class="empty" style="padding:34px 12px"><span class="big-icon">${SJ.icon("chart")}</span><p>${esc(msg)}</p></div>`;
  }

  /* ------------------------------- line ------------------------------- */
  function lineChart(container, points, opts) {
    opts = opts || {};
    register(() => {
      container.innerHTML = "";
      const data = (points || []).filter((p) => p && p.value !== null && p.value !== undefined);
      if (!data.length) {
        container.innerHTML = emptyState(opts.empty || "Nothing to plot yet");
        return;
      }
      const W = Math.max(260, container.clientWidth || 640);
      const H = opts.height || 240;
      const pad = { l: 54, r: 14, t: 14, b: 26 };
      const iw = Math.max(10, W - pad.l - pad.r);
      const ih = H - pad.t - pad.b;
      const vals = data.map((p) => Number(p.value));
      let min = Math.min(...vals, opts.includeZero === false ? vals[0] : 0);
      let max = Math.max(...vals, opts.includeZero === false ? vals[0] : 0);
      if (min === max) { min -= Math.abs(min || 1) * 0.1; max += Math.abs(max || 1) * 0.1; }
      const span = max - min;
      min -= span * 0.06;
      max += span * 0.06;
      const n = data.length;
      const x = (i) => pad.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
      const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
      const last = vals[vals.length - 1];
      const positive = opts.color ? null : last >= 0;
      const stroke = opts.color || (positive ? "var(--green)" : "var(--red)");
      const gid = "g" + Math.random().toString(36).slice(2, 8);

      let grid = "";
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const v = min + ((max - min) * i) / steps;
        const yy = y(v);
        grid += `<line class="grid-line" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/>`;
        grid += `<text class="axis-label" x="${pad.l - 8}" y="${yy + 3.5}" text-anchor="end">${esc(compact(v))}</text>`;
      }
      let zero = "";
      if (min < 0 && max > 0) {
        zero = `<line class="zero-line" x1="${pad.l}" y1="${y(0)}" x2="${W - pad.r}" y2="${y(0)}"/>`;
      }

      let path = "";
      let area = "";
      data.forEach((p, i) => {
        const px = x(i);
        const py = y(Number(p.value));
        path += (i === 0 ? "M" : "L") + px.toFixed(1) + "," + py.toFixed(1) + " ";
      });
      const baseY = y(Math.max(min, Math.min(0, max)));
      area = path + `L${x(n - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

      const tickCount = Math.min(6, n);
      let xlabels = "";
      for (let i = 0; i < tickCount; i++) {
        const idx = tickCount === 1 ? 0 : Math.round((i * (n - 1)) / (tickCount - 1));
        const p = data[idx];
        const label = p.label || (p.date ? (opts.xStyle === "month" ? fmtDate(p.date, "day") : fmtDate(p.date)) : "");
        xlabels += `<text class="axis-label" x="${x(idx)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle"}">${esc(label)}</text>`;
      }

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.innerHTML = `
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${positive ? "#22c55e" : "#f05252"}" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="${positive ? "#22c55e" : "#f05252"}" stop-opacity="0.01"/>
          </linearGradient>
        </defs>
        ${grid}
        ${zero}
        <path d="${area}" fill="url(#${gid})" stroke="none"/>
        <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(n - 1)}" cy="${y(last)}" r="3.4" fill="${stroke}"/>
        <line class="hover-line" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
        <circle class="hover-dot" r="4" fill="${stroke}" stroke="var(--panel)" stroke-width="2" opacity="0"/>
        <rect class="hover-rect" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>
        ${xlabels}
      `;
      container.appendChild(svg);

      const tip = document.createElement("div");
      tip.className = "chart-tip";
      container.appendChild(tip);
      const hoverLine = svg.querySelector(".hover-line");
      const hoverDot = svg.querySelector(".hover-dot");

      svg.addEventListener("mousemove", (e) => {
        const rect = svg.getBoundingClientRect();
        const scale = W / rect.width;
        const mx = (e.clientX - rect.left) * scale;
        let idx = n === 1 ? 0 : Math.round(((mx - pad.l) / iw) * (n - 1));
        idx = Math.max(0, Math.min(n - 1, idx));
        const p = data[idx];
        const px = x(idx);
        const py = y(Number(p.value));
        hoverLine.setAttribute("x1", px);
        hoverLine.setAttribute("x2", px);
        hoverLine.setAttribute("opacity", "0.55");
        hoverDot.setAttribute("cx", px);
        hoverDot.setAttribute("cy", py);
        hoverDot.setAttribute("opacity", "1");
        const val = opts.format ? opts.format(p.value, p) : compact(p.value);
        const label = p.date || p.label || "";
        tip.innerHTML = `<strong>${esc(val)}</strong>${label ? `<div class="dim tiny">${esc(p.label || fmtDate(label))}</div>` : ""}`;
        const left = (px / W) * rect.width;
        const top = (py / H) * rect.height;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
        tip.classList.add("on");
      });
      svg.addEventListener("mouseleave", () => {
        tip.classList.remove("on");
        hoverLine.setAttribute("opacity", "0");
        hoverDot.setAttribute("opacity", "0");
      });
    });
  }

  /* ------------------------------- bars ------------------------------- */
  function barChart(container, items, opts) {
    opts = opts || {};
    register(() => {
      container.innerHTML = "";
      if (!items || !items.length) {
        container.innerHTML = emptyState(opts.empty || "No data for this range");
        return;
      }
      const W = Math.max(260, container.clientWidth || 640);
      const H = opts.height || 220;
      const pad = { l: 50, r: 10, t: 12, b: 34 };
      const iw = Math.max(10, W - pad.l - pad.r);
      const ih = H - pad.t - pad.b;
      const vals = items.map((d) => Number(d.value) || 0);
      let max = Math.max(...vals, 0);
      let min = Math.min(...vals, 0);
      if (max === min) max = min + 1;
      const span = max - min;
      max += span * 0.08;
      min -= span * 0.08;
      const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
      const zeroY = y(0);
      const step = iw / items.length;
      const bw = Math.min(opts.maxBarWidth || 46, step * 0.62);
      const gid = "b" + Math.random().toString(36).slice(2, 8);

      let grid = "";
      for (let i = 0; i <= 3; i++) {
        const v = min + ((max - min) * i) / 3;
        grid += `<line class="grid-line" x1="${pad.l}" y1="${y(v)}" x2="${W - pad.r}" y2="${y(v)}"/>`;
        grid += `<text class="axis-label" x="${pad.l - 7}" y="${y(v) + 3.5}" text-anchor="end">${esc(compact(v))}</text>`;
      }
      grid += `<line class="zero-line" x1="${pad.l}" y1="${zeroY}" x2="${W - pad.r}" y2="${zeroY}"/>`;

      let bars = "";
      const labelEvery = items.length > 14 ? Math.ceil(items.length / 12) : 1;
      items.forEach((d, i) => {
        const v = Number(d.value) || 0;
        const cx = pad.l + step * i + step / 2;
        const top = Math.min(y(v), zeroY);
        const h = Math.max(1.5, Math.abs(zeroY - y(v)));
        const color = d.color || (v >= 0 ? "var(--green)" : "var(--red)");
        bars += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="3" fill="${color}" opacity="${d.muted ? 0.4 : 0.92}" class="bar" data-i="${i}"/>`;
        if (i % labelEvery === 0) {
          bars += `<text class="axis-label" x="${cx}" y="${H - 12}" text-anchor="middle">${esc(d.label)}</text>`;
        }
      });

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.innerHTML = grid + bars;
      container.appendChild(svg);

      const tip = document.createElement("div");
      tip.className = "chart-tip";
      container.appendChild(tip);
      svg.querySelectorAll(".bar").forEach((el) => {
        el.addEventListener("mouseenter", () => {
          const d = items[Number(el.dataset.i)];
          const val = opts.format ? opts.format(d.value, d) : compact(d.value);
          tip.innerHTML = `<strong>${esc(val)}</strong><div class="dim tiny">${esc(d.label)}${d.sub ? " · " + esc(d.sub) : ""}</div>`;
          const r = el.getBoundingClientRect();
          const c = container.getBoundingClientRect();
          tip.style.left = r.left - c.left + r.width / 2 + "px";
          tip.style.top = r.top - c.top + "px";
          tip.classList.add("on");
        });
        el.addEventListener("mouseleave", () => tip.classList.remove("on"));
      });
    });
  }

  /* ------------------------------ donut ------------------------------ */
  function donut(container, pct, opts) {
    opts = opts || {};
    register(() => {
      container.innerHTML = "";
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      const r = 40;
      const c = 2 * Math.PI * r;
      const dash = (p / 100) * c;
      const color = opts.color || (p >= 50 ? "var(--green)" : "var(--red)");
      container.innerHTML = `
        <div class="donut">
          <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="9"/>
            <circle cx="48" cy="48" r="${r}" fill="none" stroke="${color}" stroke-width="9"
              stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}" stroke-linecap="round"/>
          </svg>
          <div class="donut-center"><strong class="${p >= 50 ? "pos" : "neg"}">${p.toFixed(1)}%</strong><span>${esc(opts.label || "win rate")}</span></div>
        </div>`;
    });
  }

  /* ------------------------------ hbars ------------------------------ */
  function hbar(container, items, opts) {
    opts = opts || {};
    container.innerHTML = "";
    if (!items || !items.length) {
      container.innerHTML = emptyState(opts.empty || "No symbol data yet");
      return;
    }
    const maxAbs = Math.max(...items.map((d) => Math.abs(Number(d.value) || 0)), 1);
    const rows = items
      .map((d) => {
        const v = Number(d.value) || 0;
        const w = (Math.abs(v) / maxAbs) * 50;
        const pos = v >= 0;
        const style = pos ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
        return `<div class="hbar-row">
            <div class="hbar-label" title="${esc(d.label)}">${esc(d.label)}${d.sub ? `<div class="hbar-sub">${esc(d.sub)}</div>` : ""}</div>
            <div class="hbar-track" title="${esc(d.label)}: ${esc(SJ.fmt.signedMoney(v))}">
              <span style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border)"></span>
              <i class="hbar-fill ${pos ? "pos" : "neg"}" style="${style}"></i>
            </div>
            <div class="hbar-val ${pos ? "pos" : "neg"}">${SJ.fmt.signedMoney(v)}</div>
          </div>`;
      })
      .join("");
    container.innerHTML = `<div class="hbar-list">${rows}</div>`;
  }

  /* ---------------------------- sparkline ---------------------------- */
  function sparkline(container, values, color) {
    const vals = values || [];
    if (vals.length < 2) {
      container.innerHTML = "";
      return;
    }
    const W = 72, H = 26;
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - ((v - min) / span) * H}`).join(" ");
    container.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" stroke="${color || "currentColor"}" stroke-width="1.6" stroke-linecap="round"><polyline points="${pts}"/></svg>`;
  }

  SJ.charts = { line: lineChart, bars: barChart, donut, hbar, spark: sparkline, clear, emptyState };
})();
