"use strict";
/* ============================================================================
 * Validation suite (runs on the live solver — see METHODS.md §7):
 *
 *  1. Wave speed in vacuum: a pulsed plane wave travels between two probes;
 *     the group delay is measured by cross-correlating the two time series.
 *     Expect v = c to within the numerical-dispersion error of the grid
 *     (also reported: the theoretical FDTD group velocity for comparison).
 *
 *  2. Hertzian dipole pattern: a CW z-dipole in vacuum; the period-averaged
 *     transverse intensity <|E_t|^2> is sampled on a circle in a plane
 *     containing the dipole axis and fit to K sin^2(theta) (the exact
 *     far-field pattern), plus an azimuthal-isotropy check in the equator.
 * ========================================================================= */

const VALIDATE = (() => {

const frame = () => new Promise(r => requestAnimationFrame(r));

/** FDTD 1-D numerical group velocity along a grid axis (c = 1). */
function fdtdGroupVelocity(omega, dx, dt) {
  const k = w => (2 / dx) * Math.asin(Math.min(1, (dx / dt) * Math.sin(w * dt / 2)));
  const dw = omega * 1e-4;
  return (2 * dw) / (k(omega + dw) - k(omega - dw));
}

/* ------------------------------------------------------- test 1: speed -- */

async function runSpeedTest(app, onProgress) {
  const saved = structuredClone(app.cfg);
  const N = app.cfg.N;
  const lambda = 1.0;
  // Periodic transverse boundaries -> a genuinely infinite plane wave.
  // (Under PML the sheet must be tapered, i.e. a finite aperture, and on-axis
  // diffraction advances the measured arrival superluminally by ~1-2%.)
  const cfg = {
    ...structuredClone(app.cfg),
    boundary: "periodic", regions: [],
    sources: [{
      enabled: true, type: "plane", dir: "+x", pos: [0.15, 0.5, 0.5],
      amplitude: 1, lambda, phaseDeg: 0, chiDeg: 0, ellipDeg: 0,
      pulsed: true, pulsePeriods: 1,
    }],
  };
  app.applyConfig(cfg);
  const sim = app.sim;
  try {
    const srcX = Math.round(0.15 * N);
    const x1 = srcX + 8;
    const D = Math.floor(0.45 * N);
    const x2 = x1 + D;
    if (D < 8 || x2 > N - 2) throw new Error("Grid too small for the speed test (need N >= 48).");
    const cy = Math.floor(N / 2);
    const tau = 1 * lambda, t0 = 3.5 * tau;
    const tEnd = t0 + (x2 - srcX) * sim.dx + 3.5 * tau;
    const steps = Math.ceil(tEnd / sim.dt);
    const s1 = new Float64Array(steps), s2 = new Float64Array(steps);
    for (let s = 0; s < steps; s++) {
      sim.step(1);
      const r = sim.readProbes("E", [[x1, cy, cy], [x2, cy, cy]]);
      s1[s] = r[1];       // Ey (default +x polarization is along y)
      s2[s] = r[5];
      if (s % 24 === 0) {
        onProgress?.(`speed test: step ${s}/${steps}`, s / steps);
        await frame();
      }
    }
    // group delay via cross-correlation, sub-step by parabolic refinement
    const maxShift = steps - 2;
    let best = 1, bestV = -Infinity;
    const xc = sh => { let a = 0; for (let t = 0; t + sh < steps; t++) a += s1[t] * s2[t + sh]; return a; };
    const xcArr = new Float64Array(maxShift);
    for (let sh = 0; sh < maxShift; sh++) {
      xcArr[sh] = xc(sh);
      if (xcArr[sh] > bestV) { bestV = xcArr[sh]; best = sh; }
    }
    let delta = 0;
    if (best > 0 && best < maxShift - 1) {
      const ym = xcArr[best - 1], y0 = xcArr[best], yp = xcArr[best + 1];
      const den = ym - 2 * y0 + yp;
      if (Math.abs(den) > 1e-30) delta = 0.5 * (ym - yp) / den;
    }
    const delay = (best + delta) * sim.dt;
    const v = D * sim.dx / delay;
    const vg = fdtdGroupVelocity(2 * Math.PI / lambda, sim.dx, sim.dt);
    const errC = (v - 1) * 100;
    const errVg = (v / vg - 1) * 100;
    const peak = Math.max(...s2.map(Math.abs));
    // Pass = the pulse moves at c within the grid's numerical-dispersion
    // tolerance AND matches the exact discrete-Maxwell prediction closely.
    return {
      pass: Math.abs(errVg) < 0.5 && Math.abs(errC) < 2.5 && peak > 1e-4,
      v, errC, vg, errVg,
      detail:
        `Infinite plane-wave pulse (periodic boundaries), probes ${D} cells ` +
        `(${(D * sim.dx).toFixed(3)} um) apart; group delay ` +
        `${(delay * FDTD.TIME_UNIT_FS).toFixed(2)} fs.\n` +
        `Measured speed v = ${v.toFixed(5)} c  (deviation from c: ${errC.toFixed(3)}%).\n` +
        `Exact FDTD dispersion theory for this grid (${sim.ppwEff} cells/lambda, ` +
        `S = ${sim.S}) predicts v_g = ${vg.toFixed(5)} c; measured agrees to ` +
        `${errVg.toFixed(3)}%.\n` +
        `The small offset from c is the second-order grid dispersion; it ` +
        `shrinks as 1/(cells per wavelength)^2 - raise "cells/lambda" and rerun.`,
    };
  } finally {
    app.applyConfig(saved);
  }
}

/* ------------------------------------------------------ test 2: dipole -- */

async function runDipoleTest(app, onProgress) {
  const saved = structuredClone(app.cfg);
  const N = app.cfg.N, pmlW = 10;
  const lambda = 1.0;
  const cfg = {
    ...structuredClone(app.cfg),
    boundary: "pml", pmlW, regions: [],
    sources: [{
      enabled: true, type: "dipole", dir: "+z", pos: [0.5, 0.5, 0.5],
      amplitude: 1, lambda, phaseDeg: 0, chiDeg: 0, ellipDeg: 0, pulsed: false,
    }],
  };
  app.applyConfig(cfg);
  const sim = app.sim;
  try {
    const c = Math.floor(N / 2);
    const R = Math.min(Math.floor(0.35 * N), Math.floor(N / 2) - pmlW - 4);
    if (R < 8) throw new Error("Grid too small for the dipole test (need N >= 48).");
    // probes: 72 on a circle in the xz plane (contains the dipole axis)
    // + 24 on the equator (xy plane) for the isotropy check
    const NTH = 72, NPH = 24;
    const pts = [], thetas = [];
    for (let i = 0; i < NTH; i++) {
      const th = (i + 0.5) * 2 * Math.PI / NTH;   // polar angle from +z
      thetas.push(th);
      pts.push([c + R * Math.sin(th), c, c + R * Math.cos(th)]);
    }
    for (let i = 0; i < NPH; i++) {
      const ph = i * 2 * Math.PI / NPH;
      pts.push([c + R * Math.cos(ph), c + R * Math.sin(ph), c]);
    }
    // settle: wave reaches R plus several periods of CW steady state
    const settle = Math.ceil((R * sim.dx + 8 * lambda) / sim.dt);
    const CH = 16;
    for (let s = 0; s < settle; s += CH) {
      sim.step(Math.min(CH, settle - s));
      if (s % (CH * 4) === 0) {
        onProgress?.(`dipole test: settling ${s}/${settle}`, 0.7 * s / settle);
        await frame();
      }
    }
    // average the transverse intensity over exactly one period
    const perSteps = Math.max(8, Math.round(lambda / sim.dt));
    const S = new Float64Array(pts.length);
    for (let s = 0; s < perSteps; s++) {
      sim.step(1);
      const r = sim.readProbes("E", pts);
      for (let i = 0; i < pts.length; i++) {
        const ex = r[i * 4], ey = r[i * 4 + 1], ez = r[i * 4 + 2];
        const rx = (pts[i][0] - c) / R, ry = (pts[i][1] - c) / R, rz = (pts[i][2] - c) / R;
        const er = ex * rx + ey * ry + ez * rz;   // radial part (near-field) removed
        S[i] += ex * ex + ey * ey + ez * ez - er * er;
      }
      if (s % 8 === 0) {
        onProgress?.(`dipole test: averaging ${s}/${perSteps}`, 0.7 + 0.3 * s / perSteps);
        await frame();
      }
    }
    // least-squares fit S(theta) = K sin^2(theta)
    let num = 0, den = 0;
    for (let i = 0; i < NTH; i++) {
      const s2 = Math.sin(thetas[i]) ** 2;
      num += S[i] * s2; den += s2 * s2;
    }
    const K = num / den;
    let rss = 0;
    for (let i = 0; i < NTH; i++)
      rss += (S[i] - K * Math.sin(thetas[i]) ** 2) ** 2;
    const rms = Math.sqrt(rss / NTH) / K;
    const eq = Array.from(S.slice(NTH));
    const mean = eq.reduce((a, b) => a + b, 0) / eq.length;
    const iso = Math.sqrt(eq.reduce((a, b) => a + (b - mean) ** 2, 0) / eq.length) / mean;
    return {
      pass: rms < 0.08 && iso < 0.05,
      rms, iso, K, thetas, S: Array.from(S.slice(0, NTH)),
      detail:
        `Sampled at r = ${(R * sim.dx).toFixed(2)} um (kr = ${(2 * Math.PI * R * sim.dx).toFixed(1)}).\n` +
        `Fit <|E_t|^2> = K sin^2(theta): RMS deviation ${(rms * 100).toFixed(2)}% of K.\n` +
        `Azimuthal isotropy in the equator: ${(iso * 100).toFixed(2)}% std/mean.`,
    };
  } finally {
    app.applyConfig(saved);
  }
}

/* ------------------------------------------------------- polar plot ----- */
/* Measured pattern (blue dots, #3987e5 — validated for the dark surface)
 * vs the ideal sin^2(theta) reference (dashed neutral line). */

function drawPolar(canvas, thetas, S, K) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wCss = canvas.clientWidth || 300, hCss = 240;
  canvas.width = wCss * dpr; canvas.height = hCss * dpr;
  canvas.style.height = hCss + "px";
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  const cx = wCss / 2, cy = hCss / 2 + 6, Rpx = Math.min(wCss, hCss) / 2 - 26;

  // recessive grid: radius rings + the dipole axis
  g.strokeStyle = "#2a2e37"; g.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    g.beginPath(); g.arc(cx, cy, Rpx * f, 0, 2 * Math.PI); g.stroke();
  }
  g.beginPath(); g.moveTo(cx, cy - Rpx - 8); g.lineTo(cx, cy + Rpx + 8); g.stroke();
  g.fillStyle = "#8b93a1"; g.font = "10px system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText("dipole axis (z)", cx, cy - Rpx - 12);

  // ideal sin^2 reference: dashed neutral
  g.strokeStyle = "#9aa3b8"; g.setLineDash([5, 4]); g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= 180; i++) {
    const th = i * 2 * Math.PI / 180;
    const r = Rpx * Math.sin(th) ** 2;
    const x = cx + r * Math.sin(th), y = cy - r * Math.cos(th);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath(); g.stroke(); g.setLineDash([]);

  // measured: blue dots
  g.fillStyle = "#3987e5";
  for (let i = 0; i < thetas.length; i++) {
    const r = Rpx * Math.min(S[i] / K, 1.15);
    const x = cx + r * Math.sin(thetas[i]), y = cy - r * Math.cos(thetas[i]);
    g.beginPath(); g.arc(x, y, 2.4, 0, 2 * Math.PI); g.fill();
  }

  // legend (identity by mark + label, not color alone)
  g.textAlign = "left"; g.font = "11px system-ui, sans-serif";
  g.fillStyle = "#3987e5";
  g.beginPath(); g.arc(10, hCss - 26, 3, 0, 2 * Math.PI); g.fill();
  g.fillStyle = "#c9d1d9"; g.fillText("measured  ⟨|Eₜ|²⟩ / K", 18, hCss - 22);
  g.strokeStyle = "#9aa3b8"; g.setLineDash([5, 4]); g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(6, hCss - 8); g.lineTo(16, hCss - 8); g.stroke(); g.setLineDash([]);
  g.fillText("ideal  sin²θ", 18, hCss - 4);
}

return { runSpeedTest, runDipoleTest, drawPolar };
})();
