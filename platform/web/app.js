/**
 * Crack overlay viewer: threshold + connected components for hover / click selection.
 */
(function () {
  const MAX_EDGE = 2048;

  /**
   * Red-overlay alpha for a crack pixel. boostPct 0 = legacy alphaBase×(L/255).
   * @param {number} L crack luminance 0–255
   * @param {number} threshold T
   * @param {number} alphaBase 0–1
   * @param {number} boostPct 0–100
   */
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
    fileOrig: document.getElementById("fileOriginal"),
    fileCrack: document.getElementById("fileCrack"),
    threshold: document.getElementById("threshold"),
    thresholdVal: document.getElementById("thresholdVal"),
    overlayAlpha: document.getElementById("overlayAlpha"),
    overlayAlphaVal: document.getElementById("overlayAlphaVal"),
    showImage: document.getElementById("showImage"),
    showProb: document.getElementById("showProb"),
    zoom: document.getElementById("zoom"),
    zoomVal: document.getElementById("zoomVal"),
    btnClear: document.getElementById("btnClear"),
    status: document.getElementById("status"),
    maxEdgeLbl: document.getElementById("maxEdgeLbl"),
    canvas: document.getElementById("canvas"),
    viewport: document.getElementById("viewport"),
    jobForm: document.getElementById("jobForm"),
    jobImage: document.getElementById("jobImage"),
    jobLabel: document.getElementById("jobLabel"),
    jobTiling: document.getElementById("jobTiling"),
    jobOverlap: document.getElementById("jobOverlap"),
    jobBatch: document.getElementById("jobBatch"),
    jobSize: document.getElementById("jobSize"),
    btnStartJob: document.getElementById("btnStartJob"),
    jobPollStatus: document.getElementById("jobPollStatus"),
    selRun: document.getElementById("selRun"),
    btnRefreshRuns: document.getElementById("btnRefreshRuns"),
    btnClearRuns: document.getElementById("btnClearRuns"),
    selImage: document.getElementById("selImage"),
    selOrigServer: document.getElementById("selOrigServer"),
    selCrackServer: document.getElementById("selCrackServer"),
    btnLoadServer: document.getElementById("btnLoadServer"),
    btnPopout: document.getElementById("btnPopout"),
    viewportEmpty: document.getElementById("viewportEmpty"),
    jobLog: document.getElementById("jobLog"),
    jobLogHint: document.getElementById("jobLogHint"),
    btnRefreshJobLog: document.getElementById("btnRefreshJobLog"),
    btnZoomIn: document.getElementById("btnZoomIn"),
    btnZoomOut: document.getElementById("btnZoomOut"),
    btnZoomReset: document.getElementById("btnZoomReset"),
    inputGsd: document.getElementById("inputGsd"),
    crackTable: document.getElementById("crackTable"),
    crackTableBody: document.getElementById("crackTableBody"),
    btnExportCsv: document.getElementById("btnExportCsv"),
  };

  el.maxEdgeLbl.textContent = String(MAX_EDGE);

  const ctx = el.canvas.getContext("2d", { willReadFrequently: true });

  let imgOriginal = null;
  let imgCrack = null;
  /** @type {Int32Array|null} */
  let labels = null;
  /** @type {Uint8Array|null} */
  let mask = null;
  /** @type {Uint8ClampedArray|null} luminance 0-255 per display pixel */
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
  /** Base message after last analyze (no hover/selection suffix). */
  let analysisMessage = "";
  /** @type {{ active: boolean, crackId: number, lum: number }} */
  let hoverState = { active: false, crackId: 0, lum: 0 };

  /** @type {Array<Record<string, number|string>>} */
  let regionRows = [];
  let crackSortKey = "area";
  let crackSortDir = -1;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let jobPollTimer = null;
  /** Job id currently being polled (for live logs); cleared when the run finishes. */
  let activePollJobId = null;

  /** @type {BroadcastChannel|null} */
  let syncBc = null;
  /** @type {Window|null} */
  let viewerPopup = null;

  /** Last /jobs response, cached so the "Load a result" panel can look up a run's resolved input dir without another request. */
  let lastJobsList = [];

  /** Which picker to trust in loadServerPair(): the auto-matched "Image" dropdown, or the manual "pick separately" selects. */
  let loadPairSource = "image";

  function getResolvedInputDirForRun(runId) {
    if (!runId) return null;
    const j = lastJobsList.find((x) => x.id === runId);
    return j && j.resolved_input_dir ? j.resolved_input_dir : null;
  }

  function updateViewportEmptyState() {
    if (!el.viewportEmpty) return;
    el.viewportEmpty.hidden = !!(imgOriginal && imgCrack);
  }

  function openOrFocusPopoutViewer() {
    try {
      const viewerUrl = new URL("/viewer", window.location.href).href;
      if (viewerPopup && !viewerPopup.closed) {
        viewerPopup.focus();
        return;
      }
      viewerPopup = window.open(viewerUrl, "crackerViewer", "noopener,noreferrer");
      if (viewerPopup) {
        viewerPopup.focus();
      } else if (el.status && !String(el.status.textContent).includes("Pop-up blocked")) {
        el.status.textContent =
          String(el.status.textContent) +
          " — Pop-up blocked: allow windows for this site, or open /viewer manually (snapshot is saved).";
      }
    } catch (_) {
      /* pop-up blocked or no window */
    }
  }

  function broadcastSync(msg) {
    if (!syncBc || typeof CrackerSync === "undefined") return;
    try {
      syncBc.postMessage({ ...msg, tabId: CrackerSync.tabId });
    } catch (_) {
      /* ignore */
    }
  }

  if (typeof CrackerSync !== "undefined") {
    try {
      syncBc = new BroadcastChannel(CrackerSync.CHANNEL);
      syncBc.onmessage = (ev) => {
        const d = ev.data;
        if (!d || d.tabId === CrackerSync.tabId) return;
        if (d.type === "pointer") {
          const h = d.hoverState;
          hoverState =
            h && typeof h === "object"
              ? {
                  active: !!h.active,
                  crackId: Number(h.crackId) || 0,
                  lum: Number(h.lum) || 0,
                }
              : { active: false, crackId: 0, lum: 0 };
          refreshStatus();
          paint();
        } else if (d.type === "select") {
          selectedId = typeof d.selectedId === "number" ? d.selectedId : 0;
          refreshStatus();
          paint();
          syncCrackTableSelection();
          if (selectedId > 0) scrollCrackRowIntoView(selectedId);
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
          if (d.showImage != null && el.showImage) el.showImage.checked = !!d.showImage;
          if (d.showProb != null && el.showProb) el.showProb.checked = !!d.showProb;
          paint();
        } else if (d.type === "threshold") {
          if (d.threshold != null) {
            el.threshold.value = String(d.threshold);
            syncThresholdLabel();
            if (imgOriginal && imgCrack) analyzeAndPaint();
          }
        }
      };
    } catch (_) {
      syncBc = null;
    }
  }

  function isRunJobId(v) {
    return typeof v === "string" && v.length === 36 && /^[0-9a-f-]{36}$/i.test(v);
  }

  async function fetchJobLogs(jobId) {
    if (!el.jobLog || !jobId || !isRunJobId(jobId)) return;
    try {
      const r = await fetch(`/jobs/${encodeURIComponent(jobId)}/logs?tail=200000`);
      if (!r.ok) return;
      const d = await r.json();
      const parts = [];
      if (d.stdout) parts.push("--- stdout ---\n" + d.stdout);
      if (d.stderr) parts.push("--- stderr ---\n" + d.stderr);
      el.jobLog.textContent = parts.join("\n\n") || "(no output yet)";
      if (el.jobLogHint) {
        el.jobLogHint.textContent = d.status ? `status: ${d.status}` : "";
      }
      el.jobLog.scrollTop = el.jobLog.scrollHeight;
    } catch (_) {
      /* ignore log fetch errors during poll */
    }
  }

  function logRefreshTargetId() {
    if (activePollJobId && isRunJobId(activePollJobId)) return activePollJobId;
    if (el.selRun && isRunJobId(el.selRun.value)) return el.selRun.value;
    return null;
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

  function loadFileAsImage(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error("no file"));
        return;
      }
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(url);
        resolve(im);
      };
      im.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("bad image"));
      };
      im.src = url;
    });
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("bad image: " + url));
      im.src = url;
    });
  }

  function clearJobPoll() {
    if (jobPollTimer !== null) {
      clearTimeout(jobPollTimer);
      jobPollTimer = null;
    }
  }

  function setJobFormBusy(busy) {
    if (el.btnStartJob) el.btnStartJob.disabled = busy;
  }

  async function refreshRuns() {
    if (!el.selRun) return;
    const keep = el.selRun.value;
    const r = await fetch("/jobs");
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    lastJobsList = data.jobs || [];
    while (el.selRun.options.length > 1) {
      el.selRun.remove(1);
    }
    for (const j of data.jobs || []) {
      const opt = document.createElement("option");
      opt.value = j.id;
      const lab = j.label ? `${j.label} · ` : "";
      opt.textContent = `${lab}${j.id.slice(0, 8)}… · ${j.status}`;
      el.selRun.appendChild(opt);
    }
    if (keep && [...el.selRun.options].some((o) => o.value === keep)) {
      el.selRun.value = keep;
    }
  }

  async function refreshInputList(dirOverride) {
    if (!el.selOrigServer) return;
    el.selOrigServer.innerHTML = "";
    const url = dirOverride
      ? `/results/inputs/list?dir=${encodeURIComponent(dirOverride)}`
      : "/results/inputs/list";
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    if (!d.exists || !d.files || !d.files.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "(no input_crops on server)";
      el.selOrigServer.appendChild(o);
      return;
    }
    for (const f of d.files) {
      const o = document.createElement("option");
      o.value = f.name;
      o.textContent = f.name;
      el.selOrigServer.appendChild(o);
    }
  }

  async function refreshCrackList() {
    if (!el.selCrackServer || !el.selRun) return;
    el.selCrackServer.innerHTML = "";
    const runId = el.selRun.value;
    const url = runId ? `/results?run_id=${encodeURIComponent(runId)}` : "/results";
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    const crack = (d.files || []).filter((f) => f.name.toLowerCase().includes("crackprob"));
    if (!crack.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = runId
        ? "(no crackprob in this run yet)"
        : "(no crackprob in default results)";
      el.selCrackServer.appendChild(o);
      return;
    }
    for (const f of crack) {
      const o = document.createElement("option");
      o.value = f.name;
      o.textContent = f.name;
      el.selCrackServer.appendChild(o);
    }
  }

  function baseNameNoExt(name) {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  }

  /**
   * Build the single "Image" picker by matching each run's crackprob output to its
   * original input file (by base filename), so picking one item loads both.
   */
  function buildImageOptions() {
    if (!el.selImage) return;
    el.selImage.innerHTML = "";
    const crackOpts = el.selCrackServer ? [...el.selCrackServer.options] : [];
    const origOpts = el.selOrigServer ? [...el.selOrigServer.options] : [];
    const origByBase = new Map();
    for (const o of origOpts) {
      if (!o.value) continue;
      origByBase.set(baseNameNoExt(o.value).toLowerCase(), o.value);
    }
    let any = false;
    for (const c of crackOpts) {
      if (!c.value) continue;
      any = true;
      const base = baseNameNoExt(c.value).replace(/_crackprob$/i, "");
      const orig = origByBase.get(base.toLowerCase());
      const opt = document.createElement("option");
      opt.value = c.value;
      opt.dataset.orig = orig || "";
      opt.textContent = orig ? base : `${c.value} (no matching original found — use “pick separately” below)`;
      opt.disabled = !orig;
      el.selImage.appendChild(opt);
    }
    if (!any) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = el.selRun && el.selRun.value ? "(no results in this run yet)" : "(no results yet)";
      el.selImage.appendChild(o);
    } else {
      const firstValid = [...el.selImage.options].find((o) => !o.disabled);
      if (firstValid) el.selImage.value = firstValid.value;
    }
  }

  /** Refresh crack/original lists for the selected run and rebuild the combined Image picker. */
  async function refreshLoadPanelForSelectedRun() {
    const runId = el.selRun ? el.selRun.value : "";
    await refreshCrackList();
    await refreshInputList(getResolvedInputDirForRun(runId));
    buildImageOptions();
    loadPairSource = "image";
  }

  function schedulePoll(jobId) {
    clearJobPoll();
    jobPollTimer = setTimeout(() => {
      jobPollTimer = null;
      void pollJob(jobId);
    }, 1500);
  }

  function setJobPollStatus(text, kind) {
    if (!el.jobPollStatus) return;
    el.jobPollStatus.textContent = text;
    el.jobPollStatus.className = "job-status" + (kind ? ` status-${kind}` : "");
  }

  async function pollJob(jobId) {
    if (!el.jobPollStatus) return;
    try {
      await fetchJobLogs(jobId);
      const r = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const st = j.status;
      if (st === "queued" || st === "running") {
        const waiting = j.blocked_by ? ` — waiting for job ${String(j.blocked_by).slice(0, 8)}… to finish` : "";
        setJobPollStatus(`${st}: ${j.message || ""}${waiting} (${jobId.slice(0, 8)}…)`, st);
        schedulePoll(jobId);
        return;
      }
      clearJobPoll();
      activePollJobId = null;
      setJobFormBusy(false);
      await fetchJobLogs(jobId);
      if (st === "succeeded") {
        console.log("[Cracker] Done: inference job finished successfully.", jobId);
        await refreshRuns();
        el.selRun.value = jobId;
        await refreshLoadPanelForSelectedRun();
        const firstValid = el.selImage ? [...el.selImage.options].find((o) => !o.disabled) : null;
        if (firstValid) {
          el.selImage.value = firstValid.value;
          selectTab(1);
          setJobPollStatus("Done — loading result…", "succeeded");
          await loadServerPair();
          setJobPollStatus("Done.", "succeeded");
        } else {
          selectTab(1);
          setJobPollStatus("Done — pick the image below and press Load.", "succeeded");
        }
      } else {
        console.warn("[Cracker] Done: inference job failed.", jobId, j.message || st);
        setJobPollStatus(`Failed: ${j.message || st}`, "failed");
        await refreshRuns();
        el.selRun.value = jobId;
      }
    } catch (e) {
      clearJobPoll();
      activePollJobId = null;
      setJobFormBusy(false);
      console.warn("[Cracker] Job poll error:", e);
      setJobPollStatus(`Poll error: ${e && e.message ? e.message : e}`, "failed");
    }
  }

  async function loadServerPair() {
    const runId = el.selRun && el.selRun.value;
    const imgOpt = el.selImage && el.selImage.selectedOptions && el.selImage.selectedOptions[0];
    const fromImagePicker = imgOpt && imgOpt.value && imgOpt.dataset.orig;
    const fromManualPickers = (el.selOrigServer && el.selOrigServer.value) && (el.selCrackServer && el.selCrackServer.value);
    let origName;
    let crackName;
    if (loadPairSource === "manual" && fromManualPickers) {
      origName = el.selOrigServer.value;
      crackName = el.selCrackServer.value;
    } else if (fromImagePicker) {
      crackName = imgOpt.value;
      origName = imgOpt.dataset.orig;
    } else if (fromManualPickers) {
      origName = el.selOrigServer.value;
      crackName = el.selCrackServer.value;
    }
    if (!origName || !crackName) {
      el.status.textContent = "Pick an image from the list above (or use “pick separately” for a custom pairing).";
      return;
    }
    const dirOverride = getResolvedInputDirForRun(runId);
    const origUrl =
      `/results/inputs/file/${encodeURIComponent(origName)}` +
      (dirOverride ? `?dir=${encodeURIComponent(dirOverride)}` : "");
    const crackUrl = runId
      ? `/results/file/${encodeURIComponent(crackName)}?run_id=${encodeURIComponent(runId)}`
      : `/results/file/${encodeURIComponent(crackName)}`;
    try {
      el.status.textContent = "Loading from server…";
      const [imO, imC] = await Promise.all([loadImageFromUrl(origUrl), loadImageFromUrl(crackUrl)]);
      imgOriginal = imO;
      imgCrack = imC;
      analyzeAndPaint();
    } catch (err) {
      analysisMessage = "";
      el.status.textContent = `Could not load from server: ${err && err.message ? err.message : err}`;
    }
  }

  /**
   * 8-connected components on binary mask (values 0/1). labels 0 = background, 1..N = regions.
   */
  function labelMask(maskArr, w, h) {
    const labels = new Int32Array(w * h);
    let next = 1;
    const stack = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (maskArr[i] !== 1 || labels[i] !== 0) continue;
        const id = next++;
        labels[i] = id;
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
            if (maskArr[k] !== 1 || labels[k] !== 0) continue;
            labels[k] = id;
            stack.push(k);
          }
        }
      }
    }
    return { labels, count: next - 1 };
  }

  /**
   * Shape-only PCI-oriented guess from elongation and principal axis angle (deg, ~0 = horizontal in image).
   */
  function classifyPciGuess(elong, angleDeg, bboxAspect, area) {
    const horiz = Math.abs(angleDeg) < 22.5;
    const vert = Math.abs(angleDeg) > 67.5;
    if (elong < 2 && bboxAspect < 2) {
      return {
        label: "Blob / block-like",
        note: "Low elongation; verify visually before mapping to a PCI distress type.",
      };
    }
    if (elong >= 2.5 && horiz) {
      return {
        label: "Longitudinal-like",
        note: "Elongated along image rows; rotate ortho if needed so lane direction is horizontal.",
      };
    }
    if (elong >= 2.5 && vert) {
      return {
        label: "Transverse-like",
        note: "Elongated along image columns (perpendicular to row axis).",
      };
    }
    if (elong >= 3 && !horiz && !vert) {
      return { label: "Diagonal (oblique)", note: "Linear distress at an oblique angle to image axes." };
    }
    if (elong >= 2 && bboxAspect < 2.5 && area > 500) {
      return {
        label: "Alligator-like (tentative)",
        note: "Moderate elongation on a fairly compact patch; often mesh cracking—confirm visually.",
      };
    }
    return {
      label: "Unclassified linear",
      note: "Heuristic only; not official PCI severity or ASTM D6433.",
    };
  }

  /**
   * Per-region stats from labeled mask (display resolution).
   */
  function computeCrackRegions(labelsArr, maskArr, lumArr, w, h, count) {
    if (!count || count < 1) return [];
    const acc = [];
    for (let i = 0; i <= count; i++) {
      acc.push({
        area: 0,
        minX: w,
        minY: h,
        maxX: -1,
        maxY: -1,
        sumX: 0,
        sumY: 0,
        sumLum: 0,
        sumXX: 0,
        sumYY: 0,
        sumXY: 0,
      });
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const lab = labelsArr[idx];
        if (lab <= 0 || maskArr[idx] !== 1) continue;
        const s = acc[lab];
        s.area++;
        if (x < s.minX) s.minX = x;
        if (y < s.minY) s.minY = y;
        if (x > s.maxX) s.maxX = x;
        if (y > s.maxY) s.maxY = y;
        s.sumX += x;
        s.sumY += y;
        s.sumLum += lumArr[idx];
        s.sumXX += x * x;
        s.sumYY += y * y;
        s.sumXY += x * y;
      }
    }

    const rows = [];
    for (let id = 1; id <= count; id++) {
      const s = acc[id];
      if (s.area < 1) continue;
      const mx = s.sumX / s.area;
      const my = s.sumY / s.area;
      const cxx = s.sumXX / s.area - mx * mx;
      const cyy = s.sumYY / s.area - my * my;
      const cxy = s.sumXY / s.area - mx * my;
      const angleRad = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const trace = cxx + cyy;
      const det = cxx * cyy - cxy * cxy;
      const disc = Math.max(0, trace * trace * 0.25 - det);
      const lamMax = trace * 0.5 + Math.sqrt(disc);
      const lamMin = Math.max(trace * 0.5 - Math.sqrt(disc), 1e-12);
      let elong = Math.sqrt(Math.max(lamMax, 1e-12) / lamMin);
      if (!Number.isFinite(elong) || elong < 1) elong = 1;
      elong = Math.min(99, elong);
      const angleDeg = (angleRad * 180) / Math.PI;
      const bw = s.maxX - s.minX + 1;
      const bh = s.maxY - s.minY + 1;
      const bboxAspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      const lengthPx = Math.sqrt(Math.max(1, s.area) * elong);
      const pci = classifyPciGuess(elong, angleDeg, bboxAspect, s.area);
      rows.push({
        id,
        area: s.area,
        minX: s.minX,
        maxX: s.maxX,
        minY: s.minY,
        maxY: s.maxY,
        cx: mx,
        cy: my,
        meanLum: s.sumLum / s.area,
        angleDeg,
        elong,
        lengthPx,
        bboxW: bw,
        bboxH: bh,
        pciLabel: pci.label,
        pciNote: pci.note,
      });
    }
    return rows;
  }

  function getMetersPerDisplayPixel() {
    const gsd = el.inputGsd ? Number(el.inputGsd.value) : 0;
    if (!(gsd > 0) || !origW || !displayW) return 0;
    return gsd * (origW / displayW);
  }

  function syncCrackTableSelection() {
    if (!el.crackTableBody) return;
    el.crackTableBody.querySelectorAll("tr[data-region-id]").forEach((tr) => {
      tr.classList.toggle("is-selected", Number(tr.dataset.regionId) === selectedId);
    });
  }

  function scrollCrackRowIntoView(regionId) {
    if (!el.crackTableBody || regionId <= 0) return;
    const tr = el.crackTableBody.querySelector(`tr[data-region-id="${regionId}"]`);
    tr?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function getSortedCrackRows(mPerDisp) {
    const mult = crackSortDir;
    return regionRows.slice().sort((a, b) => {
      let av;
      let bv;
      const k = crackSortKey;
      if (k === "lengthM") {
        av = a.lengthPx * mPerDisp;
        bv = b.lengthPx * mPerDisp;
      } else if (k === "areaM2") {
        av = a.area * mPerDisp * mPerDisp;
        bv = b.area * mPerDisp * mPerDisp;
      } else if (k === "pciLabel") {
        av = String(a.pciLabel);
        bv = String(b.pciLabel);
        if (av < bv) return -1 * mult;
        if (av > bv) return 1 * mult;
        return 0;
      } else {
        av = Number(a[k]);
        bv = Number(b[k]);
      }
      if (av < bv) return -1 * mult;
      if (av > bv) return 1 * mult;
      return (a.id - b.id) * mult;
    });
  }

  function renderCrackTable() {
    if (!el.crackTableBody || !el.crackTable) return;
    const mPerDisp = getMetersPerDisplayPixel();
    el.crackTable.classList.toggle("no-gsd", !(mPerDisp > 0));

    if (!regionRows.length) {
      el.crackTableBody.innerHTML =
        '<tr class="placeholder-row"><td colspan="10">Load original + crack probability, then adjust threshold to list regions.</td></tr>';
      return;
    }

    const sorted = getSortedCrackRows(mPerDisp);

    const fmt = (v, d) => (mPerDisp > 0 ? v.toFixed(d) : "—");
    el.crackTableBody.innerHTML = sorted
      .map((r) => {
        const lenM = r.lengthPx * mPerDisp;
        const areaM2 = r.area * mPerDisp * mPerDisp;
        const title = String(r.pciNote || "")
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;");
        return (
          `<tr data-region-id="${r.id}" title="${title}">` +
          `<td>${r.id}</td>` +
          `<td>${r.pciLabel}</td>` +
          `<td class="num">${r.area}</td>` +
          `<td class="num">${r.lengthPx.toFixed(1)}</td>` +
          `<td class="num">${r.angleDeg.toFixed(1)}</td>` +
          `<td class="num">${r.elong.toFixed(2)}</td>` +
          `<td class="num">${r.meanLum.toFixed(1)}</td>` +
          `<td class="num">${r.bboxW}×${r.bboxH}</td>` +
          `<td class="num len-m-col">${fmt(lenM, 3)}</td>` +
          `<td class="num area-m-col">${fmt(areaM2, 4)}</td>` +
          `</tr>`
        );
      })
      .join("");
    syncCrackTableSelection();
  }

  function csvEscape(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCrackTableCsv() {
    if (!regionRows.length) return;
    const mPerDisp = getMetersPerDisplayPixel();
    const sorted = getSortedCrackRows(mPerDisp);
    const header = [
      "ID",
      "PCI-style (heuristic)",
      "Area (px)",
      "Length est. (px)",
      "Axis deg",
      "Elong.",
      "Mean signal",
      "Bbox W (px)",
      "Bbox H (px)",
      "Length (m)",
      "Area (m2)",
      "Note",
    ];
    const lines = [header.map(csvEscape).join(",")];
    sorted.forEach((r) => {
      const lenM = mPerDisp > 0 ? r.lengthPx * mPerDisp : "";
      const areaM2 = mPerDisp > 0 ? r.area * mPerDisp * mPerDisp : "";
      lines.push(
        [
          r.id,
          r.pciLabel,
          r.area,
          r.lengthPx.toFixed(1),
          r.angleDeg.toFixed(1),
          r.elong.toFixed(2),
          r.meanLum.toFixed(1),
          r.bboxW,
          r.bboxH,
          lenM === "" ? "" : lenM.toFixed(3),
          areaM2 === "" ? "" : areaM2.toFixed(4),
          r.pciNote || "",
        ]
          .map(csvEscape)
          .join(","),
      );
    });

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `crack-summary-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

  async function persistViewerSnapshotThenBroadcast() {
    if (typeof CrackerSync === "undefined" || !labels || !mask || !lum || !origImageData) return;
    try {
      await CrackerSync.saveSnapshot({
        displayW,
        displayH,
        origW,
        origH,
        crackW,
        crackH,
        labelsBuf: labels.slice().buffer,
        maskBuf: mask.slice().buffer,
        lumBuf: lum.slice().buffer,
        origRgbaBuf: origImageData.data.slice().buffer,
        overlayAlpha: Number(el.overlayAlpha.value),
        zoom: Number(el.zoom.value),
        threshold: Number(el.threshold.value),
        faintCrackBoost: (() => {
          const n = document.getElementById("faintCrackBoost");
          return n ? Number(n.value) : 0;
        })(),
        showImage: !el.showImage || el.showImage.checked,
        showProb: !el.showProb || el.showProb.checked,
      });
      broadcastSync({ type: "snapshot" });
    } catch (e) {
      console.warn("[Cracker] viewer snapshot save failed", e);
    }
  }

  const mainTabs = [
    { btn: document.getElementById("tabJob"), panel: document.getElementById("panelJob") },
    { btn: document.getElementById("tabLoad"), panel: document.getElementById("panelLoad") },
  ].filter((t) => t.btn && t.panel);

  /** Switch the setup tabs (0 = Run detection, 1 = Load a result). No-op if tabs aren't present. */
  function selectTab(activeIndex) {
    mainTabs.forEach((t, i) => {
      const on = i === activeIndex;
      t.btn.setAttribute("aria-selected", on ? "true" : "false");
      t.btn.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
    });
  }

  function initTabs() {
    mainTabs.forEach((t, i) => t.btn.addEventListener("click", () => selectTab(i)));
  }

  function analyzeAndPaint() {
    if (!imgOriginal || !imgCrack) return;
    updateViewportEmptyState();

    origW = imgOriginal.naturalWidth;
    origH = imgOriginal.naturalHeight;
    crackW = imgCrack.naturalWidth;
    crackH = imgCrack.naturalHeight;

    const scale = Math.min(1, MAX_EDGE / Math.max(origW, origH));
    displayW = Math.max(1, Math.round(origW * scale));
    displayH = Math.max(1, Math.round(origH * scale));

    const cStretch = document.createElement("canvas");
    cStretch.width = origW;
    cStretch.height = origH;
    const xs = cStretch.getContext("2d");
    xs.drawImage(imgCrack, 0, 0, crackW, crackH, 0, 0, origW, origH);

    const cSmall = document.createElement("canvas");
    cSmall.width = displayW;
    cSmall.height = displayH;
    const x0 = cSmall.getContext("2d");
    x0.drawImage(imgOriginal, 0, 0, origW, origH, 0, 0, displayW, displayH);
    origImageData = x0.getImageData(0, 0, displayW, displayH);

    x0.drawImage(cStretch, 0, 0, origW, origH, 0, 0, displayW, displayH);
    const crackData = x0.getImageData(0, 0, displayW, displayH);

    const T = Number(el.threshold.value);
    const n = displayW * displayH;
    mask = new Uint8Array(n);
    lum = new Uint8ClampedArray(n);
    const cd = crackData.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const L = Math.round(0.299 * cd[o] + 0.587 * cd[o + 1] + 0.114 * cd[o + 2]);
      lum[i] = L;
      mask[i] = L >= T ? 1 : 0;
    }

    const { labels: lb, count } = labelMask(mask, displayW, displayH);
    labels = lb;
    regionRows = computeCrackRegions(lb, mask, lum, displayW, displayH, count);
    selectedId = 0;
    hoverState = { active: false, crackId: 0, lum: 0 };

    setAnalysisStatus(
      `Display ${displayW}×${displayH} (from ${origW}×${origH}). ` +
        `Crack map was ${crackW}×${crackH} → stretched to match original. ` +
        `Threshold ${T}: ${count} crack region(s) (8-connected).`
    );

    renderCrackTable();
    paint();
    void persistViewerSnapshotThenBroadcast();
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
    const showImg = !el.showImage || el.showImage.checked;
    const showProb = !el.showProb || el.showProb.checked;

    for (let i = 0; i < displayW * displayH; i++) {
      const o = i * 4;
      let r = showImg ? od[o] : 0;
      let g = showImg ? od[o + 1] : 0;
      let b = showImg ? od[o + 2] : 0;
      const L = lum[i];
      const id = labels[i];

      if (showProb && mask[i] === 1) {
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
    syncCrackTableSelection();
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
    if (selectedId > 0) scrollCrackRowIntoView(selectedId);
  }

  if (el.crackTable && el.crackTableBody) {
    el.crackTable.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const key = th.dataset.sort;
      if (crackSortKey === key) crackSortDir *= -1;
      else {
        crackSortKey = key;
        crackSortDir = key === "pciLabel" || key === "id" ? 1 : -1;
      }
      renderCrackTable();
    });

    el.crackTableBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-region-id]");
      if (!tr) return;
      selectedId = Number(tr.dataset.regionId);
      refreshStatus();
      paint();
      broadcastSync({ type: "select", selectedId });
    });
  }

  if (el.inputGsd) {
    el.inputGsd.addEventListener("input", () => renderCrackTable());
  }

  el.fileOrig.addEventListener("change", async () => {
    try {
      const f = el.fileOrig.files[0];
      imgOriginal = await loadFileAsImage(f);
      if (imgCrack) {
        analyzeAndPaint();
      } else {
        analysisMessage = "";
        regionRows = [];
        labels = null;
        mask = null;
        renderCrackTable();
        el.status.textContent = "Original loaded. Now load crack probability PNG.";
      }
    } catch {
      analysisMessage = "";
      el.status.textContent = "Could not load original image.";
    }
  });

  el.fileCrack.addEventListener("change", async () => {
    try {
      const f = el.fileCrack.files[0];
      imgCrack = await loadFileAsImage(f);
      if (imgOriginal) {
        analyzeAndPaint();
      } else {
        analysisMessage = "";
        regionRows = [];
        labels = null;
        mask = null;
        renderCrackTable();
        el.status.textContent = "Crack map loaded. Now load original image.";
      }
    } catch {
      analysisMessage = "";
      el.status.textContent = "Could not load crack map.";
    }
  });

  el.threshold.addEventListener("input", () => {
    syncThresholdLabel();
    if (imgOriginal && imgCrack) analyzeAndPaint();
  });

  el.overlayAlpha.addEventListener("input", () => {
    syncOverlayLabel();
    paint();
    broadcastSync({ type: "ui", overlayAlpha: Number(el.overlayAlpha.value) });
  });

  if (el.showImage) {
    el.showImage.addEventListener("change", () => {
      paint();
      broadcastSync({ type: "ui", showImage: el.showImage.checked });
    });
  }

  if (el.showProb) {
    el.showProb.addEventListener("change", () => {
      paint();
      broadcastSync({ type: "ui", showProb: el.showProb.checked });
    });
  }

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

  if (el.btnZoomIn) el.btnZoomIn.addEventListener("click", () => stepViewerZoom(10));
  if (el.btnZoomOut) el.btnZoomOut.addEventListener("click", () => stepViewerZoom(-10));
  if (el.btnZoomReset) el.btnZoomReset.addEventListener("click", () => resetViewerZoom());

  el.viewport.addEventListener(
    "wheel",
    (e) => {
      if (!imgOriginal || !imgCrack) return;
      e.preventDefault();
      // Small fixed steps so wheel / trackpad zoom is gentle (magnitude of deltaY ignored).
      const step = e.shiftKey ? 8 : 2;
      const dir = Math.sign(e.deltaY);
      if (dir === 0) return;
      stepViewerZoom(-dir * step);
    },
    { passive: false },
  );

  el.btnExportCsv?.addEventListener("click", exportCrackTableCsv);

  el.btnClear.addEventListener("click", () => {
    selectedId = 0;
    hoverState = { active: false, crackId: 0, lum: 0 };
    refreshStatus();
    paint();
    syncCrackTableSelection();
    broadcastSync({ type: "select", selectedId: 0 });
    broadcastSync({ type: "pointer", hoverState: { ...hoverState } });
  });

  el.canvas.addEventListener("mousemove", onPointerMove);
  el.canvas.addEventListener("mouseleave", () => {
    hoverState = { active: false, crackId: 0, lum: 0 };
    refreshStatus();
    paint();
    broadcastSync({ type: "pointer", hoverState: { ...hoverState } });
  });
  el.canvas.addEventListener("click", onClick);

  if (el.jobForm && el.btnRefreshRuns && el.selRun && el.btnLoadServer) {
    el.jobForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = el.jobImage && el.jobImage.files && el.jobImage.files[0];
      if (!file) {
        setJobPollStatus("Choose a photo first.", "failed");
        return;
      }
      clearJobPoll();
      activePollJobId = null;
      const body = new FormData();
      body.append("file", file);
      if (el.jobLabel.value.trim()) body.append("label", el.jobLabel.value.trim());
      body.append("use_tiling_for_large_images", String(el.jobTiling.checked));
      body.append("tile_overlap_percent", String(Number(el.jobOverlap.value)));
      body.append("tile_batch_size", String(Number(el.jobBatch.value)));
      body.append("size", String(Number(el.jobSize.value)));
      try {
        setJobFormBusy(true);
        setJobPollStatus("Uploading…", "queued");
        if (el.jobLog) el.jobLog.textContent = "Uploading photo…";
        if (el.jobLogHint) el.jobLogHint.textContent = "";
        const res = await fetch("/jobs/from-upload", { method: "POST", body });
        if (!res.ok) {
          setJobFormBusy(false);
          setJobPollStatus(await res.text(), "failed");
          return;
        }
        const job = await res.json();
        activePollJobId = job.id;
        setJobPollStatus(`Queued ${job.id.slice(0, 8)}…`, "queued");
        void pollJob(job.id);
      } catch (err) {
        setJobFormBusy(false);
        setJobPollStatus(`Request failed: ${err && err.message ? err.message : err}`, "failed");
      }
    });

    el.btnRefreshRuns.addEventListener("click", () => {
      void (async () => {
        try {
          await refreshRuns();
          await refreshLoadPanelForSelectedRun();
        } catch (e) {
          if (el.jobPollStatus) el.jobPollStatus.textContent = String(e && e.message ? e.message : e);
        }
      })();
    });

    if (el.btnClearRuns) {
      el.btnClearRuns.addEventListener("click", () => {
        if (
          !confirm(
            "Delete every job run folder? This removes outputs, logs, and meta on disk. This cannot be undone.",
          )
        ) {
          return;
        }
        void (async () => {
          try {
            const r = await fetch("/jobs/all", { method: "DELETE" });
            if (!r.ok) {
              const t = await r.text();
              if (el.jobPollStatus) el.jobPollStatus.textContent = t || r.statusText;
              return;
            }
            const d = await r.json();
            clearJobPoll();
            activePollJobId = null;
            setJobFormBusy(false);
            if (el.selRun) el.selRun.value = "";
            await refreshRuns();
            await refreshLoadPanelForSelectedRun();
            if (el.jobLog) el.jobLog.textContent = "";
            if (el.jobLogHint) el.jobLogHint.textContent = "";
            if (el.jobPollStatus) {
              el.jobPollStatus.textContent = `Removed ${d.deleted} run folder(s).`;
            }
          } catch (e) {
            if (el.jobPollStatus) {
              el.jobPollStatus.textContent = String(e && e.message ? e.message : e);
            }
          }
        })();
      });
    }

    el.selRun.addEventListener("change", () => {
      void refreshLoadPanelForSelectedRun();
      const lid = logRefreshTargetId();
      if (lid) void fetchJobLogs(lid);
    });

    if (el.btnRefreshJobLog) {
      el.btnRefreshJobLog.addEventListener("click", () => {
        const lid = logRefreshTargetId();
        if (lid) void fetchJobLogs(lid);
        else if (el.jobLogHint) el.jobLogHint.textContent = "select a run or start a job";
      });
    }

    el.btnLoadServer.addEventListener("click", () => {
      void loadServerPair();
    });

    if (el.selImage) {
      el.selImage.addEventListener("change", () => {
        loadPairSource = "image";
      });
    }
    if (el.selOrigServer) {
      el.selOrigServer.addEventListener("change", () => {
        loadPairSource = "manual";
      });
    }
    if (el.selCrackServer) {
      el.selCrackServer.addEventListener("change", () => {
        loadPairSource = "manual";
      });
    }

    void (async () => {
      try {
        await refreshRuns();
        await refreshLoadPanelForSelectedRun();
      } catch (e) {
        if (el.jobPollStatus) {
          el.jobPollStatus.textContent = `API: ${e && e.message ? e.message : e} (is the platform server running?)`;
        }
      }
    })();
  }

  initTabs();

  if (el.btnPopout) {
    el.btnPopout.addEventListener("click", (e) => {
      e.preventDefault();
      openOrFocusPopoutViewer();
    });
  }

  updateViewportEmptyState();
  syncThresholdLabel();
  syncOverlayLabel();
  syncZoomLabel();
  syncFaintCrackBoostLabel();
})();
