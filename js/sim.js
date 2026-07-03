"use strict";
/* ============================================================================
 * FDTDSim — GPU (WebGL2) 3-D FDTD solver for the full time-domain Maxwell
 * equations on a Yee staggered grid with leapfrog time stepping.
 *
 * Units: normalized, c = eps0 = mu0 = 1 (lengths shown as um,
 *        1 time unit = 3.335641 fs). See METHODS.md.
 *
 * Stability: dt = S * dx / (c * sqrt(3)), S in (0, 1]  (3-D Courant/CFL).
 * Sampling: dx = lambda_min / ppw with ppw >= 15 enforced by the UI.
 * ========================================================================= */

const FDTD = (() => {

const C_UM_PER_FS = 0.299792458;        // c in um/fs (for SI display only)
const TIME_UNIT_FS = 1 / C_UM_PER_FS;   // 3.335641 fs per normalized time unit

/* ------------------------------------------------------------- GL utils - */

function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    throw new Error(`Shader "${name}" failed to compile:\n${log}`);
  }
  return s;
}

function makeProgram(gl, vsSrc, fsSrc, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, name + ".vs"));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + ".fs"));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Program "${name}" failed to link:\n${gl.getProgramInfoLog(p)}`);
  }
  const prog = { p, u: {} };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const key = info.name.replace(/\[0\]$/, "");
    prog.u[key] = gl.getUniformLocation(p, info.name);
  }
  return prog;
}

function makeTex(gl, w, h, internal, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function makeFBO(gl, attachments) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs = [];
  attachments.forEach((tex, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i,
                            gl.TEXTURE_2D, tex, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  gl.drawBuffers(bufs);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error("Framebuffer incomplete: 0x" + st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}

/* ------------------------------------------------------------ simulator - */

class FDTDSim {
  /**
   * cfg = {
   *   N, ppw, courant (S), boundary: 'pml'|'reflecting'|'periodic', pmlW,
   *   sources: [{enabled,type:'dipole'|'plane'|'gauss', dir:'+x'...,
   *              pos:[3 frac], amplitude, lambda (um), phaseDeg, chiDeg,
   *              ellipDeg, pulsed, pulsePeriods, waistUm}],
   *   regions: [{shape:'box'|'sphere', type:'dielectric'|'pec'|'drude',
   *              center:[3 frac], size:[3 frac] | radius (frac),
   *              eps, mu, sigma, lambdaP (um), gammaFs (1/fs)}],
   * }
   */
  constructor(gl, cfg) {
    this.gl = gl;
    this.cfg = cfg;
    this.programsInit();
    this.rebuild();
  }

  programsInit() {
    const gl = this.gl;
    if (!FDTDSim._progCache) FDTDSim._progCache = new WeakMap();
    let progs = FDTDSim._progCache.get(gl);
    if (!progs) {
      progs = {
        stepH:   makeProgram(gl, SHADERS.V_FULLSCREEN, SHADERS.F_STEP_H, "stepH"),
        stepE:   makeProgram(gl, SHADERS.V_FULLSCREEN, SHADERS.F_STEP_E, "stepE"),
        display: makeProgram(gl, SHADERS.V_FULLSCREEN, SHADERS.F_DISPLAY, "display"),
        extract: makeProgram(gl, SHADERS.V_FULLSCREEN, SHADERS.F_EXTRACT, "extract"),
        probe:   makeProgram(gl, SHADERS.V_FULLSCREEN, SHADERS.F_PROBE, "probe"),
      };
      FDTDSim._progCache.set(gl, progs);
    }
    this.progs = progs;
  }

  /** Derived numerics: dx from the shortest enabled source wavelength. */
  computeNumerics() {
    const c = this.cfg;
    const lambdas = c.sources.filter(s => s.enabled).map(s => s.lambda);
    const lamMin = lambdas.length ? Math.min(...lambdas) : 1.0;
    const ppw = Math.max(15, c.ppw);                 // enforce >= 15 cells/lambda
    this.dx = lamMin / ppw;
    const S = Math.min(Math.max(c.courant, 0.05), 1.0);
    this.dt = S * this.dx / Math.sqrt(3);            // 3-D CFL: c dt <= dx/sqrt(3)
    this.lamMin = lamMin;
    this.ppwEff = ppw;
    this.S = S;
  }

  rebuild() {
    const gl = this.gl;
    this.dispose();
    this.computeNumerics();

    const N = this.N = this.cfg.N;
    const TX = this.TX = Math.ceil(Math.sqrt(N));
    const TY = this.TY = Math.ceil(N / TX);
    const W = this.W = TX * N;
    const H = this.H = TY * N;

    const mk = () => makeTex(gl, W, H, gl.RGBA32F, gl.NEAREST);
    this.tex = {
      E:  [mk(), mk()], H:  [mk(), mk()],
      pEa:[mk(), mk()], pEb:[mk(), mk()],
      pHa:[mk(), mk()], pHb:[mk(), mk()],
      Jd: [mk(), mk()],
      mat1: mk(), mat2: mk(),
      disp: makeTex(gl, W, H, gl.RGBA16F, gl.LINEAR),
      probe: makeTex(gl, 96, 1, gl.RGBA32F, gl.NEAREST),
      slice32: makeTex(gl, N, N, gl.RGBA32F, gl.NEAREST),
    };
    // FBOs indexed by the WRITE parity.
    this.fboH = [0, 1].map(w => makeFBO(gl,
      [this.tex.H[w], this.tex.pHa[w], this.tex.pHb[w]]));
    this.fboE = [0, 1].map(w => makeFBO(gl,
      [this.tex.E[w], this.tex.pEa[w], this.tex.pEb[w], this.tex.Jd[w]]));
    this.fboDisp   = makeFBO(gl, [this.tex.disp]);
    this.fboProbe  = makeFBO(gl, [this.tex.probe]);
    this.fboSlice32= makeFBO(gl, [this.tex.slice32]);

    this.buildMaterial();
    this.reset();
  }

  boundaryCode() {
    return { pml: 0, reflecting: 1, periodic: 2 }[this.cfg.boundary] ?? 0;
  }

  reset() {
    const gl = this.gl;
    this.pE = 0; this.pH = 0; this.n = 0;
    const zero = new Float32Array(4);
    for (const w of [0, 1]) {
      for (const [fbo, cnt] of [[this.fboH[w], 3], [this.fboE[w], 4]]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        for (let i = 0; i < cnt; i++) gl.clearBufferfv(gl.COLOR, i, zero);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Current simulated time in normalized units (and fs for display). */
  get time()   { return this.n * this.dt; }
  get timeFs() { return this.time * TIME_UNIT_FS; }

  /* ------------------------------------------------------- material ---- */

  buildMaterial() {
    const gl = this.gl, N = this.N, TX = this.TX, W = this.W, H = this.H;
    const m1 = new Float32Array(W * H * 4);
    const m2 = new Float32Array(W * H * 4);
    // vacuum defaults
    for (let k = 0; k < N; k++) {
      const bx = (k % TX) * N, by = Math.floor(k / TX) * N;
      for (let j = 0; j < N; j++) {
        let idx = ((by + j) * W + bx) * 4;
        for (let i = 0; i < N; i++, idx += 4) { m1[idx] = 1; m1[idx + 1] = 1; }
      }
    }
    const setCell = (i, j, k, r) => {
      const px = (k % TX) * N + i, py = Math.floor(k / TX) * N + j;
      const idx = (py * W + px) * 4;
      m1[idx]     = r.eps ?? 1;
      m1[idx + 1] = r.mu ?? 1;
      m1[idx + 2] = r.sigma ?? 0;
      m1[idx + 3] = r.type === "pec" ? 1 : r.type === "drude" ? 2 : 0;
      if (r.type === "drude") {
        m2[idx]     = 2 * Math.PI / Math.max(r.lambdaP ?? 0.5, 1e-3); // wp
        m2[idx + 1] = (r.gammaFs ?? 0.01) * TIME_UNIT_FS;             // gamma
      }
    };
    // Regions apply in list order (later regions override earlier ones),
    // tested at cell centers (staircase approximation of curved boundaries).
    for (const r of this.cfg.regions) {
      if (r.enabled === false) continue;
      const c = r.center.map(f => f * N);
      if (r.shape === "sphere") {
        const R = r.radius * N, R2 = R * R;
        const lo = c.map(v => Math.max(0, Math.floor(v - R - 1)));
        const hi = c.map(v => Math.min(N - 1, Math.ceil(v + R + 1)));
        for (let k = lo[2]; k <= hi[2]; k++)
          for (let j = lo[1]; j <= hi[1]; j++)
            for (let i = lo[0]; i <= hi[0]; i++) {
              const dxc = i + 0.5 - c[0], dyc = j + 0.5 - c[1], dzc = k + 0.5 - c[2];
              if (dxc * dxc + dyc * dyc + dzc * dzc <= R2) setCell(i, j, k, r);
            }
      } else {
        const half = r.size.map(f => f * N / 2);
        const lo = c.map((v, a) => Math.max(0, Math.round(v - half[a])));
        const hi = c.map((v, a) => Math.min(N - 1, Math.round(v + half[a]) - 1));
        for (let k = lo[2]; k <= hi[2]; k++)
          for (let j = lo[1]; j <= hi[1]; j++)
            for (let i = lo[0]; i <= hi[0]; i++) setCell(i, j, k, r);
      }
    }
    for (const [tex, data] of [[this.tex.mat1, m1], [this.tex.mat2, m2]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, data);
    }
  }

  /* -------------------------------------------------------- sources ---- */

  sourceUniformData() {
    const A = new Float32Array(16), B = new Float32Array(16),
          C = new Float32Array(16), D = new Float32Array(16);
    const list = this.cfg.sources.slice(0, 4);
    list.forEach((s, i) => {
      const axis = { x: 0, y: 1, z: 2 }[s.dir[1]];
      const sgn = s.dir[0] === "-" ? -1 : 1;
      const type = { dipole: 0, plane: 1, gauss: 2 }[s.type];
      const omega = 2 * Math.PI / s.lambda;           // c = 1
      const period = s.lambda;
      const tau = (s.pulsePeriods ?? 2) * period;
      A.set([type, axis, sgn, s.enabled ? 1 : 0], i * 4);
      B.set([...s.pos.map(f => Math.min(this.N - 1, Math.max(0, Math.round(f * this.N)))),
             s.amplitude], i * 4);
      C.set([omega, (s.phaseDeg ?? 0) * Math.PI / 180,
             (s.chiDeg ?? 0) * Math.PI / 180,
             (s.ellipDeg ?? 0) * Math.PI / 180], i * 4);
      D.set([s.pulsed ? 1 : 0, 3.5 * tau, tau,
             Math.max((s.waistUm ?? 1) / this.dx, 1)], i * 4);
    });
    return { A, B, C, D, count: list.length };
  }

  setCommonUniforms(prog, srcTime) {
    const gl = this.gl, u = prog.u;
    gl.uniform1i(u.uN, this.N);
    gl.uniform1i(u.uTX, this.TX);
    gl.uniform1i(u.uBoundary, this.boundaryCode());
    gl.uniform1f(u.uDx, this.dx);
    gl.uniform1f(u.uDt, this.dt);
    gl.uniform1f(u.uPmlW, this.boundaryCode() === 0 ? this.cfg.pmlW : 0);
    gl.uniform1f(u.uPmlSigMax, 0.8 * 4 / this.dx);  // 0.8 (m+1) / (eta0 dx), m=3
    gl.uniform1f(u.uPmlAlpha, 0.15);
    const s = this.sourceUniformData();
    gl.uniform1i(u.uNumSrc, s.count);
    gl.uniform4fv(u.uSrcA, s.A);
    gl.uniform4fv(u.uSrcB, s.B);
    gl.uniform4fv(u.uSrcC, s.C);
    gl.uniform4fv(u.uSrcD, s.D);
    gl.uniform1f(u.uT, srcTime);
  }

  bindTexUnit(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /* ----------------------------------------------------------- stepping */

  step(nSteps = 1) {
    const gl = this.gl, t = this.tex;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, this.W, this.H);

    for (let s = 0; s < nSteps; s++) {
      // --- H half-step: H^{n+1/2} = H^{n-1/2} - dt/mu (curl E^n + M(n dt))
      let prog = this.progs.stepH;
      gl.useProgram(prog.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH[1 - this.pH]);
      this.setCommonUniforms(prog, this.n * this.dt);
      this.bindTexUnit(0, t.E[this.pE],  prog.u.uE);
      this.bindTexUnit(1, t.H[this.pH],  prog.u.uH);
      this.bindTexUnit(2, t.pHa[this.pH], prog.u.uPa);
      this.bindTexUnit(3, t.pHb[this.pH], prog.u.uPb);
      this.bindTexUnit(4, t.mat1, prog.u.uMat1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.pH ^= 1;

      // --- E full step: E^{n+1} = ca E^n + cb (curl H^{n+1/2} - J((n+1/2)dt))
      prog = this.progs.stepE;
      gl.useProgram(prog.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboE[1 - this.pE]);
      this.setCommonUniforms(prog, (this.n + 0.5) * this.dt);
      this.bindTexUnit(0, t.E[this.pE],  prog.u.uE);
      this.bindTexUnit(1, t.H[this.pH],  prog.u.uH);
      this.bindTexUnit(2, t.pEa[this.pE], prog.u.uPa);
      this.bindTexUnit(3, t.pEb[this.pE], prog.u.uPb);
      this.bindTexUnit(4, t.Jd[this.pE],  prog.u.uJd);
      this.bindTexUnit(5, t.mat1, prog.u.uMat1);
      this.bindTexUnit(6, t.mat2, prog.u.uMat2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.pE ^= 1;
      this.n++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  curE() { return this.tex.E[this.pE]; }
  curH() { return this.tex.H[this.pH]; }
  curField(which) { return which === "H" ? this.curH() : this.curE(); }

  /** Update the half-float LINEAR display copy (alpha = |F|^2). */
  updateDisplay(which) {
    const gl = this.gl, prog = this.progs.display;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp);
    gl.viewport(0, 0, this.W, this.H);
    this.bindTexUnit(0, this.curField(which), prog.u.uF);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Extract slice (axis 0..2, index) of the current field into an FBO. */
  extractSliceTo(fbo, which, axis, idx) {
    const gl = this.gl, prog = this.progs.extract;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, this.N, this.N);
    gl.uniform1i(prog.u.uN, this.N);
    gl.uniform1i(prog.u.uTX, this.TX);
    gl.uniform1i(prog.u.uBoundary, 1);
    gl.uniform1i(prog.u.uAxis, axis);
    gl.uniform1i(prog.u.uIdx, Math.min(this.N - 1, Math.max(0, idx)));
    this.bindTexUnit(0, this.curField(which), prog.u.uF);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Read back a full slice as Float32Array (N*N*4), RGBA = (Fx,Fy,Fz,|F|^2). */
  readSlice(which, axis, idx) {
    const gl = this.gl;
    this.extractSliceTo(this.fboSlice32, which, axis, idx);
    const out = new Float32Array(this.N * this.N * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSlice32);
    gl.readPixels(0, 0, this.N, this.N, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Read the field at up to 96 cell positions [[i,j,k],...] -> Float32Array(n*4). */
  readProbes(which, points) {
    const gl = this.gl, prog = this.progs.probe;
    const count = Math.min(points.length, 96);
    const arr = new Float32Array(96 * 3);
    for (let i = 0; i < count; i++) arr.set(points[i], i * 3);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboProbe);
    gl.viewport(0, 0, 96, 1);
    gl.uniform1i(prog.u.uN, this.N);
    gl.uniform1i(prog.u.uTX, this.TX);
    gl.uniform1i(prog.u.uBoundary, 1);
    gl.uniform3fv(prog.u.uProbes, arr);
    gl.uniform1i(prog.u.uCount, count);
    this.bindTexUnit(0, this.curField(which), prog.u.uF);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Float32Array(count * 4);
    gl.readPixels(0, 0, count, 1, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  memoryMB() {
    const atl = this.W * this.H;
    return (16 * atl * 16 + atl * 8) / 1e6; // 16 RGBA32F atlases + 16F display
  }

  dispose() {
    const gl = this.gl;
    if (this.tex) {
      for (const v of Object.values(this.tex))
        (Array.isArray(v) ? v : [v]).forEach(t => gl.deleteTexture(t));
      [...this.fboH, ...this.fboE, this.fboDisp, this.fboProbe, this.fboSlice32]
        .forEach(f => gl.deleteFramebuffer(f));
      this.tex = null;
    }
  }
}

return { FDTDSim, C_UM_PER_FS, TIME_UNIT_FS };
})();
