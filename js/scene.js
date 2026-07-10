// Scene graph: bodies, rings, atmospheres, belts, sky, grids, orbit lines,
// Lagrange markers, shadow cones, HTML label overlay.
//
// Rendering strategy for 1:1 scale across 10^9 km:
//  * floating origin — every position is computed relative to the camera
//    focus in double precision on the CPU, so GPU float32 coordinates stay
//    small where it matters;
//  * logarithmic depth buffer (set on the renderer in main.js);
//  * belt particles propagate their own Kepler orbits in the vertex shader.

import * as THREE from '../vendor/three.module.js';
import { KM_PER_UNIT, KM_PER_AU, UNITS_PER_AU, DEG, GM } from './const.js';
import { BODIES, BODY_BY_ID, childrenOf } from './catalog.js';
import { V, M3 } from './kepler.js';
import { M_EQJ_FROM_ECL } from './ephemeris.js';
import { bodyTexture, proceduralTexture, ringTexture, fileTexture, glowTexture } from './textures.js';
import { makePlanetMaterial, makeSunMaterial, makeRingMaterial, makeAtmosphereMaterial, makeBeltMaterial, makeSkyMaterial, makeSkyGridShaderMaterial, makeStarPointsMaterial, MAX_OCCLUDERS } from './shaders.js';

export const sceneFromEcl = v => new THREE.Vector3(v[0], v[2], -v[1]);
export function sceneFromEclKm(vKm, focusKm) {
  return new THREE.Vector3(
    (vKm[0] - focusKm[0]) / KM_PER_UNIT,
    (vKm[2] - focusKm[2]) / KM_PER_UNIT,
    -(vKm[1] - focusKm[1]) / KM_PER_UNIT,
  );
}

// Which bodies can eclipse the Sun for each body (max MAX_OCCLUDERS).
const OCCLUDERS = {
  moon: ['earth'], earth: ['moon'],
  io: ['jupiter', 'europa', 'ganymede', 'callisto'],
  europa: ['jupiter', 'io', 'ganymede', 'callisto'],
  ganymede: ['jupiter', 'io', 'europa', 'callisto'],
  callisto: ['jupiter', 'io', 'europa', 'ganymede'],
  jupiter: ['io', 'europa', 'ganymede', 'callisto'],
  saturn: ['titan', 'rhea', 'dione', 'tethys'],
  mimas: ['saturn', 'titan'], enceladus: ['saturn', 'titan'], tethys: ['saturn', 'titan'],
  dione: ['saturn', 'titan'], rhea: ['saturn', 'titan'], titan: ['saturn'], iapetus: ['saturn'],
  miranda: ['uranus'], ariel: ['uranus'], umbriel: ['uranus'], titania: ['uranus'], oberon: ['uranus'],
  uranus: ['titania', 'oberon', 'ariel', 'umbriel'],
  neptune: ['triton'], triton: ['neptune'],
  pluto: ['charon'], charon: ['pluto'],
};

const LAGRANGE_PAIRS = [
  ['sun', 'earth'], ['sun', 'mars'], ['sun', 'jupiter'], ['sun', 'saturn'], ['earth', 'moon'],
];

export class SceneManager {
  constructor(overlayEl, onSelect) {
    this.scene = new THREE.Scene();
    this.overlayEl = overlayEl;
    this.onSelect = onSelect;
    this.entries = {};
    this.overlayItems = new Map();
    this.sphereGeo = new THREE.SphereGeometry(1, 96, 48);
    this._buildBodies();
    this._buildSky();
    this._buildStars();
    this._buildBelts();
    this._buildGrids();
    this._buildOrbitLines();
    this._buildLagrange();
    this._buildShadowCones();
    this._buildTrace();
    this._tmpV = new THREE.Vector3();
  }

  // ---------------- bodies ----------------
  _buildBodies() {
    for (const b of BODIES) {
      const group = new THREE.Group();
      let mesh, mat;
      const tex = bodyTexture(b);
      if (b.type === 'star') {
        mat = makeSunMaterial(tex);
        mesh = new THREE.Mesh(this.sphereGeo, mat);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85,
        }));
        glow.name = 'glow';
        group.add(glow);
      } else {
        const night = b.nightTexture ? bodyTexture(b, { night: true }) : null;
        mat = makePlanetMaterial(tex, night);
        mesh = new THREE.Mesh(this.sphereGeo, mat);
      }
      mesh.userData.bodyId = b.id;
      group.add(mesh);

      let ringMesh = null;
      if (b.ring) {
        const rtex = b.ring.texture ? fileTexture(b.ring.texture) : ringTexture(b.ring.procedural);
        ringMesh = new THREE.Mesh(makeRingGeometry(), makeRingMaterial(rtex, b.ring.opacity));
        ringMesh.userData.ringTex = rtex;
        group.add(ringMesh);
      }
      let atmo = null;
      if (b.atmosphere) {
        atmo = new THREE.Mesh(this.sphereGeo, makeAtmosphereMaterial(b.atmosphere.color, b.atmosphere.intensity));
        group.add(atmo);
      }
      this.scene.add(group);
      this.entries[b.id] = { body: b, group, mesh, mat, ringMesh, atmo };
      this._addOverlay(b.id, b.name, b.color, 'body');
    }
  }

  _addOverlay(key, text, color, kind) {
    const el = document.createElement('div');
    el.className = `ov ov-${kind}`;
    el.innerHTML = `<span class="dot" style="background:${color}"></span><span class="txt">${text}</span>`;
    el.addEventListener('pointerdown', e => { e.stopPropagation(); this.onSelect?.(key, kind); });
    this.overlayEl.appendChild(el);
    this.overlayItems.set(key, { el, kind, visible: false });
    return el;
  }

  // ---------------- sky ----------------
  _buildSky() {
    const tex = fileTexture('textures/starmap_8k.jpg');
    tex.wrapS = THREE.RepeatWrapping;
    this.skyMat = makeSkyMaterial(tex);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMat);
    this.sky.scale.setScalar(4.0e7);
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    // scene -> ecl matrix: (x,y,z)scene -> (x,-z,y)ecl ; then ecl -> eqj
    const mSceneToEcl = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    const m = M3.mul(M_EQJ_FROM_ECL, mSceneToEcl);
    this.skyMat.uniforms.uEqjFromScene.value.set(
      m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]);
    this.scene.add(this.sky);
  }

  // ---------------- catalog star points ----------------
  // ~10k real stars (HYG, mag ≤ 6.6) rendered as sharp shader points.
  // The photo sky map fades out as the FOV narrows and these carry the sky,
  // so telescope zooms never show texture pixels.
  _buildStars() {
    this.starPoints = null;
    fetch('data/stars_mag66.json').then(r => r.json()).then(arr => {
      const n = arr.length;
      const pos = new Float32Array(n * 3);
      const mag = new Float32Array(n);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const [raDeg, decDeg, m, ci] = arr[i];
        const ra = raDeg * DEG, dec = decDeg * DEG;
        // EQJ direction -> ecliptic -> scene
        const eqj = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
        const M = M3.transpose(M_EQJ_FROM_ECL);   // ecl <- eqj
        const e = M3.mulVec(M, eqj);
        pos[i * 3] = e[0]; pos[i * 3 + 1] = e[2]; pos[i * 3 + 2] = -e[1];
        mag[i] = m;
        const c = bvToRGB(ci);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      const pts = new THREE.Points(geo, makeStarPointsMaterial());
      pts.scale.setScalar(3.7e7);
      pts.renderOrder = -80;
      pts.frustumCulled = false;
      this.scene.add(pts);
      this.starPoints = pts;
    }).catch(err => console.warn('star catalog failed to load', err));
  }

  // ---------------- belts ----------------
  _buildBelts() {
    const rng = mulberry(20260704);
    this.belts = [];
    // Main asteroid belt with Kirkwood gaps. Deliberately dim: real
    // asteroids are unresolvable specks — the belt should read as a faint
    // statistical haze, not a highlighted feature.
    this.belts.push(makeBelt(this.scene, rng, 25000, () => {
      let a;
      for (;;) {
        a = 2.15 + rng() * 1.2;
        const gaps = [[2.502, 0.018], [2.825, 0.015], [2.958, 0.012], [3.279, 0.02]];
        let w = 1;
        for (const [g, s] of gaps) w *= 1 - 0.92 * Math.exp(-((a - g) ** 2) / (2 * s * s));
        if (rng() < w) break;
      }
      return { a, e: rayleigh(rng, 0.09, 0.32), i: rayleigh(rng, 6, 28) };
    }, '#6e675e', '#3f3a34', 0.28, 1.1));
    // Jupiter Trojans (L4 + L5 clouds, librating about ±60°)
    const lamJ0 = 34.35, nJ = 0.0830912;   // Jupiter mean longitude J2000 + rate (deg, deg/day)
    this.belts.push(makeBelt(this.scene, rng, 4200, (k) => {
      const lead = k % 2 === 0;
      const a = 5.2028 + gauss(rng) * 0.006;
      const lam = lamJ0 + (lead ? 60 : -60) + gauss(rng) * 13;
      return { a, e: rayleigh(rng, 0.045, 0.15), i: rayleigh(rng, 10, 32), lockLambda: lam, lockRate: nJ };
    }, '#63594f', '#3a332c', 0.26, 1.0));
    // Kuiper belt: plutinos + classical + scattered
    this.belts.push(makeBelt(this.scene, rng, 14000, () => {
      const u = rng();
      if (u < 0.18) return { a: 39.4 + gauss(rng) * 0.25, e: 0.1 + rng() * 0.2, i: rayleigh(rng, 12, 35) };
      if (u < 0.85) return { a: 42 + rng() * 5.5, e: rayleigh(rng, 0.055, 0.24), i: rng() < 0.6 ? rayleigh(rng, 2.2, 8) : rayleigh(rng, 13, 35) };
      const q = 32 + rng() * 8, ap = 48 + rng() * 45;
      return { a: ap, e: 1 - q / ap, i: rayleigh(rng, 15, 40) };
    }, '#5d6570', '#363c44', 0.24, 1.05));
  }

  // ---------------- grids ----------------
  _buildGrids() {
    // Ecliptic plane grid (heliocentric): rings at log-ish radii + spokes
    const g1 = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x2a3a4a, transparent: true, opacity: 0.6 });
    for (const rAU of [0.5, 1, 2, 5, 10, 20, 30, 40, 50]) {
      const pts = [];
      for (let k = 0; k <= 180; k++) {
        const th = k / 180 * 2 * Math.PI;
        pts.push(new THREE.Vector3(Math.cos(th) * rAU * UNITS_PER_AU, 0, Math.sin(th) * rAU * UNITS_PER_AU));
      }
      g1.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    const spokes = [];
    for (let k = 0; k < 12; k++) {
      const th = k / 12 * 2 * Math.PI;
      spokes.push(new THREE.Vector3(Math.cos(th) * 0.5 * UNITS_PER_AU, 0, Math.sin(th) * 0.5 * UNITS_PER_AU));
      spokes.push(new THREE.Vector3(Math.cos(th) * 50 * UNITS_PER_AU, 0, Math.sin(th) * 50 * UNITS_PER_AU));
    }
    g1.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), mat));
    this.gridEclPlane = g1;
    this.scene.add(g1);

    // Sky grids (camera-centered): equatorial (EQJ) and ecliptic
    // grid vertices are in their native frame (pole = +Z); orient into scene:
    // v_scene = S · M_frame→ecl · v_frame,  S = ecl→scene = [[1,0,0],[0,0,1],[0,-1,0]]
    // Sky grids are drawn analytically in a fragment shader (no polylines):
    // perfectly smooth at any zoom, and the angular step subdivides from a
    // ladder as the FOV narrows — Stellarium-style. Frames:
    //   equatorial: scene -> ecl -> EQJ ;  ecliptic: scene -> ecl ;
    //   azimuthal: scene -> local ENU at the observer site (per-frame).
    const mSceneToEcl = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    const mkGridSphere = (color, opacity, frameM3) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), makeSkyGridShaderMaterial(color, opacity));
      if (frameM3) setMatrix3(mesh.material.uniforms.uFrameFromScene.value, frameM3);
      mesh.renderOrder = -49;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    };
    this.gridEqSky = mkGridSphere(0x5fc287, 0.85, M3.mul(M_EQJ_FROM_ECL, mSceneToEcl));
    this.gridEclSky = mkGridSphere(0xc2b25f, 0.6, mSceneToEcl);
    this.gridAzSky = mkGridSphere(0x6f9fdf, 0.9, null);

    // cardinal direction labels for the azimuthal grid
    this.cardinals = [];
    for (const [key, name] of [['C:N', 'N'], ['C:E', 'E'], ['C:S', 'S'], ['C:W', 'W']]) {
      this._addOverlay(key, name, '#7fb3e8', 'cardinal');
      this.cardinals.push({ key, name, worldPos: new THREE.Vector3() });
    }
  }

  // ---------------- orbit lines ----------------
  _buildOrbitLines() {
    this.orbits = {};
    this._orbitQueue = [];
    for (const b of BODIES) {
      if (!b.parent) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POINTS_PER_ORBIT * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(b.color), transparent: true, opacity: 0.45 });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.orbits[b.id] = { line, cachedUt: null, dirty: true };
    }
  }

  // Recompute (budgeted) orbit-line geometry from the actual ephemeris, so
  // lines show true perturbed paths and follow element edits.
  refreshOrbits(eph, ut) {
    for (const b of BODIES) {
      if (!b.parent) continue;
      const o = this.orbits[b.id];
      if (!o.line.visible && !o.dirty) continue;   // don't refresh hidden lines
      const period = currentPeriod(eph, b, ut);
      o.period = period;
      // Keplerian-source loops only change shape via slow node/apsis
      // precession — refresh them rarely; analytic (VSOP/ELP/E5) orbits
      // carry real perturbation wiggles and refresh more often
      const staleFrac = b.ephem.source === 'kepler' ? 0.5 : 0.05;
      if (o.cachedUt === null || Math.abs(ut - o.cachedUt) > period * staleFrac || o.dirty) {
        if (!this._orbitQueue.includes(b.id)) this._orbitQueue.push(b.id);
      }
    }
    // most-stale first, so fast moons don't starve behind slow planets
    this._orbitQueue.sort((a, c) => {
      const oa = this.orbits[a], oc = this.orbits[c];
      const sa = oa.cachedUt === null ? 1e9 : Math.abs(ut - oa.cachedUt) / (oa.period || 1);
      const sc = oc.cachedUt === null ? 1e9 : Math.abs(ut - oc.cachedUt) / (oc.period || 1);
      return sc - sa;
    });
    let budget = 3;
    while (budget-- > 0 && this._orbitQueue.length) {
      const id = this._orbitQueue.shift();
      const b = BODY_BY_ID[id];
      const o = this.orbits[id];
      const period = o.period || 365;
      const pos = o.line.geometry.attributes.position.array;
      // Phase-stable CLOSED-loop sampling: times sit on a fixed absolute
      // grid (multiples of period/RAW) and the spline is closed, so
      //  (a) a refresh never moves an existing point (no popping), and
      //  (b) there is no trailing endpoint that the body can outrun at high
      //      time rates — the old open-ended window left a moving gap in
      //      the ellipse right where the body is.
      const gridStep = period / RAW_ORBIT_SAMPLES;
      const tEnd = Math.ceil(ut / gridStep) * gridStep;
      const raw = [];
      for (let k = 0; k < RAW_ORBIT_SAMPLES; k++) {
        const t = tEnd - period + (k + 1) * gridStep;
        const rel = V.sub(eph.posOfAt(id, t), eph.posOfAt(b.parent, t));
        raw.push(new THREE.Vector3(rel[0] / KM_PER_UNIT, rel[2] / KM_PER_UNIT, -rel[1] / KM_PER_UNIT));
      }
      // closed + uniform parameterization: outputs stay aligned with the
      // grid-stable control points across refreshes, and the loop is
      // seamless (the closure spans exactly one grid step of phase)
      const curve = new THREE.CatmullRomCurve3(raw, true, 'catmullrom');
      const smooth = curve.getPoints(POINTS_PER_ORBIT - 1);
      for (let k = 0; k < POINTS_PER_ORBIT; k++) {
        pos[k * 3] = smooth[k].x; pos[k * 3 + 1] = smooth[k].y; pos[k * 3 + 2] = smooth[k].z;
      }
      o.line.geometry.attributes.position.needsUpdate = true;
      o.line.geometry.computeBoundingSphere?.();
      o.cachedUt = ut;
      o.dirty = false;
    }
  }
  markOrbitDirty(id) { if (this.orbits[id]) this.orbits[id].dirty = true; }

  // ---------------- Lagrange markers ----------------
  _buildLagrange() {
    this.lagrangeGroup = new THREE.Group();
    this.scene.add(this.lagrangeGroup);
    this.lagrangeItems = [];
    for (const [p1, p2] of LAGRANGE_PAIRS) {
      for (let i = 1; i <= 5; i++) {
        const key = `L:${p1}:${p2}:${i}`;
        this._addOverlay(key, `${BODY_BY_ID[p2].name} L${i}`, '#7fd4a8', 'lagrange');
        this.lagrangeItems.push({ key, p1, p2, n: i, pos: new THREE.Vector3() });
      }
    }
  }

  // ---------------- shadow cones ----------------
  _buildShadowCones() {
    this.shadowGroup = new THREE.Group();
    this.scene.add(this.shadowGroup);
    this.umbraMat = new THREE.LineBasicMaterial({ color: 0x884444, transparent: true, opacity: 0.7 });
    this.penumbraMat = new THREE.LineBasicMaterial({ color: 0x665533, transparent: true, opacity: 0.45 });
    this._coneLines = [];
  }

  _coneFor(centerScene, sunScene, radiusUnits, sunRadiusUnits) {
    // returns geometry positions for umbra + penumbra outlines
    const axis = centerScene.clone().sub(sunScene);
    const dSun = axis.length();
    axis.normalize();
    const umbraLen = radiusUnits * dSun / Math.max(1e-9, sunRadiusUnits - radiusUnits);
    return { axis, umbraLen };
  }

  // ---------------- apparent path trace ----------------
  _buildTrace() {
    this.traceGeo = new THREE.BufferGeometry();
    this.traceMax = 12000;                 // recorded samples
    this.traceDrawMax = 30000;             // spline-subdivided render points
    this.traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.traceDrawMax * 3), 3));
    this.traceLine = new THREE.Line(this.traceGeo, new THREE.LineBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9 }));
    this.traceLine.frustumCulled = false;
    this.traceDirs = [];
    this.scene.add(this.traceLine);
  }
  pushTraceSample(dirScene) {
    if (this.traceDirs.length >= this.traceMax) this.traceDirs.shift();
    this.traceDirs.push(dirScene.clone());
  }
  clearTrace() { this.traceDirs = []; }
  setTraceColor(cssColor) { this.traceLine.material.color.set(cssColor); }

  // =====================================================================
  // per-frame update
  // =====================================================================
  update(snap, view, opts, selection, eph) {
    const { focusKm, camera, sizeScale } = view;
    const camPos = camera.position;

    // -- body positions/orientations/scales --
    const scenePos = {};
    for (const b of BODIES) {
      scenePos[b.id] = sceneFromEclKm(snap.pos.get(b.id), focusKm);
    }
    const sunScene = scenePos.sun;
    // one uniform factor for every body (Sun included) so relative
    // proportions are always preserved — Jupiter can never outgrow the Sun
    const sunRadiusUnits = BODY_BY_ID.sun.radiusKm / KM_PER_UNIT * sizeScale;

    for (const b of BODIES) {
      const e = this.entries[b.id];
      e.group.position.copy(scenePos[b.id]);
      const m = snap.orient.get(b.id);
      // local X = prime meridian(bx), local Y = north(bz), local Z = -by
      const bx = sceneFromEcl([m[0][0], m[1][0], m[2][0]]);
      const by = sceneFromEcl([m[0][1], m[1][1], m[2][1]]);
      const bz = sceneFromEcl([m[0][2], m[1][2], m[2][2]]);
      const m4 = new THREE.Matrix4().makeBasis(bx, bz, by.multiplyScalar(-1));
      e.mesh.quaternion.setFromRotationMatrix(m4);

      const k = sizeScale;
      const re = (b.equatorialRadiusKm || b.radiusKm) / KM_PER_UNIT * k;
      const rp = re * (1 - (b.flattening || 0));
      e.mesh.scale.set(re, rp, re);
      e.displayedRadius = re;

      // hide the body the camera sits inside (center / "view from" mode)
      const isCenterBody = view.centerBodyId === b.id;
      e.mesh.visible = !isCenterBody;

      if (e.atmo) {
        e.atmo.visible = !!opts.atmos && !isCenterBody;
        e.atmo.quaternion.copy(e.mesh.quaternion);
        e.atmo.scale.set(re * 1.017, rp * 1.017, re * 1.017);
        e.atmo.material.uniforms.uSunPos.value.copy(sunScene);
      }
      if (e.ringMesh) {
        e.ringMesh.visible = !!opts.rings;
        e.ringMesh.quaternion.copy(e.mesh.quaternion);
        const ri = b.ring.innerKm / KM_PER_UNIT * k, ro = b.ring.outerKm / KM_PER_UNIT * k;
        e.ringMesh.scale.set(ro, ro, ro);
        e.ringMesh.userData.inner = ri; e.ringMesh.userData.outer = ro;
        updateRingGeometryRatio(e.ringMesh, ri / ro);
      }
      if (b.type === 'star') {
        const glow = e.group.getObjectByName('glow');
        if (glow) {
          const d = camPos.distanceTo(scenePos[b.id]);
          glow.scale.setScalar(Math.max(re * 9, d * 0.05));
          // fade the glow when the camera is close enough to be inside the
          // sprite, so it doesn't wash the whole sky beige
          glow.material.opacity = 0.85 * Math.min(1, Math.max(0, (d / re - 1.5) / 8));
        }
      }
    }

    // -- material lighting uniforms --
    for (const b of BODIES) {
      const e = this.entries[b.id];
      if (b.type === 'star') continue;
      const u = e.mat.uniforms;
      u.uSunPos.value.copy(sunScene);
      u.uSunRadius.value = sunRadiusUnits;
      u.uEclipseOn.value = opts.eclipseShading ? 1 : 0;
      const occ = OCCLUDERS[b.id] || [];
      let n = 0;
      for (const oid of occ) {
        if (n >= MAX_OCCLUDERS) break;
        const oe = this.entries[oid];
        u.uOccluders.value[n].set(scenePos[oid].x, scenePos[oid].y, scenePos[oid].z, oe.displayedRadius);
        n++;
      }
      u.uOccCount.value = n;
      u.uTwilight.value = b.atmosphere ? 0.09 : 0.018;
      // ring shadow (planet with rings)
      if (e.ringMesh && opts.rings) {
        u.uRingOn.value = 1;
        u.uRingCenter.value.copy(scenePos[b.id]);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(e.mesh.quaternion);
        u.uRingNormal.value.copy(up);
        u.uRingInner.value = e.ringMesh.userData.inner;
        u.uRingOuter.value = e.ringMesh.userData.outer;
        u.tRingAlpha.value = e.ringMesh.userData.ringTex;
      } else if (u.uRingOn) u.uRingOn.value = 0;
      // ring material sun/occluders
      if (e.ringMesh) {
        const ru = e.ringMesh.material.uniforms;
        ru.uSunPos.value.copy(sunScene);
        ru.uSunRadius.value = sunRadiusUnits;
        ru.uEclipseOn.value = 1;
        ru.uOccluders.value[0].set(scenePos[b.id].x, scenePos[b.id].y, scenePos[b.id].z, e.displayedRadius);
        ru.uOccCount.value = 1;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(e.mesh.quaternion);
        ru.uNormal.value.copy(up);
      }
    }

    // -- orbit lines --
    const showOrb = t => (t === 'planet' && opts.orbitsPlanets) || (t === 'moon' && opts.orbitsMoons) || (t === 'dwarf' && opts.orbitsDwarfs);
    for (const b of BODIES) {
      if (!b.parent) continue;
      const o = this.orbits[b.id];
      // viewing from inside a body: its own orbit line passes through the
      // camera and streaks across the sky — hide it (moons' orbits stay:
      // they read as rings around the observer, which is informative)
      const hide = view.centerBodyId && b.id === view.centerBodyId;
      o.line.visible = showOrb(b.type) && !hide;
      if (o.line.visible) o.line.position.copy(scenePos[b.parent]);
    }
    if (eph) this.refreshOrbits(eph, snap.ut);

    // -- belts --
    for (const belt of this.belts) {
      belt.points.visible = !!opts.belts;
      belt.mat.uniforms.uT.value = snap.ut;
      belt.mat.uniforms.uFocus.value.set(focusKm[0] / KM_PER_UNIT, focusKm[2] / KM_PER_UNIT, -focusKm[1] / KM_PER_UNIT);
    }

    // -- sky + grids --
    // photo sky map fades as FOV narrows (its pixels would show); the
    // catalog star points stay sharp and carry the deep-zoom sky
    const fovNow = camera.fov;
    const texFade = Math.min(1, Math.max(0.04, (fovNow - 0.8) / 10));
    this.sky.position.copy(camPos);
    this.skyMat.uniforms.uBrightness.value = opts.skyBrightness * texFade;
    this.sky.visible = opts.skyBrightness > 0.01;
    if (this.starPoints) {
      this.starPoints.position.copy(camPos);
      this.starPoints.visible = opts.skyBrightness > 0.01;
      const u = this.starPoints.material.uniforms;
      u.uBrightness.value = Math.min(1.5, opts.skyBrightness);
      u.uZoomBoost.value = Math.min(12, Math.max(1, Math.pow(50 / fovNow, 0.42)));
    }
    this.gridEclPlane.visible = !!opts.gridEclPlane;
    this.gridEclPlane.position.copy(sunScene);
    // adaptive grid step: pick from a ladder so ~4-10 lines cross the view;
    // the shader draws minor + (5x brighter) major + fundamental circle
    const LADDER = [30, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];
    let li = LADDER.findIndex(s => fovNow / s >= 3.2);
    if (li < 0) li = LADDER.length - 1;
    const stepMinor = LADDER[li] * DEG;
    const stepMajor = LADDER[Math.max(0, li - 1)] * DEG;
    const setGrid = (mesh, on, scale) => {
      mesh.visible = !!on;
      if (!mesh.visible) return;
      mesh.position.copy(camPos);
      mesh.scale.setScalar(scale);
      mesh.material.uniforms.uStepMinor.value = stepMinor;
      mesh.material.uniforms.uStepMajor.value = stepMajor;
    };
    setGrid(this.gridEqSky, opts.gridEqSky, 3.4e7);
    setGrid(this.gridEclSky, opts.gridEclSky, 3.3e7);

    // azimuthal grid: local ENU frame at the observer site on the viewed
    // body (from-body mode only — a horizon needs a place to stand)
    const azOn = !!opts.gridAzSky && !!view.centerBodyId;
    setGrid(this.gridAzSky, azOn, 3.2e7);
    if (azOn) {
      const m = snap.orient.get(view.centerBodyId);
      const site = view.site || { latDeg: 0, lonDeg: 0 };
      const lat = site.latDeg * DEG, lon = site.lonDeg * DEG;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const bx = sceneFromEcl([m[0][0], m[1][0], m[2][0]]);
      const by = sceneFromEcl([m[0][1], m[1][1], m[2][1]]);
      const bz = sceneFromEcl([m[0][2], m[1][2], m[2][2]]);
      const up = bx.clone().multiplyScalar(cl * Math.cos(lon)).add(by.clone().multiplyScalar(cl * Math.sin(lon))).add(bz.clone().multiplyScalar(sl)).normalize();
      const north = bx.clone().multiplyScalar(-sl * Math.cos(lon)).add(by.clone().multiplyScalar(-sl * Math.sin(lon))).add(bz.clone().multiplyScalar(cl)).normalize();
      const east = north.clone().cross(up);
      // rows: x=north, y=east, z=up  →  lat=altitude, lon=azimuth (N→E)
      this.gridAzSky.material.uniforms.uFrameFromScene.value.set(
        north.x, north.y, north.z, east.x, east.y, east.z, up.x, up.y, up.z);
      const R = 3.1e7;
      this.cardinals[0].worldPos.copy(camPos).addScaledVector(north, R);
      this.cardinals[1].worldPos.copy(camPos).addScaledVector(east, R);
      this.cardinals[2].worldPos.copy(camPos).addScaledVector(north, -R);
      this.cardinals[3].worldPos.copy(camPos).addScaledVector(east, -R);
    }
    for (const c of this.cardinals) {
      const ov = this.overlayItems.get(c.key);
      ov.want = azOn;
      ov.worldPos = c.worldPos;
    }

    // -- Lagrange points --
    const showLag = !!opts.lagrange;
    for (const it of this.lagrangeItems) {
      const ov = this.overlayItems.get(it.key);
      if (!showLag) { ov.want = false; continue; }
      const p1 = snap.pos.get(it.p1), p2 = snap.pos.get(it.p2);
      const pos = lagrangePoint(it.p1, it.p2, p1, p2, it.n, eph, snap.ut);
      it.pos = sceneFromEclKm(pos, focusKm);
      ov.want = true;
      ov.worldPos = it.pos;
    }

    // -- shadow cones --
    for (const l of this._coneLines) this.shadowGroup.remove(l);
    this._coneLines = [];
    if (opts.shadowCones) {
      const targets = new Set(['earth', 'moon']);
      if (selection && selection !== 'sun') targets.add(selection);
      for (const id of targets) {
        const e = this.entries[id];
        if (!e || e.body.type === 'star') continue;
        this._drawCones(scenePos[id], sunScene, e.displayedRadius, sunRadiusUnits);
      }
    }

    // -- trace: render through a spherical Catmull-Rom spline so the path
    // is a smooth curve, not visible chords (subdivision adapts to budget)
    const nT = this.traceDirs.length;
    if (nT > 1) {
      const arr = this.traceGeo.attributes.position.array;
      const R = 2.0e7;
      // subdivide so each drawn chord is ~4px at the CURRENT zoom (capped
      // by the buffer): the curve reads as a curve at any magnification
      const sampleAng = this.traceSampleAng || 0.001;
      const pxPerSample = (sampleAng / (camera.fov * DEG)) * (this.overlayEl.clientHeight || 800);
      const subNeed = Math.max(2, Math.ceil(pxPerSample / 4));
      const sub = Math.max(1, Math.min(subNeed, 48, Math.floor((this.traceDrawMax - 2) / Math.max(1, nT - 1))));
      const D = this.traceDirs;
      let w = 0;
      const put = v => {
        const l = R / Math.hypot(v.x, v.y, v.z);
        arr[w * 3] = v.x * l + camPos.x; arr[w * 3 + 1] = v.y * l + camPos.y; arr[w * 3 + 2] = v.z * l + camPos.z;
        w++;
      };
      const tmp = this._tmpV;
      for (let i = 0; i < nT - 1; i++) {
        const p0 = D[Math.max(0, i - 1)], p1 = D[i], p2 = D[i + 1], p3 = D[Math.min(nT - 1, i + 2)];
        for (let s = 0; s < sub; s++) {
          const t = s / sub, t2 = t * t, t3 = t2 * t;
          tmp.set(
            0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
            0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3));
          put(tmp);
        }
      }
      put(tmp.copy(D[nT - 1]));
      this.traceGeo.setDrawRange(0, w);
      this.traceGeo.attributes.position.needsUpdate = true;
      this.traceLine.visible = true;
    } else this.traceLine.visible = false;

    // -- overlay (labels/markers) --
    this._updateOverlay(scenePos, camera, opts, selection);
    this._scenePos = scenePos;
  }

  _drawCones(center, sunScene, radius, sunRadius) {
    const axis = center.clone().sub(sunScene);
    const dSun = axis.length();
    axis.normalize();
    const uLen = radius * dSun / Math.max(1e-9, sunRadius - radius);
    // basis perpendicular to axis
    const b1 = new THREE.Vector3(0, 1, 0).cross(axis).normalize();
    if (b1.lengthSq() < 0.1) b1.set(1, 0, 0).cross(axis).normalize();
    const b2 = axis.clone().cross(b1);
    const mkCone = (len, r0, r1, mat) => {
      const pts = [];
      const N = 24;
      for (let k = 0; k < N; k++) {
        const th = k / N * 2 * Math.PI;
        const dir = b1.clone().multiplyScalar(Math.cos(th)).add(b2.clone().multiplyScalar(Math.sin(th)));
        pts.push(center.clone().add(dir.clone().multiplyScalar(r0)));
        pts.push(center.clone().add(axis.clone().multiplyScalar(len)).add(dir.multiplyScalar(r1)));
      }
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.frustumCulled = false;
      this.shadowGroup.add(line);
      this._coneLines.push(line);
    };
    mkCone(uLen, radius, 0, this.umbraMat);                                   // umbra
    const pLen = Math.min(uLen * 2.5, uLen + radius * 900);
    const pR = radius + (sunRadius + radius) * (pLen / dSun);
    mkCone(pLen, radius, pR, this.penumbraMat);                               // penumbra
  }

  _updateOverlay(scenePos, camera, opts, selection) {
    // refresh camera matrices NOW: three.js only updates them inside
    // render(), so projecting with stale matrices makes every HTML marker
    // lag the WebGL scene by one frame — very visible during fast camera
    // moves, and it made bodies appear to sit off their orbit lines
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const w = this.overlayEl.clientWidth, h = this.overlayEl.clientHeight;
    const proj = this._tmpV;
    const parentScreen = {};
    const place = (key, world, show, isSel) => {
      const ov = this.overlayItems.get(key);
      if (!ov) return null;
      if (!show) { if (ov.visible) { ov.el.style.display = 'none'; ov.visible = false; } return null; }
      proj.copy(world).project(camera);
      const behind = proj.z > 1 || proj.z < -1;
      const x = (proj.x * 0.5 + 0.5) * w, y = (-proj.y * 0.5 + 0.5) * h;
      if (behind || x < -40 || x > w + 40 || y < -20 || y > h + 20) {
        if (ov.visible) { ov.el.style.display = 'none'; ov.visible = false; }
        return null;
      }
      ov.el.style.display = 'block';
      ov.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      ov.el.classList.toggle('sel', !!isSel);
      ov.el.classList.toggle('nametag', !!opts.labels);
      // labels and markers are independent: dots only when markers is on
      ov.el.classList.toggle('nodot', ov.kind === 'body' && !opts.markers);
      ov.visible = true;
      return [x, y];
    };

    for (const b of BODIES) {
      const e = this.entries[b.id];
      let show = opts.labels || opts.markers;
      if (show && b.type === 'moon' && b.id !== selection) {
        // declutter: hide moon labels when visually glued to parent
        const pp = parentScreen[b.parent];
        if (pp) {
          proj.copy(scenePos[b.id]).project(camera);
          const x = (proj.x * 0.5 + 0.5) * w, y = (-proj.y * 0.5 + 0.5) * h;
          const dx = x - pp[0], dy = y - pp[1];
          if (dx * dx + dy * dy < 26 * 26) show = false;
        }
      }
      // hide label when the body fills a good part of the view (either by
      // proximity or by telescope magnification)
      const dist = camera.position.distanceTo(scenePos[b.id]);
      const angFrac = 2 * Math.atan2(e.displayedRadius, Math.max(dist, 1e-12)) / (camera.fov * DEG);
      if (dist < e.displayedRadius * 4 || angFrac > 0.35) show = opts.labels && b.id === selection && angFrac <= 0.35 ? show : false;
      const sp = place(b.id, scenePos[b.id], show, b.id === selection);
      if (sp && (b.type === 'planet' || b.type === 'star' || b.type === 'dwarf')) parentScreen[b.id] = sp;
    }
    for (const it of this.lagrangeItems) {
      const ov = this.overlayItems.get(it.key);
      place(it.key, ov.worldPos || new THREE.Vector3(), !!ov.want, false);
    }
    for (const c of this.cardinals) {
      const ov = this.overlayItems.get(c.key);
      place(c.key, ov.worldPos || new THREE.Vector3(), !!ov.want, false);
    }
  }
}

// ============================ helpers =============================

const RAW_ORBIT_SAMPLES = 300;
// closed loop: RAW segments, exactly 4 spline outputs per segment (+1 wrap
// point) so output vertices coincide with control points and stay identical
// across grid-shifted refreshes
const POINTS_PER_ORBIT = RAW_ORBIT_SAMPLES * 4 + 1;

function currentPeriod(eph, b, ut) {
  const ov = eph.overrides.get(b.id);
  if (ov) return ov.display.periodD;
  return b.orbitPeriodD || 365.25;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rayleigh = (rng, sigma, max) => Math.min(max, sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, 1 - rng()))));
function gauss(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
}

function makeBelt(scene, rng, count, sampler, colorA, colorB, opacity, size) {
  const el1 = new Float32Array(count * 4);
  const el2 = new Float32Array(count * 4);
  const GM_SUN_AU = 2.9591220828559093e-4;  // AU^3/day^2 (Gaussian)
  for (let k = 0; k < count; k++) {
    const s = sampler(k);
    const n = Math.sqrt(GM_SUN_AU / (s.a * s.a * s.a));   // rad/day
    const node = rng() * 2 * Math.PI;
    const peri = rng() * 2 * Math.PI;
    let M0;
    if (s.lockLambda !== undefined) {
      M0 = (s.lockLambda * DEG) - node - peri;   // mean longitude locked (Trojans)
    } else {
      M0 = rng() * 2 * Math.PI;
    }
    el1[k * 4] = s.a; el1[k * 4 + 1] = s.e; el1[k * 4 + 2] = s.i * DEG; el1[k * 4 + 3] = node;
    el2[k * 4] = peri; el2[k * 4 + 1] = M0; el2[k * 4 + 2] = n; el2[k * 4 + 3] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3)); // unused but required
  geo.setAttribute('aElems1', new THREE.BufferAttribute(el1, 4));
  geo.setAttribute('aElems2', new THREE.BufferAttribute(el2, 4));
  const mat = makeBeltMaterial(colorA, colorB, opacity, size);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  return { points, mat };
}

function makeRingGeometry(segments = 160) {
  // annulus in the XZ plane, u = radial (0 inner .. 1 outer), unit outer radius;
  // actual inner/outer ratio applied via updateRingGeometryRatio
  const geo = new THREE.BufferGeometry();
  const pos = [], uv = [], idx = [];
  for (let k = 0; k <= segments; k++) {
    const th = k / segments * 2 * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    pos.push(c * 0.5, 0, s * 0.5, c, 0, s);
    uv.push(0, 0.5, 1, 0.5);
  }
  for (let k = 0; k < segments; k++) {
    const a = k * 2, b = k * 2 + 1, c = k * 2 + 2, d = k * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.userData.ratio = 0.5;
  geo.userData.segments = segments;
  return geo;
}

function updateRingGeometryRatio(mesh, ratio) {
  const geo = mesh.geometry;
  if (Math.abs((geo.userData.ratio || 0) - ratio) < 1e-6) return;
  const segments = geo.userData.segments;
  const pos = geo.attributes.position.array;
  for (let k = 0; k <= segments; k++) {
    const th = k / segments * 2 * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    pos[k * 6] = c * ratio; pos[k * 6 + 2] = s * ratio;
  }
  geo.attributes.position.needsUpdate = true;
  geo.userData.ratio = ratio;
}

function setMatrix3(target, m) {
  target.set(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]);
}

// approximate B-V color index -> linear RGB (star colors)
const BV_STOPS = [
  [-0.33, 0.61, 0.70, 1.00], [0.0, 0.79, 0.84, 1.00], [0.3, 1.00, 0.96, 0.92],
  [0.58, 1.00, 0.90, 0.81], [0.81, 1.00, 0.85, 0.70], [1.4, 1.00, 0.78, 0.56], [2.0, 1.00, 0.65, 0.32],
];
function bvToRGB(bv) {
  const x = Math.max(-0.33, Math.min(2.0, bv));
  for (let i = 0; i < BV_STOPS.length - 1; i++) {
    const a = BV_STOPS[i], b = BV_STOPS[i + 1];
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return [1, 0.65, 0.32];
}

// CR3BP collinear + triangular Lagrange points from actual instantaneous
// geometry (positions in km, ecliptic frame).
function lagrangePoint(id1, id2, p1, p2, n, eph, ut) {
  const mu1 = GM[id1] ?? GM.sun, mu2 = GM[id2] ?? GM.sun;
  const mu = mu2 / (mu1 + mu2);
  const r = V.sub(p2, p1);
  const d = V.len(r);
  const u = V.scale(r, 1 / d);
  const bary = V.add(p1, V.scale(r, mu));
  if (n === 4 || n === 5) {
    // equilateral: rotate r about the orbit normal by ±60°
    const v = eph.relVelKmS(id2, ut);
    let h = V.cross(r, v);
    if (V.len(h) < 1e-12) h = [0, 0, 1];
    h = V.norm(h);
    const ang = (n === 4 ? 60 : -60) * DEG;   // L4 leads
    const c = Math.cos(ang), s = Math.sin(ang);
    const rot = V.add(V.add(V.scale(r, c), V.scale(V.cross(h, r), s)), V.scale(h, V.dot(h, r) * (1 - c)));
    return V.add(p1, rot);
  }
  // collinear: Newton on f(x) = x - (1-mu)(x+mu)/|x+mu|^3 - mu(x-1+mu)/|x-1+mu|^3
  const g = Math.cbrt(mu / 3);
  let x = n === 1 ? 1 - mu - g : n === 2 ? 1 - mu + g : -(1 + 5 * mu / 12);
  for (let it = 0; it < 25; it++) {
    const A = x + mu, B = x - 1 + mu;
    const f = x - (1 - mu) * A / Math.pow(Math.abs(A), 3) - mu * B / Math.pow(Math.abs(B), 3);
    const fp = 1 + 2 * (1 - mu) / Math.pow(Math.abs(A), 3) + 2 * mu / Math.pow(Math.abs(B), 3);
    const dx = f / fp;
    x -= dx;
    if (Math.abs(dx) < 1e-12) break;
  }
  // CR3BP frame: barycenter at origin, separation 1 → world = bary + u·d·x
  return V.add(bary, V.scale(u, x * d));
}
