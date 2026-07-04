// Ephemeris provider.
//
// Sources of truth:
//  * astronomy-engine (vendored, MIT): VSOP87-truncation planets, ELP2000-
//    class Moon, TOP2013-derived Pluto (system barycenter), Lieske E5
//    Galilean moons, IAU WGCCRE rotation axes. Analytic, deterministic,
//    exactly time-reversible.
//  * Precessing Keplerian propagation (kepler.js) for outer-planet moons,
//    Charon and the dwarf planets, in the parent's IAU equator frame or the
//    J2000 ecliptic. Nodal/apsidal precession from the parent's J2.
//
// All public positions are heliocentric J2000-ecliptic km ([x,y,z] arrays).
// Orientations are 3x3 matrices whose columns are the body-fixed x (prime
// meridian), y, z (north pole) axes expressed in the ecliptic frame.
//
// Editing: any body can be switched to a user-defined Keplerian orbit
// (relative to its parent, ecliptic frame). The editor baseline is the
// osculating element set computed from the body's actual state vector, so
// an untouched edit reproduces the current orbit and "reset" returns to the
// exact analytic ephemeris.

import * as A from '../vendor/astronomy.esm.js';
import { KM_PER_AU, C_KM_S, DEG, GM, J2 } from './const.js';
import { V, M3, elementsToStateVector, bakeElements, j2Rates, solveKepler, planetElementsAt } from './kepler.js';
import { BODIES, BODY_BY_ID, PLANET_MEAN_ELEMENTS } from './catalog.js';

export { A as Astronomy };

const LIGHT_DAY_KM = C_KM_S * 86400;

// ---- fixed frame matrices ------------------------------------------------
function rotToM3(rot) {
  // astronomy-engine RotationMatrix → our column-basis M3 via basis vectors.
  const e1 = A.RotateVector(rot, new A.Vector(1, 0, 0, A.MakeTime(0)));
  const e2 = A.RotateVector(rot, new A.Vector(0, 1, 0, A.MakeTime(0)));
  const e3 = A.RotateVector(rot, new A.Vector(0, 0, 1, A.MakeTime(0)));
  return M3.fromColumns([e1.x, e1.y, e1.z], [e2.x, e2.y, e2.z], [e3.x, e3.y, e3.z]);
}
export const M_ECL_FROM_EQJ = rotToM3(A.Rotation_EQJ_ECL());
export const M_EQJ_FROM_ECL = M3.transpose(M_ECL_FROM_EQJ);

export function eqjToEcl(v) { return M3.mulVec(M_ECL_FROM_EQJ, v); }
export function eclToEqj(v) { return M3.mulVec(M_EQJ_FROM_ECL, v); }

function rodrigues(v, axis, angleRad) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  const k = axis;
  const kxv = V.cross(k, v);
  const kdv = V.dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

// ---- element preparation --------------------------------------------------
const bakedEls = new Map();      // id -> baked catalog elements (with J2 rates)
for (const b of BODIES) {
  if (b.ephem.source !== 'kepler') continue;
  const el = { ...b.ephem.el };
  const isMoon = el.frame === 'parentEq';
  const baked = bakeElements(el, 2451545.0);
  if (el.j2Precess && isMoon) {
    const jj = J2[b.parent];
    if (jj) {
      const r = j2Rates(baked.nRadPerDay, jj.j2, jj.refR, baked.a, baked.e, baked.iRad);
      baked.nodeRateRadPerDay = r.nodeRate;
      baked.apsRateRadPerDay = r.apsRate;
    }
  }
  bakedEls.set(b.id, baked);
}

const CHARON_Q = GM.charon / GM.pluto;   // mass ratio for barycenter split

export class Ephemeris {
  constructor() {
    this.overrides = new Map();   // id -> { baked, display }
    this._snapCache = { key: NaN, snap: null };
  }

  // ---- overrides (editable parameters) ----
  hasOverride(id) { return this.overrides.has(id); }

  // display: { aKm, e, iDeg, nodeDeg, periDeg, M0Deg, periodD, epochJD }
  setOverride(id, display) {
    const parent = BODY_BY_ID[id].parent;
    const mu = GM[parent] ?? GM.sun;
    const periodD = 2 * Math.PI * Math.sqrt(Math.pow(display.aKm, 3) / mu) / 86400;
    const full = { ...display, periodD };
    const baked = bakeElements({
      aKm: full.aKm, e: full.e, iDeg: full.iDeg, nodeDeg: full.nodeDeg,
      periDeg: full.periDeg, M0Deg: full.M0Deg, periodD, epochJD: full.epochJD,
    }, full.epochJD);
    this.overrides.set(id, { baked, display: full });
    this._snapCache.key = NaN;
  }
  clearOverride(id) { this.overrides.delete(id); this._snapCache.key = NaN; }
  clearAllOverrides() { this.overrides.clear(); this._snapCache.key = NaN; }

  // Osculating elements of `id` about its parent, ecliptic frame, from the
  // actual current state vector. Baseline for the element editor.
  osculatingElements(id, ut) {
    const body = BODY_BY_ID[id];
    if (!body.parent) return null;
    const mu = GM[body.parent] ?? GM.sun;
    const r = V.sub(this.posOfAt(id, ut), this.posOfAt(body.parent, ut));
    const v = this.relVelKmS(id, ut);
    const rl = V.len(r), vl = V.len(v);
    const h = V.cross(r, v);
    const hl = V.len(h);
    const evec = V.sub(V.scale(V.cross(v, h), 1 / mu), V.scale(r, 1 / rl));
    const e = V.len(evec);
    const a = 1 / (2 / rl - vl * vl / mu);
    const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hl)));
    const n = V.cross([0, 0, 1], h);
    const nl = V.len(n);
    let node = nl > 1e-10 ? Math.atan2(n[1], n[0]) : 0;
    let peri;
    if (nl > 1e-10 && e > 1e-9) {
      peri = Math.acos(Math.max(-1, Math.min(1, V.dot(n, evec) / (nl * e))));
      if (evec[2] < 0) peri = 2 * Math.PI - peri;
    } else peri = e > 1e-9 ? Math.atan2(evec[1], evec[0]) : 0;
    let nu;
    if (e > 1e-9) {
      nu = Math.acos(Math.max(-1, Math.min(1, V.dot(evec, r) / (e * rl))));
      if (V.dot(r, v) < 0) nu = 2 * Math.PI - nu;
    } else {
      const ref = nl > 1e-10 ? V.scale(n, 1 / nl) : [1, 0, 0];
      nu = Math.acos(Math.max(-1, Math.min(1, V.dot(ref, r) / rl)));
      if (r[2] < 0 && nl > 1e-10) nu = 2 * Math.PI - nu;
    }
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const M = E - e * Math.sin(E);
    const norm = x => ((x / DEG) % 360 + 360) % 360;
    return {
      aKm: a, e, iDeg: i / DEG, nodeDeg: norm(node), periDeg: norm(peri),
      M0Deg: norm(M), epochJD: ut + 2451545.0,
      periodD: a > 0 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) / 86400 : NaN,
    };
  }

  relVelKmS(id, ut) {
    const dtD = 60 / 86400;
    const p = BODY_BY_ID[id].parent;
    const r1 = V.sub(this.posOfAt(id, ut - dtD / 2), this.posOfAt(p, ut - dtD / 2));
    const r2 = V.sub(this.posOfAt(id, ut + dtD / 2), this.posOfAt(p, ut + dtD / 2));
    return V.scale(V.sub(r2, r1), 1 / 60);
  }

  velKmS(id, ut) {
    const r1 = this.posOfAt(id, ut - 30 / 86400);
    const r2 = this.posOfAt(id, ut + 30 / 86400);
    return V.scale(V.sub(r2, r1), 1 / 60);
  }

  // ---- core position computation ----
  // Heliocentric ecliptic km at UT days since J2000. No caching (used for
  // light-time and sampling); snapshot() memoizes the per-frame case.
  posOfAt(id, ut) {
    const body = BODY_BY_ID[id];
    const ov = this.overrides.get(id);
    if (ov && body.parent) {
      const st = elementsToStateVector(ov.baked, ut + 2451545.0);
      return V.add(this.posOfAt(body.parent, ut), st.pos);
    }
    const src = body.ephem.source;
    const time = A.MakeTime(ut);
    switch (src) {
      case 'origin': return [0, 0, 0];
      case 'ae': {
        const v = A.HelioVector(A.Body[body.ephem.ae], time);
        const ecl = eqjToEcl([v.x, v.y, v.z]);
        const pos = V.scale(ecl, KM_PER_AU);
        if (body.ephem.barycenterOf === 'charon' && !this.overrides.has('pluto')) {
          // astronomy-engine's Pluto is the system barycenter: shift Pluto
          // opposite Charon by the mass ratio.
          const d = this._charonRel(ut);
          return V.add(pos, V.scale(d, -CHARON_Q / (1 + CHARON_Q)));
        }
        return pos;
      }
      case 'ae-geo': {
        const v = A.GeoVector(A.Body[body.ephem.ae], time, false);
        const ecl = V.scale(eqjToEcl([v.x, v.y, v.z]), KM_PER_AU);
        return V.add(this.posOfAt(body.parent, ut), ecl);
      }
      case 'jupmoon': {
        const jm = A.JupiterMoons(time)[body.ephem.index];
        const ecl = V.scale(eqjToEcl([jm.x, jm.y, jm.z]), KM_PER_AU);
        return V.add(this.posOfAt('jupiter', ut), ecl);
      }
      case 'kepler': {
        if (id === 'charon') {
          // Charon shares the barycenter split with Pluto.
          return V.add(this.posOfAt('pluto', ut), this._charonRel(ut));
        }
        const baked = bakedEls.get(id);
        const st = elementsToStateVector(baked, ut + 2451545.0);
        let rel = st.pos;
        if (body.ephem.el.frame === 'parentEq') {
          rel = M3.mulVec(this.parentEqToEclMatrix(body.parent, ut), rel);
        } else if (body.ephem.el.aAU !== undefined) {
          rel = V.scale(rel, KM_PER_AU);   // dwarf planets: elements in AU
        }
        return V.add(this.posOfAt(body.parent ?? 'sun', ut), rel);
      }
      default: throw new Error(`unknown ephem source ${src}`);
    }
  }

  _charonRel(ut) {
    const ovC = this.overrides.get('charon');
    if (ovC) return elementsToStateVector(ovC.baked, ut + 2451545.0).pos;
    const st = elementsToStateVector(bakedEls.get('charon'), ut + 2451545.0);
    return M3.mulVec(this.parentEqToEclMatrix('pluto', ut), st.pos);
  }

  // Matrix mapping the parent's IAU-equator frame (x toward the IAU node Q,
  // z along the north pole) to the ecliptic frame.
  parentEqToEclMatrix(parentId, ut) {
    const p = BODY_BY_ID[parentId];
    let northEqj;
    if (p.rotation.source === 'iau') {
      const axis = A.RotationAxis(A.Body[p.rotation.ae], A.MakeTime(ut));
      northEqj = [axis.north.x, axis.north.y, axis.north.z];
    } else if (p.rotation.source === 'fixed') {
      const ra = p.rotation.poleRA * DEG, dec = p.rotation.poleDec * DEG;
      northEqj = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    } else {
      northEqj = [0, 0, 1];
    }
    let q = V.cross([0, 0, 1], northEqj);
    if (V.len(q) < 1e-9) q = [1, 0, 0];
    q = V.norm(q);
    const y = V.cross(northEqj, q);
    const xE = eqjToEcl(q), yE = eqjToEcl(y), zE = eqjToEcl(northEqj);
    return M3.fromColumns(xE, yE, zE);
  }

  // ---- orientation: body-fixed -> ecliptic ----
  orientationOf(id, ut, posMap = null) {
    const body = BODY_BY_ID[id];
    const rot = body.rotation;
    const getPos = bid => posMap ? posMap.get(bid) : this.posOfAt(bid, ut);
    if (rot.source === 'iau' || rot.source === 'fixed') {
      let northEqj, spinDeg;
      if (rot.source === 'iau') {
        const axis = A.RotationAxis(A.Body[rot.ae], A.MakeTime(ut));
        northEqj = [axis.north.x, axis.north.y, axis.north.z];
        spinDeg = axis.spin;
      } else {
        const ra = rot.poleRA * DEG, dec = rot.poleDec * DEG;
        northEqj = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
        spinDeg = rot.W0 + rot.WRateDegPerDay * ut;
      }
      let q = V.cross([0, 0, 1], northEqj);
      if (V.len(q) < 1e-9) q = [1, 0, 0];
      q = V.norm(q);
      const xb = rodrigues(q, V.norm(northEqj), spinDeg * DEG);
      const zb = V.norm(northEqj);
      const yb = V.cross(zb, xb);
      return M3.fromColumns(eqjToEcl(xb), eqjToEcl(yb), eqjToEcl(zb));
    }
    // 'sync': tidally locked — pole = orbit normal, prime meridian toward parent.
    const parent = body.parent;
    const r = V.sub(getPos(id), getPos(parent));
    const v = this.relVelKmS(id, ut);
    let z = V.cross(r, v);
    if (V.len(z) < 1e-12) z = [0, 0, 1];
    z = V.norm(z);
    let x = V.scale(r, -1);                       // toward parent
    x = V.sub(x, V.scale(z, V.dot(x, z)));        // project into equator plane
    x = V.norm(x);
    const y = V.cross(z, x);
    return M3.fromColumns(x, y, z);
  }

  // ---- per-frame snapshot ----
  // Returns { ut, pos: Map, orient: Map, lightTimeSec: Map|null }.
  // If opts.lightTime and opts.observerId are set, every body other than the
  // observer is shown where it *appears* from the observer (retarded
  // positions, 2 fixed-point iterations — converges to meters).
  snapshot(ut, opts = {}) {
    const key = ut + (opts.lightTime ? 1e9 + this._hashObs(opts.observerId) : 0);
    if (this._snapCache.key === key) return this._snapCache.snap;
    const pos = new Map();
    for (const b of BODIES) pos.set(b.id, this.posOfAt(b.id, ut));
    let lightTimeSec = null;
    if (opts.lightTime && opts.observerId) {
      lightTimeSec = new Map();
      const obs = pos.get(opts.observerId);
      for (const b of BODIES) {
        if (b.id === opts.observerId) { lightTimeSec.set(b.id, 0); continue; }
        let p = pos.get(b.id);
        let tau = 0;
        for (let it = 0; it < 2; it++) {
          tau = V.len(V.sub(p, obs)) / LIGHT_DAY_KM;   // days
          p = this.posOfAt(b.id, ut - tau);
        }
        pos.set(b.id, p);
        lightTimeSec.set(b.id, tau * 86400);
      }
    }
    const orient = new Map();
    for (const b of BODIES) orient.set(b.id, this.orientationOf(b.id, ut, pos));
    const snap = { ut, pos, orient, lightTimeSec };
    this._snapCache = { key, snap };
    return snap;
  }

  _hashObs(id) {
    let h = 0; const s = id || '';
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1e6;
    return h;
  }

  // ---- Kepler-mode planets (counterfactual editing baseline) ----
  // JPL mean elements evaluated at ut, converted to the editor's km form.
  planetMeanElementsDisplay(id, ut) {
    const me = PLANET_MEAN_ELEMENTS[id];
    if (!me) return null;
    const T = ut / 36525.0;
    const el = planetElementsAt(me, T);
    const norm = x => ((x % 360) + 360) % 360;
    return {
      aKm: el.a * KM_PER_AU, e: el.e, iDeg: el.i,
      nodeDeg: norm(el.node), periDeg: norm(el.varpi - el.node),
      M0Deg: norm(el.L - el.varpi), epochJD: ut + 2451545.0,
      periodD: 2 * Math.PI * Math.sqrt(Math.pow(el.a * KM_PER_AU, 3) / GM.sun) / 86400,
    };
  }
}

// ---- photometry ------------------------------------------------------------
// Apparent magnitude of `body` seen from an arbitrary vantage.
// H from radius+geometric albedo, HG phase law (G=0.15). Good to a few
// tenths of a magnitude — labelled "≈" in the UI.
export function apparentMagnitude(body, sunDistKm, obsDistKm, phaseAngleDeg) {
  if (body.type === 'star') {
    return -26.74 + 5 * Math.log10(Math.max(1e-9, obsDistKm / KM_PER_AU));
  }
  const D = 2 * body.radiusKm;
  const H = 5 * Math.log10(1329 / (D / 1000 * Math.sqrt(Math.max(0.02, body.albedo))));
  const a = Math.max(0, Math.min(179.9, phaseAngleDeg)) * DEG;
  const G = 0.15;
  const phi1 = Math.exp(-3.33 * Math.pow(Math.tan(a / 2), 0.63));
  const phi2 = Math.exp(-1.87 * Math.pow(Math.tan(a / 2), 1.22));
  const phase = -2.5 * Math.log10(Math.max(1e-6, (1 - G) * phi1 + G * phi2));
  return H + 5 * Math.log10((sunDistKm / KM_PER_AU) * (obsDistKm / KM_PER_AU)) + phase;
}
