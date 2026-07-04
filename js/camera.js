// Camera rig: two modes.
//  'orbit'   — locked to a body, spherical orbit around it (+ pan offset),
//              wheel zooms distance.
//  'surface' — standing at lat/lon on a body's (rotating) surface: the rig
//              rides the body's IAU rotation state, look direction is
//              heading/altitude, wheel zooms FOV like a telescope. This is
//              the planetarium view: retrograde loops, eclipses, transits
//              and phases appear exactly as observed.
//
// The rig owns the floating origin: update() returns focusKm (ecliptic km,
// double precision) and positions the camera relative to it.

import * as THREE from '../vendor/three.module.js';
import { KM_PER_UNIT, DEG, clamp } from './const.js';
import { BODY_BY_ID } from './catalog.js';
import { V } from './kepler.js';

const sceneToEclKm = v => [v.x * KM_PER_UNIT, -v.z * KM_PER_UNIT, v.y * KM_PER_UNIT];
const eclToSceneDir = v => new THREE.Vector3(v[0], v[2], -v[1]);

export class CameraRig {
  constructor(canvas) {
    this.canvas = canvas;
    this.camera = new THREE.PerspectiveCamera(50, 1, 1e-6, 1.2e8);
    this.mode = 'orbit';
    this.targetId = 'earth';

    // orbit state
    this.distU = 0.05;
    this.yawDeg = 35;
    this.pitchDeg = 18;
    this.panOffsetKm = [0, 0, 0];
    this.orbitFov = 50;

    // surface state
    this.surf = { lat: 28.4, lon: -80.6, headingDeg: 130, altDeg: 25, heightKm: 0.002, fov: 60, trackId: null };

    this._focusBlend = null;
    this._lastFocus = [0, 0, 0];
    this._dragging = 0;
    this._bindInput();
  }

  setTarget(id, entries) {
    if (id === this.targetId) return;
    const prevFocus = [...this._lastFocus];
    this.targetId = id;
    this.panOffsetKm = [0, 0, 0];
    this._focusBlend = { from: prevFocus, t0: performance.now(), dur: 800 };
    if (this.mode === 'surface') this.surf.trackId = null;
  }

  frameTarget(entries) {
    const e = entries[this.targetId];
    if (e) this.distU = Math.max(e.displayedRadius * 4.5, 1e-6);
  }

  setMode(mode) { this.mode = mode; }

  // Aim surface view at a body (returns true if above horizon)
  aimAt(idOrDir, snap, focusKm) {
    const dir = Array.isArray(idOrDir) ? idOrDir
      : V.norm(V.sub(snap.pos.get(idOrDir), focusKm));
    const b = this._surfBasis;
    if (!b) return false;
    const up = [b.up.x, b.up.y, b.up.z].map(Number);
    const dS = eclToSceneDir(dir);
    const sinAlt = dS.dot(b.up);
    const horiz = dS.clone().sub(b.up.clone().multiplyScalar(sinAlt)).normalize();
    this.surf.altDeg = Math.asin(clamp(sinAlt, -1, 1)) / DEG;
    this.surf.headingDeg = Math.atan2(horiz.dot(b.east), horiz.dot(b.north)) / DEG;
    return sinAlt > 0;
  }

  // ---- main per-frame update -------------------------------------------
  // Returns focusKm. entries: scene entries (for displayed radii).
  update(snap, entries, opts = {}) {
    const targetPos = snap.pos.get(this.targetId);
    const e = entries[this.targetId];
    const radU = e ? e.displayedRadius : 1e-5;
    let focusKm;

    if (this.mode === 'orbit') {
      focusKm = V.add(targetPos, this.panOffsetKm);
      this.distU = clamp(this.distU, radU * 1.03 + 1e-9, 4.5e5);
      const y = this.yawDeg * DEG, p = this.pitchDeg * DEG;
      const dir = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
      this.camera.position.copy(dir.multiplyScalar(this.distU));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      this.camera.fov = this.orbitFov;
    } else {
      // surface mode: body-fixed location, using DISPLAYED radius so the
      // view stays on the surface in visibility-scale mode too.
      const m = snap.orient.get(this.targetId);
      const bx = eclToSceneDir([m[0][0], m[1][0], m[2][0]]);
      const by = eclToSceneDir([m[0][1], m[1][1], m[2][1]]);
      const bz = eclToSceneDir([m[0][2], m[1][2], m[2][2]]);
      const lat = this.surf.lat * DEG, lon = this.surf.lon * DEG;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const up = bx.clone().multiplyScalar(cl * Math.cos(lon))
        .add(by.clone().multiplyScalar(cl * Math.sin(lon)))
        .add(bz.clone().multiplyScalar(sl)).normalize();
      const north = bx.clone().multiplyScalar(-sl * Math.cos(lon))
        .add(by.clone().multiplyScalar(-sl * Math.sin(lon)))
        .add(bz.clone().multiplyScalar(cl)).normalize();
      const east = north.clone().cross(up);
      this._surfBasis = { up, north, east };

      const body = BODY_BY_ID[this.targetId];
      const f = body.flattening || 0;
      const rSurfU = radU * (1 - f * sl * sl);
      const upEclKm = V.norm(sceneToEclKm(up));
      focusKm = V.add(targetPos, V.scale(upEclKm, rSurfU * KM_PER_UNIT + this.surf.heightKm));

      if (this.surf.trackId && this.surf.trackId !== this.targetId) {
        this.aimAt(this.surf.trackId, snap, focusKm);
      }
      const hd = this.surf.headingDeg * DEG, al = this.surf.altDeg * DEG;
      const dir = north.clone().multiplyScalar(Math.cos(al) * Math.cos(hd))
        .add(east.clone().multiplyScalar(Math.cos(al) * Math.sin(hd)))
        .add(up.clone().multiplyScalar(Math.sin(al)));
      this.camera.position.set(0, 0, 0);
      this.camera.up.copy(up);
      const m4 = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir, up);
      this.camera.quaternion.setFromRotationMatrix(m4);
      this.camera.fov = this.surf.fov;
    }

    // focus blending for smooth target switches
    if (this._focusBlend) {
      const t = (performance.now() - this._focusBlend.t0) / this._focusBlend.dur;
      if (t >= 1) this._focusBlend = null;
      else {
        const s = t * t * (3 - 2 * t);
        focusKm = V.add(V.scale(this._focusBlend.from, 1 - s), V.scale(focusKm, s));
      }
    }
    this._lastFocus = focusKm;

    // near/far
    const nearApproach = this.mode === 'surface' ? Math.max(this.surf.heightKm / KM_PER_UNIT, 2e-9)
      : Math.max((this.distU - radU) * 0.02, 2e-9);
    this.camera.near = clamp(nearApproach, 2e-9, 50);
    this.camera.far = 1.2e8;
    this.camera.updateProjectionMatrix();
    return focusKm;
  }

  // ---- input --------------------------------------------------------------
  _bindInput() {
    const cv = this.canvas;
    let lastX = 0, lastY = 0, button = 0;
    cv.addEventListener('pointerdown', e => {
      this._dragging = 1;
      button = e.button;
      lastX = e.clientX; lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      if (!this._dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (this.mode === 'orbit') {
        if (button === 2 || e.shiftKey) {
          // pan: move focus in the camera plane
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
          const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
          const kPan = this.distU * 0.0016;
          const dScene = right.multiplyScalar(-dx * kPan).add(upv.multiplyScalar(dy * kPan));
          this.panOffsetKm = V.add(this.panOffsetKm, sceneToEclKm(dScene));
        } else {
          this.yawDeg += dx * 0.25;
          this.pitchDeg = clamp(this.pitchDeg + dy * 0.25, -89.5, 89.5);
        }
      } else {
        const k = this.surf.fov / 500;
        if (dx || dy) this.surf.trackId = null;   // manual look cancels tracking
        this.surf.headingDeg = (this.surf.headingDeg + dx * k * 1.4) % 360;
        this.surf.altDeg = clamp(this.surf.altDeg + dy * k, -89.9, 89.9);
      }
    });
    cv.addEventListener('pointerup', () => { this._dragging = 0; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const s = Math.exp(e.deltaY * 0.0012);
      if (this.mode === 'orbit') this.distU *= s;
      else this.surf.fov = clamp(this.surf.fov * s, 0.35, 110);
    }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }

  serialize() {
    return {
      mode: this.mode, targetId: this.targetId, distU: this.distU,
      yawDeg: this.yawDeg, pitchDeg: this.pitchDeg, panOffsetKm: this.panOffsetKm,
      orbitFov: this.orbitFov, surf: { ...this.surf },
    };
  }
  restore(s) {
    Object.assign(this, {
      mode: s.mode, targetId: s.targetId, distU: s.distU,
      yawDeg: s.yawDeg, pitchDeg: s.pitchDeg, panOffsetKm: s.panOffsetKm || [0, 0, 0],
      orbitFov: s.orbitFov || 50,
    });
    Object.assign(this.surf, s.surf || {});
    this._focusBlend = null;
  }
}
