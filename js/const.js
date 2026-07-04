// Physical constants and frame conventions.
//
// Internal physics frame ("ECL"): heliocentric J2000 ecliptic, right-handed,
//   +x toward J2000 equinox, +z toward north ecliptic pole. Units: km.
// Scene frame: three.js right-handed with +Y up. We map
//   scene.x = ecl.x, scene.y = ecl.z, scene.z = -ecl.y  (a rotation, so
//   handedness and all geometry are preserved; ecliptic north = scene +Y).
// Scene length unit: 1 unit = KM_PER_UNIT km. Rendering uses a floating
//   origin (camera focus subtracted on the CPU in double precision) so
//   float32 GPU coordinates stay small near the camera.

export const KM_PER_AU = 149597870.7;
export const KM_PER_UNIT = 1.0e6;          // 1 scene unit = 1e6 km
export const UNITS_PER_AU = KM_PER_AU / KM_PER_UNIT;
export const C_KM_S = 299792.458;          // speed of light
export const DAY_S = 86400.0;              // solar day, seconds
export const SIDEREAL_DAY_S = 86164.0905;  // Earth sidereal day, seconds
export const JULIAN_YEAR_D = 365.25;
export const J2000_JD = 2451545.0;
export const DEG = Math.PI / 180;
export const HOUR_D = 1 / 24;
export const SEC_D = 1 / 86400;

// GM values, km^3/s^2 (DE440-era values)
export const GM = {
  sun: 1.32712440018e11,
  mercury: 2.2031780e4,
  venus: 3.24858592e5,
  earth: 3.986004418e5,
  moon: 4.9028001e3,
  mars: 4.282837362e4,
  jupiter: 1.26686531900e8,
  saturn: 3.79312074986e7,
  uranus: 5.793951322e6,
  neptune: 6.835099502e6,
  pluto: 8.696e2,
  charon: 1.0588e2,
  ceres: 6.26325e1,
  eris: 1.1089e3,
  haumea: 2.674e2,
  makemake: 2.069e2,
};

// J2 oblateness coefficients + reference radii (km) used to compute
// physically-based nodal regression / apsidal precession of moon orbits.
export const J2 = {
  earth:   { j2: 1.08263e-3,  refR: 6378.137 },
  mars:    { j2: 1.96045e-3,  refR: 3396.19 },
  jupiter: { j2: 1.4736e-2,   refR: 71492 },
  saturn:  { j2: 1.6298e-2,   refR: 60268 },
  uranus:  { j2: 3.34343e-3,  refR: 25559 },
  neptune: { j2: 3.411e-3,    refR: 24764 },
  pluto:   { j2: 0,           refR: 1188.3 },
};

export function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

export function fmtDistance(km) {
  const au = km / KM_PER_AU;
  if (Math.abs(au) >= 0.01) return `${au.toFixed(au >= 10 ? 3 : 5)} AU  (${(km / 1e6).toFixed(2)} Mkm)`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

export function fmtAngle(deg) {
  const a = Math.abs(deg);
  if (a >= 1) return `${deg.toFixed(3)}°`;
  const amin = deg * 60;
  if (a >= 1 / 60) return `${amin.toFixed(2)}′`;
  return `${(amin * 60).toFixed(2)}″`;
}
