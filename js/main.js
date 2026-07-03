"use strict";
/* ============================================================================
 * Application: UI wiring, presets, main loop.
 * ========================================================================= */

(() => {

const $ = id => document.getElementById(id);

function showError(msg) {
  const box = $("errBox");
  box.style.display = "block";
  box.textContent = String(msg);
  console.error(msg);
}
window.addEventListener("error", e => showError(e.message + (e.filename ? `\n${e.filename}:${e.lineno}` : "")));
window.addEventListener("unhandledrejection", e => showError(e.reason?.stack || e.reason));

/* ------------------------------------------------------------- defaults - */

function defaultSource(type = "dipole") {
  return {
    enabled: true, type, dir: "+z", pos: [0.5, 0.5, 0.5], amplitude: 1,
    lambda: 1.0, phaseDeg: 0, chiDeg: 0, ellipDeg: 0,
    pulsed: false, pulsePeriods: 2, waistUm: 1.2,
  };
}
function defaultRegion() {
  return {
    enabled: true, shape: "box", type: "dielectric",
    center: [0.7, 0.5, 0.5], size: [0.3, 1, 1], radius: 0.15,
    eps: 2.25, mu: 1, sigma: 0, lambdaP: 0.3, gammaFs: 0.02,
  };
}
function defaultConfig() {
  return {
    N: 96, ppw: 15, courant: 0.5, boundary: "pml", pmlW: 10,
    sources: [defaultSource("dipole")],
    regions: [],
  };
}

const viz = {
  field: "E", showVolume: true, showSlice: true, showGlyphs: false,
  mode: 0, comp: 2, cmap: "inferno", gain: Math.pow(10, 1.5), opacity: 1,
  raySteps: 160, clipMin: [0, 0, 0], clipMax: [1, 1, 1],
  sliceAxis: 1, sliceFrac: 0.5, sliceAlpha: 1,
  glyphStride: 4, glyphScale: 1.5, scrubAgo: 0, autoGainAt: null,
};

/* -------------------------------------------------------------- presets - */

const PRESETS = {
  "Hertzian dipole (z)": () => {
    const c = defaultConfig();
    Object.assign(viz, { mode: 0, cmap: "inferno", showVolume: true, showSlice: true,
      showGlyphs: false, sliceAxis: 1, sliceFrac: 0.5, autoGainAt: 4.5, field: "E" });
    return c;
  },
  "Rotating dipole (circular)": () => {
    const c = defaultConfig();
    c.sources[0].ellipDeg = 45;
    Object.assign(viz, { mode: 0, cmap: "inferno", sliceAxis: 2, sliceFrac: 0.5,
      showVolume: true, showSlice: true, showGlyphs: true, autoGainAt: 4.5, field: "E" });
    return c;
  },
  "Plane-wave pulse (vacuum)": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("plane"), dir: "+x", pos: [0.14, 0.5, 0.5],
      pulsed: true, pulsePeriods: 2 }];
    Object.assign(viz, { mode: 1, comp: 1, cmap: "coolwarm", gain: 1,
      showVolume: true, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: null, field: "E" });
    return c;
  },
  "Double slit": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("plane"), dir: "+x", pos: [0.14, 0.5, 0.5] }];
    c.regions = [
      { ...defaultRegion(), type: "pec", center: [0.36, 0.5, 0.5], size: [0.035, 1, 1] },
      { ...defaultRegion(), type: "dielectric", eps: 1, center: [0.36, 0.5 - 0.235, 0.5], size: [0.05, 0.125, 1] },
      { ...defaultRegion(), type: "dielectric", eps: 1, center: [0.36, 0.5 + 0.235, 0.5], size: [0.05, 0.125, 1] },
    ];
    Object.assign(viz, { mode: 0, cmap: "viridis", gain: 2,
      showVolume: true, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: 8, field: "E" });
    return c;
  },
  "Dielectric slab (n = 1.5)": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("plane"), dir: "+x", pos: [0.14, 0.5, 0.5] }];
    c.regions = [{ ...defaultRegion(), center: [0.72, 0.5, 0.5], size: [0.4, 1, 1], eps: 2.25 }];
    Object.assign(viz, { mode: 1, comp: 1, cmap: "coolwarm", gain: 1,
      showVolume: false, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: null, field: "E" });
    return c;
  },
  "Dielectric sphere (lens)": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("plane"), dir: "+x", pos: [0.14, 0.5, 0.5] }];
    c.regions = [{ ...defaultRegion(), shape: "sphere", center: [0.5, 0.5, 0.5],
      radius: 0.18, eps: 2.25 }];
    Object.assign(viz, { mode: 0, cmap: "inferno", gain: 1.5,
      showVolume: true, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: 9, field: "E" });
    return c;
  },
  "Drude metal slab (mirror)": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("plane"), dir: "+x", pos: [0.14, 0.5, 0.5] }];
    c.regions = [{ ...defaultRegion(), type: "drude", center: [0.75, 0.5, 0.5],
      size: [0.3, 1, 1], lambdaP: 0.3, gammaFs: 0.02 }];
    Object.assign(viz, { mode: 1, comp: 1, cmap: "coolwarm", gain: 1.2,
      showVolume: false, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: null, field: "E" });
    return c;
  },
  "Gaussian beam": () => {
    const c = defaultConfig();
    c.sources = [{ ...defaultSource("gauss"), dir: "+x", pos: [0.14, 0.5, 0.5],
      waistUm: 1.2 }];
    Object.assign(viz, { mode: 0, cmap: "inferno", gain: 1.5,
      showVolume: true, showSlice: true, showGlyphs: false,
      sliceAxis: 2, sliceFrac: 0.5, autoGainAt: 8, field: "E" });
    return c;
  },
};

/* ----------------------------------------------------------------- boot - */

const canvas = $("glcanvas");
const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (!gl) { showError("WebGL2 is not available in this browser."); throw new Error("no webgl2"); }
if (!gl.getExtension("EXT_color_buffer_float"))
  showError("EXT_color_buffer_float is not supported — float render targets required.");

const state = { playing: true, stepsPerFrame: 3, validating: false };
let cfg = PRESETS["Hertzian dipole (z)"]();
let sim, renderer;

try {
  sim = new FDTD.FDTDSim(gl, cfg);
  renderer = new VIZ.Renderer(gl, canvas);
  renderer.allocHistory(cfg.N);
} catch (e) { showError(e.stack || e); throw e; }

function applyConfig(newCfg) {
  cfg = newCfg;
  sim.cfg = cfg;
  sim.rebuild();
  if (!renderer.history || renderer.history.N !== cfg.N) renderer.allocHistory(cfg.N);
  else { renderer.history.head = -1; renderer.history.count = 0; }
  viz.scrubAgo = 0;
  syncStaticInputs();
  renderLists();
  updateScrubUI();
}

const app = window.app = {
  get cfg() { return cfg; },
  get sim() { return sim; },
  get viz() { return viz; },
  renderer, state, applyConfig,
};

/* ---------------------------------------------------- static UI binding - */

function syncStaticInputs() {
  $("inN").value = cfg.N;
  $("inPpw").value = cfg.ppw;
  $("inCourant").value = cfg.courant; $("courantVal").textContent = cfg.courant.toFixed(2);
  $("inBoundary").value = cfg.boundary;
  $("inPmlW").value = cfg.pmlW;
  $("vField").value = viz.field;
  $("vShowVolume").checked = viz.showVolume;
  $("vShowSlice").checked = viz.showSlice;
  $("vShowGlyphs").checked = viz.showGlyphs;
  $("vMode").value = viz.mode;
  $("vComp").value = viz.comp;
  $("vCmap").value = viz.cmap;
  $("vGain").value = Math.log10(viz.gain);
  $("vGainVal").textContent = viz.gain.toExponential(1);
  $("vOpacity").value = viz.opacity; $("vOpacityVal").textContent = viz.opacity.toFixed(2);
  $("vSteps").value = viz.raySteps; $("vStepsVal").textContent = viz.raySteps;
  $("vClipX0").value = viz.clipMin[0]; $("vClipX1").value = viz.clipMax[0];
  $("vClipY0").value = viz.clipMin[1]; $("vClipY1").value = viz.clipMax[1];
  $("vClipZ0").value = viz.clipMin[2]; $("vClipZ1").value = viz.clipMax[2];
  $("vSliceAxis").value = viz.sliceAxis;
  $("vSliceFrac").value = viz.sliceFrac;
  $("vSliceAlpha").value = viz.sliceAlpha; $("vSliceAlphaVal").textContent = viz.sliceAlpha.toFixed(2);
  $("vGlyphStride").value = viz.glyphStride;
  $("vGlyphScale").value = viz.glyphScale;
  updateLegend();
  updateNumericsReadout();
}

function bindStatic() {
  const rebuild = () => applyConfig(cfg);
  $("inN").onchange = e => { cfg.N = +e.target.value; rebuild(); };
  $("inPpw").onchange = e => { cfg.ppw = Math.max(15, +e.target.value || 15); rebuild(); };
  $("inCourant").oninput = e => {
    cfg.courant = +e.target.value; $("courantVal").textContent = cfg.courant.toFixed(2); rebuild();
  };
  $("inBoundary").onchange = e => { cfg.boundary = e.target.value; rebuild(); };
  $("inPmlW").onchange = e => { cfg.pmlW = +e.target.value || 10; rebuild(); };

  $("vField").onchange = e => viz.field = e.target.value;
  $("vShowVolume").onchange = e => viz.showVolume = e.target.checked;
  $("vShowSlice").onchange = e => viz.showSlice = e.target.checked;
  $("vShowGlyphs").onchange = e => viz.showGlyphs = e.target.checked;
  $("vMode").onchange = e => { viz.mode = +e.target.value; updateLegend(); };
  $("vComp").onchange = e => viz.comp = +e.target.value;
  $("vCmap").onchange = e => { viz.cmap = e.target.value; updateLegend(); };
  $("vGain").oninput = e => {
    viz.gain = Math.pow(10, +e.target.value);
    $("vGainVal").textContent = viz.gain.toExponential(1);
  };
  $("vOpacity").oninput = e => { viz.opacity = +e.target.value; $("vOpacityVal").textContent = viz.opacity.toFixed(2); };
  $("vSteps").oninput = e => { viz.raySteps = +e.target.value; $("vStepsVal").textContent = viz.raySteps; };
  for (const [id, arr, i] of [["vClipX0", "clipMin", 0], ["vClipY0", "clipMin", 1], ["vClipZ0", "clipMin", 2],
                              ["vClipX1", "clipMax", 0], ["vClipY1", "clipMax", 1], ["vClipZ1", "clipMax", 2]]) {
    $(id).oninput = e => {
      viz[arr][i] = +e.target.value;
      if (viz.clipMin[i] > viz.clipMax[i]) {
        if (arr === "clipMin") viz.clipMax[i] = viz.clipMin[i]; else viz.clipMin[i] = viz.clipMax[i];
        syncStaticInputs();
      }
    };
  }
  $("vSliceAxis").onchange = e => { viz.sliceAxis = +e.target.value; renderer.history.count = 0; renderer.history.head = -1; };
  $("vSliceFrac").oninput = e => { viz.sliceFrac = +e.target.value; };
  $("vSliceAlpha").oninput = e => { viz.sliceAlpha = +e.target.value; $("vSliceAlphaVal").textContent = viz.sliceAlpha.toFixed(2); };
  $("vGlyphStride").onchange = e => viz.glyphStride = Math.max(2, +e.target.value | 0);
  $("vGlyphScale").oninput = e => viz.glyphScale = +e.target.value;

  $("btnAutoGain").onclick = autoGain;

  $("btnPlay").onclick = togglePlay;
  $("btnStep").onclick = () => { if (!state.validating) { doSteps(1); } };
  $("btnReset").onclick = () => { if (!state.validating) { sim.reset(); renderer.history.count = 0; renderer.history.head = -1; viz.scrubAgo = 0; updateScrubUI(); } };
  $("stepsPerFrame").oninput = e => { state.stepsPerFrame = +e.target.value; $("spfVal").textContent = e.target.value; };
  $("scrub").oninput = e => {
    const h = renderer.history;
    viz.scrubAgo = h.count - 1 - (+e.target.value);
    updateScrubLabel();
  };
  window.addEventListener("keydown", e => {
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); togglePlay(); }
  });

  const sel = $("preset");
  for (const name of Object.keys(PRESETS)) {
    const o = document.createElement("option");
    o.textContent = name; sel.appendChild(o);
  }
  sel.onchange = () => { if (!state.validating) applyConfig(PRESETS[sel.value]()); };

  $("btnAddSource").onclick = () => {
    if (cfg.sources.length >= 4) return;
    cfg.sources.push(defaultSource());
    applyConfig(cfg);
  };
  $("btnAddRegion").onclick = () => { cfg.regions.push(defaultRegion()); applyConfig(cfg); };

  $("btnValSpeed").onclick = () => runValidation(VALIDATE.runSpeedTest, false);
  $("btnValDipole").onclick = () => runValidation(VALIDATE.runDipoleTest, true);
}

function togglePlay() {
  if (state.validating) return;
  state.playing = !state.playing;
  $("btnPlay").textContent = state.playing ? "Pause" : "Play";
  if (state.playing) viz.scrubAgo = 0;
  updateScrubUI();
}

function doSteps(n) {
  sim.step(n);
  renderer.capture(sim, viz);
  viz.scrubAgo = 0;
  updateScrubUI();
}

function updateScrubUI() {
  const h = renderer.history, s = $("scrub");
  const enabled = !state.playing && h.count > 1 && !state.validating;
  s.disabled = !enabled;
  s.max = Math.max(0, h.count - 1);
  s.value = h.count - 1 - viz.scrubAgo;
  updateScrubLabel();
}
function updateScrubLabel() {
  const h = renderer.history;
  if (viz.scrubAgo <= 0) { $("scrubLabel").textContent = "live"; return; }
  const t = h.times[renderer.historyLayer(viz.scrubAgo)];
  $("scrubLabel").textContent = (t * FDTD.TIME_UNIT_FS).toFixed(1) + " fs";
}

function updateLegend() {
  const bar = $("legendBar");
  const stops = [];
  for (let i = 0; i <= 12; i++) stops.push(VIZ.cmapCss(viz.cmap, i / 12));
  bar.style.background = `linear-gradient(90deg, ${stops.join(",")})`;
  $("legendMin").textContent = viz.mode === 0 ? "0" : "−1/gain";
  $("legendMax").textContent = viz.mode === 0 ? "1/gain (|F|²)" : "+1/gain";
}

function updateNumericsReadout() {
  $("roDx").textContent = sim.dx.toFixed(4) + " µm";
  $("roDt").textContent = (sim.dt * FDTD.TIME_UNIT_FS).toFixed(4) + " fs";
  $("roDomain").textContent = (sim.N * sim.dx).toFixed(2) + " µm";
  $("roCells").textContent = (sim.N ** 3 / 1e6).toFixed(2) + " M";
  $("roMem").textContent = sim.memoryMB().toFixed(0) + " MB";
}

/* ------------------------------------------------------- dynamic lists -- */

function inputRow(label, inner) {
  return `<div class="row"><label>${label}</label>${inner}</div>`;
}
function numIn(path, v, step = 0.01, min = null, max = null, w = 64) {
  return `<input type="number" data-path="${path}" value="${v}" step="${step}"` +
    (min !== null ? ` min="${min}"` : "") + (max !== null ? ` max="${max}"` : "") +
    ` style="width:${w}px">`;
}
function vec3In(path, v, step = 0.01, min = 0, max = 1) {
  return [0, 1, 2].map(i => numIn(`${path}.${i}`, +v[i].toFixed(3), step, min, max, 56)).join("");
}

function renderLists() {
  const dS = $("divSources");
  dS.innerHTML = cfg.sources.map((s, i) => `
    <div class="card">
      <div class="head">
        <label><input type="checkbox" data-path="sources.${i}.enabled" ${s.enabled ? "checked" : ""}>
          <b>source ${i + 1}</b></label>
        <span>
        <select data-path="sources.${i}.type">
          <option value="dipole" ${s.type === "dipole" ? "selected" : ""}>Hertzian dipole</option>
          <option value="plane" ${s.type === "plane" ? "selected" : ""}>plane wave</option>
          <option value="gauss" ${s.type === "gauss" ? "selected" : ""}>Gaussian beam</option>
        </select>
        <button data-del-src="${i}" title="remove">✕</button></span>
      </div>
      ${inputRow(s.type === "dipole" ? "dipole axis" : "direction",
        `<select data-path="sources.${i}.dir">` +
        ["+x", "-x", "+y", "-y", "+z", "-z"].map(d =>
          `<option ${s.dir === d ? "selected" : ""}>${d}</option>`).join("") + `</select>`)}
      ${inputRow("position (frac)", vec3In(`sources.${i}.pos`, s.pos))}
      ${inputRow("amplitude", numIn(`sources.${i}.amplitude`, s.amplitude, 0.1))}
      ${inputRow("wavelength λ (µm)", numIn(`sources.${i}.lambda`, s.lambda, 0.05, 0.3, 5) + `<span class="mini">rebuilds</span>`)}
      ${inputRow("phase (°)", numIn(`sources.${i}.phaseDeg`, s.phaseDeg, 5, -360, 360))}
      ${inputRow("pol. angle χ (°)", numIn(`sources.${i}.chiDeg`, s.chiDeg, 5, -180, 180))}
      ${inputRow("ellipticity (°)", numIn(`sources.${i}.ellipDeg`, s.ellipDeg, 5, 0, 45) + `<span class="mini">45 = circular</span>`)}
      ${inputRow("pulse", `<label><input type="checkbox" data-path="sources.${i}.pulsed" ${s.pulsed ? "checked" : ""}> pulsed</label>` +
        numIn(`sources.${i}.pulsePeriods`, s.pulsePeriods, 0.5, 0.5, 20, 52) + `<span class="mini">periods</span>`)}
      ${s.type === "gauss" ? inputRow("waist w₀ (µm)", numIn(`sources.${i}.waistUm`, s.waistUm, 0.1, 0.3, 10)) : ""}
    </div>`).join("");

  const dR = $("divRegions");
  dR.innerHTML = cfg.regions.length === 0
    ? `<div class="mini" style="margin:4px 0">vacuum everywhere — add a region to insert a medium</div>`
    : cfg.regions.map((r, i) => `
    <div class="card">
      <div class="head">
        <label><input type="checkbox" data-path="regions.${i}.enabled" ${r.enabled !== false ? "checked" : ""}>
          <b>region ${i + 1}</b></label>
        <span>
        <select data-path="regions.${i}.shape">
          <option value="box" ${r.shape === "box" ? "selected" : ""}>box</option>
          <option value="sphere" ${r.shape === "sphere" ? "selected" : ""}>sphere</option>
        </select>
        <select data-path="regions.${i}.type">
          <option value="dielectric" ${r.type === "dielectric" ? "selected" : ""}>dielectric</option>
          <option value="pec" ${r.type === "pec" ? "selected" : ""}>PEC</option>
          <option value="drude" ${r.type === "drude" ? "selected" : ""}>Drude</option>
        </select>
        <button data-del-reg="${i}" title="remove">✕</button></span>
      </div>
      ${inputRow("center (frac)", vec3In(`regions.${i}.center`, r.center))}
      ${r.shape === "sphere"
        ? inputRow("radius (frac)", numIn(`regions.${i}.radius`, r.radius, 0.01, 0.01, 0.5))
        : inputRow("size (frac)", vec3In(`regions.${i}.size`, r.size))}
      ${r.type === "dielectric" ? `
        ${inputRow("ε<sub>r</sub>", numIn(`regions.${i}.eps`, r.eps, 0.05, 1, 20))}
        ${inputRow("µ<sub>r</sub>", numIn(`regions.${i}.mu`, r.mu, 0.05, 0.1, 20))}
        ${inputRow("σ (norm.)", numIn(`regions.${i}.sigma`, r.sigma, 0.1, 0, 100))}` : ""}
      ${r.type === "drude" ? `
        ${inputRow("plasma λ<sub>p</sub> (µm)", numIn(`regions.${i}.lambdaP`, r.lambdaP, 0.02, 0.05, 3))}
        ${inputRow("collision γ (fs⁻¹)", numIn(`regions.${i}.gammaFs`, r.gammaFs, 0.005, 0, 2))}` : ""}
    </div>`).join("");

  // delegation
  for (const el of [...dS.querySelectorAll("[data-path]"), ...dR.querySelectorAll("[data-path]")]) {
    el.onchange = onPathEdit;
  }
  for (const b of dS.querySelectorAll("[data-del-src]"))
    b.onclick = () => { cfg.sources.splice(+b.dataset.delSrc, 1); applyConfig(cfg); };
  for (const b of dR.querySelectorAll("[data-del-reg]"))
    b.onclick = () => { cfg.regions.splice(+b.dataset.delReg, 1); applyConfig(cfg); };
}

function onPathEdit(e) {
  const el = e.target, path = el.dataset.path.split(".");
  let obj = cfg;
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
  const key = path[path.length - 1];
  const val = el.type === "checkbox" ? el.checked
            : el.tagName === "SELECT" ? el.value : +el.value;
  obj[isNaN(+key) ? key : +key] = val;

  const p = el.dataset.path;
  if (/sources\.\d+\.(lambda|type)$/.test(p) || /sources\.\d+\.enabled$/.test(p)) {
    applyConfig(cfg);              // dx tracks lambda_min; type changes the card UI
  } else if (p.startsWith("regions.")) {
    if (/(shape|type)$/.test(p)) { sim.buildMaterial(); renderLists(); }
    else sim.buildMaterial();      // material-only update, fields keep running
  }
  // all other source params are read live from cfg each step
}

/* ------------------------------------------------------------ auto gain - */

function autoGain() {
  const idx = Math.round(viz.sliceFrac * (sim.N - 1));
  const data = sim.readSlice(viz.field, viz.sliceAxis, idx);
  let m = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > m) m = data[i];
  if (m > 1e-30) {
    viz.gain = 0.85 / m;
    syncStaticInputs();
  }
}

/* ------------------------------------------------------------ validation */

async function runValidation(fn, plot) {
  if (state.validating) return;
  state.validating = true;
  const wasPlaying = state.playing;
  state.playing = false;
  $("btnPlay").textContent = "Play";
  for (const id of ["btnValSpeed", "btnValDipole", "btnPlay", "btnStep", "btnReset"]) $(id).disabled = true;
  $("valCanvas").style.display = "none";
  $("valOut").textContent = "running…";
  try {
    const res = await fn(app, (msg, frac) => {
      $("valProgress").textContent = `${msg}  (${Math.round(frac * 100)}%)`;
    });
    const badge = res.pass ? "PASS" : "FAIL";
    $("valOut").innerHTML =
      `<span class="${res.pass ? "ok" : "fail"}">${badge}</span>  ${res.detail.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}`;
    if (plot && res.thetas) {
      $("valCanvas").style.display = "block";
      VALIDATE.drawPolar($("valCanvas"), res.thetas, res.S, res.K);
    }
  } catch (err) {
    $("valOut").textContent = "Error: " + (err?.message || err);
  } finally {
    $("valProgress").textContent = "";
    for (const id of ["btnValSpeed", "btnValDipole", "btnPlay", "btnStep", "btnReset"]) $(id).disabled = false;
    state.validating = false;
    state.playing = wasPlaying;
    $("btnPlay").textContent = state.playing ? "Pause" : "Play";
    updateScrubUI();
  }
}

/* ------------------------------------------------------------ main loop - */

let lastT = 0, fpsAcc = 0, fpsN = 0, fps = 0, spsAcc = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dtms = ts - lastT; lastT = ts;
  if (dtms > 0 && dtms < 500) {
    fpsAcc += dtms; fpsN++;
    if (fpsAcc > 500) {
      fps = 1000 * fpsN / fpsAcc;
      $("roSps").textContent = (spsAcc * 1000 / fpsAcc).toFixed(0);
      fpsAcc = 0; fpsN = 0; spsAcc = 0;
      $("hudFps").textContent = fps.toFixed(0);
    }
  }
  try {
    if (state.playing && !state.validating) {
      sim.step(state.stepsPerFrame);
      spsAcc += state.stepsPerFrame;
      renderer.capture(sim, viz);
      if (viz.autoGainAt !== null && sim.time >= viz.autoGainAt) {
        autoGain(); viz.autoGainAt = null;
      }
    }
    renderer.draw(sim, viz);
  } catch (e) {
    showError(e.stack || e);
    state.playing = false;
  }
  $("hudTime").textContent = "t = " + sim.timeFs.toFixed(1) + " fs";
  $("hudStep").textContent = sim.n;
  if (state.playing) updateScrubUI();
}

bindStatic();
syncStaticInputs();
renderLists();
window.__APP_READY = true;
requestAnimationFrame(loop);

})();
