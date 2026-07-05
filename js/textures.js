// Texture loading + procedural generation.
//
// Real photo-derived maps (textures/*.jpg) are used when present; every body
// also has a seeded procedural generator as fallback, and bodies without
// published full-surface maps (most outer-planet moons) are procedural by
// design: physically plausible coloring/features (albedo, banding, craters,
// known large-scale features like Iapetus' two-tone dichotomy or Pluto's
// Sputnik Planitia) — labelled "representative" in the README.
//
// Noise is evaluated in 3D on the unit sphere from equirectangular (u,v),
// so textures are seamless and pole-artifact-free.

import * as THREE from '../vendor/three.module.js';

// ---- seeded RNG + 3D value noise ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix, iy, iz, seed) {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296);
}

function smooth(t) { return t * t * (3 - 2 * t); }

function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = smooth(fx), sy = smooth(fy), sz = smooth(fz);
  let r = 0;
  for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) {
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
    r += w * hash3(ix + dx, iy + dy, iz + dz, seed);
  }
  return r;
}

function fbm(x, y, z, seed, oct = 5, lac = 2.1, gain = 0.52) {
  let a = 0, amp = 1, f = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    a += amp * noise3(x * f, y * f, z * f, seed + o * 101);
    tot += amp; amp *= gain; f *= lac;
  }
  return a / tot;
}

function ridged(x, y, z, seed, oct = 4) {
  let a = 0, amp = 1, f = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    a += amp * Math.abs(2 * noise3(x * f, y * f, z * f, seed + o * 77) - 1);
    tot += amp; amp *= 0.5; f *= 2.2;
  }
  return a / tot;
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const mix = (a, b, t) => a + (b - a) * t;
function mixc(c1, c2, t) { return [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)]; }

// Generate an equirect canvas; shade(dir, lonDeg, latDeg, u, v) -> [r,g,b] 0..1
function genMap(w, h, shade) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    const lat = (0.5 - v) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w;
      const lon = (u - 0.5) * 2 * Math.PI;
      const dir = [cl * Math.cos(lon), cl * Math.sin(lon), sl];
      const c = shade(dir, lon * 180 / Math.PI, lat * 180 / Math.PI, u, v);
      const k = (j * w + i) * 4;
      d[k] = clamp01(c[0]) * 255; d[k + 1] = clamp01(c[1]) * 255; d[k + 2] = clamp01(c[2]) * 255; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Crater field helper: returns brightness multiplier at dir given a list of
// craters [{c:[x,y,z], r: angular radius rad, d: depth}] (precomputed).
function makeCraters(seed, count, minR, maxR) {
  const rng = mulberry32(seed);
  const craters = [];
  for (let i = 0; i < count; i++) {
    const z = rng() * 2 - 1, ph = rng() * 2 * Math.PI;
    const s = Math.sqrt(1 - z * z);
    craters.push({
      c: [s * Math.cos(ph), s * Math.sin(ph), z],
      r: minR + (maxR - minR) * Math.pow(rng(), 2.2),
      d: 0.25 + rng() * 0.5,
    });
  }
  return function craterShade(dir) {
    let m = 1;
    for (const cr of craters) {
      const cosA = dir[0] * cr.c[0] + dir[1] * cr.c[1] + dir[2] * cr.c[2];
      if (cosA < Math.cos(cr.r * 1.6)) continue;
      const a = Math.acos(Math.min(1, cosA)) / cr.r;   // 0 center .. 1 rim
      if (a < 0.75) m *= 1 - cr.d * (1 - a * 0.4);       // floor: darker
      else if (a < 1.05) m *= 1 + cr.d * 0.55;           // rim: brighter
      else if (a < 1.5) m *= 1 - cr.d * 0.12;            // ejecta shadow
    }
    return m;
  };
}

// ---- per-body generators ----
const GEN = {
  sun: (w, h) => genMap(w, h, (p) => {
    const g = fbm(p[0] * 18, p[1] * 18, p[2] * 18, 11, 4);
    const b = 0.92 + 0.08 * g;
    return [1.0 * b, 0.82 * b, 0.55 * b * (0.9 + 0.1 * g)];
  }),

  rock_gray: (w, h, seed = 21) => {
    const cr = makeCraters(seed, 260, 0.012, 0.16);
    return genMap(w, h, (p) => {
      const base = 0.45 + 0.25 * fbm(p[0] * 3, p[1] * 3, p[2] * 3, seed, 5);
      const m = base * cr(p);
      return [m, m * 0.98, m * 0.95];
    });
  },

  rock_dark: (w, h, seed = 33) => {
    const cr = makeCraters(seed, 200, 0.015, 0.14);
    return genMap(w, h, (p) => {
      const base = 0.22 + 0.15 * fbm(p[0] * 3.5, p[1] * 3.5, p[2] * 3.5, seed, 5);
      const m = base * cr(p);
      return [m * 1.02, m, m * 0.96];
    });
  },

  mars: (w, h) => {
    const cr = makeCraters(7, 180, 0.012, 0.1);
    return genMap(w, h, (p, lon, lat) => {
      const t = fbm(p[0] * 3, p[1] * 3, p[2] * 3, 7, 6);
      const dark = smooth(clamp01((t - 0.52) * 4));
      let c = mixc([0.72, 0.42, 0.25], [0.42, 0.27, 0.18], dark);
      const cap = smooth(clamp01((Math.abs(lat) - 75) / 8 + t * 0.5));
      c = mixc(c, [0.95, 0.93, 0.9], cap);
      const m = cr(p);
      return [c[0] * m, c[1] * m, c[2] * m];
    });
  },

  earth: (w, h) => genMap(w, h, (p, lon, lat) => {
    const t = fbm(p[0] * 2.2, p[1] * 2.2, p[2] * 2.2, 5, 6);
    const land = t > 0.52;
    if (!land) {
      const d = clamp01((0.52 - t) * 6);
      return mixc([0.1, 0.25, 0.45], [0.03, 0.1, 0.28], d);
    }
    const el = clamp01((t - 0.52) * 7);
    let c = mixc([0.2, 0.4, 0.15], [0.5, 0.42, 0.28], el);
    if (Math.abs(lat) > 62) c = mixc(c, [0.92, 0.94, 0.96], clamp01((Math.abs(lat) - 62) / 10));
    return c;
  }),

  venus: (w, h) => genMap(w, h, (p, lon, lat) => {
    const band = fbm(p[0] * 1.5, p[1] * 1.5, p[2] * 4 + lat * 0.02, 13, 5);
    const s = 0.8 + 0.2 * band;
    return [0.93 * s, 0.8 * s, 0.55 * s];
  }),

  jupiter: (w, h) => genMap(w, h, (p, lon, lat) => {
    const turb = fbm(p[0] * 4, p[1] * 4, p[2] * 8, 3, 5) - 0.5;
    const bl = Math.sin((lat + turb * 6) * Math.PI / 12);
    const zone = smooth(clamp01(bl * 2 + 0.5));
    let c = mixc([0.62, 0.45, 0.32], [0.85, 0.78, 0.66], zone);
    // Great Red Spot near 22°S
    const dlat = (lat + 22) / 9, dlon = (((lon + 55 + 540) % 360) - 180) / 16;
    const spot = Math.exp(-(dlat * dlat + dlon * dlon) * 2.2);
    c = mixc(c, [0.75, 0.32, 0.2], clamp01(spot * 1.2));
    return c;
  }),

  saturn: (w, h) => genMap(w, h, (p, lon, lat) => {
    const turb = fbm(p[0] * 3, p[1] * 3, p[2] * 6, 17, 4) - 0.5;
    const bl = Math.sin((lat + turb * 3) * Math.PI / 15);
    const zone = smooth(clamp01(bl * 1.6 + 0.5));
    return mixc([0.72, 0.6, 0.42], [0.88, 0.82, 0.64], zone);
  }),

  uranus: (w, h) => genMap(w, h, (p, lon, lat) => {
    const b = 0.96 + 0.04 * fbm(p[0], p[1], p[2] * 3, 19, 3);
    const band = 1 + 0.03 * Math.sin(lat * Math.PI / 20);
    return [0.55 * b * band, 0.78 * b, 0.8 * b];
  }),

  neptune: (w, h) => genMap(w, h, (p, lon, lat) => {
    const t = fbm(p[0] * 2, p[1] * 2, p[2] * 5, 23, 4);
    let c = [0.2 + 0.1 * t, 0.3 + 0.12 * t, 0.75 + 0.15 * t];
    const dlat = (lat + 25) / 8, dlon = (((lon - 30 + 540) % 360) - 180) / 12;
    const spot = Math.exp(-(dlat * dlat + dlon * dlon) * 2.5);
    return mixc(c, [0.1, 0.15, 0.5], clamp01(spot));
  }),

  io: (w, h) => {
    const rng = mulberry32(31);
    const volcs = [];
    for (let i = 0; i < 26; i++) {
      const z = rng() * 2 - 1, ph = rng() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
      volcs.push({ c: [s * Math.cos(ph), s * Math.sin(ph), z], r: 0.05 + rng() * 0.12 });
    }
    return genMap(w, h, (p, lon, lat) => {
      const t = fbm(p[0] * 3, p[1] * 3, p[2] * 3, 31, 5);
      let c = mixc([0.9, 0.85, 0.55], [0.75, 0.6, 0.25], t);
      if (Math.abs(lat) > 55) c = mixc(c, [0.85, 0.82, 0.75], clamp01((Math.abs(lat) - 55) / 20));
      for (const vv of volcs) {
        const cosA = p[0] * vv.c[0] + p[1] * vv.c[1] + p[2] * vv.c[2];
        const a = Math.acos(Math.min(1, cosA));
        if (a < vv.r) c = mixc([0.25, 0.12, 0.05], c, smooth(a / vv.r));
        else if (a < vv.r * 2.4) c = mixc(c, [0.95, 0.55, 0.2], 0.35 * (1 - (a - vv.r) / (vv.r * 1.4)));
      }
      return c;
    });
  },

  europa: (w, h) => genMap(w, h, (p) => {
    const lines = ridged(p[0] * 2.4, p[1] * 2.4, p[2] * 2.4, 41, 4);
    const crack = smooth(clamp01((0.16 - lines) * 9));
    const t = fbm(p[0] * 2, p[1] * 2, p[2] * 2, 42, 4);
    let c = mixc([0.92, 0.9, 0.85], [0.8, 0.75, 0.62], t);
    return mixc(c, [0.62, 0.4, 0.25], crack * 0.7);
  }),

  ganymede: (w, h) => {
    const cr = makeCraters(51, 140, 0.01, 0.07);
    return genMap(w, h, (p) => {
      const terr = fbm(p[0] * 1.8, p[1] * 1.8, p[2] * 1.8, 51, 5);
      const dark = smooth(clamp01((terr - 0.5) * 5));
      let c = mixc([0.72, 0.68, 0.6], [0.42, 0.38, 0.32], dark);
      const m = Math.min(1.3, cr(p) * 1.06);
      return [c[0] * m, c[1] * m, c[2] * m];
    });
  },

  callisto: (w, h) => {
    const cr = makeCraters(61, 320, 0.008, 0.09);
    return genMap(w, h, (p) => {
      const t = fbm(p[0] * 3, p[1] * 3, p[2] * 3, 61, 5);
      const base = 0.3 + 0.14 * t;
      const m = cr(p);
      const bright = m > 1 ? (m - 1) * 1.6 : 0;
      return [base * m + bright * 0.4, base * m * 0.96 + bright * 0.4, base * m * 0.88 + bright * 0.4];
    });
  },

  titan: (w, h) => genMap(w, h, (p, lon, lat) => {
    const t = fbm(p[0] * 2.5, p[1] * 2.5, p[2] * 2.5, 71, 4);
    let c = [0.85, 0.62, 0.3];
    const dunes = smooth(clamp01((0.5 - Math.abs(lat)) / 30)) * smooth(clamp01((t - 0.45) * 5));
    c = mixc(c, [0.5, 0.35, 0.18], dunes * 0.5 * clamp01((30 - Math.abs(lat)) / 30));
    if (lat > 60) c = mixc(c, [0.6, 0.55, 0.4], clamp01((lat - 60) / 25) * t);
    return c;
  }),

  enceladus: (w, h) => genMap(w, h, (p, lon, lat) => {
    let c = [0.97, 0.98, 1.0];
    const t = fbm(p[0] * 4, p[1] * 4, p[2] * 4, 81, 4);
    c = mixc(c, [0.85, 0.9, 0.95], t * 0.5);
    if (lat < -55) {
      const stripe = Math.abs(Math.sin((lon + t * 40) * Math.PI / 45));
      if (stripe < 0.12) c = mixc(c, [0.55, 0.75, 0.8], (0.12 - stripe) / 0.12 * clamp01((-lat - 55) / 15));
    }
    return c;
  }),

  ice_cratered: (w, h, seed = 91) => {
    const cr = makeCraters(seed, 240, 0.012, 0.13);
    return genMap(w, h, (p) => {
      const base = 0.62 + 0.2 * fbm(p[0] * 3, p[1] * 3, p[2] * 3, seed, 5);
      const m = base * cr(p);
      return [m * 0.96, m * 0.98, m];
    });
  },

  ice_wispy: (w, h, seed = 101) => {
    const cr = makeCraters(seed, 150, 0.01, 0.08);
    return genMap(w, h, (p) => {
      const base = 0.58 + 0.18 * fbm(p[0] * 3, p[1] * 3, p[2] * 3, seed, 5);
      const wisp = ridged(p[0] * 3.2, p[1] * 3.2, p[2] * 3.2, seed + 5, 4);
      const streak = smooth(clamp01((0.13 - wisp) * 8)) * 0.35;
      const m = base * cr(p) + streak;
      return [m * 0.97, m * 0.99, m];
    });
  },

  ice_chaotic: (w, h) => genMap(w, h, (p) => {
    const dom = noise3(p[0] * 2.2, p[1] * 2.2, p[2] * 2.2, 111);
    const ridg = ridged(p[0] * 5, p[1] * 5, p[2] * 5, 112, 4);
    const band = Math.abs(Math.sin(dom * 14 + ridg * 5));
    const base = 0.45 + 0.3 * dom + 0.15 * (band < 0.25 ? -0.8 : 0.3);
    return [base * 0.97, base * 0.99, base];
  }),

  ice_bright: (w, h, seed = 121) => genMap(w, h, (p) => {
    const t = fbm(p[0] * 3, p[1] * 3, p[2] * 3, seed, 4);
    const b = 0.85 + 0.13 * t;
    return [b * 0.97, b * 0.99, b];
  }),

  iapetus: (w, h) => {
    const cr = makeCraters(131, 220, 0.012, 0.12);
    return genMap(w, h, (p, lon) => {
      // Cassini Regio: dark leading hemisphere (centered ~90°E of the
      // sub-parent meridian in our synchronous convention).
      const t = fbm(p[0] * 2.5, p[1] * 2.5, p[2] * 2.5, 131, 5);
      const dLon = ((lon - 90 + 540) % 360) - 180;
      const dark = smooth(clamp01((70 - Math.abs(dLon)) / 30 + (t - 0.5)));
      let base = mix(0.65, 0.1, dark) * (0.85 + 0.3 * t);
      base *= cr(p);
      return dark > 0.5 ? [base * 1.25, base * 0.95, base * 0.7] : [base, base * 0.98, base * 0.94];
    });
  },

  triton: (w, h) => genMap(w, h, (p, lon, lat) => {
    const cant = Math.abs(2 * noise3(p[0] * 8, p[1] * 8, p[2] * 8, 141) - 1);
    let c = [0.78 + 0.1 * cant, 0.72 + 0.08 * cant, 0.68 + 0.06 * cant];
    if (lat < -10) {
      const capT = clamp01((-lat - 10) / 30 + (cant - 0.5) * 0.3);
      c = mixc(c, [0.95, 0.9, 0.85], smooth(capT));
    }
    return c;
  }),

  pluto: (w, h) => {
    const cr = makeCraters(151, 90, 0.015, 0.09);
    return genMap(w, h, (p, lon, lat) => {
      const t = fbm(p[0] * 2.4, p[1] * 2.4, p[2] * 2.4, 151, 5);
      let c = mixc([0.78, 0.62, 0.45], [0.55, 0.4, 0.28], t);
      // dark equatorial maculae
      const mac = smooth(clamp01((25 - Math.abs(lat + 5)) / 25)) * smooth(clamp01((t - 0.42) * 5));
      c = mixc(c, [0.25, 0.15, 0.1], mac * 0.8);
      // Sputnik Planitia: bright nitrogen-ice basin
      const dlat = (lat - 20) / 22, dlon = (((lon - 160 + 540) % 360) - 180) / 18;
      const sp = Math.exp(-(dlat * dlat + dlon * dlon) * 1.8);
      c = mixc(c, [0.94, 0.92, 0.88], clamp01(sp * 1.3));
      const m = cr(p);
      return [c[0] * m, c[1] * m, c[2] * m];
    });
  },

  charon: (w, h) => {
    const cr = makeCraters(161, 130, 0.014, 0.1);
    return genMap(w, h, (p, lon, lat) => {
      const t = fbm(p[0] * 2.6, p[1] * 2.6, p[2] * 2.6, 161, 5);
      let c = [0.5 + 0.16 * t, 0.48 + 0.15 * t, 0.47 + 0.14 * t];
      if (lat > 55) c = mixc(c, [0.45, 0.28, 0.2], clamp01((lat - 55) / 20));  // Mordor Macula
      const m = cr(p);
      return [c[0] * m, c[1] * m, c[2] * m];
    });
  },
};

// ---- ring strip generators (1D radial, u = (r-inner)/(outer-inner)) ----
function genRing(w, bands) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = 2;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, 2);
  const d = img.data;
  for (let i = 0; i < w; i++) {
    const u = i / (w - 1);
    let r = 0, g = 0, b = 0, a = 0;
    for (const bd of bands) {
      if (u >= bd.u0 && u <= bd.u1) {
        const t = (u - bd.u0) / Math.max(1e-6, bd.u1 - bd.u0);
        const prof = Math.sin(Math.PI * clamp01(t)) ** 0.4;
        const n = 0.75 + 0.25 * Math.sin(u * 260 + Math.sin(u * 77) * 3);
        r = bd.c[0] * n; g = bd.c[1] * n; b = bd.c[2] * n;
        a = Math.max(a, bd.a * prof * n);
      }
    }
    for (let j = 0; j < 2; j++) {
      const k = (j * w + i) * 4;
      d[k] = r * 255; d[k + 1] = g * 255; d[k + 2] = b * 255; d[k + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

const RING_GEN = {
  // Saturn: C (dim), B (bright), Cassini division, A ring, F thread
  ring_saturn: () => genRing(1024, [
    { u0: 0.0, u1: 0.17, c: [0.45, 0.4, 0.33], a: 0.25 },
    { u0: 0.17, u1: 0.52, c: [0.85, 0.78, 0.62], a: 0.95 },
    { u0: 0.545, u1: 0.78, c: [0.75, 0.68, 0.55], a: 0.8 },
    { u0: 0.985, u1: 1.0, c: [0.8, 0.75, 0.62], a: 0.5 },
  ]),
  ring_uranus: () => genRing(1024, [
    { u0: 0.0, u1: 0.02, c: [0.5, 0.5, 0.55], a: 0.5 },
    { u0: 0.2, u1: 0.215, c: [0.5, 0.5, 0.55], a: 0.45 },
    { u0: 0.36, u1: 0.375, c: [0.5, 0.5, 0.55], a: 0.4 },
    { u0: 0.55, u1: 0.565, c: [0.55, 0.55, 0.6], a: 0.5 },
    { u0: 0.97, u1: 1.0, c: [0.62, 0.62, 0.66], a: 0.9 },   // epsilon
  ]),
  ring_faint_tan: () => genRing(512, [
    { u0: 0.0, u1: 1.0, c: [0.7, 0.6, 0.45], a: 0.5 },
  ]),
  ring_faint_gray: () => genRing(512, [
    { u0: 0.05, u1: 0.2, c: [0.55, 0.55, 0.6], a: 0.4 },
    { u0: 0.5, u1: 0.6, c: [0.55, 0.55, 0.6], a: 0.45 },
    { u0: 0.9, u1: 1.0, c: [0.6, 0.6, 0.65], a: 0.8 },      // Adams w/ arcs-ish
  ]),
};

// ---- public API ----
const texCache = new Map();

export function proceduralTexture(key, size = 1024) {
  const ck = key + size;
  if (texCache.has(ck)) return texCache.get(ck);
  const gen = GEN[key] || GEN.rock_gray;
  const cv = gen(size, size / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.set(ck, tex);
  return tex;
}

export function ringTexture(key) {
  if (texCache.has(key)) return texCache.get(key);
  const gen = RING_GEN[key] || RING_GEN.ring_faint_gray;
  const tex = new THREE.CanvasTexture(gen());
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, tex);
  return tex;
}

// Load a file texture with procedural fallback. Returns the texture
// immediately (procedural pixels swapped for the file once loaded).
export function bodyTexture(body, { night = false } = {}) {
  const file = night ? body.nightTexture : body.texture;
  const prockey = night ? null : (body.procedural || 'rock_gray');
  const size = body.radiusKm > 1000 ? 1024 : 512;
  if (!file) return prockey ? proceduralTexture(prockey, size) : null;
  const ck = 'file:' + file;
  if (texCache.has(ck)) return texCache.get(ck);
  const loader = new THREE.TextureLoader();
  const tex = loader.load(file, undefined, undefined, () => {
    // fallback: draw procedural into a canvas-backed texture
    if (prockey) {
      const fallback = proceduralTexture(prockey, size);
      tex.image = fallback.image;
      tex.needsUpdate = true;
    }
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  texCache.set(ck, tex);
  return tex;
}

export function fileTexture(path, { srgb = true } = {}) {
  const ck = 'file:' + path;
  if (texCache.has(ck)) return texCache.get(ck);
  const tex = new THREE.TextureLoader().load(path);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  texCache.set(ck, tex);
  return tex;
}

// Radial gradient sprite for the Sun's glow.
export function glowTexture() {
  if (texCache.has('glow')) return texCache.get('glow');
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,253,248,1)');
  g.addColorStop(0.16, 'rgba(255,248,228,0.6)');
  g.addColorStop(0.5, 'rgba(255,235,190,0.13)');
  g.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set('glow', tex);
  return tex;
}
