/* =====================================================================
   Trade form & detail, review queue, CSV import, Zerodha, settings
   ===================================================================== */
(function () {
  "use strict";
  const SJ = window.SJ;
  const F = SJ.fmt;
  const esc = SJ.escape;
  const icon = SJ.icon;

  const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];

  /* =================================================================
     TRADE FORM
     ================================================================= */
  function blankTrade() {
    return {
      symbol: "", exchange: "NSE", side: "LONG", entry_date: F.todayISO(),
      entry_price: "", quantity: "", stop_loss: "", target: "", fees: "",
      exit_date: "", exit_price: "", strategy: "", tags: "", notes: "", rating: 0,
    };
  }

  async function tradeForm(id, preset) {
    let trade = blankTrade();
    if (preset) trade = { ...trade, ...preset };
    if (id) {
      try {
        const res = await SJ.api(`/api/trades/${id}`);
        trade = res.trade;
      } catch (e) {
        return SJ.toast("Could not open trade", e.message, "error");
      }
    }
    const existingPhotos = (trade.photos || []).slice();
    const pendingFiles = [];
    let rating = Number(trade.rating) || 0;

    const body = `
      <form id="tradeForm" autocomplete="off">
        <div class="form-grid">
          <div class="field span-2">
            <label>Symbol *</label>
            <input class="input" name="symbol" id="tfSymbol" required placeholder="e.g. RELIANCE" value="${esc(trade.symbol)}" style="text-transform:uppercase">
          </div>
          <div class="field">
            <label>Exchange</label>
            <select class="select" name="exchange">${EXCHANGES.map((x) => `<option ${trade.exchange === x ? "selected" : ""}>${x}</option>`).join("")}</select>
          </div>
          <div class="field">
            <label>Direction</label>
            <select class="select" name="side">
              <option value="LONG" ${trade.side !== "SHORT" ? "selected" : ""}>Long (buy first)</option>
              <option value="SHORT" ${trade.side === "SHORT" ? "selected" : ""}>Short (sell first)</option>
            </select>
          </div>

          <div class="field"><label>Entry date *</label><input class="input" type="date" name="entry_date" value="${esc(trade.entry_date || F.todayISO())}" required></div>
          <div class="field"><label>Quantity *</label><input class="input" type="number" step="any" min="0.0001" name="quantity" value="${esc(trade.quantity)}" required placeholder="10"></div>
          <div class="field"><label>Entry price *</label><input class="input" type="number" step="any" min="0" name="entry_price" value="${esc(trade.entry_price)}" required placeholder="1500.50"></div>
          <div class="field"><label>Stop loss</label><input class="input" type="number" step="any" min="0" name="stop_loss" value="${esc(trade.stop_loss ?? "")}" placeholder="optional — enables R"></div>

          <div class="field"><label>Exit date</label><input class="input" type="date" name="exit_date" value="${esc(trade.exit_date || "")}"></div>
          <div class="field"><label>Exit price</label><input class="input" type="number" step="any" min="0" name="exit_price" value="${esc(trade.exit_price ?? "")}" placeholder="leave blank if open"></div>
          <div class="field"><label>Target</label><input class="input" type="number" step="any" min="0" name="target" value="${esc(trade.target ?? "")}" placeholder="optional"></div>
          <div class="field"><label>Fees &amp; charges</label><input class="input" type="number" step="any" min="0" name="fees" value="${esc(trade.fees ?? "")}" placeholder="brokerage + taxes"></div>

          <div class="field span-2"><label>Setup / strategy</label><input class="input" name="strategy" value="${esc(trade.strategy)}" placeholder="Breakout, Pullback, VCP…"></div>
          <div class="field span-2"><label>Tags</label><input class="input" name="tags" value="${esc(trade.tags)}" placeholder="A+ setup, earnings, momentum"></div>

          <div class="field span-4"><label>Notes</label><textarea class="textarea" name="notes" placeholder="Why did you take it? What did you see? What would you do differently?">${esc(trade.notes)}</textarea></div>

          <div class="field span-2">
            <label>Trade rating</label>
            <div class="row"><span id="tfStars">${SJ.stars(rating, true)}</span><span class="hint">execution quality, not the result</span></div>
          </div>
        </div>

        <div class="trade-preview mt" id="tfPreview"></div>

        <div class="form-section">
          <h3>Screenshots</h3>
          <div class="photo-grid" id="tfPhotos"></div>
          <div class="row mt">
            <label class="btn ghost sm" style="cursor:pointer">${icon("camera")} Add photos
              <input type="file" id="tfFiles" accept="image/*" multiple hidden>
            </label>
            <span class="hint">Charts &amp; entry screenshots are copied into your journal data folder.</span>
          </div>
        </div>
      </form>
    `;

    const footer = `
      ${id ? `<button class="btn danger left" data-x="delete">${icon("trash")} Delete</button>` : ""}
      <span class="left hint" id="tfHint">${id ? `Editing trade #${id}` : "Manual entry"}</span>
      <button class="btn ghost" data-x="cancel">Cancel</button>
      <button class="btn primary" data-x="save">${icon("save")} ${id ? "Save changes" : "Add trade"}</button>
    `;

    SJ.openModal({
      title: id ? `Edit trade #${id}` : "Add a trade",
      body,
      footer,
      wide: true,
      onMount: (b, f) => {
        const form = b.querySelector("#tradeForm");
        const preview = b.querySelector("#tfPreview");
        const photoWrap = b.querySelector("#tfPhotos");
        const hint = f.querySelector("#tfHint");

        const drawPhotos = () => {
          const items = [
            ...existingPhotos.map((p) => ({ url: p.url, id: p.id, existing: true })),
            ...pendingFiles.map((p, i) => ({ url: p.url, pending: true, i })),
          ];
          photoWrap.innerHTML = items.length
            ? items.map((p) => `<div class="photo-thumb" data-url="${esc(p.url)}" ${p.existing ? `data-pid="${p.id}"` : `data-pi="${p.i}"`}>
                  <img src="${esc(p.url)}" alt="screenshot">
                  <button type="button" class="del" data-del>${icon("close")}</button>
                </div>`).join("")
            : `<span class="hint">No screenshots yet.</span>`;
          photoWrap.querySelectorAll(".photo-thumb img").forEach((img) => {
            img.onclick = () => SJ.lightbox(img.src);
          });
          photoWrap.querySelectorAll("[data-del]").forEach((btn) => {
            btn.onclick = async (e) => {
              e.stopPropagation();
              const thumb = btn.closest(".photo-thumb");
              if (thumb.dataset.pid) {
                try {
                  await SJ.api(`/api/trades/${id}/photos/${thumb.dataset.pid}`, { method: "DELETE" });
                  const idx = existingPhotos.findIndex((p) => String(p.id) === thumb.dataset.pid);
                  if (idx >= 0) existingPhotos.splice(idx, 1);
                  drawPhotos();
                } catch (err) { SJ.toast("Could not delete photo", err.message, "error"); }
              } else {
                const i = Number(thumb.dataset.pi);
                URL.revokeObjectURL(pendingFiles[i].url);
                pendingFiles.splice(i, 1);
                drawPhotos();
              }
            };
          });
        };
        drawPhotos();

        b.querySelector("#tfFiles").onchange = (e) => {
          Array.from(e.target.files || []).forEach((file) => {
            if (!file.type.startsWith("image/")) return;
            pendingFiles.push({ file, url: URL.createObjectURL(file) });
          });
          e.target.value = "";
          drawPhotos();
        };

        // stars
        const starsEl = b.querySelector("#tfStars");
        const paint = () => {
          starsEl.innerHTML = SJ.stars(rating, true);
          bindStars();
        };
        const bindStars = () => {
          starsEl.querySelectorAll("[data-star]").forEach((s) => {
            s.onclick = () => {
              const val = Number(s.dataset.star);
              rating = rating === val ? 0 : val;
              paint();
            };
          });
        };
        bindStars();

        const updatePreview = () => {
          const p = SJ.readForm(form);
          const entry = Number(p.entry_price), qty = Number(p.quantity);
          const exit = p.exit_price === "" ? null : Number(p.exit_price);
          const dir = p.side === "SHORT" ? -1 : 1;
          const fees = Number(p.fees) || 0;
          let pnl = null, pct = null, r = null, hold = null;
          if (exit !== null && entry > 0 && qty > 0) {
            pnl = (exit - entry) * qty * dir - fees;
            pct = ((exit - entry) * qty * dir - fees) / (entry * qty) * 100;
            const sl = Number(p.stop_loss);
            if (sl > 0 && Math.abs(entry - sl) > 0) r = pnl / (Math.abs(entry - sl) * qty);
          }
          if (p.entry_date) {
            const end = p.exit_date || F.todayISO();
            const a = new Date(p.entry_date), bb = new Date(end);
            hold = Math.max(0, Math.round((bb - a) / 86400000));
          }
          const status = exit === null ? "OPEN" : pnl > 0 ? "PROFIT" : "LOSS";
          preview.innerHTML = `
            <div class="tp"><span>Status</span><strong>${status === "OPEN" ? '<span class="pill open">Open</span>' : status === "PROFIT" ? '<span class="pill profit">Profit</span>' : '<span class="pill loss">Loss</span>'}</strong></div>
            <div class="tp"><span>Net P&amp;L</span><strong class="${F.cls(pnl)}">${pnl === null ? "—" : F.signedMoney(pnl)}</strong></div>
            <div class="tp"><span>Return</span><strong class="${F.cls(pct)}">${pct === null ? "—" : F.pct(pct)}</strong></div>
            <div class="tp"><span>R multiple</span><strong class="${F.cls(r)}">${r === null ? "—" : r.toFixed(2) + "R"}</strong></div>
            <div class="tp"><span>Hold</span><strong>${hold === null ? "—" : hold === 0 ? "Same day" : hold + " days"}</strong></div>
            <div class="tp"><span>Invested</span><strong>${entry > 0 && qty > 0 ? F.money(entry * qty, 0) : "—"}</strong></div>`;
        };
        form.addEventListener("input", updatePreview);
        form.addEventListener("change", updatePreview);
        updatePreview();

        f.querySelector('[data-x="cancel"]').onclick = SJ.closeModal;
        if (id && f.querySelector('[data-x="delete"]'))
          f.querySelector('[data-x="delete"]').onclick = async () => {
            const ok = await SJ.confirm({ title: "Delete trade?", message: `Trade #${id} (${esc(trade.symbol)}) will be permanently removed, including its screenshots.`, confirm: "Delete", danger: true });
            if (!ok) return;
            try {
              await SJ.api(`/api/trades/${id}`, { method: "DELETE" });
              SJ.closeModal();
              SJ.toast("Trade deleted", "", "success");
              SJ.refreshCurrent();
              SJ.refreshBadges();
            } catch (e) { SJ.toast("Could not delete", e.message, "error"); }
          };

        f.querySelector('[data-x="save"]').onclick = async () => {
          const p = SJ.readForm(form);
          p.symbol = (p.symbol || "").trim().toUpperCase();
          if (!p.symbol) return SJ.toast("Symbol required", "Enter the trading symbol", "warn");
          if (!p.entry_price || !p.quantity) return SJ.toast("Missing values", "Entry price and quantity are required", "warn");
          p.rating = rating || null;
          if (p.exit_price === "") p.exit_price = null;
          if (p.exit_date === "") p.exit_date = null;
          if (p.stop_loss === "") p.stop_loss = null;
          if (p.target === "") p.target = null;
          const saveBtn = f.querySelector('[data-x="save"]');
          saveBtn.disabled = true;
          try {
            let res;
            if (id) res = await SJ.api(`/api/trades/${id}`, { method: "PUT", body: p });
            else res = await SJ.api("/api/trades", { method: "POST", body: p });
            let tradeId = id || (res.trade && res.trade.id) || res.trade_id;
            if (res.duplicate) {
              saveBtn.disabled = false;
              hint.innerHTML = `<span class="neg">${esc(res.message || "Already in the journal")}</span> — adjust it or open <a href="#" id="tfOpenMatch">trade #${res.trade_id}</a>`;
              const link = b.querySelector("#tfOpenMatch") || f.querySelector("#tfOpenMatch");
              if (link) link.onclick = (e) => { e.preventDefault(); SJ.closeModal(); SJ.tradeDetail(res.trade_id); };
              return;
            }
            if (res.review) {
              SJ.closeModal();
              SJ.toast("Held for manual review", res.message || "A possible duplicate needs your decision", "warn");
              SJ.refreshBadges();
              SJ.refreshCurrent();
              return;
            }
            if (tradeId && pendingFiles.length) {
              const fd = new FormData();
              pendingFiles.forEach((p) => fd.append("files", p.file));
              try { await SJ.api(`/api/trades/${tradeId}/photos`, { method: "POST", form: fd }); }
              catch (err) { SJ.toast("Trade saved, photo upload failed", err.message, "warn"); }
            }
            SJ.closeModal();
            SJ.toast(res.created === false ? "Trade updated" : "Trade saved", id ? "Changes applied" : "Added to your journal", "success");
            SJ.refreshCurrent();
            SJ.refreshBadges();
          } catch (e) {
            saveBtn.disabled = false;
            SJ.toast("Could not save trade", e.message, "error");
          }
        };
      },
    });
  }

  /* =================================================================
     TRADE DETAIL
     ================================================================= */
  async function tradeDetail(id) {
    let t;
    try {
      const res = await SJ.api(`/api/trades/${id}`);
      t = res.trade;
    } catch (e) {
      return SJ.toast("Could not load trade", e.message, "error");
    }
    const s = t.status;
    const body = `
      <div class="row between wrap" style="align-items:flex-start;gap:16px">
        <div>
          <div class="row" style="gap:10px">
            <h3 style="margin:0;font-size:20px;letter-spacing:-.3px">${esc(t.symbol)}</h3>
            ${s === "OPEN" ? '<span class="pill open">Open</span>' : s === "PROFIT" ? '<span class="pill profit">Profit</span>' : '<span class="pill loss">Loss</span>'}
            ${t.side === "SHORT" ? '<span class="side-tag short">SHORT</span>' : ""}
          </div>
          <div class="muted small mt" style="margin-top:4px">${esc(t.exchange)} · ${esc(t.strategy || "No setup")} · ${esc(t.hold_label)} held · <span class="dim">${esc(t.source)}</span></div>
        </div>
        <div class="right" style="margin-left:auto;text-align:right">
          <div style="font-size:24px;font-weight:700" class="${F.cls(t.pnl)}">${t.pnl === null ? "—" : F.signedMoney(t.pnl)}</div>
          <div class="${F.cls(t.pnl_pct)}" style="font-size:13px">${t.pnl_pct === null ? (s === "OPEN" ? "unrealised — no LTP yet" : "—") : F.pct(t.pnl_pct)}${t.r_multiple !== null ? ` · ${t.r_multiple.toFixed(2)}R` : ""}</div>
        </div>
      </div>

      <div class="split-2 mt">
        <div class="compare-col">
          <h4>Entry</h4>
          <div class="kv">
            <dt>Date</dt><dd>${F.date(t.entry_date, "long")}</dd>
            <dt>Price</dt><dd>${F.money(t.entry_price, 2)}</dd>
            <dt>Quantity</dt><dd>${F.num(t.quantity, 4)}</dd>
            <dt>Invested</dt><dd>${F.money(t.invested, 2)}</dd>
            <dt>Stop loss</dt><dd>${t.stop_loss ? F.money(t.stop_loss, 2) : "—"}</dd>
            <dt>Target</dt><dd>${t.target ? F.money(t.target, 2) : "—"}</dd>
          </div>
        </div>
        <div class="compare-col">
          <h4>${t.exit_price !== null ? "Exit" : "Position"}</h4>
          <div class="kv">
            <dt>${t.exit_date ? "Date" : "Held for"}</dt><dd>${t.exit_date ? F.date(t.exit_date, "long") : esc(t.hold_label)}</dd>
            <dt>${t.exit_price !== null ? "Price" : "Last price"}</dt><dd>${t.exit_price !== null ? F.money(t.exit_price, 2) : t.ltp ? F.money(t.ltp, 2) : "—"}</dd>
            <dt>Fees</dt><dd>${F.money(t.fees, 2)}</dd>
            <dt>Net P&amp;L</dt><dd class="${F.cls(t.pnl)}">${F.signedMoney(t.pnl)}</dd>
            <dt>Return</dt><dd class="${F.cls(t.pnl_pct)}">${t.pnl_pct === null ? "—" : F.pct(t.pnl_pct)}</dd>
            <dt>R multiple</dt><dd>${t.r_multiple === null ? "—" : t.r_multiple.toFixed(2) + "R"}</dd>
          </div>
        </div>
      </div>

      ${t.tags || t.rating ? `<div class="row wrap mt">${t.rating ? `<span class="tiny muted">Rating</span> ${SJ.stars(t.rating)}` : ""}${(t.tags || "").split(",").filter(Boolean).map((x) => `<span class="tag">${esc(x.trim())}</span>`).join("")}</div>` : ""}

      ${t.notes ? `<div class="form-section"><h3>Notes</h3><div style="white-space:pre-wrap;color:var(--text-2);font-size:12.5px">${esc(t.notes)}</div></div>` : ""}

      <div class="form-section">
        <div class="row between"><h3 style="margin:0">Screenshots</h3>
          <label class="btn ghost xs" style="cursor:pointer">${icon("camera")} Add <input type="file" id="tdFile" accept="image/*" multiple hidden></label>
        </div>
        <div class="photo-grid mt" id="tdPhotos">
          ${(t.photos || []).length
            ? t.photos.map((p) => `<div class="photo-thumb"><img src="${esc(p.url)}" alt="screenshot"></div>`).join("")
            : `<span class="hint">No screenshots attached.</span>`}
        </div>
      </div>

      <div class="form-section">
        <h3>Audit</h3>
        <div class="kv" style="font-size:11.5px">
          <dt>Trade ID</dt><dd>#${t.id}</dd>
          <dt>Created</dt><dd>${esc((t.created_at || "").replace("T", " "))}</dd>
          <dt>Updated</dt><dd>${esc((t.updated_at || "").replace("T", " "))}</dd>
          ${t.broker_ids && t.broker_ids !== "[]" ? `<dt>Broker refs</dt><dd class="tiny dim">${esc(t.broker_ids)}</dd>` : ""}
        </div>
      </div>
    `;

    SJ.openModal({
      title: "Trade details",
      body,
      wide: true,
      footer: `
        <button class="btn danger left" data-x="delete">${icon("trash")} Delete</button>
        <button class="btn ghost" data-x="edit">${icon("edit")} Edit</button>
        ${t.status === "OPEN"
          ? `<button class="btn green" data-x="close">${icon("check")} Close trade</button>`
          : `<button class="btn ghost" data-x="reopen">${icon("refresh")} Re-open</button>`}
        <button class="btn" data-x="done">Done</button>
      `,
      onMount: (b, f) => {
        b.querySelectorAll("#tdPhotos img").forEach((img) => (img.onclick = () => SJ.lightbox(img.src)));
        b.querySelector("#tdFile").onchange = async (e) => {
          const fd = new FormData();
          Array.from(e.target.files || []).forEach((file) => fd.append("files", file));
          if (!fd.getAll("files").length) return;
          try {
            await SJ.api(`/api/trades/${id}/photos`, { method: "POST", form: fd });
            SJ.closeModal();
            tradeDetail(id);
            SJ.refreshCurrent();
            SJ.toast("Screenshot added", "", "success");
          } catch (err) { SJ.toast("Upload failed", err.message, "error"); }
        };
        f.querySelector('[data-x="done"]').onclick = SJ.closeModal;
        f.querySelector('[data-x="edit"]').onclick = () => { SJ.closeModal(); tradeForm(id); };
        f.querySelector('[data-x="delete"]').onclick = async () => {
          const ok = await SJ.confirm({ title: "Delete trade?", message: `Trade #${id} (${esc(t.symbol)}) will be permanently removed.`, confirm: "Delete", danger: true });
          if (!ok) return;
          try {
            await SJ.api(`/api/trades/${id}`, { method: "DELETE" });
            SJ.closeModal();
            SJ.toast("Trade deleted", "", "success");
            SJ.refreshCurrent();
            SJ.refreshBadges();
          } catch (e) { SJ.toast("Could not delete", e.message, "error"); }
        };
        const closeBtn = f.querySelector('[data-x="close"]');
        if (closeBtn) closeBtn.onclick = () => { SJ.closeModal(); closeTradeDialog(t); };
        const reopenBtn = f.querySelector('[data-x="reopen"]');
        if (reopenBtn) reopenBtn.onclick = async () => {
          try {
            await SJ.api(`/api/trades/${id}/reopen`, { method: "POST" });
            SJ.closeModal();
            SJ.toast("Trade re-opened", "Exit price cleared", "success");
            SJ.refreshCurrent();
          } catch (e) { SJ.toast("Could not re-open", e.message, "error"); }
        };
      },
    });
  }

  function closeTradeDialog(t) {
    const defaultPrice = t.ltp || t.entry_price || "";
    SJ.openModal({
      title: `Close ${esc(t.symbol)}`,
      narrow: true,
      body: `<form id="closeForm">
        <div class="trade-preview" id="clPreview" style="margin-bottom:12px"></div>
        <div class="field mb"><label>Exit price *</label><input class="input" type="number" step="any" name="exit_price" id="clPrice" value="${defaultPrice}"></div>
        <div class="field mb"><label>Exit date</label><input class="input" type="date" name="exit_date" value="${F.todayISO()}"></div>
        <div class="field mb"><label>Extra fees</label><input class="input" type="number" step="any" name="fees" value="" placeholder="optional"></div>
        <div class="field"><label>Note</label><input class="input" name="notes" placeholder="optional"></div>
      </form>`,
      footer: `<button class="btn ghost" data-x="cancel">Cancel</button><button class="btn green" data-x="save">${icon("check")} Close trade</button>`,
      onMount: (b, f) => {
        const form = b.querySelector("#closeForm");
        const preview = b.querySelector("#clPreview");
        const paint = () => {
          const price = Number(form.exit_price.value);
          if (!price) { preview.innerHTML = '<span class="hint">Enter the exit price to see the result</span>'; return; }
          const dir = t.side === "SHORT" ? -1 : 1;
          const fees = (t.fees || 0) + (Number(form.fees.value) || 0);
          const pnl = (price - t.entry_price) * t.quantity * dir - fees;
          const pct = pnl / (t.entry_price * t.quantity) * 100;
          preview.innerHTML = `<div class="tp"><span>Result</span><strong class="${F.cls(pnl)}">${F.signedMoney(pnl)}</strong></div>
            <div class="tp"><span>Return</span><strong class="${F.cls(pct)}">${F.pct(pct)}</strong></div>
            <div class="tp"><span>R</span><strong>${t.stop_loss ? (pnl / (Math.abs(t.entry_price - t.stop_loss) * t.quantity)).toFixed(2) + "R" : "—"}</strong></div>`;
        };
        form.addEventListener("input", paint);
        paint();
        f.querySelector('[data-x="cancel"]').onclick = SJ.closeModal;
        f.querySelector('[data-x="save"]').onclick = async () => {
          const p = SJ.readForm(form);
          if (!p.exit_price) return SJ.toast("Exit price required", "", "warn");
          try {
            await SJ.api(`/api/trades/${t.id}/close`, { method: "POST", body: p });
            SJ.closeModal();
            SJ.toast("Trade closed", "P&L has been booked in your journal", "success");
            SJ.refreshCurrent();
          } catch (e) { SJ.toast("Could not close trade", e.message, "error"); }
        };
      },
    });
  }

  async function deleteTrade(t) {
    const ok = await SJ.confirm({ title: "Delete trade?", message: `#${t.id} ${esc(t.symbol)} — this cannot be undone.`, confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await SJ.api(`/api/trades/${t.id}`, { method: "DELETE" });
      SJ.toast("Trade deleted", "", "success");
      SJ.refreshCurrent();
    } catch (e) { SJ.toast("Could not delete", e.message, "error"); }
  }

  async function reopenTrade(t) {
    try {
      await SJ.api(`/api/trades/${t.id}/reopen`, { method: "POST" });
      SJ.toast("Trade re-opened", "Exit price cleared", "success");
      SJ.refreshCurrent();
    } catch (e) { SJ.toast("Could not re-open", e.message, "error"); }
  }

  SJ.tradeForm = tradeForm;
  SJ.tradeDetail = tradeDetail;
  SJ.closeTradeDialog = closeTradeDialog;
  SJ.deleteTrade = deleteTrade;
  SJ.reopenTrade = reopenTrade;

  /* =================================================================
     REVIEW
     ================================================================= */
  const KIND_LABEL = {
    DUPLICATE: "Possible duplicate",
    PRICE_MISMATCH: "Price mismatch",
    QTY_MISMATCH: "Quantity mismatch",
    SELL_WITHOUT_BUY: "Unmatched sell",
    BROKER_CLOSED: "Broker closed",
  };

  async function renderReview(el) {
    el.innerHTML = `<div id="reviewBody"><div class="loading"><div class="spinner"></div><span>Loading review queue…</span></div></div>`;
    const body = el.querySelector("#reviewBody");
    const tab = (SJ.reviewState && SJ.reviewState.tab) || "PENDING";
    try {
      const res = await SJ.api(`/api/review?status=${tab === "PENDING" ? "PENDING" : "all"}`);
      let items = res.items || [];
      if (tab === "RESOLVED") items = items.filter((i) => i.status !== "PENDING");
      const pending = res.pending;
      body.innerHTML = `
        <div class="page-head">
          <div class="grow"><h2>Review queue</h2><p>Nothing gets double-counted silently. Anything doubtful waits here for your decision.</p></div>
          <div class="page-actions">
            <div class="chips">
              <button class="chip ${tab === "PENDING" ? "active" : ""}" data-tab="PENDING">Pending ${pending ? `(${pending})` : ""}</button>
              <button class="chip ${tab === "RESOLVED" ? "active" : ""}" data-tab="RESOLVED">Resolved</button>
            </div>
          </div>
        </div>
        <div class="banner mb">${icon("shield")}<div><strong>How this works:</strong> when an import or Zerodha sync looks like it might duplicate an existing trade, it is parked here instead of being written. Approve the proposal or reject it — your journal stays clean either way.</div></div>
        <div id="reviewList"></div>`;
      const list = body.querySelector("#reviewList");
      if (!items.length) {
        list.innerHTML = `<div class="card"><div class="empty"><span class="big-icon">${icon("check")}</span><strong>All clear</strong><p>${tab === "PENDING" ? "No pending decisions. Imports and broker syncs are fully reconciled." : "Nothing resolved yet."}</p></div></div>`;
      } else {
        SJ._reviewCache = items;
        list.innerHTML = items.map((i) => reviewCard(i)).join("");
        bindReview(list);
      }
      body.querySelectorAll("[data-tab]").forEach((b) => {
        b.onclick = () => {
          SJ.reviewState = { tab: b.dataset.tab };
          renderReview(el);
        };
      });
    } catch (e) {
      body.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not load review queue.</strong><br>${esc(e.message)}</div></div>`;
    }
  }

  function reviewCard(item) {
    const p = item.payload || {};
    const incoming = p.incoming || {};
    const matches = p.matches || [];
    const kindLabel = KIND_LABEL[item.kind] || item.kind;
    const isPending = item.status === "PENDING";
    const incomingRow = compareValues(incoming, item.kind);
    const match = matches[0];
    const matchRow = match ? compareValues(match, item.kind) : "";
    return `<div class="review-card">
      <div class="rc-head">
        <span class="pill ${item.kind === "DUPLICATE" ? "amber" : item.kind.includes("MISMATCH") ? "open" : "neutral"}">${esc(kindLabel)}</span>
        <div class="rc-title">${esc(item.title)}</div>
        <div style="margin-left:auto" class="row">
          <span class="tiny dim">${esc((item.created_at || "").replace("T", " "))}</span>
          ${!isPending ? `<span class="pill ${item.status === "ACCEPTED" ? "profit" : "loss"}">${esc(item.status)}</span>` : ""}
        </div>
      </div>
      <div class="rc-body">
        <div class="small" style="color:var(--text-2)">${esc(item.detail || "")}</div>
        <div class="review-compare">
          <div class="compare-col"><h4>Incoming</h4>${incomingRow}</div>
          <div class="compare-col"><h4>${matches.length > 1 ? "Existing (closest)" : "Existing trade"}</h4>${matchRow || '<span class="hint">No matching trade</span>'}</div>
        </div>
        ${isPending ? `<div class="review-actions">
          <input class="input sm" style="max-width:280px" placeholder="Optional note…" data-note>
          <button class="btn green sm" data-act="accept">${icon("check")} Approve</button>
          <button class="btn danger sm" data-act="reject">${icon("close")} Reject</button>
          <span class="hint">${actionHint(item.kind)}</span>
        </div>` : `<div class="tiny dim">${esc(item.resolution_note || "")} · ${esc((item.resolved_at || "").replace("T", " "))}</div>`}
      </div>
    </div>`;
  }

  function actionHint(kind) {
    if (kind === "DUPLICATE") return "Approve = skip the new row · Reject = import it as a separate trade";
    if (kind === "PRICE_MISMATCH") return "Approve = use broker's average price · Reject = keep journal price";
    if (kind === "QTY_MISMATCH") return "Approve = use broker's quantity · Reject = keep journal quantity";
    if (kind === "SELL_WITHOUT_BUY") return "Approve = record as a short entry · Reject = ignore the sell";
    if (kind === "BROKER_CLOSED") return "Approve = close the journal trade · Reject = keep it open";
    return "";
  }

  function compareValues(obj, kind) {
    const map = [
      ["Symbol", obj.symbol],
      ["Entry date", obj.entry_date || obj.exec_date],
      ["Entry price", obj.entry_price !== undefined ? F.money(obj.entry_price, 2) : obj.price !== undefined ? F.money(obj.price, 2) : null],
      ["Quantity", obj.quantity !== undefined ? F.num(obj.quantity, 4) : null],
      ["Exit date", obj.exit_date],
      ["Exit price", obj.exit_price !== undefined && obj.exit_price !== null ? F.money(obj.exit_price, 2) : null],
      ["Status", obj.status],
      ["P&L", obj.pnl !== undefined && obj.pnl !== null ? F.signedMoney(obj.pnl) : null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!map.length) return '<span class="hint">—</span>';
    return `<div class="kv">${map.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</div>`;
  }

  function bindReview(root) {
    const items = SJ._reviewCache || [];
    root.querySelectorAll(".review-card").forEach((card, idx) => {
      const item = items[idx];
      if (!item || item.status !== "PENDING") return;
      const note = card.querySelector("[data-note]");
      card.querySelector('[data-act="accept"]').onclick = (e) => resolve(item, "accept", note, e.currentTarget);
      card.querySelector('[data-act="reject"]').onclick = (e) => resolve(item, "reject", note, e.currentTarget);
    });
  }

  async function resolve(item, decision, noteEl, btn) {
    if (btn) { btn.disabled = true; btn.dataset.old = btn.innerHTML; btn.innerHTML = "Working…"; }
    try {
      await SJ.api(`/api/review/${item.id}/resolve`, { method: "POST", body: { decision, note: noteEl ? noteEl.value : "" } });
      SJ.toast(decision === "accept" ? "Approved" : "Rejected", item.title, decision === "accept" ? "success" : "info");
      SJ.refreshBadges();
      await renderReview(document.getElementById("view"));
      SJ.refreshCurrent();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.old || "Retry"; }
      SJ.toast("Could not resolve", e.message, "error");
    }
  }

  /* =================================================================
     IMPORT
     ================================================================= */
  const importState = (SJ.importState = { file: null, preview: null, busy: false });

  async function renderImport(el) {
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h2>Import broker CSV</h2><p>Zerodha tradebook or any broker export — columns are detected automatically.</p></div>
        <div class="page-actions"><a class="btn ghost sm" href="/api/export/csv">${icon("download")} Export journal</a></div>
      </div>
      <div class="split-2">
        <div>
          <div class="dropzone" id="dz">
            <div class="dz-ico">${icon("upload")}</div>
            <strong>Drop your CSV here, or click to choose</strong>
            <span>CSV / XLSX · Zerodha tradebook, P&amp;L statement, or any fill export</span>
            <input type="file" id="dzFile" accept=".csv,.txt,.xlsx,.xls" hidden>
          </div>
          <div class="banner mt">${icon("info")}<div><strong>CSV, not "CVV".</strong> A CSV is a comma-separated values file. In Zerodha Kite: <b>Console → Reports → Tradebook → Download CSV</b>. You can upload the same file again — duplicates are detected and skipped.</div></div>
          <div class="card mt">
            <div class="card-head"><h3>What gets detected</h3></div>
            <div class="card-body" style="font-size:12.5px;color:var(--text-2);display:flex;flex-direction:column;gap:8px">
              <div class="row">${icon("check")}<span><b>Columns:</b> symbol, date, side, quantity, price, order/trade id, charges — in any order, with any common header name.</span></div>
              <div class="row">${icon("check")}<span><b>Fills:</b> BUY/SELL rows are matched FIFO into round-trip trades, including partial exits.</span></div>
              <div class="row">${icon("check")}<span><b>Round trips:</b> entry + exit columns are imported as closed trades directly.</span></div>
              <div class="row">${icon("check")}<span><b>Safety:</b> re-uploads are deduplicated; ambiguous matches are held in Review.</span></div>
            </div>
          </div>
        </div>
        <div id="importResult">
          <div class="card"><div class="empty"><span class="big-icon">${icon("upload")}</span><strong>No file selected</strong><p>Pick a CSV to see a full preview and a dry-run summary before anything is written to your journal.</p></div></div>
        </div>
      </div>`;

    const dz = el.querySelector("#dz");
    const fileInput = el.querySelector("#dzFile");
    dz.onclick = () => fileInput.click();
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], el);
    };
    fileInput.onchange = () => {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0], el);
    };
  }

  async function handleFile(file, el) {
    if (!/\.(csv|txt|xlsx|xls)$/i.test(file.name)) {
      return SJ.toast("Unsupported file", "Choose a .csv or .xlsx file", "warn");
    }
    importState.file = file;
    importState.preview = null;
    const out = el.querySelector("#importResult");
    out.innerHTML = `<div class="card"><div class="loading"><div class="spinner"></div><span>Reading ${esc(file.name)}…</span></div></div>`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const p = await SJ.api("/api/import/preview", { method: "POST", form: fd });
      importState.preview = p;
      out.innerHTML = previewHtml(p, file);
      bindPreview(out, el);
    } catch (e) {
      out.innerHTML = `<div class="card"><div class="banner warn" style="margin:14px">${icon("alert")}<div><strong>Could not read this file.</strong><br>${esc(e.message)}</div></div></div>`;
    }
  }

  function previewHtml(p, file) {
    const sim = p.simulation || {};
    const hasError = !!sim.error;
    const cols = Object.keys((p.preview || [])[0] || {});
    const previewRows = (p.preview || []).map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c] === "number" ? (Number(r[c]) % 1 === 0 ? r[c] : Number(r[c]).toFixed(2)) : r[c] ?? "")}</td>`).join("")}</tr>`).join("");
    return `
      <div class="card">
        <div class="card-head">
          <h3>Import preview</h3>
          <div class="right"><span class="file-chip">${icon("book")} ${esc(file.name)} <span class="dim">${(file.size / 1024).toFixed(1)} KB</span></span></div>
        </div>
        <div class="card-body">
          <div class="summary-chips mb">
            <div class="sc"><div class="n">${p.row_count || 0}</div><div class="l">rows detected</div></div>
            <div class="sc"><div class="n pos">${sim.created_trades || 0}</div><div class="l">new trades</div></div>
            <div class="sc"><div class="n">${sim.closed || 0}</div><div class="l">closed by fills</div></div>
            <div class="sc"><div class="n ${sim.duplicates ? "dim" : ""}">${sim.duplicates || 0}</div><div class="l">duplicates</div></div>
            <div class="sc"><div class="n ${sim.review ? "neg" : ""}">${sim.review || 0}</div><div class="l">need review</div></div>
          </div>

          <div class="row wrap mb" style="gap:6px">
            <span class="map-chip">Format <b>${p.kind === "roundtrip" ? "round trips (entry + exit)" : "fills (buy/sell)"}</b></span>
            <span class="map-chip">Delimiter <b>${esc(p.delimiter === "\t" ? "tab" : p.delimiter)}</b></span>
            <span class="map-chip">Header row <b>${p.header_row}</b></span>
            <span class="map-chip">Skipped <b>${p.skipped || 0}</b></span>
          </div>

          <div class="map-grid mb">${Object.entries(p.mapping || {}).map(([k, v]) => `<span class="map-chip"><b>${esc(v)}</b><span class="arr">→</span>${esc(k)}</span>`).join("")}</div>

          ${hasError ? `<div class="banner warn mb">${icon("alert")}<div>${esc(sim.error)}</div></div>` : ""}
          ${(p.problems || []).length ? `<div class="banner warn mb">${icon("alert")}<div><strong>${p.problems.length} row(s) need attention</strong><br>${p.problems.slice(0, 4).map((x) => `Row ${x.row}: ${esc(x.reason)}`).join("<br>")}</div></div>` : ""}

          ${cols.length && previewRows ? `<div class="table-wrap" style="max-height:300px;border:1px solid var(--border-soft);border-radius:9px"><table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${previewRows}</tbody></table></div>` : ""}

          <div class="row between mt">
            <span class="hint">${sim.duplicates ? `${sim.duplicates} row(s) already exist and will be skipped.` : "Dry run complete — nothing has been saved yet."}</span>
            <button class="btn primary" id="doImport" ${hasError || !(p.row_count > 0) ? "disabled" : ""}>${icon("upload")} Import ${p.row_count} rows</button>
          </div>
        </div>
      </div>`;
  }

  function bindPreview(root, el) {
    const btn = root.querySelector("#doImport");
    if (!btn) return;
    btn.onclick = async () => {
      if (!importState.file) return;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Importing…`;
      const fd = new FormData();
      fd.append("file", importState.file);
      try {
        const res = await SJ.api("/api/import/commit", { method: "POST", form: fd });
        const s = res.summary;
        SJ.refreshBadges();
        root.innerHTML = `<div class="card">
          <div class="card-head"><h3>Import complete</h3><div class="right"><span class="pill profit">done</span></div></div>
          <div class="card-body">
            <div class="summary-chips mb">
              <div class="sc"><div class="n pos">${s.created_trades}</div><div class="l">trades created</div></div>
              <div class="sc"><div class="n">${s.closed}</div><div class="l">closed by sells</div></div>
              <div class="sc"><div class="n dim">${s.duplicates}</div><div class="l">duplicates skipped</div></div>
              <div class="sc"><div class="n ${s.review ? "neg" : ""}">${s.review}</div><div class="l">held for review</div></div>
              <div class="sc"><div class="n">${s.ignored}</div><div class="l">ignored</div></div>
            </div>
            ${s.review ? `<div class="banner warn mb">${icon("shield")}<div><strong>${s.review} item(s) need a decision.</strong> Nothing doubtful was written. <a href="#review">Open review queue</a>.</div></div>` : ""}
            ${(s.errors || []).length ? `<div class="banner warn mb">${icon("alert")}<div>${s.errors.map((x) => `Row ${x.row}: ${esc(x.error)}`).join("<br>")}</div></div>` : ""}
            ${(s.details || []).length ? `<div class="table-wrap" style="max-height:260px;border:1px solid var(--border-soft);border-radius:9px"><table class="data"><thead><tr><th>Row</th><th>Symbol</th><th>Action</th><th>Message</th></tr></thead><tbody>
              ${s.details.map((d) => `<tr style="cursor:default"><td>${esc(d.row ?? "")}</td><td>${esc(d.symbol || "")}</td><td><span class="pill neutral">${esc(d.action)}</span></td><td class="dim">${esc(d.message || "")}</td></tr>`).join("")}
            </tbody></table></div>` : ""}
            <div class="row mt">
              <button class="btn primary" id="importAgain">${icon("upload")} Import another file</button>
              <a class="btn ghost" href="#dashboard">Go to dashboard</a>
            </div>
          </div>
        </div>`;
        root.querySelector("#importAgain").onclick = () => {
          importState.file = null;
          importState.preview = null;
          renderImport(el);
        };
        SJ.toast("Import complete", `${s.created_trades} new trade(s), ${s.duplicates} duplicate(s) skipped`, "success");
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = `${icon("upload")} Import ${importState.preview.row_count} rows`;
        SJ.toast("Import failed", e.message, "error");
      }
    };
  }

  /* =================================================================
     BROKER (Zerodha)
     ================================================================= */
  async function renderBroker(el) {
    el.innerHTML = `<div id="brokerBody"><div class="loading"><div class="spinner"></div><span>Checking Zerodha connection…</span></div></div>`;
    const body = el.querySelector("#brokerBody");
    let st;
    try { st = await SJ.api("/api/broker/status"); }
    catch (e) {
      body.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not read broker status.</strong><br>${esc(e.message)}</div></div>`;
      return;
    }
    const connected = st.connected;
    const last = st.last_sync_summary || {};
    body.innerHTML = `
      <div class="page-head">
        <div class="grow"><h2>Zerodha Kite Connect</h2><p>Pull executed orders, holdings and positions into the journal without creating duplicates.</p></div>
        <div class="page-actions">
          <span class="pill ${connected ? "profit" : "neutral"}">${connected ? "Connected" : "Not connected"}</span>
          ${connected ? `<button class="btn ghost sm" id="brTest">${icon("plug")} Test</button>` : ""}
        </div>
      </div>

      ${connected ? `<div class="banner green mb">${icon("check")}<div><strong>Linked as ${esc(st.user_id || "Zerodha user")}.</strong> Token issued ${esc((st.connected_at || "").replace("T", " "))}. Access tokens expire around 6 AM IST — reconnect each morning if sync fails.</div></div>` : ""}

      <div class="split-2">
        <div class="card">
          <div class="card-head"><h3>${connected ? "Connection" : "Connect your account"}</h3><div class="right"><span class="sub">Kite Connect app required</span></div></div>
          <div class="card-body">
            ${connected ? connectedPanel(st) : connectWizard(st)}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Sync</h3><div class="right"><span class="sub" id="syncWhen">${st.last_sync ? "last " + esc(st.last_sync.replace("T", " ")) : "never"}</span></div></div>
          <div class="card-body">
            <div class="row wrap mb">
              <button class="btn primary" id="syncAll" ${connected ? "" : "disabled"}>${icon("sync")} Sync everything</button>
              <button class="btn ghost sm" id="syncOrders" ${connected ? "" : "disabled"}>Orders</button>
              <button class="btn ghost sm" id="syncHoldings" ${connected ? "" : "disabled"}>Holdings</button>
              <button class="btn ghost sm" id="syncPositions" ${connected ? "" : "disabled"}>Positions</button>
              <button class="btn ghost sm" id="syncLtp" ${connected ? "" : "disabled"}>Refresh LTP</button>
            </div>
            <div id="syncResult">${lastSummary(last)}</div>
          </div>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head"><h3>How the duplicate protection works</h3></div>
        <div class="card-body" style="font-size:12.5px;color:var(--text-2);display:flex;flex-direction:column;gap:9px">
          <div class="row">${icon("check")}<span><b>Orders</b> carry a unique order id — re-syncing the same day never duplicates them.</span></div>
          <div class="row">${icon("check")}<span><b>Holdings/positions</b> are matched to open journal trades by symbol, side and quantity. Price differences become a review item, not a new row.</span></div>
          <div class="row">${icon("check")}<span><b>Multiple open lots</b> for the same symbol are left untouched and reported, so nothing is merged silently.</span></div>
          <div class="row">${icon("check")}<span><b>Manually added trades</b> are respected: broker data is only used to update them after you approve.</span></div>
        </div>
      </div>`;
    bindBroker(body, st);
  }

  function connectedPanel(st) {
    return `
      <div class="kv" style="font-size:12.5px">
        <dt>API key</dt><dd>${esc(st.api_key || "—")}</dd>
        <dt>User</dt><dd>${esc(st.user_id || "—")}</dd>
        <dt>Connected</dt><dd>${esc((st.connected_at || "").replace("T", " "))}</dd>
        <dt>Last sync</dt><dd>${esc((st.last_sync || "never").replace("T", " "))}</dd>
      </div>
      <div class="row mt">
        <button class="btn ghost sm" id="brDisconnect">${icon("logout")} Disconnect</button>
        <button class="btn ghost sm" id="brNewToken">${icon("refresh")} Refresh token</button>
      </div>
      <div id="tokenPanel" class="mt hidden"></div>`;
  }

  function connectWizard(st) {
    return `
      <div class="banner mb">${icon("info")}<div>You need a Kite Connect app from <a href="https://developers.kite.trade" target="_blank" rel="noopener">developers.kite.trade</a>. Set its redirect URL to any page you control (the default <code>http://127.0.0.1</code> is fine) — you only need the <b>request_token</b> from the redirect.</div></div>
      <div class="steps">
        <div class="step"><div class="step-body"><strong>Save your API credentials</strong>
          <p>They are stored only in this computer's journal database.</p>
          <div class="field mb"><label>API key</label><input class="input" id="brKey" value="${esc(st.api_key || "")}" placeholder="your_api_key"></div>
          <div class="field mb"><label>API secret</label><input class="input" id="brSecret" type="password" placeholder="${st.api_key ? "saved — type to replace" : "your_api_secret"}"></div>
          <button class="btn primary sm" id="brSave">${icon("save")} Save credentials</button>
        </div></div>
        <div class="step"><div class="step-body"><strong>Log in to Zerodha</strong>
          <p>Open the Kite login page, sign in, then copy the <code>request_token</code> value from the address bar of the page you land on.</p>
          <button class="btn sm" id="brLogin" ${st.api_key ? "" : "disabled"}>${icon("external")} Open Kite login</button>
        </div></div>
        <div class="step"><div class="step-body"><strong>Paste the request token</strong>
          <p>We exchange it for an access token valid until roughly 6 AM tomorrow.</p>
          <div class="row"><input class="input" id="brToken" placeholder="request_token"><button class="btn primary sm" id="brConnect">Connect</button></div>
        </div></div>
      </div>`;
  }

  function bindBroker(root, st) {
    const saveBtn = root.querySelector("#brSave");
    if (saveBtn)
      saveBtn.onclick = async () => {
        const key = root.querySelector("#brKey").value.trim();
        const secret = root.querySelector("#brSecret").value.trim();
        if (!key) return SJ.toast("API key required", "", "warn");
        try {
          const res = await SJ.api("/api/broker/credentials", { method: "POST", body: { api_key: key, api_secret: secret } });
          SJ.toast("Credentials saved", "Now log in to Zerodha", "success");
          renderBroker(document.getElementById("view"));
        } catch (e) { SJ.toast("Could not save", e.message, "error"); }
      };

    const loginBtn = root.querySelector("#brLogin");
    if (loginBtn)
      loginBtn.onclick = async () => {
        try {
          const res = await SJ.api("/api/broker/login-url");
          window.open(res.login_url, "_blank", "noopener");
        } catch (e) { SJ.toast("Could not build login URL", e.message, "error"); }
      };

    const connectBtn = root.querySelector("#brConnect");
    if (connectBtn)
      connectBtn.onclick = async () => {
        const token = root.querySelector("#brToken").value.trim();
        if (!token) return SJ.toast("Request token required", "", "warn");
        connectBtn.disabled = true;
        try {
          const res = await SJ.api("/api/broker/session", { method: "POST", body: { request_token: token } });
          SJ.toast("Zerodha connected", `Linked to ${res.user_id || "your account"}`, "success");
          SJ.refreshBadges();
          renderBroker(document.getElementById("view"));
        } catch (e) {
          connectBtn.disabled = false;
          SJ.toast("Connection failed", e.message, "error");
        }
      };

    const dis = root.querySelector("#brDisconnect");
    if (dis)
      dis.onclick = async () => {
        const ok = await SJ.confirm({ title: "Disconnect Zerodha?", message: "The access token will be removed. Your journal data stays intact.", confirm: "Disconnect", danger: true });
        if (!ok) return;
        await SJ.api("/api/broker/disconnect", { method: "POST" });
        SJ.toast("Disconnected", "", "info");
        SJ.refreshBadges();
        renderBroker(document.getElementById("view"));
      };

    const newToken = root.querySelector("#brNewToken");
    if (newToken)
      newToken.onclick = () => {
        const panel = root.querySelector("#tokenPanel");
        panel.classList.toggle("hidden");
        panel.innerHTML = `<div class="form-section" style="padding-top:4px;margin-top:4px">
          <div class="row"><input class="input" id="brToken2" placeholder="new request_token"><button class="btn primary sm" id="brConnect2">Update token</button></div>
          <p class="hint mt">Open Kite login, then paste the request_token from the redirect URL.</p>
        </div>`;
        panel.querySelector("#brConnect2").onclick = async () => {
          const token = panel.querySelector("#brToken2").value.trim();
          if (!token) return;
          try {
            await SJ.api("/api/broker/session", { method: "POST", body: { request_token: token } });
            SJ.toast("Token updated", "", "success");
            renderBroker(document.getElementById("view"));
          } catch (e) { SJ.toast("Failed", e.message, "error"); }
        };
      };

    const test = root.querySelector("#brTest");
    if (test)
      test.onclick = async () => {
        test.disabled = true;
        try {
          const res = await SJ.api("/api/broker/test", { method: "POST" });
          SJ.toast("Connection OK", `Profile: ${res.profile.user_name || res.profile.user_id}`, "success");
        } catch (e) { SJ.toast("Connection failed", e.message, "error"); }
        test.disabled = false;
      };

    const modes = { syncAll: "all", syncOrders: "orders", syncHoldings: "holdings", syncPositions: "positions", syncLtp: "ltp" };
    Object.entries(modes).forEach(([id, mode]) => {
      const b = root.querySelector("#" + id);
      if (!b) return;
      b.onclick = async () => {
        const original = b.innerHTML;
        b.disabled = true;
        b.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px"></span> Syncing…`;
        const result = root.querySelector("#syncResult");
        result.innerHTML = `<div class="loading" style="padding:24px"><div class="spinner"></div><span>Talking to Zerodha…</span></div>`;
        try {
          const res = await SJ.api("/api/broker/sync", { method: "POST", body: { mode } });
          result.innerHTML = lastSummary(res.summary);
          const w = root.querySelector("#syncWhen");
          if (w) w.textContent = "last just now";
          SJ.toast("Sync complete", `${(res.summary.added || []).length} added · ${(res.summary.review || []).length} review`, (res.summary.errors || []).length ? "warn" : "success");
          SJ.refreshBadges();
          SJ.refreshCurrent();
        } catch (e) {
          result.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Sync failed.</strong><br>${esc(e.message)}</div></div>`;
          SJ.toast("Sync failed", e.message, "error");
        }
        b.disabled = false;
        b.innerHTML = original;
        SJ.hydrateIcons(b);
      };
    });
  }

  function lastSummary(s) {
    if (!s || (!s.started_at && !s.added && !s.review)) {
      return `<div class="empty" style="padding:26px"><span class="big-icon">${icon("sync")}</span><p>No sync yet. Connect Zerodha and hit “Sync everything”.</p></div>`;
    }
    const added = s.added || [];
    const review = s.review || [];
    const errors = s.errors || [];
    const notes = s.notes || [];
    return `
      <div class="summary-chips mb">
        <div class="sc"><div class="n pos">${added.length}</div><div class="l">added</div></div>
        <div class="sc"><div class="n">${s.closed || 0}</div><div class="l">closed</div></div>
        <div class="sc"><div class="n">${s.matched || 0}</div><div class="l">matched</div></div>
        <div class="sc"><div class="n dim">${s.skipped || 0}</div><div class="l">skipped</div></div>
        <div class="sc"><div class="n ${review.length ? "neg" : ""}">${review.length}</div><div class="l">review</div></div>
      </div>
      ${errors.length ? `<div class="banner warn mb">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
      ${notes.length ? `<div class="banner mb">${icon("info")}<div>${notes.map(esc).join("<br>")}</div></div>` : ""}
      ${added.length ? `<div class="small muted mb">Added</div><div class="row wrap mb">${added.slice(0, 12).map((a) => `<span class="tag">${esc(a.symbol)} · ${esc(a.kind || "")}</span>`).join("")}${added.length > 12 ? `<span class="tag">+${added.length - 12} more</span>` : ""}</div>` : ""}
      ${review.length ? `<div class="small muted mb">Held for review</div><div class="row wrap">${review.slice(0, 8).map((a) => `<span class="tag">${esc(a.symbol)} · ${esc(a.kind)}</span>`).join("")}${review.length > 8 ? `<span class="tag">+${review.length - 8}</span>` : ""}</div><div class="mt"><a class="btn ghost sm" href="#review">Open review queue</a></div>` : ""}
      <div class="hint mt">${s.holdings ? `${s.holdings} holdings · ${s.positions || 0} positions · ` : ""}${s.ltp_updated || 0} prices refreshed</div>`;
  }

  /* =================================================================
     SETTINGS
     ================================================================= */
  async function renderSettings(el) {
    el.innerHTML = `<div id="settingsBody"><div class="loading"><div class="spinner"></div><span>Loading settings…</span></div></div>`;
    const body = el.querySelector("#settingsBody");
    let cash, boot;
    try {
      [cash, boot] = await Promise.all([SJ.api("/api/cash"), SJ.api("/api/bootstrap")]);
    } catch (e) {
      body.innerHTML = `<div class="banner warn">${icon("alert")}<div><strong>Could not load settings.</strong><br>${esc(e.message)}</div></div>`;
      return;
    }
    SJ.state.settings = boot.settings;
    const s = boot.settings;
    const cols = s.columns || {};
    const cards = s.stats_cards || {};
    const h = boot.holdings || {};
    const theme = document.documentElement.dataset.theme;
    body.innerHTML = `
      <div class="page-head">
        <div class="grow"><h2>Settings</h2><p>Account, data safety, duplicate detection and appearance</p></div>
      </div>

      <div class="settings-grid">
        <div class="card">
          <div class="card-head"><h3>Account</h3><div class="right"><span class="sub">used for account returns</span></div></div>
          <div class="card-body">
            <div class="row wrap mb">
              <div class="field grow"><label>Cash balance</label><input class="input" id="acctBalance" type="number" step="any" value="${Number(s.account_balance || 0)}"></div>
              <button class="btn primary" id="acctSave" style="align-self:flex-end">Save</button>
            </div>
            <div class="summary-strip" style="margin-bottom:12px">
              <div class="item"><span>Holdings worth</span><strong>${F.money(h.worth || 0, 0)}</strong></div>
              <div class="item"><span>Account value</span><strong>${F.money(h.account_value || 0, 0)}</strong></div>
              <div class="item"><span>Open P&amp;L</span><strong class="${F.cls(h.unrealised)}">${F.signedMoney(h.unrealised)}</strong></div>
            </div>
            <div class="form-section">
              <h3>Cash movement</h3>
              <div class="row wrap mb">
                <select class="select" id="cashKind" style="width:auto"><option value="DEPOSIT">Deposit</option><option value="WITHDRAW">Withdraw</option><option value="ADJUST">Adjust</option></select>
                <input class="input" id="cashAmt" type="number" step="any" placeholder="Amount" style="max-width:130px">
                <input class="input" id="cashNote" placeholder="Note (optional)" style="max-width:180px">
                <button class="btn sm" id="cashAdd">Add</button>
              </div>
              <div id="cashList">${cashList(cash.entries)}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Duplicate protection</h3><div class="right"><span class="sub">imports &amp; broker sync</span></div></div>
          <div class="card-body">
            <div class="field mb"><label>Price tolerance for “same trade”</label>
              <div class="row"><input class="input" type="number" step="0.1" min="0" max="10" id="dupTol" value="${s.duplicate_price_tolerance_pct}"><span class="muted">%</span></div>
              <span class="hint">Same symbol + quantity + date within this price band = duplicate.</span>
            </div>
            <div class="field mb"><label>Date window</label>
              <div class="row"><input class="input" type="number" step="1" min="0" max="30" id="dupWindow" value="${s.duplicate_date_window_days}"><span class="muted">days</span></div>
              <span class="hint">Matches inside this window are treated as the same trade.</span>
            </div>
            <div class="setting-row">
              <div class="sr-main"><div class="sr-title">Create new trades from broker sync</div><div class="sr-sub">If off, unmatched holdings/positions go to review instead</div></div>
              <label class="switch"><input type="checkbox" id="autoBroker" ${s.auto_create_new_from_broker ? "checked" : ""}><i></i></label>
            </div>
            <button class="btn primary sm mt" id="dupSave">Save</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Trade table columns</h3><div class="right"><span class="sub">dashboard</span></div></div>
          <div class="card-body">
            <div class="checks" id="colChecks">
              ${(SJ.DASH_COLUMNS || []).filter((c) => c.key !== "actions").map((c) => `<label class="check"><input type="checkbox" value="${c.key}" ${cols[c.key] !== false ? "checked" : ""}> ${esc(c.label)}</label>`).join("")}
            </div>
            <button class="btn sm mt" id="colSave">Save columns</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Stats cards</h3><div class="right"><span class="sub">stats page</span></div></div>
          <div class="card-body">
            <div class="checks" id="statChecks">
              ${(SJ.STAT_CARDS || []).map((c) => `<label class="check"><input type="checkbox" value="${c.key}" ${cards[c.key] !== false ? "checked" : ""}> ${esc(c.label)}</label>`).join("")}
            </div>
            <button class="btn sm mt" id="statSave">Save stats</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Appearance</h3></div>
          <div class="card-body">
            <div class="setting-row">
              <div class="sr-main"><div class="sr-title">Light theme</div><div class="sr-sub">Switch between dark and light</div></div>
              <label class="switch"><input type="checkbox" id="themeToggle" ${theme === "light" ? "checked" : ""}><i></i></label>
            </div>
            <div class="setting-row">
              <div class="sr-main"><div class="sr-title">Currency</div><div class="sr-sub">Indian Rupee (₹)</div></div>
              <span class="tag">INR</span>
            </div>
            <div class="setting-row">
              <div class="sr-main"><div class="sr-title">Print / PDF</div><div class="sr-sub">Use your browser's print for a clean report</div></div>
              <button class="btn ghost xs" onclick="window.print()">Print</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Data &amp; backup</h3><div class="right"><span class="sub">stored on this computer</span></div></div>
          <div class="card-body">
            <div class="field mb"><label>Data folder</label><div class="code-box">${esc(boot.storage.data_dir)}</div>
              <span class="hint">Database: ${esc(boot.storage.db_path)} · ${(boot.storage.db_size / 1024).toFixed(0)} KB · ${boot.storage.attachments} screenshots</span>
            </div>
            <div class="row wrap mb">
              <button class="btn sm" id="doBackup">${icon("download")} Download backup (JSON)</button>
              <button class="btn ghost sm" id="doExport">${icon("download")} Export trades (CSV)</button>
              <label class="btn ghost sm" style="cursor:pointer">${icon("upload")} Restore backup<input type="file" id="doRestore" accept="application/json,.json" hidden></label>
            </div>
            <div class="row wrap">
              <button class="btn ghost sm" id="loadSample">${icon("play")} Load sample data</button>
              <button class="btn danger sm" id="doReset">${icon("trash")} Reset journal</button>
            </div>
            <p class="hint mt">Backups are saved in the <code>backups</code> sub-folder automatically each time you download one.</p>
          </div>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head"><h3>About</h3></div>
        <div class="card-body row wrap between" style="gap:14px">
          <div class="small muted" style="max-width:680px">
            <b>Stock Journal</b> v${esc(boot.version)} — a local-first, standalone trading journal. All data stays in the folder above; nothing is uploaded anywhere.
            Zerodha sync uses the official Kite Connect API with your own app credentials. Imported files are processed locally.
          </div>
          <div class="row"><a class="btn ghost sm" href="https://kite.trade/docs/connect/v3/" target="_blank" rel="noopener">Kite API docs ${icon("external")}</a></div>
        </div>
      </div>`;

    bindSettings(body, boot, cash);
  }

  function cashList(entries) {
    if (!entries || !entries.length) return `<p class="hint">No deposits or withdrawals recorded.</p>`;
    return `<table class="mini-table"><thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead><tbody>
      ${entries.slice(0, 8).map((e) => `<tr><td>${F.date(e.date, "day")}</td><td><span class="pill ${e.kind === "WITHDRAW" ? "loss" : "profit"}">${e.kind}</span></td>
        <td class="num ${e.kind === "WITHDRAW" ? "neg" : "pos"}">${F.money(e.amount)}</td><td class="dim">${esc(e.note || "")}</td>
        <td class="right"><button class="icon-btn sm danger" data-del-cash="${e.id}" title="Remove">${icon("trash")}</button></td></tr>`).join("")}
    </tbody></table>`;
  }

  function bindSettings(root, boot, cash) {
    const s = boot.settings;
    root.querySelector("#acctSave").onclick = async () => {
      const val = Number(root.querySelector("#acctBalance").value) || 0;
      try {
        const res = await SJ.api("/api/settings", { method: "PUT", body: { account_balance: val } });
        SJ.state.settings = res.settings;
        SJ.toast("Balance updated", F.money(val, 0), "success");
        await SJ.loadBootstrap();
        renderSettings(document.getElementById("view"));
      } catch (e) { SJ.toast("Could not save", e.message, "error"); }
    };

    root.querySelector("#cashAdd").onclick = async () => {
      const amount = Number(root.querySelector("#cashAmt").value);
      if (!amount) return SJ.toast("Enter an amount", "", "warn");
      try {
        await SJ.api("/api/cash", { method: "POST", body: { amount, kind: root.querySelector("#cashKind").value, note: root.querySelector("#cashNote").value } });
        SJ.toast("Cash entry added", "", "success");
        renderSettings(document.getElementById("view"));
        SJ.loadBootstrap();
      } catch (e) { SJ.toast("Could not add", e.message, "error"); }
    };
    root.querySelectorAll("[data-del-cash]").forEach((b) => {
      b.onclick = async () => {
        try {
          await SJ.api(`/api/cash/${b.dataset.delCash}`, { method: "DELETE" });
          renderSettings(document.getElementById("view"));
          SJ.loadBootstrap();
        } catch (e) { SJ.toast("Could not remove", e.message, "error"); }
      };
    });

    root.querySelector("#dupSave").onclick = async () => {
      try {
        const res = await SJ.api("/api/settings", {
          method: "PUT",
          body: {
            duplicate_price_tolerance_pct: Number(root.querySelector("#dupTol").value) || 1,
            duplicate_date_window_days: Number(root.querySelector("#dupWindow").value) || 3,
            auto_create_new_from_broker: root.querySelector("#autoBroker").checked,
          },
        });
        SJ.state.settings = res.settings;
        SJ.toast("Saved", "Duplicate rules updated", "success");
      } catch (e) { SJ.toast("Could not save", e.message, "error"); }
    };

    root.querySelector("#colSave").onclick = async () => {
      const next = {};
      (SJ.DASH_COLUMNS || []).filter((c) => c.key !== "actions").forEach((c) => (next[c.key] = false));
      root.querySelectorAll("#colChecks input:checked").forEach((i) => (next[i.value] = true));
      next.actions = true;
      try {
        const res = await SJ.api("/api/settings", { method: "PUT", body: { columns: next } });
        SJ.state.settings = res.settings;
        SJ.toast("Columns saved", "", "success");
      } catch (e) { SJ.toast("Could not save", e.message, "error"); }
    };

    root.querySelector("#statSave").onclick = async () => {
      const next = {};
      (SJ.STAT_CARDS || []).forEach((c) => (next[c.key] = false));
      root.querySelectorAll("#statChecks input:checked").forEach((i) => (next[i.value] = true));
      try {
        const res = await SJ.api("/api/settings", { method: "PUT", body: { stats_cards: next } });
        SJ.state.settings = res.settings;
        SJ.toast("Stats saved", "", "success");
      } catch (e) { SJ.toast("Could not save", e.message, "error"); }
    };

    root.querySelector("#themeToggle").onchange = (e) => {
      const theme = e.target.checked ? "light" : "dark";
      SJ.applyTheme(theme);
      SJ.api("/api/settings", { method: "PUT", body: { theme } }).catch(() => {});
    };

    root.querySelector("#doBackup").onclick = async () => {
      try {
        await SJ.download("/api/backup", `stock-journal-backup-${F.todayISO()}.json`);
        SJ.toast("Backup downloaded", "Also saved in your data/backups folder", "success");
      } catch (e) { SJ.toast("Backup failed", e.message, "error"); }
    };
    root.querySelector("#doExport").onclick = () => SJ.download("/api/export/csv", `stock-journal-${F.todayISO()}.csv`);

    root.querySelector("#doRestore").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const ok = await SJ.confirm({ title: "Restore backup?", message: "This replaces every trade, review item and setting currently in the journal with the backup contents.", confirm: "Restore", danger: true });
      if (!ok) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await SJ.api("/api/restore", { method: "POST", form: fd });
        SJ.toast("Backup restored", `${res.restored.trades || 0} trades loaded`, "success");
        SJ.loadBootstrap();
        renderSettings(document.getElementById("view"));
      } catch (err) { SJ.toast("Restore failed", err.message, "error"); }
    };

    root.querySelector("#loadSample").onclick = async () => {
      const ok = await SJ.confirm({ title: "Load sample data?", message: "This adds ~75 demo trades so you can explore the dashboard. You can reset the journal later.", confirm: "Load sample" });
      if (!ok) return;
      try {
        const res = await SJ.api("/api/sample", { method: "POST", body: { force: true } });
        SJ.toast("Sample data loaded", `${res.sample.created || 0} trades`, "success");
        SJ.loadBootstrap();
        SJ.refreshCurrent();
      } catch (e) { SJ.toast("Could not load sample", e.message, "error"); }
    };

    root.querySelector("#doReset").onclick = async () => {
      const ok = await SJ.confirm({ title: "Reset the journal?", message: "<b>Every trade, screenshot, review item and cash entry</b> will be deleted, and the account balance will go back to zero. Download a backup first if you might need this data.", confirm: "Delete everything", danger: true });
      if (!ok) return;
      try {
        await SJ.api("/api/reset", { method: "POST", body: { confirm: "RESET" } });
        SJ.toast("Journal reset", "All trades and balances cleared", "info");
        SJ.loadBootstrap();
        SJ.refreshCurrent();
      } catch (e) { SJ.toast("Reset failed", e.message, "error"); }
    };
  }

  /* =================================================================
     EXPOSE VIEWS
     ================================================================= */
  SJ.views = SJ.views || {};
  SJ.views.review = {
    title: "Review",
    subtitle: "Doubtful imports wait here until you decide",
    async render(el) {
      SJ.state.view = "review";
      await renderReview(el);
      // cache for the binder
    },
    refresh() { return renderReview(document.getElementById("view")); },
  };
  SJ.views.import = {
    title: "Import CSV",
    subtitle: "Auto-detected broker exports with duplicate protection",
    async render(el) { await renderImport(el); },
  };
  SJ.views.broker = {
    title: "Zerodha",
    subtitle: "Kite Connect sync for orders, holdings and positions",
    async render(el) { await renderBroker(el); },
  };
  SJ.views.settings = {
    title: "Settings",
    subtitle: "Account, data, duplicate rules and appearance",
    async render(el) { await renderSettings(el); },
  };
})();
