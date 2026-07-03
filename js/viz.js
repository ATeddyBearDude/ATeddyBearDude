"use strict";
/* ============================================================================
 * Renderer: interactive 3-D view of the FDTD fields.
 *  - volume raymarching of |E|^2 (or a signed component) with clip box
 *  - axis-aligned slice plane with colormap + material overlay
 *  - instanced E-vector glyphs on the slice plane
 *  - orbit / pan / zoom camera, wireframe boxes for domain / PML / regions
 *  - slice history ring buffer for time scrubbing while paused
 * ========================================================================= */

const VIZ = (() => {

/* ------------------------------------------------------------- mat4 ----- */
const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  },
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,  0, f, 0, 0,
      0, 0, (far + near) * nf, -1,  0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, tgt, up) {
    const z = norm3(sub3(eye, tgt));
    const x = norm3(cross3(up, z));
    const y = cross3(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,  x[1], y[1], z[1], 0,  x[2], y[2], z[2], 0,
      -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1]);
  },
  invert(m) {
    const inv = new Float32Array(16), o = new Float32Array(16);
    inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
    inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
    inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
    inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
    inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];
    inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
    inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
    inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];
    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (!det) return o;
    det = 1 / det;
    for (let i = 0; i < 16; i++) o[i] = inv[i] * det;
    return o;
  },
};
function sub3(a, b)  { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function dot3(a, b)  { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross3(a, b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm3(a)    { const l = Math.hypot(...a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

/* JS copies of the shader colormap anchors (legend + validation plot). */
const CMAPS = {
  viridis:  [[0.267,0.005,0.329],[0.275,0.194,0.496],[0.213,0.359,0.552],[0.153,0.497,0.557],[0.122,0.633,0.530],[0.369,0.789,0.383],[0.993,0.906,0.144]],
  inferno:  [[0.001,0.000,0.014],[0.183,0.037,0.352],[0.445,0.122,0.507],[0.705,0.214,0.401],[0.906,0.376,0.229],[0.988,0.645,0.040],[0.988,0.998,0.645]],
  coolwarm: [[0.230,0.299,0.754],[0.406,0.538,0.934],[0.602,0.731,0.999],[0.865,0.865,0.865],[0.968,0.720,0.612],[0.887,0.464,0.360],[0.706,0.016,0.150]],
  gray:     [[0,0,0],[1/6,1/6,1/6],[2/6,2/6,2/6],[0.5,0.5,0.5],[4/6,4/6,4/6],[5/6,5/6,5/6],[1,1,1]],
};
const CMAP_INDEX = { viridis: 0, inferno: 1, coolwarm: 2, gray: 3 };
function cmapCss(name, t) {
  const c = CMAPS[name] || CMAPS.viridis;
  const x = Math.min(Math.max(t, 0), 1) * 6, i = Math.min(Math.floor(x), 5), f = x - i;
  const v = c[i].map((a, k) => Math.round(255 * (a + (c[i + 1][k] - a) * f)));
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}

/* ------------------------------------------------------------ renderer -- */

const HISTORY = 181;   // slice frames kept for time scrubbing

class Renderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.cam = { yaw: 0.7, pitch: 0.42, dist: 2.4, target: [0, 0, 0], fov: 40 * Math.PI / 180 };
    this.progs = {
      volume: this._prog(SHADERS.V_VOLUME, SHADERS.F_VOLUME, "volume"),
      slice:  this._prog(SHADERS.V_SLICE,  SHADERS.F_SLICE,  "slice"),
      glyph:  this._prog(SHADERS.V_GLYPH,  SHADERS.F_GLYPH,  "glyph"),
      lines:  this._prog(SHADERS.V_LINES,  SHADERS.F_LINES,  "lines"),
    };
    this._makeBoxVBO();
    this.history = null;   // allocated per grid size
    this._installControls();
  }

  _prog(vs, fs, name) {
    const gl = this.gl;
    const c = (t, s) => {
      const sh = gl.createShader(t);
      gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error(`viz shader "${name}": ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, c(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(`viz link "${name}": ${gl.getProgramInfoLog(p)}`);
    const prog = { p, u: {} };
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      prog.u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
    }
    return prog;
  }

  _makeBoxVBO() {
    const gl = this.gl;
    // unit box centered at origin, 12 edges = 24 vertices
    const e = [];
    const C = [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],
               [-0.5,-0.5, 0.5],[0.5,-0.5, 0.5],[0.5,0.5, 0.5],[-0.5,0.5, 0.5]];
    const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of E) e.push(...C[a], ...C[b]);
    this.boxVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(e), gl.STATIC_DRAW);
    this.boxVAO = gl.createVertexArray();
    gl.bindVertexArray(this.boxVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.emptyVAO = gl.createVertexArray();
  }

  allocHistory(N) {
    const gl = this.gl;
    if (this.history) {
      gl.deleteTexture(this.history.tex);
      this.history.fbos.forEach(f => gl.deleteFramebuffer(f));
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, N, N, HISTORY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbos = [];
    for (let l = 0; l < HISTORY; l++) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, l);
      fbos.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.history = { tex, fbos, N, head: -1, count: 0, times: new Float64Array(HISTORY) };
  }

  /** Capture the current slice of `sim` into the history ring. */
  capture(sim, viz) {
    const h = this.history;
    h.head = (h.head + 1) % HISTORY;
    h.count = Math.min(h.count + 1, HISTORY);
    h.times[h.head] = sim.time;
    const idx = Math.round(viz.sliceFrac * (sim.N - 1));
    sim.extractSliceTo(h.fbos[h.head], viz.field, viz.sliceAxis, idx);
  }
  /** layer index for "ago" frames back (0 = newest). */
  historyLayer(ago) {
    const h = this.history;
    ago = Math.min(ago, h.count - 1);
    return (h.head - ago + HISTORY) % HISTORY;
  }

  /* ---------------------------------------------------------- camera --- */

  _installControls() {
    const c = this.canvas, cam = this.cam;
    let drag = null;
    c.addEventListener("pointerdown", e => {
      drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 2 || drag.shift) {           // pan
        const s = cam.dist * 0.0016;
        const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
        const up = [Math.sin(cam.yaw) * Math.sin(cam.pitch), Math.cos(cam.pitch),
                    Math.cos(cam.yaw) * Math.sin(cam.pitch)];
        for (let i = 0; i < 3; i++)
          cam.target[i] += -right[i] * dx * s + up[i] * dy * s;
      } else {                                      // orbit
        cam.yaw   += dx * 0.008;
        cam.pitch = Math.min(1.55, Math.max(-1.55, cam.pitch + dy * 0.008));
      }
    });
    const end = () => drag = null;
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", e => {
      e.preventDefault();
      cam.dist = Math.min(12, Math.max(0.4, cam.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
    c.addEventListener("contextmenu", e => e.preventDefault());
  }

  camMatrices(w, h) {
    const cam = this.cam;
    const eye = [
      cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.target[1] + cam.dist * Math.sin(cam.pitch),
      cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
    const V = M4.lookAt(eye, cam.target, [0, 1, 0]);
    const P = M4.perspective(cam.fov, w / h, 0.02, 60);
    const VP = M4.mul(P, V);
    return { eye, VP, invVP: M4.invert(VP) };
  }

  /* ------------------------------------------------------------ draw --- */

  /**
   * viz = { field:'E'|'H', showVolume, showSlice, showGlyphs, mode:0|1,
   *   comp:0..2, cmap:'viridis'..., gain, opacity, raySteps,
   *   clipMin:[3], clipMax:[3], sliceAxis:0..2, sliceFrac, sliceAlpha,
   *   glyphStride, glyphScale, scrubAgo (0 = live) }
   */
  draw(sim, viz) {
    const gl = this.gl, canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    sim.updateDisplay(viz.field);

    const { eye, VP, invVP } = this.camMatrices(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.055, 0.06, 0.075, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cmapIdx = CMAP_INDEX[viz.cmap] ?? 0;

    // --- wireframes: domain, PML shell, material regions
    this._drawBox(VP, [1, 1, 1], [0, 0, 0], [0.45, 0.5, 0.6, 0.9]);
    if (sim.boundaryCode() === 0 && sim.cfg.pmlW > 0) {
      const s = 1 - 2 * sim.cfg.pmlW / sim.N;
      this._drawBox(VP, [s, s, s], [0, 0, 0], [0.3, 0.34, 0.42, 0.5]);
    }
    for (const r of sim.cfg.regions) {
      if (r.enabled === false) continue;
      const col = r.type === "pec" ? [0.75, 0.75, 0.78, 0.8]
                : r.type === "drude" ? [0.85, 0.6, 0.35, 0.8] : [0.45, 0.62, 0.85, 0.8];
      const off = r.center.map(f => f - 0.5);
      const sc = r.shape === "sphere"
        ? [2 * r.radius, 2 * r.radius, 2 * r.radius] : r.size.slice();
      this._drawBox(VP, sc, off, col);
    }

    // --- volume raymarch (blended; drawn first so the slice cuts through it)
    const sliceIdx = Math.round(viz.sliceFrac * (sim.N - 1));
    if (viz.showVolume) {
      const prog = this.progs.volume;
      gl.useProgram(prog.p);
      gl.bindVertexArray(this.emptyVAO);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(prog.u.uInvVP, false, invVP);
      gl.uniform3fv(prog.u.uCamPos, eye);
      gl.uniform2f(prog.u.uViewport, w, h);
      gl.uniform1f(prog.u.uNf, sim.N);
      gl.uniform1i(prog.u.uTXv, sim.TX);
      gl.uniform2f(prog.u.uTexSize, sim.W, sim.H);
      gl.uniform3fv(prog.u.uClipMin, viz.clipMin);
      gl.uniform3fv(prog.u.uClipMax, viz.clipMax);
      gl.uniform1i(prog.u.uSteps, viz.raySteps);
      gl.uniform1i(prog.u.uMode, viz.mode);
      gl.uniform1i(prog.u.uComp, viz.comp);
      gl.uniform1f(prog.u.uGain, viz.mode === 0 ? viz.gain : Math.sqrt(viz.gain));
      gl.uniform1f(prog.u.uOpacity, viz.opacity);
      gl.uniform1i(prog.u.uCmap, cmapIdx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sim.tex.disp);
      gl.uniform1i(prog.u.uDisp, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }

    // --- slice plane
    if (viz.showSlice && this.history && this.history.count > 0) {
      const prog = this.progs.slice;
      gl.useProgram(prog.p);
      gl.bindVertexArray(this.emptyVAO);
      gl.uniformMatrix4fv(prog.u.uVP, false, VP);
      gl.uniform1i(prog.u.uAxis, viz.sliceAxis);
      gl.uniform1f(prog.u.uFrac, (sliceIdx + 0.5) / sim.N);
      gl.uniform1f(prog.u.uLayer, this.historyLayer(viz.scrubAgo || 0));
      gl.uniform1i(prog.u.uN, sim.N);
      gl.uniform1i(prog.u.uTX, sim.TX);
      gl.uniform1i(prog.u.uBoundary, 1);
      gl.uniform1i(prog.u.uIdx, sliceIdx);
      gl.uniform1i(prog.u.uMode, viz.mode);
      gl.uniform1i(prog.u.uComp, viz.comp);
      gl.uniform1f(prog.u.uGain, viz.mode === 0 ? viz.gain : Math.sqrt(viz.gain));
      gl.uniform1f(prog.u.uAlpha, viz.sliceAlpha);
      gl.uniform1i(prog.u.uCmap, cmapIdx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.history.tex);
      gl.uniform1i(prog.u.uHist, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sim.tex.mat1);
      gl.uniform1i(prog.u.uMat1, 1);
      gl.disable(gl.CULL_FACE);
      if (viz.sliceAlpha < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
    }

    // --- vector glyphs on the slice
    if (viz.showGlyphs) {
      const prog = this.progs.glyph;
      const stride = Math.max(2, viz.glyphStride);
      const n = Math.floor(sim.N / stride);
      gl.useProgram(prog.p);
      gl.bindVertexArray(this.emptyVAO);
      gl.uniformMatrix4fv(prog.u.uVP, false, VP);
      gl.uniform1i(prog.u.uN, sim.N);
      gl.uniform1i(prog.u.uTX, sim.TX);
      gl.uniform1i(prog.u.uBoundary, 1);
      gl.uniform1i(prog.u.uAxis, viz.sliceAxis);
      gl.uniform1i(prog.u.uIdx, sliceIdx);
      gl.uniform1i(prog.u.uStride, stride);
      gl.uniform1f(prog.u.uGain, Math.sqrt(viz.gain));
      gl.uniform1f(prog.u.uScaleLen, viz.glyphScale * stride / sim.N);
      gl.uniform1i(prog.u.uCmap, cmapIdx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sim.curField(viz.field));
      gl.uniform1i(prog.u.uF, 0);
      gl.drawArraysInstanced(gl.LINES, 0, 2, n * n);
    }
    gl.bindVertexArray(null);
  }

  _drawBox(VP, scale, offset, color) {
    const gl = this.gl, prog = this.progs.lines;
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.boxVAO);
    gl.uniformMatrix4fv(prog.u.uVP, false, VP);
    gl.uniform3fv(prog.u.uScaleV, scale);
    gl.uniform3fv(prog.u.uOffset, offset);
    gl.uniform4fv(prog.u.uColor, color);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}

return { Renderer, CMAPS, cmapCss, HISTORY };
})();
