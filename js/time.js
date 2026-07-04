// Simulation clock. Sim time is stored as UT days since J2000 (astronomy-
// engine's native time base, float64: sub-millisecond resolution over
// ±several millennia). Fully deterministic: jumping, reversing and stepping
// all just set this one number.

import { DAY_S, SIDEREAL_DAY_S, JULIAN_YEAR_D, J2000_JD, SEC_D } from './const.js';

export const STEP_UNITS = [
  { id: 'seconds', label: 'seconds', days: SEC_D },
  { id: 'minutes', label: 'minutes', days: 60 * SEC_D },
  { id: 'hours', label: 'hours', days: 3600 * SEC_D },
  { id: 'days', label: 'solar days', days: 1 },
  { id: 'sidereal', label: 'sidereal days', days: SIDEREAL_DAY_S / DAY_S },
  { id: 'years', label: 'years (Julian)', days: JULIAN_YEAR_D },
];

// Speed presets in sim-seconds per real second.
export const SPEED_STEPS = [
  1, 10, 60, 600, 3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400,
  182 * 86400, 365.25 * 86400, 5 * 365.25 * 86400, 25 * 365.25 * 86400,
];

export class SimClock {
  constructor() {
    this.ut = (Date.now() / 86400000) - 10957.5;  // days since J2000 UT, now
    this.rate = 1;          // sim seconds per real second (signed)
    this.paused = false;
    this._lastRateIndex = 0;
    this.direction = 1;     // +1 forward, -1 reverse
  }

  get effectiveRate() { return this.paused ? 0 : this.rate * this.direction; }

  // Advance by real-time delta (seconds). Clamped so one frame never jumps
  // more than 40 years (keeps orbit-line refresh and UI sane on tab wake).
  tick(dtRealSec) {
    if (this.paused) return;
    let dDays = this.rate * this.direction * dtRealSec * SEC_D;
    const cap = 40 * 365.25;
    if (dDays > cap) dDays = cap; else if (dDays < -cap) dDays = -cap;
    this.ut += dDays;
  }

  setDate(date) { this.ut = (date.getTime() / 86400000) - 10957.5; }
  setJD(jd) { this.ut = jd - J2000_JD; }
  get jd() { return this.ut + J2000_JD; }
  get date() { return new Date((this.ut + 10957.5) * 86400000); }
  stepBy(amount, unitDays) { this.ut += amount * unitDays; }

  speedIndexFor(rate) {
    let best = 0, bd = Infinity;
    SPEED_STEPS.forEach((s, i) => { const d = Math.abs(Math.log(s / Math.abs(rate || 1))); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  faster() {
    const i = this.speedIndexFor(this.rate);
    this.rate = SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, i + (this.rate >= SPEED_STEPS[i] ? 1 : 0))];
  }
  slower() {
    const i = this.speedIndexFor(this.rate);
    this.rate = SPEED_STEPS[Math.max(0, i - (this.rate <= SPEED_STEPS[i] ? 1 : 0))];
  }

  fmtUTC() {
    const d = this.date;
    if (!isFinite(d.getTime())) return '(out of Date range)';
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
           `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  }

  fmtRate() {
    const r = Math.abs(this.rate);
    const dir = this.direction < 0 ? '−' : '';
    if (r < 60) return `${dir}${r.toFixed(r < 10 ? 1 : 0)} s/s`;
    if (r < 3600) return `${dir}${(r / 60).toFixed(1)} min/s`;
    if (r < 86400) return `${dir}${(r / 3600).toFixed(1)} hr/s`;
    if (r < 86400 * 365.25) return `${dir}${(r / 86400).toFixed(1)} d/s`;
    return `${dir}${(r / (86400 * 365.25)).toFixed(1)} yr/s`;
  }
}
