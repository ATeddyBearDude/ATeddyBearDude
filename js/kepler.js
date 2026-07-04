// Keplerian propagation and small 3-vector/matrix helpers.
// Pure math — no dependency on astronomy-engine or three.js.
// Vectors are [x,y,z] arrays; matrices are row-major 3x3 arrays of arrays.

import { DEG } from './const.js';

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

export const M3 = {
  mulVec: (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ],
  mul: (a, b) => {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    return r;
  },
  transpose: m => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]],
  identity: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  rotX: a => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; },
  rotZ: a => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; },
  // Matrix whose columns are the given basis vectors (maps local -> world).
  fromColumns: (x, y, z) => [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]],
};

// Solve Kepler's equation M = E - e sin E. Newton with bisection fallback.
export function solveKepler(M, e) {
  M = M % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let it = 0; it < 30; it++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// Propagate orbital elements to a perifocal-frame-rotated position/velocity
// in the element reference frame. Angles in degrees, distances in the unit
// of `a`, gm in (unit of a)^3/s^2 (only needed if velocity is requested).
// Returns { pos:[x,y,z], vel:[x,y,z]|null } in the element frame.
export function elementsToStateVector(el, tJd, wantVel = false) {
  const { a, e } = el;
  const n = el.nRadPerDay;                       // mean motion, rad/day
  const dt = tJd - el.epochJD;                   // days
  const M = el.M0Rad + n * dt
    + 0;                                          // (rates applied by caller)
  const node = el.nodeRad + (el.nodeRateRadPerDay || 0) * dt;
  const peri = el.periRad + (el.apsRateRadPerDay || 0) * dt;
  const inc = el.iRad;

  const E = solveKepler(M, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const xp = a * (cosE - e);                     // perifocal coordinates
  const yp = a * Math.sqrt(1 - e * e) * sinE;

  const cO = Math.cos(node), sO = Math.sin(node);
  const cw = Math.cos(peri), sw = Math.sin(peri);
  const ci = Math.cos(inc), si = Math.sin(inc);

  // Rz(node) Rx(inc) Rz(peri) applied to (xp, yp, 0)
  const x1 = cw * xp - sw * yp;
  const y1 = sw * xp + cw * yp;
  const x2 = x1;
  const y2 = ci * y1;
  const z2 = si * y1;
  const pos = [cO * x2 - sO * y2, sO * x2 + cO * y2, z2];

  let vel = null;
  if (wantVel) {
    const r = a * (1 - e * cosE);
    const nDaySec = n / 86400;                   // rad/s
    const vxp = -a * nDaySec * a / r * sinE;
    const vyp = a * nDaySec * a / r * Math.sqrt(1 - e * e) * cosE;
    const vx1 = cw * vxp - sw * vyp;
    const vy1 = sw * vxp + cw * vyp;
    const vy2 = ci * vy1, vz2 = si * vy1;
    vel = [cO * vx1 - sO * vy2, sO * vx1 + cO * vy2, vz2];
  }
  return { pos, vel };
}

// Normalize a user-facing element set {aKm|aAU, e, iDeg, nodeDeg, periDeg,
// M0Deg, periodD|nDegPerDay, epochJD, nodeRateDegPerDay?, apsRateDegPerDay?}
// into the radian/precomputed form used by elementsToStateVector.
export function bakeElements(src, epochDefaultJD) {
  const a = src.aKm !== undefined ? src.aKm : src.aAU;
  const nDegPerDay = src.nDegPerDay !== undefined ? src.nDegPerDay : 360 / src.periodD;
  return {
    a, e: src.e,
    iRad: src.iDeg * DEG,
    nodeRad: src.nodeDeg * DEG,
    periRad: src.periDeg * DEG,
    M0Rad: src.M0Deg * DEG,
    nRadPerDay: nDegPerDay * DEG,
    epochJD: src.epochJD !== undefined ? src.epochJD : epochDefaultJD,
    nodeRateRadPerDay: (src.nodeRateDegPerDay || 0) * DEG,
    apsRateRadPerDay: (src.apsRateDegPerDay || 0) * DEG,
  };
}

// J2-driven secular rates (rad/day) for a satellite orbit:
//   dNode/dt = -3/2 n J2 (R/a)^2 cos i / (1-e^2)^2
//   dPeri/dt = +3/4 n J2 (R/a)^2 (5 cos^2 i - 1) / (1-e^2)^2
export function j2Rates(nRadPerDay, j2, refR, a, e, iRad) {
  const p2 = Math.pow(refR / a, 2) / Math.pow(1 - e * e, 2);
  const ci = Math.cos(iRad);
  return {
    nodeRate: -1.5 * nRadPerDay * j2 * p2 * ci,
    apsRate: 0.75 * nRadPerDay * j2 * p2 * (5 * ci * ci - 1),
  };
}

// Convert JPL planet mean elements (a,e,i,L,varpi,node + per-century rates)
// at time T centuries past J2000 into a baked element set (ecliptic frame).
export function planetMeanToBaked(me, edits = null) {
  const el = {
    a: me.a, e: me.e, i: me.i, L: me.L, varpi: me.varpi, node: me.node,
  };
  if (edits) Object.assign(el, edits);
  return el;
}

// Evaluate JPL mean elements at Julian centuries T; returns degrees/AU set.
export function planetElementsAt(me, T) {
  return {
    a: me.a + me.da * T,
    e: me.e + me.de * T,
    i: me.i + me.di * T,
    L: me.L + me.dL * T,
    varpi: me.varpi + me.dvarpi * T,
    node: me.node + me.dnode * T,
  };
}
