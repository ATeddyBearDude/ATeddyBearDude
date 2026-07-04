// App bootstrap + frame loop.

import * as THREE from '../vendor/three.module.js';
import { KM_PER_UNIT } from './const.js';
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

    // start: visibility scale on for a friendly first view, orbiting Earth
    const scaleVis = document.getElementById('scaleVis');
    scaleVis.checked = true;
    scaleVis.dispatchEvent(new Event('change'));
    this.rig.distU = 900;
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
    if (hits.length) this.selectAndTarget(hits[0].object.userData.bodyId);
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

  onTimeJump() {
    this.sceneMgr.clearTrace();
    this._lastTraceUt = null;
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
    $('camMode').value = this.rig.mode;
    $('surfaceControls').classList.toggle('hidden', this.rig.mode !== 'surface');
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

    const focusKm = this.rig.update(snap, this.sceneMgr.entries);
    this.sceneMgr.update(snap, {
      focusKm, camera: this.rig.camera, sizeScale: this.opts.sizeScale,
      surfaceBodyId: this.rig.mode === 'surface' ? this.rig.targetId : null,
    }, this.opts, this.selection, this.eph);

    // apparent-path trace of the selected body from the current viewpoint
    if (this.opts.trace && this.selection) {
      const sampleGap = Math.max(0.05, Math.min(5, Math.abs(this.clock.effectiveRate) / 86400 * 0.4));
      if (this._lastTraceUt === null || Math.abs(this.clock.ut - this._lastTraceUt) >= sampleGap) {
        const bodyScene = sceneFromEclKm(snap.pos.get(this.selection), focusKm);
        const dir = bodyScene.sub(this.rig.camera.position);
        if (dir.lengthSq() > 0) this.sceneMgr.pushTraceSample(dir.normalize());
        this._lastTraceUt = this.clock.ut;
      }
    }

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
