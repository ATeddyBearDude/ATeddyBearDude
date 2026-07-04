// Validation of known astronomical events against the simulator's own
// ephemeris pipeline (the exact same code the renderer uses).
//
// Run:  node tests/validate.mjs
//
// Checks:
//  1. Total solar eclipse of 2017-08-21: Sun–Moon angular separation from
//     Salem, OR (topocentric) < 0.1° at local totality (17:18 UTC), and the
//     surface point sits inside the umbra (sun disk fully covered).
//  2. Mars retrograde around the 2018-07-27 opposition: apparent geocentric
//     ecliptic longitude reverses direction between June and September 2018,
//     and minimum Earth–Mars distance lands within a day of 2018-07-31.
//  3. Time reversibility: positions at t, then t±N years, then back to t,
//     are bit-identical (analytic ephemeris, no integration state).
//  4. Moon distance range over a saros: 356k–407k km.
//  5. Galilean moon periods from the model (numerical) match published values.
//  6. 2012-06-05/06 transit of Venus: Sun–Venus separation from Earth center
//     below 16' near mid-transit (Venus silhouette inside the solar disk).

import { Ephemeris, Astronomy as A } from '../js/ephemeris.js';
import { V, M3 } from '../js/kepler.js';
import { KM_PER_AU, DEG } from '../js/const.js';

const eph = new Ephemeris();
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const ut = d => A.MakeTime(d).ut;

// ---------- 1. 2017-08-21 eclipse, topocentric from Salem OR ----------
{
  const t = ut(new Date(Date.UTC(2017, 7, 21, 17, 18, 0)));
  const snap = eph.snapshot(t);
  // topocentric observer: Salem 44.94N, -123.03E on the WGS84-ish sphere
  const m = snap.orient.get('earth');
  const lat = 44.94 * DEG, lon = -123.03 * DEG;
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const upEcl = M3.mulVec(m, up);
  const obs = V.add(snap.pos.get('earth'), V.scale(upEcl, 6371));
  const toSun = V.norm(V.sub(snap.pos.get('sun'), obs));
  const toMoon = V.norm(V.sub(snap.pos.get('moon'), obs));
  const sep = Math.acos(V.dot(toSun, toMoon)) / DEG;
  const dSun = V.len(V.sub(snap.pos.get('sun'), obs));
  const dMoon = V.len(V.sub(snap.pos.get('moon'), obs));
  const rSun = Math.asin(695700 / dSun) / DEG;
  const rMoon = Math.asin(1737.4 / dMoon) / DEG;
  const covered = sep + rSun <= rMoon + 1e-3;
  check('2017-08-21 17:18 UTC: topocentric Sun–Moon separation from Salem < 0.1°',
    sep < 0.1, `sep=${(sep * 60).toFixed(2)}′`);
  check('  …and the solar disk is fully covered (totality)',
    covered, `sunR=${(rSun * 60).toFixed(2)}′ moonR=${(rMoon * 60).toFixed(2)}′ sep=${(sep * 60).toFixed(2)}′`);
}

// ---------- 2. Mars retrograde around 2018 opposition ----------
{
  const lonAt = t => {
    const s = eph.snapshot(t);
    const r = V.sub(s.pos.get('mars'), s.pos.get('earth'));
    return Math.atan2(r[1], r[0]);
  };
  const tJun = ut(new Date(Date.UTC(2018, 5, 10)));
  const tJul = ut(new Date(Date.UTC(2018, 6, 27)));
  const tSep = ut(new Date(Date.UTC(2018, 8, 20)));
  const dJun = (lonAt(tJun + 1) - lonAt(tJun));
  const dJul = (lonAt(tJul + 1) - lonAt(tJul));
  const dSep = (lonAt(tSep + 1) - lonAt(tSep));
  check('Mars apparent motion prograde in early June 2018', dJun > 0, `dλ=${(dJun / DEG * 60).toFixed(1)}′/d`);
  check('Mars apparent motion RETROGRADE at 2018-07-27 opposition', dJul < 0, `dλ=${(dJul / DEG * 60).toFixed(1)}′/d`);
  check('Mars apparent motion prograde again by late Sept 2018', dSep > 0, `dλ=${(dSep / DEG * 60).toFixed(1)}′/d`);
  // closest approach: scan around 2018-07-31
  let best = null;
  for (let d = -20; d <= 20; d += 0.25) {
    const t = ut(new Date(Date.UTC(2018, 6, 31))) + d;
    const s = eph.snapshot(t);
    const dist = V.len(V.sub(s.pos.get('mars'), s.pos.get('earth')));
    if (!best || dist < best.dist) best = { t, dist, d };
  }
  const offset = best.t - ut(new Date(Date.UTC(2018, 6, 31, 7, 50)));
  check('Mars closest approach within 1 day of 2018-07-31 07:50 UTC',
    Math.abs(offset) < 1.0, `offset=${(offset * 24).toFixed(1)} h, dist=${(best.dist / KM_PER_AU).toFixed(5)} AU (actual 0.38496)`);
  check('  …closest-approach distance within 0.5% of 0.38496 AU',
    Math.abs(best.dist / KM_PER_AU - 0.38496) < 0.002, `${(best.dist / KM_PER_AU).toFixed(5)} AU`);
}

// ---------- 3. determinism / exact reversibility ----------
{
  const t0 = ut(new Date(Date.UTC(2026, 6, 4)));
  const before = eph.posOfAt('mars', t0);
  eph.posOfAt('mars', t0 + 36525);   // +100 yr
  eph.posOfAt('mars', t0 - 36525);   // -100 yr
  const after = eph.posOfAt('mars', t0);
  check('time travel is exactly reversible (analytic, stateless)',
    before[0] === after[0] && before[1] === after[1] && before[2] === after[2]);
}

// ---------- 4. Moon distance range ----------
{
  let mn = Infinity, mx = 0;
  const t0 = ut(new Date(Date.UTC(2020, 0, 1)));
  for (let d = 0; d < 6585; d += 0.5) {   // one saros
    const t = t0 + d;
    const dist = V.len(V.sub(eph.posOfAt('moon', t), eph.posOfAt('earth', t)));
    mn = Math.min(mn, dist); mx = Math.max(mx, dist);
  }
  check('Moon distance range over a saros ≈ [356 500, 406 700] km',
    mn > 354000 && mn < 358000 && mx > 404000 && mx < 408000,
    `min=${Math.round(mn)} max=${Math.round(mx)}`);
}

// ---------- 5. Galilean periods (numerical, from the model itself) ----------
{
  const period = id => {
    // sidereal period via angle sweep over 30 days
    const t0 = ut(new Date(Date.UTC(2024, 0, 1)));
    const rel = t => {
      const p = V.sub(eph.posOfAt(id, t), eph.posOfAt('jupiter', t));
      return Math.atan2(p[1], p[0]);
    };
    let angle = 0, prev = rel(t0);
    const dt = 0.02;
    for (let t = t0 + dt; t <= t0 + 30; t += dt) {
      let d = rel(t) - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      angle += d;
      prev = rel(t);
    }
    return 30 / Math.abs(angle / (2 * Math.PI));
  };
  const io = period('io'), eu = period('europa'), ga = period('ganymede'), ca = period('callisto');
  check('Io period ≈ 1.769 d', Math.abs(io - 1.769) < 0.01, io.toFixed(4));
  check('Europa period ≈ 3.551 d', Math.abs(eu - 3.551) < 0.02, eu.toFixed(4));
  check('Ganymede period ≈ 7.155 d', Math.abs(ga - 7.155) < 0.04, ga.toFixed(4));
  check('Callisto period ≈ 16.689 d', Math.abs(ca - 16.689) < 0.09, ca.toFixed(4));
}

// ---------- 6. 2012 transit of Venus ----------
{
  const t = ut(new Date(Date.UTC(2012, 5, 6, 1, 30, 0)));   // mid-transit ≈ 01:29 UTC
  const snap = eph.snapshot(t);
  const e = snap.pos.get('earth');
  const toSun = V.norm(V.sub(snap.pos.get('sun'), e));
  const toVen = V.norm(V.sub(snap.pos.get('venus'), e));
  const sep = Math.acos(V.dot(toSun, toVen)) / DEG * 60;   // arcmin
  const rSunAmin = Math.asin(695700 / V.len(V.sub(snap.pos.get('sun'), e))) / DEG * 60;
  check('2012-06-06 01:30 UTC: Venus inside the solar disk (transit)',
    sep < rSunAmin, `sep=${sep.toFixed(2)}′, sun radius=${rSunAmin.toFixed(2)}′`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
