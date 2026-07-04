# Solar System Simulator

A scientifically accurate, to-scale, real-time 3D solar system in the browser.
No build step, no server-side code — static files + WebGL2.

![validation](https://img.shields.io/badge/validation-14%2F14%20checks-brightgreen)

## Run it

Serve the directory with any static file server and open it:

```bash
cd ATeddyBearDude
python3 -m http.server 8000        # or: npx serve
# → http://localhost:8000
```

(A server is required because the app uses ES modules; opening `index.html`
via `file://` won't work in most browsers.)

Validate the ephemeris against real historical events:

```bash
node tests/validate.mjs
```

## What's inside

### Positioning engine (the accuracy core)

- **Planets, Moon, Pluto** — analytic ephemerides via the vendored
  [astronomy-engine](https://github.com/cosinekitty/astronomy) (MIT):
  VSOP87 truncation for the eight planets, an ELP2000-class lunar theory
  for the Moon, and a TOP2013-derived model for the Pluto system barycenter.
  Deterministic and **exactly time-reversible** — play forward, backward, or
  jump to any date; there is no integration state to drift.
- **Galilean moons** — astronomy-engine's Lieske E5-based theory.
- **Outer-planet moons, Charon, dwarf planets** — precessing-Keplerian
  propagation from JPL mean/osculating elements. Moon orbits live in their
  parent's IAU equator frame; nodal regression and apsidal precession are
  derived physically from the parent's J2. Dwarf-planet elements are
  full-precision JPL SBDB osculating elements (epoch JD 2461200.5).
- **Rotation states** — IAU/WGCCRE pole + prime-meridian models
  (astronomy-engine `RotationAxis`) for Sun, planets, Moon, Pluto; true
  tidal locking (pole = orbit normal, meridian faces parent) for the other
  moons; measured poles/spin rates for the dwarfs. Axial tilt is applied to
  every rendered surface.
- **Pluto–Charon** — both bodies orbit their mutual barycenter with the real
  mass ratio (the barycenter lies outside Pluto).
- **Light-time delay** (toggle) — bodies are drawn at retarded positions as
  seen from the camera's home body (2 fixed-point iterations).
- **Optional N-body mode** — symplectic velocity-Verlet integration of Sun +
  planets + Moon + Pluto + dwarfs, seeded from the ephemeris at activation.
  Clearly labelled as divergent; the UI shows live Earth divergence vs the
  analytic solution. Moons ride along with their integrated parents.

### Observed-phenomena correctness

These *emerge from geometry* — nothing is scripted — and are covered by
`tests/validate.mjs` (all passing):

| Check | Result |
|---|---|
| 2017-08-21 total solar eclipse, topocentric from Salem OR at 17:18 UTC | Sun–Moon separation 0.32′, solar disk fully covered |
| Mars 2018 opposition retrograde loop | prograde → retrograde at opposition → prograde |
| Mars closest approach 2018-07-31 | within 1.8 h and 0.01% of the true 0.38496 AU |
| Transit of Venus 2012-06-06 01:30 UTC | Venus 9.3′ from Sun center, inside the 15.8′ disk |
| Moon distance range over a saros | 356 442 – 406 677 km |
| Galilean sidereal periods (measured from the model) | match published values |
| Exact reversibility (t → ±100 yr → t) | bit-identical positions |

Eclipse rendering is physical: every surface fragment computes the visible
fraction of the Sun's disk against nearby occluding spheres
(circle–circle overlap in the shader), so solar eclipses show real
**umbra/penumbra/antumbra** structure sweeping across Earth, lunar eclipses
darken the Moon, and the Galilean moons throw shadows onto Jupiter and each
other. Saturn's rings shadow the planet and the planet shadows the rings.

### Bodies

Sun · 8 planets · Earth's Moon · Io, Europa, Ganymede, Callisto · Mimas,
Enceladus, Tethys, Dione, Rhea, Titan, Iapetus · Miranda, Ariel, Umbriel,
Titania, Oberon · Triton · Pluto + Charon · Ceres, Eris, Haumea, Makemake ·
ring systems for Saturn (photo texture), Jupiter, Uranus, Neptune ·
main asteroid belt (25 000 particles, with Kirkwood gaps), Jupiter Trojan
clouds at L4/L5 (4 200), Kuiper belt with plutinos/classical/scattered
components (14 000).

### Scale

- Default **true 1:1** for sizes *and* distances.
- **Visibility scale** toggle exaggerates body radii only (×1–×10 000,
  slider); orbital geometry always stays 1:1. The current mode and factor
  are always shown in the status bar, plus a live "1 px ≈ X km" reference.

### Camera

- **Orbit mode**: lock onto any body; drag to rotate, wheel to zoom,
  right-drag to pan; smooth focus transitions; double-click any body to
  travel to it.
- **Surface mode**: stand at any lat/lon on any body. The viewpoint rides
  the body's true rotation; drag looks around (alt-az), wheel zooms FOV
  down to 0.35° (telescope). "Look at" tracks any other body across the sky
  — watch retrograde loops, eclipses, transits, phases and apparent-size
  changes exactly as observed.
- **Trace target path** draws the selected body's apparent path against the
  stars from your current viewpoint (the classic retrograde-loop figure).

### Time

Play / pause / reverse / speed presets from 1 s/s to 25 yr/s · set any
date/time (UTC or Julian Date readout) · step by arbitrary amounts of
seconds, minutes, hours, **solar days, sidereal days**, or Julian years.

### Editing (counterfactuals)

Every body's orbital elements (a, e, i, Ω, ω, M₀) are editable. The editor
shows live **osculating elements computed from the actual ephemeris state**;
applying switches that body to a clearly-labelled Keplerian override, and
*reset* returns it to the exact analytic ephemeris. Defaults are always the
real measured values; one button resets everything.

### Extras

Eclipse/transit/opposition/moon-phase **event search** (jumps you to the
event — solar eclipses even place you on the centerline looking at the Sun) ·
Lagrange-point markers (Sun–Earth/Mars/Jupiter/Saturn, Earth–Moon; collinear
points Newton-solved from the CR3BP each frame) · shadow-cone visualization ·
angular-separation + distance **measurement tool** · ecliptic plane grid,
equatorial + ecliptic sky grids · full **save/load** of simulation state
(file or localStorage) · keyboard shortcuts (press `H`).

### Sky

NASA SVS Tycho star map (real stars + the Milky Way band) rendered in true
equatorial orientation by direction-sampling in the shader — the galactic
plane sits exactly where it belongs relative to the ecliptic.

## Rendering & performance tradeoffs

- **1:1 scale over 10⁹ km** is handled with a floating origin (all positions
  are computed relative to the camera focus in float64 on the CPU) plus a
  logarithmic depth buffer. Sub-meter precision near the camera, no z-fighting.
- **Belt particles** propagate their own Keplerian orbits *in the vertex
  shader* (per-particle elements as vertex attributes, one time uniform, a
  4-iteration Newton solve of Kepler's equation per vertex). 43 000+
  particles cost zero CPU per frame. Tradeoff: float32 time reduction limits
  particle phase accuracy to ~arcminutes after centuries — irrelevant for a
  statistical population (which these are: distributions match, individual
  asteroids are not real objects).
- **Textures**: 2k photo maps (~13 MB total) for Sun, planets, Moon, Ceres +
  the IAU-fictional dwarf maps; seeded procedural generation (3D sphere-domain
  noise: seamless, pole-artifact-free) for the outer-planet moons, Pluto and
  Charon with their known gross features (Iapetus dichotomy, Enceladus tiger
  stripes, Pluto's Sputnik Planitia…). Drop higher-res files into `textures/`
  with the same names to upgrade. The 4k star map blurs at telescope FOVs —
  swap in the 8k/16k NASA versions for sharper skies at the cost of load time.
- Planet/ring/atmosphere materials are hand-written GLSL (terminator with
  twilight softness, analytic extended-Sun occlusion, Earth night lights,
  ring translucency/backlighting).

## Known approximations (honesty section)

- Orbital *phases at epoch* for the non-Galilean outer moons are approximate
  (their planes, shapes, periods and precession are real; JPL mean-element
  epoch phases were not all available). Sun/Moon/planets — the bodies all
  the validated phenomena depend on — are ephemeris-grade.
- Apparent magnitudes for moons/dwarfs use an H-G photometric model derived
  from radius + geometric albedo (≈ a few tenths of a magnitude); planets are
  similarly approximated from albedo rather than per-planet empirical fits.
- The N-body mode is Newtonian point masses only (no relativity, no
  oblateness coupling) — that's why it's labelled as diverging.
- Visibility-scale mode uses the *displayed* (inflated) radii for eclipse
  shading and shadow cones so what you see stays self-consistent; switch to
  true 1:1 scale for physically exact shadow geometry.
- Topocentric parallax applies to the camera position (you stand on the
  rotating surface); the info-panel RA/Dec is J2000 geometric direction from
  the camera without atmospheric refraction.

## Credits & licenses

- [astronomy-engine](https://github.com/cosinekitty/astronomy) — Don Cross,
  MIT (vendored: `vendor/astronomy.esm.js`)
- [three.js](https://threejs.org) — MIT (vendored: `vendor/three.module.js`)
- Planet/moon photo textures — [Solar System Scope](https://www.solarsystemscope.com/textures/)
  (CC BY 4.0; based on NASA elevation/imagery)
- Star map — NASA/Goddard Space Flight Center Scientific Visualization
  Studio, Tycho catalog ([SVS 3895](https://svs.gsfc.nasa.gov/3895)), public domain
- Saturn ring alpha texture — Solar System Scope (CC BY 4.0)
- Everything else (code, procedural textures) — this repository
