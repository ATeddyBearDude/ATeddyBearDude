// Optional N-body layer: direct gravitational integration of the Sun,
// planets, Moon, Pluto and the dwarf planets (leapfrog/velocity-Verlet,
// symplectic). Seeded from the analytic ephemeris state at activation.
//
// This is deliberately labelled as *diverging* from ephemeris accuracy:
// it models only point-mass Newtonian gravity among the included bodies
// (no relativity, no asteroids, no oblateness), so positions drift from
// the analytic solution over months-to-years of simulated time. The UI
// shows the current divergence. Moons other than Earth's Moon remain
// attached to their (integrated) parents via the analytic relative orbit.

import { GM } from './const.js';
import { V } from './kepler.js';
import { BODY_BY_ID } from './catalog.js';

export const NBODY_IDS = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars',
  'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres', 'eris', 'haumea', 'makemake'];

export class NBody {
  constructor(eph) {
    this.eph = eph;
    this.active = false;
    this.maxStepS = 900;           // integrator substep cap (s)
    this.pos = new Map();          // id -> km (heliocentric-frame inertial, sun included)
    this.vel = new Map();          // id -> km/s
    this.ut = 0;
    this.startUt = 0;
  }

  activate(ut) {
    for (const id of NBODY_IDS) {
      this.pos.set(id, this.eph.posOfAt(id, ut));
      this.vel.set(id, this.eph.velKmS(id, ut));
    }
    this.ut = ut;
    this.startUt = ut;
    this.active = true;
  }

  deactivate() { this.active = false; }

  _accels() {
    const acc = new Map();
    for (const id of NBODY_IDS) acc.set(id, [0, 0, 0]);
    for (let i = 0; i < NBODY_IDS.length; i++) {
      const a = NBODY_IDS[i], pa = this.pos.get(a);
      for (let j = i + 1; j < NBODY_IDS.length; j++) {
        const b = NBODY_IDS[j], pb = this.pos.get(b);
        const d = V.sub(pb, pa);
        const r2 = V.dot(d, d);
        const r = Math.sqrt(r2);
        const f = 1 / (r2 * r);
        const aa = acc.get(a), ab = acc.get(b);
        const ga = GM[b] * f, gb = GM[a] * f;
        aa[0] += d[0] * ga; aa[1] += d[1] * ga; aa[2] += d[2] * ga;
        ab[0] -= d[0] * gb; ab[1] -= d[1] * gb; ab[2] -= d[2] * gb;
      }
    }
    return acc;
  }

  // Integrate to target UT. Substep budget keeps frames responsive; if the
  // budget is exhausted the integrator lags and catches up on later frames.
  advanceTo(targetUt, maxSubsteps = 4000) {
    if (!this.active) return;
    let remaining = (targetUt - this.ut) * 86400;   // seconds
    const dir = Math.sign(remaining);
    if (dir === 0) return;
    let steps = 0;
    let acc = this._accels();
    while (Math.abs(remaining) > 1e-6 && steps < maxSubsteps) {
      const h = dir * Math.min(Math.abs(remaining), this.maxStepS);
      // velocity Verlet (KDK)
      for (const id of NBODY_IDS) {
        const v = this.vel.get(id), a = acc.get(id), p = this.pos.get(id);
        v[0] += a[0] * h / 2; v[1] += a[1] * h / 2; v[2] += a[2] * h / 2;
        p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
      }
      acc = this._accels();
      for (const id of NBODY_IDS) {
        const v = this.vel.get(id), a = acc.get(id);
        v[0] += a[0] * h / 2; v[1] += a[1] * h / 2; v[2] += a[2] * h / 2;
      }
      remaining -= h;
      steps++;
    }
    this.ut = targetUt - remaining / 86400;
  }

  // Merge integrated positions into an ephemeris snapshot: integrated bodies
  // take N-body positions (heliocentric = minus the integrated Sun, so the
  // Sun's barycentric wobble becomes visible); analytic moons ride along
  // with their parents.
  applyToSnapshot(snap) {
    if (!this.active) return snap;
    const shift = new Map();
    for (const id of NBODY_IDS) {
      const old = snap.pos.get(id);
      const nb = this.pos.get(id);
      snap.pos.set(id, [...nb]);
      shift.set(id, V.sub(nb, old));
    }
    for (const [id, p] of snap.pos) {
      if (NBODY_IDS.includes(id)) continue;
      // ride along with the nearest integrated ancestor
      let anc = id;
      while (anc && !NBODY_IDS.includes(anc)) anc = BODY_BY_ID[anc].parent;
      if (anc && shift.has(anc)) snap.pos.set(id, V.add(p, shift.get(anc)));
    }
    return snap;
  }

  divergenceKm(ut) {
    if (!this.active) return 0;
    return V.len(V.sub(this.pos.get('earth'), this.eph.posOfAt('earth', ut)));
  }
}
