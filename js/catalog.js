// Body catalog: physical data, ephemeris sources, rotation states, rings.
//
// Ephemeris sources:
//   'ae'      — astronomy-engine analytic ephemeris (VSOP87 truncation for the
//               planets, ELP2000-82-class lunar theory for the Moon, TOP2013-
//               derived model for Pluto). Deterministic and time-reversible.
//   'jupmoon' — astronomy-engine's Galilean satellite theory (Lieske E5 fit).
//   'kepler'  — precessing-Keplerian propagation from JPL mean/osculating
//               elements (used for outer-planet moons, Charon and the dwarf
//               planets). Node/apsis precession of moons derives from the
//               parent's J2. Orbital planes, shapes and periods are real
//               measured values; orbital phase at epoch for some minor moons
//               is approximate (documented in README).
//
// Rotation sources:
//   'iau'  — astronomy-engine RotationAxis (IAU WGCCRE model: real pole
//            RA/Dec + W(t), includes precession terms).
//   'sync' — tidally locked: pole = orbit normal, prime meridian faces parent.
//            True for every moon we model this way.
//   'fixed'— constant pole (RA/Dec, J2000 equatorial) + linear W(t).
//
// Moon Keplerian elements: a (km), e, i/node/peri/M0 (deg), n (deg/day),
// epochJD; frame 'parentEq' = parent's IAU equator plane with the node
// reference at the IAU node Q (ascending node of the parent equator on the
// ICRF equator). Dwarf planets: frame 'ecliptic', heliocentric J2000 ecliptic
// osculating elements from JPL SBDB (epoch JD 2461200.5, fetched 2026-07).

export const SBDB_EPOCH_JD = 2461200.5;

export const BODIES = [
  // ============================== STAR ==============================
  {
    id: 'sun', name: 'Sun', type: 'star', parent: null,
    radiusKm: 695700, gm: 1.32712440018e11,
    ephem: { source: 'origin' },
    rotation: { source: 'iau', ae: 'Sun' },
    texture: 'textures/2k_sun.jpg', procedural: 'sun',
    color: '#ffd27d', albedo: 1,
  },

  // ============================ PLANETS =============================
  {
    id: 'mercury', name: 'Mercury', type: 'planet', parent: 'sun',
    radiusKm: 2439.7, gm: 2.2031780e4,
    ephem: { source: 'ae', ae: 'Mercury' },
    rotation: { source: 'iau', ae: 'Mercury' },   // 58.646 d sidereal, 3:2 resonance
    texture: 'textures/2k_mercury.jpg', procedural: 'rock_gray',
    color: '#b5a79a', albedo: 0.142,
    orbitPeriodD: 87.969,
  },
  {
    id: 'venus', name: 'Venus', type: 'planet', parent: 'sun',
    radiusKm: 6051.8, gm: 3.24858592e5,
    ephem: { source: 'ae', ae: 'Venus' },
    rotation: { source: 'iau', ae: 'Venus' },     // retrograde, 243.018 d
    texture: 'textures/2k_venus_atmosphere.jpg', procedural: 'venus',
    color: '#e8c56e', albedo: 0.689,
    atmosphere: { color: [0.94, 0.83, 0.6], intensity: 0.55 },
    orbitPeriodD: 224.701,
  },
  {
    id: 'earth', name: 'Earth', type: 'planet', parent: 'sun',
    radiusKm: 6371.0, equatorialRadiusKm: 6378.137, flattening: 1 / 298.257,
    gm: 3.986004418e5,
    ephem: { source: 'ae', ae: 'Earth' },
    rotation: { source: 'iau', ae: 'Earth' },     // 23h56m4.1s, obliquity 23.44°
    texture: 'textures/2k_earth_daymap.jpg', nightTexture: 'textures/2k_earth_nightmap.jpg',
    procedural: 'earth',
    color: '#6b93d6', albedo: 0.434,
    atmosphere: { color: [0.45, 0.65, 1.0], intensity: 0.75 },
    orbitPeriodD: 365.256,
  },
  {
    id: 'mars', name: 'Mars', type: 'planet', parent: 'sun',
    radiusKm: 3389.5, equatorialRadiusKm: 3396.2, flattening: 0.00589,
    gm: 4.282837362e4,
    ephem: { source: 'ae', ae: 'Mars' },
    rotation: { source: 'iau', ae: 'Mars' },      // 24h37m22s, obliquity 25.19°
    texture: 'textures/2k_mars.jpg', procedural: 'mars',
    color: '#d1603d', albedo: 0.170,
    atmosphere: { color: [0.9, 0.6, 0.4], intensity: 0.18 },
    orbitPeriodD: 686.980,
  },
  {
    id: 'jupiter', name: 'Jupiter', type: 'planet', parent: 'sun',
    radiusKm: 69911, equatorialRadiusKm: 71492, flattening: 0.06487,
    gm: 1.26686531900e8,
    ephem: { source: 'ae', ae: 'Jupiter' },
    rotation: { source: 'iau', ae: 'Jupiter' },   // 9h55m30s System III
    texture: 'textures/2k_jupiter.jpg', procedural: 'jupiter',
    color: '#c9a178', albedo: 0.538,
    atmosphere: { color: [0.85, 0.78, 0.65], intensity: 0.3 },
    ring: { innerKm: 122500, outerKm: 129000, opacity: 0.06, procedural: 'ring_faint_tan' },
    orbitPeriodD: 4332.59,
  },
  {
    id: 'saturn', name: 'Saturn', type: 'planet', parent: 'sun',
    radiusKm: 58232, equatorialRadiusKm: 60268, flattening: 0.09796,
    gm: 3.79312074986e7,
    ephem: { source: 'ae', ae: 'Saturn' },
    rotation: { source: 'iau', ae: 'Saturn' },    // 10h33m38s, obliquity 26.73°
    texture: 'textures/2k_saturn.jpg', procedural: 'saturn',
    color: '#e3d3a3', albedo: 0.499,
    atmosphere: { color: [0.9, 0.85, 0.7], intensity: 0.25 },
    ring: { innerKm: 74500, outerKm: 140220, opacity: 1.0, texture: 'textures/2k_saturn_ring_alpha.png', procedural: 'ring_saturn' },
    orbitPeriodD: 10759.22,
  },
  {
    id: 'uranus', name: 'Uranus', type: 'planet', parent: 'sun',
    radiusKm: 25362, equatorialRadiusKm: 25559, flattening: 0.0229,
    gm: 5.793951322e6,
    ephem: { source: 'ae', ae: 'Uranus' },
    rotation: { source: 'iau', ae: 'Uranus' },    // retrograde 17h14m, obliquity 97.77°
    texture: 'textures/2k_uranus.jpg', procedural: 'uranus',
    color: '#9fd6d2', albedo: 0.488,
    atmosphere: { color: [0.6, 0.85, 0.85], intensity: 0.3 },
    ring: { innerKm: 41837, outerKm: 51149, opacity: 0.25, procedural: 'ring_uranus' },
    orbitPeriodD: 30685.4,
  },
  {
    id: 'neptune', name: 'Neptune', type: 'planet', parent: 'sun',
    radiusKm: 24622, equatorialRadiusKm: 24764, flattening: 0.0171,
    gm: 6.835099502e6,
    ephem: { source: 'ae', ae: 'Neptune' },
    rotation: { source: 'iau', ae: 'Neptune' },   // 16h6.6m, obliquity 28.32°
    texture: 'textures/2k_neptune.jpg', procedural: 'neptune',
    color: '#5a7fd6', albedo: 0.442,
    atmosphere: { color: [0.45, 0.55, 0.95], intensity: 0.3 },
    ring: { innerKm: 53200, outerKm: 62930, opacity: 0.12, procedural: 'ring_faint_gray' },
    orbitPeriodD: 60189.0,
  },

  // ========================== EARTH'S MOON ==========================
  {
    id: 'moon', name: 'Moon', type: 'moon', parent: 'earth',
    radiusKm: 1737.4, gm: 4.9028001e3,
    ephem: { source: 'ae-geo', ae: 'Moon' },      // ELP2000-class lunar theory
    rotation: { source: 'iau', ae: 'Moon' },      // includes real libration-scale pole model
    texture: 'textures/2k_moon.jpg', procedural: 'rock_gray',
    color: '#c8c8c8', albedo: 0.12,
    orbitPeriodD: 27.321661,
    // Display/edit elements (mean values; editing switches Moon to kepler mode)
    editElements: { aKm: 384400, e: 0.0549, iDeg: 5.145, nodeDeg: 125.08, periDeg: 318.15, M0Deg: 135.27, periodD: 27.321661, frame: 'ecliptic', nodeRateDegPerDay: -0.0529539, apsRateDegPerDay: 0.1114041 },
  },

  // ======================== GALILEAN MOONS ==========================
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter', radiusKm: 1821.6, gm: 5959.9,
    ephem: { source: 'jupmoon', index: 'io' }, rotation: { source: 'sync' },
    procedural: 'io', color: '#e8d060', albedo: 0.63, orbitPeriodD: 1.769138 },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter', radiusKm: 1560.8, gm: 3202.7,
    ephem: { source: 'jupmoon', index: 'europa' }, rotation: { source: 'sync' },
    procedural: 'europa', color: '#d8c8a8', albedo: 0.67, orbitPeriodD: 3.551181 },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter', radiusKm: 2634.1, gm: 9887.8,
    ephem: { source: 'jupmoon', index: 'ganymede' }, rotation: { source: 'sync' },
    procedural: 'ganymede', color: '#a89880', albedo: 0.43, orbitPeriodD: 7.154553 },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter', radiusKm: 2410.3, gm: 7179.3,
    ephem: { source: 'jupmoon', index: 'callisto' }, rotation: { source: 'sync' },
    procedural: 'callisto', color: '#8a7a6a', albedo: 0.17, orbitPeriodD: 16.689017 },

  // ========================= SATURN MOONS ===========================
  // JPL mean elements w.r.t. Saturn's equatorial (Laplace) plane.
  { id: 'mimas', name: 'Mimas', type: 'moon', parent: 'saturn', radiusKm: 198.2, gm: 2.504,
    ephem: { source: 'kepler', el: { aKm: 185539, e: 0.0196, iDeg: 1.574, nodeDeg: 153.2, periDeg: 14.3, M0Deg: 255.3, periodD: 0.9424218, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_cratered', color: '#b0b0b8', albedo: 0.962, orbitPeriodD: 0.9424218 },
  { id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn', radiusKm: 252.1, gm: 7.211,
    ephem: { source: 'kepler', el: { aKm: 238042, e: 0.0047, iDeg: 0.009, nodeDeg: 93.2, periDeg: 211.9, M0Deg: 197.0, periodD: 1.370218, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'enceladus', color: '#e8f0f2', albedo: 0.99, orbitPeriodD: 1.370218 },
  { id: 'tethys', name: 'Tethys', type: 'moon', parent: 'saturn', radiusKm: 531.1, gm: 41.21,
    ephem: { source: 'kepler', el: { aKm: 294672, e: 0.0001, iDeg: 1.091, nodeDeg: 330.9, periDeg: 262.8, M0Deg: 189.0, periodD: 1.887802, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_cratered', color: '#c5c9cc', albedo: 0.80, orbitPeriodD: 1.887802 },
  { id: 'dione', name: 'Dione', type: 'moon', parent: 'saturn', radiusKm: 561.4, gm: 73.116,
    ephem: { source: 'kepler', el: { aKm: 377415, e: 0.0022, iDeg: 0.028, nodeDeg: 168.8, periDeg: 168.2, M0Deg: 65.99, periodD: 2.736915, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_wispy', color: '#c9ccce', albedo: 0.90, orbitPeriodD: 2.736915 },
  { id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn', radiusKm: 763.8, gm: 153.94,
    ephem: { source: 'kepler', el: { aKm: 527068, e: 0.001, iDeg: 0.331, nodeDeg: 311.5, periDeg: 256.6, M0Deg: 311.6, periodD: 4.5175, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_wispy', color: '#c0c2c4', albedo: 0.90, orbitPeriodD: 4.5175 },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn', radiusKm: 2574.7, gm: 8978.14,
    ephem: { source: 'kepler', el: { aKm: 1221870, e: 0.0288, iDeg: 0.35, nodeDeg: 78.6, periDeg: 78.3, M0Deg: 11.7, periodD: 15.945421, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'titan', color: '#d8a95e', albedo: 0.22,
    atmosphere: { color: [0.9, 0.65, 0.35], intensity: 0.55 }, orbitPeriodD: 15.945421 },
  { id: 'iapetus', name: 'Iapetus', type: 'moon', parent: 'saturn', radiusKm: 734.5, gm: 120.51,
    ephem: { source: 'kepler', el: { aKm: 3560840, e: 0.0293, iDeg: 15.47, nodeDeg: 81.1, periDeg: 271.6, M0Deg: 201.8, periodD: 79.330183, frame: 'parentEq', j2Precess: false } },
    rotation: { source: 'sync' }, procedural: 'iapetus', color: '#9a8a76', albedo: 0.25, orbitPeriodD: 79.330183 },

  // ========================= URANUS MOONS ===========================
  { id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus', radiusKm: 235.8, gm: 4.4,
    ephem: { source: 'kepler', el: { aKm: 129390, e: 0.0013, iDeg: 4.232, nodeDeg: 326.4, periDeg: 68.3, M0Deg: 311.3, periodD: 1.413479, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_chaotic', color: '#b8bcc0', albedo: 0.32, orbitPeriodD: 1.413479 },
  { id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus', radiusKm: 578.9, gm: 86.4,
    ephem: { source: 'kepler', el: { aKm: 191020, e: 0.0012, iDeg: 0.260, nodeDeg: 22.4, periDeg: 115.3, M0Deg: 39.0, periodD: 2.520379, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_cratered', color: '#bcc0c2', albedo: 0.53, orbitPeriodD: 2.520379 },
  { id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus', radiusKm: 584.7, gm: 81.5,
    ephem: { source: 'kepler', el: { aKm: 266300, e: 0.0039, iDeg: 0.128, nodeDeg: 33.5, periDeg: 84.7, M0Deg: 12.5, periodD: 4.144177, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'rock_dark', color: '#8a8c8e', albedo: 0.26, orbitPeriodD: 4.144177 },
  { id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus', radiusKm: 788.4, gm: 228.2,
    ephem: { source: 'kepler', el: { aKm: 435910, e: 0.0011, iDeg: 0.340, nodeDeg: 99.8, periDeg: 284.4, M0Deg: 24.6, periodD: 8.705872, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'ice_cratered', color: '#b4b0aa', albedo: 0.35, orbitPeriodD: 8.705872 },
  { id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus', radiusKm: 761.4, gm: 192.4,
    ephem: { source: 'kepler', el: { aKm: 583520, e: 0.0014, iDeg: 0.058, nodeDeg: 279.8, periDeg: 104.4, M0Deg: 283.1, periodD: 13.463239, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'rock_dark', color: '#a49c94', albedo: 0.31, orbitPeriodD: 13.463239 },

  // ========================= NEPTUNE MOON ===========================
  { id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune', radiusKm: 1353.4, gm: 1428.0,
    // Retrograde (i > 90°); node precesses ~688 yr due to Neptune J2 + tilt.
    ephem: { source: 'kepler', el: { aKm: 354759, e: 0.000016, iDeg: 156.885, nodeDeg: 177.6, periDeg: 66.1, M0Deg: 352.3, periodD: 5.876854, frame: 'parentEq', j2Precess: true } },
    rotation: { source: 'sync' }, procedural: 'triton', color: '#d8c8c0', albedo: 0.76, orbitPeriodD: 5.876854 },

  // ===================== PLUTO SYSTEM + DWARFS ======================
  {
    id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sun',
    radiusKm: 1188.3, gm: 8.696e2,
    // astronomy-engine models the Pluto system barycenter; we offset
    // Pluto and Charon around it by their mass ratio (see ephemeris.js).
    ephem: { source: 'ae', ae: 'Pluto', barycenterOf: 'charon' },
    rotation: { source: 'iau', ae: 'Pluto' },     // 6.3872 d retrograde, obliquity ~120°
    procedural: 'pluto', color: '#d4b896', albedo: 0.52, orbitPeriodD: 90560,
  },
  { id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto', radiusKm: 606.0, gm: 1.0588e2,
    ephem: { source: 'kepler', el: { aKm: 19591.4, e: 0.0002, iDeg: 0.08, nodeDeg: 26.9, periDeg: 146.1, M0Deg: 27.7, periodD: 6.3872304, frame: 'parentEq', j2Precess: false } },
    rotation: { source: 'sync' }, procedural: 'charon', color: '#a89c94', albedo: 0.372, orbitPeriodD: 6.3872304 },

  // Heliocentric osculating elements: JPL SBDB, epoch JD 2461200.5 (TDB).
  { id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sun', radiusKm: 469.7, gm: 62.6325,
    ephem: { source: 'kepler', el: { aAU: 2.765552595034094, e: 0.07969229514816586, iDeg: 10.58802780183462, nodeDeg: 80.24862682043221, periDeg: 73.29421453021587, M0Deg: 274.4193463761342, nDegPerDay: 0.21430445064843, epochJD: 2461200.5, frame: 'ecliptic' } },
    rotation: { source: 'fixed', poleRA: 291.42, poleDec: 66.76, W0: 170.65, WRateDegPerDay: 952.1532 },
    texture: 'textures/2k_ceres_fictional.jpg', procedural: 'rock_gray', color: '#9a9186', albedo: 0.09, orbitPeriodD: 1680 },
  { id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sun', radiusKm: 1163, gm: 1108.9,
    ephem: { source: 'kepler', el: { aAU: 67.93394687853566, e: 0.4382385347971672, iDeg: 43.9258279471791, nodeDeg: 36.00477044417249, periDeg: 150.7949235840312, M0Deg: 211.774434275007, nDegPerDay: 0.001760247770619088, epochJD: 2461200.5, frame: 'ecliptic' } },
    rotation: { source: 'fixed', poleRA: 21.2, poleDec: -60.5, W0: 0, WRateDegPerDay: 360 / 15.786 },  // tidally locked to Dysnomia
    texture: 'textures/2k_eris_fictional.jpg', procedural: 'ice_bright', color: '#d8d8dc', albedo: 0.96, orbitPeriodD: 203830 },
  { id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sun', radiusKm: 780, gm: 267.4,
    ephem: { source: 'kepler', el: { aAU: 43.06029023650952, e: 0.1944430148898797, iDeg: 28.20847393040364, nodeDeg: 121.7860561329425, periDeg: 240.6905472508661, M0Deg: 223.2104118812299, nDegPerDay: 0.003488097731816818, epochJD: 2461200.5, frame: 'ecliptic' } },
    rotation: { source: 'fixed', poleRA: 282.6, poleDec: -13.0, W0: 0, WRateDegPerDay: 360 / (3.9155 / 24) },  // fastest-spinning large body
    texture: 'textures/2k_haumea_fictional.jpg', procedural: 'ice_bright', color: '#d0ccc8', albedo: 0.80, orbitPeriodD: 103410 },
  { id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sun', radiusKm: 715, gm: 206.9,
    ephem: { source: 'kepler', el: { aAU: 45.57093317300052, e: 0.1588889953992523, iDeg: 29.02785603743067, nodeDeg: 79.2948338209406, periDeg: 297.0922733397207, M0Deg: 169.9379962048232, nDegPerDay: 0.003203850120050116, epochJD: 2461200.5, frame: 'ecliptic' } },
    rotation: { source: 'fixed', poleRA: 0, poleDec: 90, W0: 0, WRateDegPerDay: 360 / (22.8266 / 24) },
    texture: 'textures/2k_makemake_fictional.jpg', procedural: 'pluto', color: '#c8a888', albedo: 0.81, orbitPeriodD: 111845 },
];

// JPL "Keplerian elements and rates" (Standish, 1800AD–2050AD table),
// J2000 ecliptic, angles in degrees, a in AU, rates per Julian century.
// Used for (a) the element editor's baseline for the 8 planets + Pluto and
// (b) counterfactual Kepler-mode propagation once a planet's elements are
// edited. L = mean longitude, varpi = longitude of perihelion.
export const PLANET_MEAN_ELEMENTS = {
  mercury: { a: 0.38709927, e: 0.20563593, i: 7.00497902, L: 252.25032350, varpi: 77.45779628, node: 48.33076593,
             da: 0.00000037, de: 0.00001906, di: -0.00594749, dL: 149472.67411175, dvarpi: 0.16047689, dnode: -0.12534081 },
  venus:   { a: 0.72333566, e: 0.00677672, i: 3.39467605, L: 181.97909950, varpi: 131.60246718, node: 76.67984255,
             da: 0.00000390, de: -0.00004107, di: -0.00078890, dL: 58517.81538729, dvarpi: 0.00268329, dnode: -0.27769418 },
  earth:   { a: 1.00000261, e: 0.01671123, i: -0.00001531, L: 100.46457166, varpi: 102.93768193, node: 0.0,
             da: 0.00000562, de: -0.00004392, di: -0.01294668, dL: 35999.37244981, dvarpi: 0.32327364, dnode: 0.0 },
  mars:    { a: 1.52371034, e: 0.09339410, i: 1.84969142, L: -4.55343205, varpi: -23.94362959, node: 49.55953891,
             da: 0.00001847, de: 0.00007882, di: -0.00813131, dL: 19140.30268499, dvarpi: 0.44441088, dnode: -0.29257343 },
  jupiter: { a: 5.20288700, e: 0.04838624, i: 1.30439695, L: 34.39644051, varpi: 14.72847983, node: 100.47390909,
             da: -0.00011607, de: -0.00013253, di: -0.00183714, dL: 3034.74612775, dvarpi: 0.21252668, dnode: 0.20469106 },
  saturn:  { a: 9.53667594, e: 0.05386179, i: 2.48599187, L: 49.95424423, varpi: 92.59887831, node: 113.66242448,
             da: -0.00125060, de: -0.00050991, di: 0.00193609, dL: 1222.49362201, dvarpi: -0.41897216, dnode: -0.28867794 },
  uranus:  { a: 19.18916464, e: 0.04725744, i: 0.77263783, L: 313.23810451, varpi: 170.95427630, node: 74.01692503,
             da: -0.00196176, de: -0.00004397, di: -0.00242939, dL: 428.48202785, dvarpi: 0.40805281, dnode: 0.04240589 },
  neptune: { a: 30.06992276, e: 0.00859048, i: 1.77004347, L: -55.12002969, varpi: 44.96476227, node: 131.78422574,
             da: 0.00026291, de: 0.00005105, di: 0.00035372, dL: 218.45945325, dvarpi: -0.32241464, dnode: -0.00508664 },
  pluto:   { a: 39.48211675, e: 0.24882730, i: 17.14001206, L: 238.92903833, varpi: 224.06891629, node: 110.30393684,
             da: -0.00031596, de: 0.00005170, di: 0.00004818, dL: 145.20780515, dvarpi: -0.04062942, dnode: -0.01183482 },
};

export const BODY_BY_ID = Object.fromEntries(BODIES.map(b => [b.id, b]));
export function childrenOf(id) { return BODIES.filter(b => b.parent === id); }
