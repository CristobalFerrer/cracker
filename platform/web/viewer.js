/**
 * Standalone canvas viewer: loads pixel snapshot from IndexedDB, syncs hover/selection/UI with main tab.
 */
(function () {
  function crackOverlayAlpha(L, threshold, alphaBase, boostPct) {
    const t = Math.max(0, Math.min(255, threshold));
    const boost01 = Math.min(1, Math.max(0, (Number(boostPct) || 0) / 100));
    const linear = L / 255;
    const span = Math.max(1, 255 - t);
    const rel = Math.min(1, Math.max(0, (L - t) / span));
    const raised = Math.pow(rel, 0.38);
    const vis = linear * (1 - boost01) + raised * boost01;
    const amp = 1 + 0.45 * boost01;
    return Math.min(1, alphaBase * vis * amp);
  }

  const el = {
    overlayAlpha: document.getElementById("overlayAlpha"),
    overlayAlphaVal: document.getElementById("overlayAlphaVal"),
    zoom: document.getElementById("zoom"),
    zoomVal: document.getElementById("zoomVal"),
    threshold: document.getElementById("threshold"),
    thresholdVal: document.getElementById("thresholdVal"),
    status: document.getElementById("status"),
    canvas: document.getElementById("canvas"),
    viewport: document.getElementById("viewport"),
    btnZoomIn: document.getElementById("btnZoomIn"),
    btnZoomOut: document.getElementById("btnZoomOut"),
    btnZoomReset: document.getElementById("btnZoomReset"),
    hint: document.getElementById("viewerHint"),
  };

  const ctx = el.canvas.getContext("2d", { willReadFrequently: true });

  /** @type {Int32Array|null} */
  let labels = null;
  /** @type {Uint8Array|null} */
  let mask = null;
  /** @type {Uint8ClampedArray|null} */
  let lum = null;
  /** @type {ImageData|null} */
  let origImageData = null;
  let displayW = 0;
  let displayH = 0;
  let origW = 0;
  let origH = 0;
  let crackW = 0;
  let crackH = 0;
  let selectedId = 0;
  let rafPending = false;
  let analysisMessage = "";
  /** @type {{ active: boolean, crackId: number, lum: number }} */
  let hoverState = { active: false, crackId: 0, lum: 0 };

  /** @type {BroadcastChannel|null} */
  let syncBc = null;

  function broadcastSync(msg) {
    if (!syncBc || typeof CrackerSync === "undefined") return;
    try {
      syncBc.postMessage({ ...msg, tabId: CrackerSync.tabId });
    } catch (_) {
      /* ignore */
    }
  }

  function labelMask(maskArr, w, h) {
    const out = new Int32Array(w * h);
    let next = 1;
    const stack = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (maskArr[i] !== 1 || out[i] !== 0) continue;
        const id = next++;
        out[i] = id;
        stack.length = 0;
        stack.push(i);

        while (stack.length) {
          const j = stack.pop();
          const jx = j % w;
          const jy = (j / w) | 0;
          const nbs = [
            jx > 0 ? j - 1 : -1,
            jx < w - 1 ? j + 1 : -1,
            jy > 0 ? j - w : -1,
            jy < h - 1 ? j + w : -1,
            jx > 0 && jy > 0 ? j - w - 1 : -1,
            jx < w - 1 && jy > 0 ? j - w + 1 : -1,
            jx > 0 && jy < h - 1 ? j + w - 1 : -1,
            jx < w - 1 && jy < h - 1 ? j + w + 1 : -1,
          ];
          for (const k of nbs) {
            if (k < 0) continue;
            if (maskArr[k] !== 1 || out[k] !== 0) continue;
            out[k] = id;
            stack.push(k);
          }
        }
      }
    }
    return { labels: out, count: next - 1 };
  }

  function refreshStatus() {
    let s = analysisMessage;
    if (hoverState.active) {
      if (hoverState.crackId > 0) {
        s += ` — hover: crack #${hoverState.crackId} (value ${hoverState.lum})`;
      } else {
        s += ` — hover: background (value ${hoverState.lum})`;
      }
    }
    if (selectedId > 0) s += ` — selected: #${selectedId}`;
    el.status.textContent = s;
  }

  function setAnalysisStatus(msg) {
    analysisMessage = msg;
    refreshStatus();
  }

  function syncThresholdLabel() {
    el.thresholdVal.textContent = el.threshold.value;
  }

  function syncOverlayLabel() {
    const v = Number(el.overlayAlpha.value) / 100;
    el.overlayAlphaVal.textContent = v.toFixed(2);
  }

  function syncZoomLabel() {
    el.zoomVal.textContent = `${el.zoom.value}%`;
  }

  function syncFaintCrackBoostLabel() {
    const inp = document.getElementById("faintCrackBoost");
    const lab = document.getElementById("faintCrackBoostVal");
    if (!inp || !lab) return;
    lab.textContent = `${inp.value}%`;
  }

  function reanalyzeFromLum(T) {
    if (!lum || !displayW || !displayH) return;
    const n = displayW * displayH;
    mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      mask[i] = lum[i] >= T ? 1 : 0;
    }
    const { labels: lb, count } = labelMask(mask, displayW, displayH);
    labels = lb;
    selectedId = 0;
    hoverState = { active: false, crackId: 0, lum: 0 };
    setAnalysisStatus(
      `Display ${displayW}×${displayH} (from ${origW}×${origH}). Crack map ${crackW}×${crackH} (stretched on main). Threshold ${T}: ${count} crack region(s).`,
    );
  }

  /**
   * @param {Record<string, unknown>} rec
   */
  function applySnapshotRecord(rec) {
    if (
      !rec ||
      typeof rec.displayW !== "number" ||
      typeof rec.displayH !== "number" ||
      !rec.lumBuf ||
      !rec.origRgbaBuf
    ) {
      setAnalysisStatus("Snapshot missing or invalid. Load a pair on the main page.");
      return;
    }
    selectedId = 0;
    hoverState = { active: false, crackId: 0, lum: 0 };
    displayW = rec.displayW;
    displayH = rec.displayH;
    origW = typeof rec.origW === "number" ? rec.origW : displayW;
    origH = typeof rec.origH === "number" ? rec.origH : displayH;
    crackW = typeof rec.crackW === "number" ? rec.crackW : displayW;
    crackH = typeof rec.crackH === "number" ? rec.crackH : displayH;

    lum = new Uint8ClampedArray(rec.lumBuf);
    const rgba = new Uint8ClampedArray(rec.origRgbaBuf);
    origImageData = new ImageData(rgba, displayW, displayH);

    if (typeof rec.overlayAlpha === "number") el.overlayAlpha.value = String(rec.overlayAlpha);
    if (typeof rec.zoom === "number") el.zoom.value = String(rec.zoom);
    if (typeof rec.threshold === "number") el.threshold.value = String(rec.threshold);
    {
      const fi = document.getElementById("faintCrackBoost");
      if (fi) fi.value = typeof rec.faintCrackBoost === "number" ? String(rec.faintCrackBoost) : "0";
    }
    syncOverlayLabel();
    syncZoomLabel();
    syncThresholdLabel();
    syncFaintCrackBoostLabel();

    const T = Number(el.threshold.value);
    if (rec.labelsBuf && rec.maskBuf) {
      labels = new Int32Array(rec.labelsBuf);
      mask = new Uint8Array(rec.maskBuf);
      let maxId = 0;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] > maxId) maxId = labels[i];
      }
      setAnalysisStatus(
        `Display ${displayW}×${displayH} (from ${origW}×${origH}). Crack map ${crackW}×${crackH}. Threshold ${T}: ${maxId} crack region(s).`,
      );
    } else {
      reanalyzeFromLum(T);
    }
    refreshStatus();
    paint();
  }

  function paint() {
    if (!origImageData || !mask || !lum || !labels) return;

    const out = ctx.createImageData(displayW, displayH);
    const od = origImageData.data;
    const d = out.data;
    const alphaBase = Number(el.overlayAlpha.value) / 100;
    const Tpaint = Number(el.threshold.value);
    const faintInp = document.getElementById("faintCrackBoost");
    const faintRaw = faintInp ? Number(faintInp.value) : 0;
    const faintB = Number.isFinite(faintRaw) ? faintRaw : 0;
    const hiHover = hoverState.active && hoverState.crackId > 0;
    const hiSel = selectedId > 0;

    for (let i = 0; i < displayW * displayH; i++) {
      const o = i * 4;
      let r = od[o];
      let g = od[o + 1];
      let b = od[o + 2];
      const L = lum[i];
      const id = labels[i];

      if (mask[i] === 1) {
        const a = crackOverlayAlpha(L, Tpaint, alphaBase, faintB);
        r = Math.round(r * (1 - a) + 255 * a);
        g = Math.round(g * (1 - a) + 0 * a);
        b = Math.round(b * (1 - a) + 40 * a);
      }

      if (hiSel && id === selectedId) {
        r = Math.min(255, Math.round(r * 0.75 + 255 * 0.25));
        g = Math.min(255, Math.round(g * 0.75 + 220 * 0.25));
        b = Math.round(b * 0.6);
      } else if (hiHover && id === hoverState.crackId && id !== selectedId) {
        r = Math.min(255, Math.round(r * 0.85 + 200 * 0.15));
        g = Math.min(255, Math.round(g * 0.85 + 255 * 0.15));
        b = Math.round(b * 0.85);
      }

      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }

    el.canvas.width = displayW;
    el.canvas.height = displayH;
    ctx.putImageData(out, 0, 0);

    const z = Number(el.zoom.value) / 100;
    el.canvas.style.width = `${Math.round(displayW * z)}px`;
    el.canvas.style.height = `${Math.round(displayH * z)}px`;
  }

  function canvasCoords(ev) {
    const rect = el.canvas.getBoundingClientRect();
    const sx = displayW / rect.width;
    const sy = displayH / rect.height;
    const x = Math.floor((ev.clientX - rect.left) * sx);
    const y = Math.floor((ev.clientY - rect.top) * sy);
    if (x < 0 || y < 0 || x >= displayW || y >= displayH) return null;
    return { x, y, i: y * displayW + x };
  }

  function onPointerMove(ev) {
    if (!labels || !lum) return;
    const c = canvasCoords(ev);
    if (!c) {
      hoverState = { active: false, crackId: 0, lum: 0 };
      refreshStatus();
      paint();
      broadcastSync({ type: "pointer", hoverState: { ...hoverState } });
      return;
    }
    const crackId = mask[c.i] === 1 ? labels[c.i] : 0;
    const next = { active: true, crackId, lum: lum[c.i] };
    if (
      next.crackId === hoverState.crackId &&
      next.lum === hoverState.lum &&
      next.active === hoverState.active
    ) {
      return;
    }
    hoverState = next;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        refreshStatus();
        paint();
        broadcastSync({ type: "pointer", hoverState: { ...hoverState } });
      });
    }
  }

  function onClick(ev) {
    if (!labels || !mask) return;
    const c = canvasCoords(ev);
    if (!c) return;
    if (mask[c.i] !== 1) {
      selectedId = 0;
    } else {
      selectedId = labels[c.i];
    }
    refreshStatus();
    paint();
    broadcastSync({ type: "select", selectedId });
  }

  function stepViewerZoom(deltaPct) {
    const min = Number(el.zoom.min);
    const max = Number(el.zoom.max);
    const step = Number(el.zoom.step) || 5;
    let z = Number(el.zoom.value) + deltaPct;
    z = Math.round(z / step) * step;
    z = Math.max(min, Math.min(max, z));
    el.zoom.value = String(z);
    syncZoomLabel();
    paint();
    broadcastSync({ type: "ui", zoom: Number(el.zoom.value) });
  }

  function resetViewerZoom() {
    el.zoom.value = "100";
    syncZoomLabel();
    paint();
    el.viewport.scrollLeft = 0;
    el.viewport.scrollTop = 0;
    broadcastSync({ type: "ui", zoom: 100 });
  }

  async function reloadFromIdb() {
    if (typeof CrackerSync === "undefined") return;
    try {
      const rec = await CrackerSync.loadSnapshot();
      if (rec) {
        applySnapshotRecord(rec);
        if (el.hint) el.hint.style.display = "none";
      } else {
        setAnalysisStatus("No snapshot yet. Load original + crack map on the main page.");
      }
    } catch (e) {
      setAnalysisStatus(`Could not read snapshot: ${e && e.message ? e.message : e}`);
    }
  }

  function wireBroadcastIn() {
    if (typeof CrackerSync === "undefined") return;
    try {
      syncBc = new BroadcastChannel(CrackerSync.CHANNEL);
    } catch (_) {
      return;
    }
    syncBc.onmessage = (ev) => {
      const d = ev.data;
      if (!d || d.tabId === CrackerSync.tabId) return;
      if (d.type === "pointer") {
        hoverState = d.hoverState || { active: false, crackId: 0, lum: 0 };
        refreshStatus();
        paint();
      } else if (d.type === "select") {
        selectedId = typeof d.selectedId === "number" ? d.selectedId : 0;
        refreshStatus();
        paint();
      } else if (d.type === "ui") {
        if (d.overlayAlpha != null) {
          el.overlayAlpha.value = String(d.overlayAlpha);
          syncOverlayLabel();
        }
        if (d.zoom != null) {
          el.zoom.value = String(d.zoom);
          syncZoomLabel();
        }
        if (d.faintCrackBoost != null) {
          const fi = document.getElementById("faintCrackBoost");
          if (fi) fi.value = String(d.faintCrackBoost);
          syncFaintCrackBoostLabel();
        }
        paint();
      } else if (d.type === "threshold") {
        if (d.threshold != null) {
          el.threshold.value = String(d.threshold);
          syncThresholdLabel();
          const T = Number(el.threshold.value);
          reanalyzeFromLum(T);
          paint();
        }
      } else if (d.type === "snapshot") {
        void reloadFromIdb();
      }
    };
  }

  el.overlayAlpha.addEventListener("input", () => {
    syncOverlayLabel();
    paint();
    broadcastSync({ type: "ui", overlayAlpha: Number(el.overlayAlpha.value) });
  });

  function onFaintCrackBoostInput(ev) {
    if (!ev.target || ev.target.id !== "faintCrackBoost") return;
    syncFaintCrackBoostLabel();
    paint();
    broadcastSync({ type: "ui", faintCrackBoost: Number(ev.target.value) });
  }
  document.addEventListener("input", onFaintCrackBoostInput);
  document.addEventListener("change", onFaintCrackBoostInput);

  el.zoom.addEventListener("input", () => {
    syncZoomLabel();
    paint();
    broadcastSync({ type: "ui", zoom: Number(el.zoom.value) });
  });

  el.threshold.addEventListener("input", () => {
    syncThresholdLabel();
    const T = Number(el.threshold.value);
    reanalyzeFromLum(T);
    paint();
    broadcastSync({ type: "threshold", threshold: T });
  });

  if (el.btnZoomIn) el.btnZoomIn.addEventListener("click", () => stepViewerZoom(10));
  if (el.btnZoomOut) el.btnZoomOut.addEventListener("click", () => stepViewerZoom(-10));
  if (el.btnZoomReset) el.btnZoomReset.addEventListener("click", () => resetViewerZoom());

  el.viewport.addEventListener(
    "wheel",
    (e) => {
      if (!lum) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 2;
      const dir = Math.sign(e.deltaY);
      if (dir === 0) return;
      stepViewerZoom(-dir * step);
    },
    { passive: false },
  );

  el.canvas.addEventListener("mousemove", onPointerMove);
  el.canvas.addEventListener("mouseleave", () => {
    hoverState = { active: false, crackId: 0, lum: 0 };
    refreshStatus();
    paint();
    broadcastSync({ type: "pointer", hoverState: { ...hoverState } });
  });
  el.canvas.addEventListener("click", onClick);

  wireBroadcastIn();
  syncThresholdLabel();
  syncOverlayLabel();
  syncZoomLabel();
  syncFaintCrackBoostLabel();
  void reloadFromIdb();
})();
