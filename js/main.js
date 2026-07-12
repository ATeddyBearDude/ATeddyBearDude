// App bootstrap + frame loop.

import * as THREE from '../vendor/three.module.js';
import { KM_PER_UNIT, DEG } from './const.js';
import { BODY_BY_ID, BODIES } from './catalog.js';
import { V } from './kepler.js';
import { Ephemeris } from './ephemeris.js';
import { SimClock } from './time.js';
import { SceneManager, sceneFromEclKm } from './scene.js';
import { CameraRig } from './camera.js';
import { NBody } from './nbody.js';
import { UI } from './ui.js';

class App {
  constructor() {
    const canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.clock = new SimClock();
    this.eph = new Ephemeris();
    this.nbody = new NBody(this.eph);
    this.opts = { sizeScale: 1 };
    this.sceneMgr = new SceneManager(document.getElementById('overlay'), (key, kind) => {
      if (kind === 'body') this.select(key);
    });
    this.rig = new CameraRig(canvas);
    this.ui = new UI(this);
    this.selection = 'earth';
    this.ui.select('earth');

    // start: true 1:1 scale, Earth filling a good part of the view
    this.rig.distU = 0.055;
    this._lastReal = performance.now();
    this._lastUiRefresh = 0;
    this._lastTraceUt = null;

    canvas.addEventListener('dblclick', e => this._pick(e));
    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._raycaster = new THREE.Raycaster();

    requestAnimationFrame(() => this._frame());
  }

  // ---------------- selection / targeting ----------------
  select(id) {
    this.selection = id;
    this.ui.select(id);
  }

  selectAndTarget(id) {
    if (!BODY_BY_ID[id]) return;
    this.select(id);
    const prev = this.rig.targetId;
    this.rig.setTarget(id, this.sceneMgr.entries);
    const e = this.sceneMgr.entries[id];
    if (e && prev !== id) {
      const r = Math.max(e.displayedRadius, 1e-9);
      if (this.rig.distU > r * 4000 || this.rig.distU < r * 1.1) this.rig.distU = r * 5;
    }
    this.sceneMgr.clearTrace();
  }

  _pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(ndc, this.rig.camera);
    const meshes = Object.values(this.sceneMgr.entries).map(en => en.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const id = hits[0].object.userData.bodyId;
    if (this.rig.mode === 'center') {
      // in planetarium view, double-tapping a sky object locks onto it
      if (id !== this.rig.targetId) {
        this.select(id);
        this.ui.setLookAt(id);
      }
    } else {
      this.selectAndTarget(id);
    }
  }

  // ---------------- physics mode ----------------
  setNbody(on) {
    if (on) {
      this.nbody.activate(this.clock.ut);
      if (this.opts.lightTime) {
        this.opts.lightTime = false;
        document.getElementById('tLightTime').checked = false;
      }
    } else this.nbody.deactivate();
  }

  resetTrace() {
    this.sceneMgr.clearTrace();
    this._lastTraceDir = null;
    this._lastTraceUt = null;
    this._traceOf = null;
  }

  onTimeJump() {
    this.resetTrace();
    if (this.nbody.active) this.nbody.activate(this.clock.ut);   // re-seed
  }

  // ---------------- state ----------------
  serializeState() {
    return {
      version: 1,
      ut: this.clock.ut, rate: this.clock.rate, direction: this.clock.direction, paused: this.clock.paused,
      camera: this.rig.serialize(),
      selection: this.selection,
      opts: { ...this.opts },
      overrides: Object.fromEntries([...this.eph.overrides].map(([id, o]) => [id, o.display])),
      nbody: this.nbody.active,
    };
  }

  restoreState(s) {
    try {
      this.clock.ut = s.ut; this.clock.rate = s.rate;
      this.clock.direction = s.direction || 1; this.clock.paused = !!s.paused;
      this.rig.restore(s.camera);
      this.eph.clearAllOverrides();
      for (const [id, disp] of Object.entries(s.overrides || {})) this.eph.setOverride(id, disp);
      Object.assign(this.opts, s.opts || {});
      this.select(s.selection || 'earth');
      for (const b of BODIES) this.sceneMgr.markOrbitDirty(b.id);
      if (s.nbody) this.nbody.activate(this.clock.ut); else this.nbody.deactivate();
      this._syncDomFromOpts();
      this.onTimeJump();
    } catch (err) {
      console.error('state restore failed', err);
    }
  }

  _syncDomFromOpts() {
    const $ = id => document.getElementById(id);
    const map = {
      tLabels: 'labels', tMarkers: 'markers', tOrbP: 'orbitsPlanets', tOrbM: 'orbitsMoons',
      tOrbD: 'orbitsDwarfs', tBelts: 'belts', tRings: 'rings', tAtmos: 'atmos',
      tEclipse: 'eclipseShading', tGridPlane: 'gridEclPlane', tGridEq: 'gridEqSky',
      tGridEcl: 'gridEclSky', tCones: 'shadowCones', tLagrange: 'lagrange',
      tLightTime: 'lightTime', tTrace: 'trace',
    };
    for (const [el, key] of Object.entries(map)) $(el).checked = !!this.opts[key];
    $('skyBrightness').value = this.opts.skyBrightness ?? 1;
    this.ui.setMode(this.rig.mode);
    if (this.opts.sizeScale === 1) $('scaleTrue').checked = true;
    else { $('scaleVis').checked = true; $('scaleSlider').value = Math.log10(this.opts.sizeScale); }
    $('scaleValue').textContent = '×' + Math.round(this.opts.sizeScale).toLocaleString('en-US');
    $('physNbody').checked = this.nbody.active;
    $('physEphem').checked = !this.nbody.active;
  }

  // ---------------- frame loop ----------------
  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  _frame() {
    requestAnimationFrame(() => this._frame());
    const now = performance.now();
    const dtReal = Math.min(0.25, (now - this._lastReal) / 1000);
    this._lastReal = now;

    this.clock.tick(dtReal);

    // N-body: integrate to sim time; if the substep budget can't keep up,
    // hold the sim clock back so physics and clock stay consistent.
    if (this.nbody.active) {
      this.nbody.advanceTo(this.clock.ut);
      if (Math.abs(this.nbody.ut - this.clock.ut) > 1e-9) this.clock.ut = this.nbody.ut;
    }

    const useLT = this.opts.lightTime && !this.nbody.active;
    const baseSnap = this.eph.snapshot(this.clock.ut, {
      lightTime: useLT, observerId: useLT ? this.rig.targetId : null,
    });
    let snap = baseSnap;
    if (this.nbody.active) {
      snap = { ut: baseSnap.ut, pos: new Map(baseSnap.pos), orient: baseSnap.orient, lightTimeSec: null };
      this.nbody.applyToSnapshot(snap);
    }

    const focusKm = this.rig.update(snap, this.sceneMgr.entries, dtReal);

    // apparent-path trace: only meaningful when tracking a body from
    // another body's perspective (from-body mode + look-at engaged).
    // Sampled BEFORE the scene draws this frame so the tip is never a
    // frame behind the planet.
    const traceTarget = (this.rig.mode === 'center' && this.rig.look.trackId) ? this.rig.look.trackId : null;
    if (this.opts.trace && traceTarget) {
      if (this._traceOf !== traceTarget) {           // tracked body changed
        this.sceneMgr.clearTrace();
        this.sceneMgr.setTraceColor(BODY_BY_ID[traceTarget].color);
        this._traceOf = traceTarget;
        this._lastTraceDir = null;
        this._lastTraceUt = null;
      }
      // angular threshold sampling with sub-frame interpolation: when one
      // frame advances time so far that the body jumped several thresholds,
      // intermediate ephemeris samples fill the gap — smooth at any rate.
      // The observer MUST match the camera exactly: if a surface site is
      // set, every sample is topocentric at its own time (mixing geocentric
      // interpolation with topocentric frame samples once produced a
      // sawtooth of daily-parallax offsets).
      const site = this.rig.look.site;
      const siteRadiusKm = (this.sceneMgr.entries[this.rig.targetId]?.displayedRadius || 0) * KM_PER_UNIT;
      const obsAt = t => {
        const c = this.eph.posOfAt(this.rig.targetId, t);
        if (!site) return c;
        const m = this.eph.orientationOf(this.rig.targetId, t);
        const lat = site.latDeg * DEG, lon = site.lonDeg * DEG, cl = Math.cos(lat);
        const l = [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
        const up = [
          m[0][0] * l[0] + m[0][1] * l[1] + m[0][2] * l[2],
          m[1][0] * l[0] + m[1][1] * l[1] + m[1][2] * l[2],
          m[2][0] * l[0] + m[2][1] * l[1] + m[2][2] * l[2],
        ];
        return [c[0] + up[0] * siteRadiusKm, c[1] + up[1] * siteRadiusKm, c[2] + up[2] * siteRadiusKm];
      };
      const dirAt = t => sceneFromEclKm(this.eph.posOfAt(traceTarget, t), obsAt(t)).normalize();
      // sample density follows the current zoom: tighter threshold when the
      // user is zoomed in, so the recorded path is smooth at that scale
      const THR = Math.max(2e-6, Math.min(1e-3, this.rig.camera.fov * DEG / 700));
      this.sceneMgr.traceSampleAng = THR;
      const dirNow = sceneFromEclKm(snap.pos.get(traceTarget), focusKm)
        .sub(this.rig.camera.position).normalize();
      if (this._lastTraceDir === null || this._lastTraceUt === null) {
        this.sceneMgr.pushTraceSample(dirNow);
        this._lastTraceDir = dirNow.clone();
        this._lastTraceUt = this.clock.ut;
        this._lastPushUt = this.clock.ut;
      } else if (this.clock.ut !== this._lastTraceUt) {
        const dt = this.clock.ut - this._lastTraceUt;
        const jump = this._lastTraceDir.angleTo(dirNow);
        // subdivide by BOTH apparent motion and elapsed time: retrograde
        // cusps move slowly but curve sharply, so they need time samples;
        // a surface site adds a daily parallax cycle that must be resolved
        // finely or it aliases into jagged teeth
        const maxGapD = site ? 0.02 : 1.0;
        const n = Math.min(64, Math.max(1, Math.ceil(jump / THR), Math.ceil(Math.abs(dt) / maxGapD)));
        for (let k = 1; k <= n; k++) {
          const t = this._lastTraceUt + dt * k / n;
          const d = k === n ? dirNow : dirAt(t);
          if (this._lastTraceDir.angleTo(d) > THR || Math.abs(t - this._lastPushUt) > maxGapD * 1.5) {
            this.sceneMgr.pushTraceSample(d);
            this._lastTraceDir = d.clone();
            this._lastPushUt = t;
          }
        }
        this._lastTraceUt = this.clock.ut;
      }
      // live tip: the drawn curve always ends exactly at the planet's
      // current direction, even between threshold samples
      this.sceneMgr.traceTip = dirNow;
    } else {
      this.sceneMgr.traceTip = null;
      if (this.sceneMgr.traceDirs.length && this.rig.mode !== 'center') {
        // recording stops when tracking stops, but the drawn path persists
        // in from-body mode (so you can unlock and admire the whole loop);
        // leaving from-body mode erases it
        this.sceneMgr.clearTrace();
        this._traceOf = null;
      }
    }

    this.sceneMgr.update(snap, {
      focusKm, camera: this.rig.camera, sizeScale: this.opts.sizeScale,
      centerBodyId: this.rig.mode === 'center' ? this.rig.targetId : null,
      site: this.rig.look.site,
      priorityBodyId: traceTarget || this.selection,
    }, this.opts, this.selection, this.eph);

    this.renderer.render(this.sceneMgr.scene, this.rig.camera);

    if (now - this._lastUiRefresh > 200) {
      this.ui.refresh(snap, focusKm);
      this._lastUiRefresh = now;
    }
  }
}

try {
  window.app = new App();
} catch (err) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;inset:20% 20%;color:#f88;background:#200;padding:20px;z-index:99;font:14px monospace;';
  div.textContent = 'Failed to start: ' + err.message + '\n(WebGL2 required)';
  document.body.appendChild(div);
  throw err;
}
