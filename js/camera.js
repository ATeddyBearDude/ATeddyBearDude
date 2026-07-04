// Camera rig: three modes.
//  'orbit'  — locked to a body, spherical orbit around it (+ pan offset);
//             wheel / pinch zooms distance. The locked body is always at
//             screen center (unless panned).
//  'center' — planetarium view *from* a body: the camera sits at the body's
//             center (the body itself is hidden), looking out at the sky in
//             an inertial frame. "Look at" tracks any other object, keeping
//             it centered — retrograde loops, eclipses, transits, phases
//             appear exactly as observed from that world. Wheel/pinch zooms
//             FOV down to telescope fields.
//  'free'   — free roam: fly anywhere. Drag looks, wheel/pinch dollies along
//             the view direction (speed scales with distance to the nearest
//             body), WASD/QE fly, Shift = faster.
//
// Touch: one finger = rotate/look, two fingers = pinch zoom + (orbit) pan.
// The rig owns the floating origin: update() returns focusKm (ecliptic km,
// double precision) and positions the camera relative to it.

import * as THREE from '../vendor/three.module.js';
import { KM_PER_UNIT, DEG, clamp } from './const.js';
import { BODY_BY_ID, BODIES } from './catalog.js';
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

    // center ("view from body") state
    this.look = { yawDeg: 0, pitchDeg: 0, fov: 60, trackId: 'sun' };

    // free roam state
    this.freePosKm = null;          // ecliptic km, double precision
    this.freeYawDeg = 0;
    this.freePitchDeg = 0;
    this.freeFov = 55;
    this._keys = new Set();

    this._focusBlend = null;
    this._lastFocus = [0, 0, 0];
    this._pointers = new Map();
    this._pinchPrev = null;
    this._bindInput();
  }

  setTarget(id, entries) {
    if (id === this.targetId) return;
    const prevFocus = [...this._lastFocus];
    this.targetId = id;
    this.panOffsetKm = [0, 0, 0];
    this._focusBlend = { from: prevFocus, t0: performance.now(), dur: 800 };
    if (this.look.trackId === id) this.look.trackId = id === 'sun' ? 'earth' : 'sun';
  }

  setMode(mode, snapshotCamera = true) {
    if (mode === 'free' && this.mode !== 'free' && snapshotCamera) {
      // detach seamlessly from the current view
      this.freePosKm = V.add(this._lastFocus, sceneToEclKm(this.camera.position));
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.freeYawDeg = Math.atan2(d.z, d.x) / DEG;
      this.freePitchDeg = Math.asin(clamp(d.y, -1, 1)) / DEG;
      this.freeFov = this.camera.fov;
    }
    this.mode = mode;
  }

  // Aim the center-view at a body right now (also used when tracking).
  aimAt(id, snap, focusKm) {
    const dir = V.norm(V.sub(snap.pos.get(id), focusKm));
    const dS = eclToSceneDir(dir);
    this.look.pitchDeg = Math.asin(clamp(dS.y, -1, 1)) / DEG;
    this.look.yawDeg = Math.atan2(dS.z, dS.x) / DEG;
  }

  // ---- main per-frame update -------------------------------------------
  update(snap, entries, dtReal = 0.016) {
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
    } else if (this.mode === 'center') {
      focusKm = targetPos;
      if (this.look.trackId && this.look.trackId !== this.targetId) {
        this.aimAt(this.look.trackId, snap, focusKm);
      }
      const y = this.look.yawDeg * DEG, p = this.look.pitchDeg * DEG;
      const dir = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
      this.camera.position.set(0, 0, 0);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(dir);
      this.camera.fov = this.look.fov;
    } else {
      // free roam
      if (!this.freePosKm) this.freePosKm = V.add(targetPos, [0, -radU * KM_PER_UNIT * 6, 0]);
      this._lastNearestU = this._nearestSurfaceU(snap, entries);
      this._applyFreeFlight(snap, entries, dtReal);
      focusKm = this.freePosKm;
      const y = this.freeYawDeg * DEG, p = this.freePitchDeg * DEG;
      const dir = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
      this.camera.position.set(0, 0, 0);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(dir);
      this.camera.fov = this.freeFov;
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
    let nearApproach;
    if (this.mode === 'orbit') nearApproach = Math.max((this.distU - radU) * 0.02, 2e-9);
    else if (this.mode === 'center') nearApproach = Math.max(radU * 0.5, 1e-6);
    else nearApproach = Math.max(this._nearestSurfaceU(snap, entries) * 0.05, 2e-9);
    this.camera.near = clamp(nearApproach, 2e-9, 50);
    this.camera.far = 1.2e8;
    this.camera.updateProjectionMatrix();
    return focusKm;
  }

  _nearestSurfaceU(snap, entries) {
    let best = 1e9;
    const p = this.freePosKm || this._lastFocus;
    for (const b of BODIES) {
      const d = V.len(V.sub(snap.pos.get(b.id), p)) / KM_PER_UNIT - (entries[b.id]?.displayedRadius || 0);
      if (d < best) best = d;
    }
    return Math.max(best, 1e-7);
  }

  _applyFreeFlight(snap, entries, dt) {
    if (!this._keys.size) return;
    const speedU = this._nearestSurfaceU(snap, entries) * (this._keys.has('shift') ? 3.0 : 0.9);
    const y = this.freeYawDeg * DEG, p = this.freePitchDeg * DEG;
    const fwd = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
    const right = fwd.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const mv = new THREE.Vector3();
    if (this._keys.has('w')) mv.add(fwd);
    if (this._keys.has('s')) mv.sub(fwd);
    if (this._keys.has('d')) mv.add(right);
    if (this._keys.has('a')) mv.sub(right);
    if (this._keys.has('e')) mv.add(up);
    if (this._keys.has('q')) mv.sub(up);
    if (mv.lengthSq() > 0) {
      mv.normalize().multiplyScalar(speedU * dt);
      this.freePosKm = V.add(this.freePosKm, sceneToEclKm(mv));
    }
  }

  _dolly(factor) {
    // free-mode travel along view direction; speed ∝ distance to nearest body
    const stepU = this._lastNearestU !== undefined ? this._lastNearestU : 1;
    const y = this.freeYawDeg * DEG, p = this.freePitchDeg * DEG;
    const fwd = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
    fwd.multiplyScalar(stepU * factor);
    this.freePosKm = V.add(this.freePosKm || this._lastFocus, sceneToEclKm(fwd));
  }

  // ---- input --------------------------------------------------------------
  _zoom(deltaFactor) {
    if (this.mode === 'orbit') this.distU *= deltaFactor;
    else if (this.mode === 'center') this.look.fov = clamp(this.look.fov * deltaFactor, 0.3, 110);
    else this._dolly(deltaFactor < 1 ? 0.22 : -0.22);
  }

  _rotate(dx, dy) {
    if (this.mode === 'orbit') {
      this.yawDeg += dx * 0.25;
      this.pitchDeg = clamp(this.pitchDeg + dy * 0.25, -89.5, 89.5);
    } else if (this.mode === 'center') {
      const k = this.look.fov / 480;
      if (dx || dy) this.look.trackId = null;   // manual look cancels tracking
      this.look.yawDeg += dx * k;
      this.look.pitchDeg = clamp(this.look.pitchDeg - dy * k, -89.9, 89.9);
    } else {
      const k = this.freeFov / 480;
      this.freeYawDeg += dx * k;
      this.freePitchDeg = clamp(this.freePitchDeg - dy * k, -89.9, 89.9);
    }
  }

  _pan(dx, dy) {
    if (this.mode !== 'orbit') return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const kPan = this.distU * 0.0016;
    const dScene = right.multiplyScalar(-dx * kPan).add(upv.multiplyScalar(dy * kPan));
    this.panOffsetKm = V.add(this.panOffsetKm, sceneToEclKm(dScene));
  }

  _bindInput() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', e => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      this._pinchPrev = null;
      try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    });
    cv.addEventListener('pointermove', e => {
      const pt = this._pointers.get(e.pointerId);
      if (!pt) return;
      if (this._pointers.size === 2) {
        // pinch zoom + two-finger pan
        pt.x = e.clientX; pt.y = e.clientY;
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (this._pinchPrev) {
          if (this._pinchPrev.dist > 0 && dist > 0) {
            this._zoom(clamp(this._pinchPrev.dist / dist, 0.9, 1.111));
          }
          this._pan(mid.x - this._pinchPrev.mid.x, mid.y - this._pinchPrev.mid.y);
        }
        this._pinchPrev = { dist, mid };
        return;
      }
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
      pt.x = e.clientX; pt.y = e.clientY;
      if (pt.button === 2 || e.shiftKey) this._pan(dx, dy);
      else this._rotate(dx, dy);
    });
    const drop = e => { this._pointers.delete(e.pointerId); this._pinchPrev = null; };
    cv.addEventListener('pointerup', drop);
    cv.addEventListener('pointercancel', drop);
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      this._zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    // free-flight keys
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (this.mode !== 'free') return;
      const k = e.key.toLowerCase();
      if ('wasdqe'.includes(k)) { this._keys.add(k); e.preventDefault(); }
      if (e.key === 'Shift') this._keys.add('shift');
    });
    window.addEventListener('keyup', e => {
      this._keys.delete(e.key.toLowerCase());
      if (e.key === 'Shift') this._keys.delete('shift');
    });
    window.addEventListener('blur', () => this._keys.clear());
  }

  serialize() {
    return {
      mode: this.mode, targetId: this.targetId, distU: this.distU,
      yawDeg: this.yawDeg, pitchDeg: this.pitchDeg, panOffsetKm: this.panOffsetKm,
      orbitFov: this.orbitFov, look: { ...this.look },
      freePosKm: this.freePosKm, freeYawDeg: this.freeYawDeg,
      freePitchDeg: this.freePitchDeg, freeFov: this.freeFov,
    };
  }
  restore(s) {
    Object.assign(this, {
      mode: s.mode === 'surface' ? 'center' : (s.mode || 'orbit'),
      targetId: s.targetId, distU: s.distU,
      yawDeg: s.yawDeg, pitchDeg: s.pitchDeg, panOffsetKm: s.panOffsetKm || [0, 0, 0],
      orbitFov: s.orbitFov || 50,
      freePosKm: s.freePosKm || null,
      freeYawDeg: s.freeYawDeg || 0, freePitchDeg: s.freePitchDeg || 0, freeFov: s.freeFov || 55,
    });
    Object.assign(this.look, s.look || {});
    this._focusBlend = null;
  }
}
