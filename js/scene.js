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
import { makePlanetMaterial, makeSunMaterial, makeRingMaterial, makeAtmosphereMaterial, makeBeltMaterial, makeSkyMaterial, MAX_OCCLUDERS } from './shaders.js';

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
    this.sphereGeo = new THREE.SphereGeometry(1, 72, 36);
    this._buildBodies();
    this._buildSky();
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
    const tex = fileTexture('textures/starmap_4k.jpg');
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

  // ---------------- belts ----------------
  _buildBelts() {
    const rng = mulberry(20260704);
    this.belts = [];
    // Main asteroid belt with Kirkwood gaps
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
    }, '#8a7f72', '#5f574d', 0.85, 1.6));
    // Jupiter Trojans (L4 + L5 clouds, librating about ±60°)
    const lamJ0 = 34.35, nJ = 0.0830912;   // Jupiter mean longitude J2000 + rate (deg, deg/day)
    this.belts.push(makeBelt(this.scene, rng, 4200, (k) => {
      const lead = k % 2 === 0;
      const a = 5.2028 + gauss(rng) * 0.006;
      const lam = lamJ0 + (lead ? 60 : -60) + gauss(rng) * 13;
      return { a, e: rayleigh(rng, 0.045, 0.15), i: rayleigh(rng, 10, 32), lockLambda: lam, lockRate: nJ };
    }, '#7a6f66', '#55493f', 0.8, 1.4));
    // Kuiper belt: plutinos + classical + scattered
    this.belts.push(makeBelt(this.scene, rng, 14000, () => {
      const u = rng();
      if (u < 0.18) return { a: 39.4 + gauss(rng) * 0.25, e: 0.1 + rng() * 0.2, i: rayleigh(rng, 12, 35) };
      if (u < 0.85) return { a: 42 + rng() * 5.5, e: rayleigh(rng, 0.055, 0.24), i: rng() < 0.6 ? rayleigh(rng, 2.2, 8) : rayleigh(rng, 13, 35) };
      const q = 32 + rng() * 8, ap = 48 + rng() * 45;
      return { a: ap, e: 1 - q / ap, i: rayleigh(rng, 15, 40) };
    }, '#7d8794', '#4d5560', 0.75, 1.5));
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
    const S = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
    this.gridEqSky = makeSkyGrid(0x3a5a3a, 0.5);
    const M_ECL_FROM_EQJ = M3.transpose(M_EQJ_FROM_ECL);
    this.gridEqSky.quaternion.setFromRotationMatrix(m3ToMatrix4(M3.mul(S, M_ECL_FROM_EQJ)));
    this.scene.add(this.gridEqSky);
    this.gridEclSky = makeSkyGrid(0x4a4a2a, 0.45);
    this.gridEclSky.quaternion.setFromRotationMatrix(m3ToMatrix4(S));
    this.scene.add(this.gridEclSky);
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
      const period = currentPeriod(eph, b, ut);
      o.period = period;
      if (o.cachedUt === null || Math.abs(ut - o.cachedUt) > period * 0.02 || o.dirty) {
        if (!this._orbitQueue.includes(b.id)) this._orbitQueue.push(b.id);
      }
    }
    let budget = 3;
    while (budget-- > 0 && this._orbitQueue.length) {
      const id = this._orbitQueue.shift();
      const b = BODY_BY_ID[id];
      const o = this.orbits[id];
      const period = o.period || 365;
      const pos = o.line.geometry.attributes.position.array;
      for (let k = 0; k < POINTS_PER_ORBIT; k++) {
        const t = ut - period + (k / (POINTS_PER_ORBIT - 1)) * period;
        const rel = V.sub(eph.posOfAt(id, t), eph.posOfAt(b.parent, t));
        pos[k * 3] = rel[0] / KM_PER_UNIT;
        pos[k * 3 + 1] = rel[2] / KM_PER_UNIT;
        pos[k * 3 + 2] = -rel[1] / KM_PER_UNIT;
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
    this.traceMax = 4000;
    this.traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.traceMax * 3), 3));
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
    const sunRadiusUnits = BODY_BY_ID.sun.radiusKm / KM_PER_UNIT * (opts.scaleSunToo ? sizeScale : Math.min(sizeScale, 50));

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

      const k = (b.type === 'star' && !opts.scaleSunToo) ? Math.min(sizeScale, 50) : sizeScale;
      const re = (b.equatorialRadiusKm || b.radiusKm) / KM_PER_UNIT * k;
      const rp = re * (1 - (b.flattening || 0));
      e.mesh.scale.set(re, rp, re);
      e.displayedRadius = re;

      if (e.atmo) {
        e.atmo.visible = !!opts.atmos;
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
      o.line.visible = showOrb(b.type);
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
    this.sky.position.copy(camPos);
    this.skyMat.uniforms.uBrightness.value = opts.skyBrightness;
    this.sky.visible = opts.skyBrightness > 0.01;
    this.gridEclPlane.visible = !!opts.gridEclPlane;
    this.gridEclPlane.position.copy(sunScene);
    this.gridEqSky.visible = !!opts.gridEqSky;
    this.gridEqSky.position.copy(camPos);
    this.gridEqSky.scale.setScalar(3.6e7);
    this.gridEclSky.visible = !!opts.gridEclSky;
    this.gridEclSky.position.copy(camPos);
    this.gridEclSky.scale.setScalar(3.5e7);

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

    // -- trace --
    if (this.traceDirs.length > 1) {
      const arr = this.traceGeo.attributes.position.array;
      const R = 2.0e7;
      for (let i = 0; i < this.traceDirs.length; i++) {
        const p = this._tmpV.copy(this.traceDirs[i]).multiplyScalar(R).add(camPos);
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      this.traceGeo.setDrawRange(0, this.traceDirs.length);
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
      // hide label when body fills a good part of the screen
      const dist = camera.position.distanceTo(scenePos[b.id]);
      if (dist < e.displayedRadius * 4) show = opts.labels && b.id === selection ? show : false;
      const sp = place(b.id, scenePos[b.id], show, b.id === selection);
      if (sp && (b.type === 'planet' || b.type === 'star' || b.type === 'dwarf')) parentScreen[b.id] = sp;
    }
    for (const it of this.lagrangeItems) {
      const ov = this.overlayItems.get(it.key);
      place(it.key, ov.worldPos || new THREE.Vector3(), !!ov.want, false);
    }
  }
}

// ============================ helpers =============================

const POINTS_PER_ORBIT = 360;

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

function makeSkyGrid(color, opacity) {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  // grid built in a frame where +Z is the pole; caller orients via quaternion
  for (let decDeg = -60; decDeg <= 60; decDeg += 30) {
    const pts = [];
    const cd = Math.cos(decDeg * DEG), sd = Math.sin(decDeg * DEG);
    for (let k = 0; k <= 120; k++) {
      const ra = k / 120 * 2 * Math.PI;
      pts.push(new THREE.Vector3(cd * Math.cos(ra), cd * Math.sin(ra), sd));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  for (let raDeg = 0; raDeg < 360; raDeg += 30) {
    const pts = [];
    for (let k = 0; k <= 60; k++) {
      const dec = (-80 + k / 60 * 160) * DEG;
      pts.push(new THREE.Vector3(Math.cos(dec) * Math.cos(raDeg * DEG), Math.cos(dec) * Math.sin(raDeg * DEG), Math.sin(dec)));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  group.renderOrder = -50;
  return group;
}

function m3ToMatrix4(m) {
  return new THREE.Matrix4().set(
    m[0][0], m[0][1], m[0][2], 0,
    m[1][0], m[1][1], m[1][2], 0,
    m[2][0], m[2][1], m[2][2], 0,
    0, 0, 0, 1);
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
