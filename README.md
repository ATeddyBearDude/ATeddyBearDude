# 3-D Electromagnetic Wave Simulator (FDTD · Maxwell · WebGL2)

A scientifically accurate, real-time 3-D electromagnetic wave propagation
simulator that runs in the browser on the GPU.

The physics core solves the **full time-domain Maxwell curl equations** for the
3-D vector fields **E** and **H** with the **FDTD method on a Yee staggered
grid with leapfrog time stepping** — no scalar, paraxial, or lower-dimensional
approximation. Propagation is purely classical Maxwell (which is exact for
free space and linear media; QED reduces to it in the coherent limit — see
[METHODS.md](METHODS.md)).

**Stack:** browser + WebGL2 GPU was chosen for real-time interactive 3-D
visualization; the accuracy trade-off vs. an offline float64 Python solver is
stated in METHODS.md §8.

## Run it

No build step, no dependencies:

```bash
python3 -m http.server 8000     # from the repo root
# open http://localhost:8000/
```

(Opening `index.html` directly from disk also works in browsers that allow
local `file://` scripts.)

**Requirements:** a browser with WebGL2 and `EXT_color_buffer_float`
(Chrome/Edge/Firefox/Safari, any recent desktop version; a discrete or
integrated GPU recommended — 96³ runs in real time on modest hardware).

## Features

* **Solver** — Yee-grid FDTD in 32-bit float GPU textures; CPML absorbing
  boundaries (default), PEC reflecting and periodic options; per-region
  ε_r, μ_r, σ; Drude dispersive media via ADE; CFL condition enforced
  (`dt = S·dx/(c√3)`, S ≤ 1); ≥ 15 grid cells per shortest wavelength enforced.
* **Sources** (up to 4, all customizable: amplitude, wavelength, phase,
  polarization angle, ellipticity 0°–45° = linear→circular, direction,
  pulsed/CW) — Hertzian point dipole (true 3-D donut radiation pattern),
  unidirectional plane wave (Huygens J+M sheet), Gaussian beam.
* **Visualization** — volume raymarching of |E|², amplitude |E|, or signed field components,
  slice planes with material overlay, instanced E-vector glyphs, orbit/pan/zoom
  camera, clip box, four colormaps, gain/opacity controls, play/pause/step,
  time-scrub of recorded slice history.
* **Presets** — Hertzian dipole, rotating (circular) dipole, plane-wave pulse,
  double slit, dielectric slab (n = 1.5), dielectric sphere lens, Drude metal
  mirror, Gaussian beam.
* **Validation** (buttons in the app) — (1) pulse time-of-flight between two
  probes confirms wave speed = c in vacuum; (2) time-averaged transverse
  intensity of a CW dipole fits the exact sin²θ pattern, with a polar plot.

**Units:** normalized `c = ε₀ = μ₀ = 1`; lengths displayed in µm, time in fs
(1 time unit = 3.336 fs). Stated in the UI header and METHODS.md §1.

## Validation results (this build)

Headless run (Chromium/SwiftShader software GL, N = 64³, 15 cells/λ, S = 0.5):

| Test | Result |
|---|---|
| Wave speed in vacuum (pulse time-of-flight, infinite plane wave) | **PASS** — v = 0.97691 c measured; exact FDTD dispersion theory for this grid predicts v_g = 0.97964 c (agreement 0.28 %). The −2.3 % offset from c is the predicted second-order grid dispersion at 15 cells/λ and vanishes as cells/λ is raised. |
| Dipole radiation pattern (fit of ⟨\|E_t\|²⟩ to K sin²θ at kr ≈ 7.5) | **PASS** — RMS deviation 3.59 % of K; azimuthal isotropy 2.29 % std/mean. |

Reproduce in the app: Validation panel → buttons 1 and 2 (runs on your current
grid; higher ppw → smaller dispersion error).

## Files

| Path | Contents |
|---|---|
| `index.html` | UI shell (no build step, plain JS) |
| `js/shaders.js` | All GLSL: FDTD update passes (H, E), CPML, sources, raymarcher, slice, glyphs |
| `js/sim.js` | GPU solver: textures/FBOs, stepping, materials, probes, readback |
| `js/viz.js` | Camera, volume/slice/glyph rendering, slice history ring |
| `js/validate.js` | Wave-speed and dipole-pattern tests + polar plot |
| `js/main.js` | UI wiring, presets, main loop |
| `METHODS.md` | Equations, Yee discretization, CFL, CPML, sources, classical-vs-quantum statement, validation methodology |

## Performance tips

* 96³ (default) is comfortable on most GPUs; 128³–160³ needs ~0.5–1.5 GB of
  GPU memory (16 float atlases for E, H, 8 CPML ψ fields, Drude J, materials).
* Raise "steps/frame" for faster simulated time; lower "ray steps" or disable
  the volume view on weak GPUs.
* Changing wavelength, grid size, ppw, Courant factor, or boundaries rebuilds
  the grid (fields reset); source amplitude/phase/polarization and materials
  update live.
