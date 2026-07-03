# Methods — 3-D FDTD Electromagnetic Wave Simulator

This document states the governing equations, the discretization, the stability
condition, the source and boundary models, what is classical vs. (optionally)
quantum, and the validation procedure.

## 1. Governing equations (classical core)

The solver integrates the **full time-domain Maxwell curl equations** for the
3-D vector fields **E**(x, y, z, t) and **H**(x, y, z, t) — no scalar, paraxial,
1-D or 2-D reduction:

```
μ ∂H/∂t = −∇×E − M                    (Faraday)
ε ∂E/∂t =  ∇×H − σE − J_d − J_s       (Ampère–Maxwell)
```

* `ε = ε₀ε_r`, `μ = μ₀μ_r`, `σ` — per-cell material parameters (regions in the UI).
* `J_s`, `M` — impressed source currents (Section 4).
* `J_d` — Drude polarization current (Section 5).

**Units.** Normalized units with `c = ε₀ = μ₀ = η₀ = 1`. The UI displays one
length unit as 1 µm; the time unit is therefore 1 µm/c = **3.335641 fs**.
Frequencies follow from `ω = 2πc/λ`; conductivity σ and the Drude parameters
(ω_p, γ) are in normalized 1/time units (the UI accepts λ_p in µm and γ in
fs⁻¹ and converts). To convert any normalized field/quantity to SI, multiply by
the appropriate combination of (1 µm, 1 µm/c, ε₀, μ₀).

### On QED

For propagation in free space and in linear media, classical Maxwell theory is
**exact** — QED reduces to it in the classical/coherent (large-photon-number)
limit. The propagation engine is therefore Maxwell/FDTD and contains no quantum
formalism; bolting quantum machinery onto the propagation of a classical
coherent field would add nothing and reduce accuracy. Everything in this
simulator is classical. The Hertzian dipole is the physically correct classical
radiator; its sin²θ pattern is also what QED predicts in the appropriate
(coherent/correspondence) limit of dipole transitions. If quantum features were
added later (e.g. a single-photon mode-function visualization), they would live
in a clearly separated optional layer and never modify this solver.

## 2. Yee discretization

Fields live on the staggered **Yee lattice** (cell size `dx = dy = dz`), stored
at cell index (i, j, k):

| Component | Location |
|---|---|
| Ex | (i+½, j, k) |
| Ey | (i, j+½, k) |
| Ez | (i, j, k+½) |
| Hx | (i, j+½, k+½) |
| Hy | (i+½, j, k+½) |
| Hz | (i+½, j+½, k) |

Time is staggered too (**leapfrog**): E lives at integer steps `n·dt`, H at
half steps `(n+½)·dt`. One update cycle (normalized units):

```
Hx|ⁿ⁺½ = Hx|ⁿ⁻½ − dt/μ_r [ (Ez_{j+1}−Ez)/dx − (Ey_{k+1}−Ey)/dx + Mx|ⁿ ]   (+ cyclic for Hy, Hz)

Ex|ⁿ⁺¹ = ca·Ex|ⁿ + cb·[ (Hz−Hz_{j−1})/dx − (Hy−Hy_{k−1})/dx − Jd_x − Js_x|ⁿ⁺½ ]  (+ cyclic)

ca = (1 − σdt/2ε)/(1 + σdt/2ε),   cb = (dt/ε)/(1 + σdt/2ε)      (semi-implicit conductivity)
```

All spatial derivatives are the standard second-order-accurate centered
differences of the Yee scheme. The curl structure guarantees ∇·B = 0 and (in
source-free regions) ∇·D = 0 to machine precision at all times.

Materials are sampled at cell centers (all six components of a cell see the
same ε_r, μ_r, σ): curved interfaces are staircased at the dx scale — a
standard first-order FDTD material approximation.

## 3. Stability and sampling

* **Courant (CFL) condition** (3-D, cubic cells): `c·dt ≤ dx/√3`.
  The UI exposes the Courant factor S and sets `dt = S·dx/(c√3)` with S ≤ 1
  (default 0.5), so the bound is enforced by construction.
* **Spatial sampling:** `dx = λ_min / ppw` where λ_min is the shortest enabled
  source wavelength and ppw (points per wavelength) is clamped to **≥ 15**
  (default 15; raise it for lower numerical dispersion).
* Numerical dispersion: at 15 cells/λ the on-axis phase-velocity error is
  ≲ 0.5 %; the validation suite reports the theoretical FDTD group velocity for
  the exact grid used so the measured speed can be compared against both c and
  theory.

## 4. Sources

All sources are **soft** (added as impressed currents, so they do not scatter).

* **Hertzian (point) dipole** — an oscillating current in a single Yee cell,
  `J_s = −(A/dx)·p̂(t)·f(t)`: the physically correct elementary radiator with
  the true 3-D sin²θ donut pattern. "Direction" sets the dipole axis;
  ellipticity > 0 adds a quadrature component perpendicular to it (45° =
  circular → rotating dipole).
* **Plane wave** — a one-cell-thick **Huygens sheet**: electric current
  `J_s = −p̂ (A/η₀ dx) f(t)` plus the matched magnetic current `M = d̂ × J_s`
  evaluated at the H-grid's staggered position and time (retardation
  `t − d̂·Δr/c` with Δr = dx/2), which cancels the backward wave to
  discretization order → a unidirectional plane wave of E-amplitude exactly A.
  The sheet is smoothly tapered near the PML.
* **Gaussian beam** — the same Huygens sheet with a Gaussian transverse profile
  `exp(−r²/w₀²)` (waist at the sheet, flat phase). Injection is the standard
  waist ansatz; propagation is still full-vector Maxwell, so the beam exhibits
  correct diffraction.

Per source: amplitude, wavelength (µm), phase, polarization angle χ,
ellipticity (0° linear … 45° circular; the quadrature component is +90° in
time), propagation direction/dipole axis (±x, ±y, ±z), and **pulsed**
(Gaussian envelope `exp(−((t−t₀)/τ)²)`, τ in optical periods) vs **CW**
(smooth 3-period turn-on). Up to 4 simultaneous sources.

## 5. Media

Per-region (box or sphere, applied in list order): relative permittivity ε_r,
relative permeability μ_r, conductivity σ, or

* **PEC** — perfect electric conductor (E forced to zero), and
* **Drude dispersion** (optional dispersive model):
  `ε(ω) = ε₀(1 − ω_p²/(ω² + iγω))`, implemented in the time domain with the
  **auxiliary differential equation (ADE)** for the polarization current:

  ```
  ∂J_d/∂t + γ J_d = ε₀ ω_p² E
  J_d|ⁿ⁺½ ≈ ½(J|ⁿ⁺ + J|ⁿ),  J|ⁿ⁺ = α J|ⁿ + β E|ⁿ,
  α = (1−γdt/2)/(1+γdt/2),  β = ω_p² dt/(1+γdt/2)
  ```

## 6. Boundaries

* **PML (default)** — Convolutional PML (CPML; Roden & Gedney 2000) on all six
  faces: each spatial derivative D entering a curl inside the PML is replaced by
  `D/κ + ψ` with the recursive convolution
  `ψⁿ = b ψⁿ⁻¹ + a Dⁿ`, `b = exp(−(σ_p/κ + α)dt)`, `a = σ_p/(σ_pκ + κ²α)(b−1)`,
  κ = 1, cubic grading `σ_p(d) = σ_max d³` with `σ_max = 0.8(m+1)/(η₀ dx)`
  (m = 3) and linear CFS `α(d) = α_max(1−d)`. ψ is stored for all 12 split
  derivative terms (6 for E, 6 for H) and evaluated at each component's true
  staggered position. The PML is backed by a PEC wall.
* **Reflecting** — PML disabled; the outer wall is a PEC mirror
  (tangential E = 0).
* **Periodic** — all fetches wrap around; PML disabled.

## 7. Validation (in-app, "Validation" panel)

1. **Wave speed = c in vacuum.** A pulsed (2-period) plane wave propagates
   along +x through vacuum with PML boundaries. The Ey time series is recorded
   at two probes D cells apart; the group delay is extracted by
   cross-correlating the two series (with sub-step parabolic interpolation of
   the correlation peak). Pass: |v − c| < 1.5 %. The report also prints the
   theoretical FDTD group velocity on the same grid (from the 1-D discrete
   dispersion relation `sin(ωdt/2)/(cdt) = sin(kdx/2)/dx`), against which the
   measured value agrees more tightly — showing the residual is numerical
   dispersion, not an error in the physics.

2. **Dipole radiation pattern.** A CW z-oriented Hertzian dipole radiates in
   vacuum; after the wave fills the sampling sphere plus 8 periods of settling,
   the transverse intensity `⟨|E_t|²⟩` (radial near-field component projected
   out) is time-averaged over exactly one optical period on a 72-point circle
   of radius r in the xz-plane (kr ≈ 9–14 depending on grid, i.e. the
   radiation zone) and fit to the exact Hertzian pattern `K sin²θ`. A 24-point
   equatorial circle checks azimuthal isotropy. Pass: RMS deviation < 8 % of K
   and equatorial std/mean < 5 %. The measured pattern is plotted against the
   ideal sin²θ curve.

Headless CI results for this build (SwiftShader, N = 64, ppw = 15, S = 0.5) are
recorded in README.md; run the same two buttons in the app to reproduce on
your grid.

## 8. Stack choice and accuracy trade-off

**Chosen: browser, real-time, GPU (WebGL2).** The FDTD update is executed in
fragment shaders over ping-ponged 32-bit-float texture atlases (the N z-slices
tiled into a 2-D texture; 3 MRT outputs for the H pass, 4 for the E pass), so a
96³–128³ grid steps at interactive rates and the 3-D visualization (volume
raymarching, slices, vector glyphs) reads the field textures directly with zero
copy.

Trade-off vs. an offline Python/float64 solver: (a) **single precision** —
round-off ~10⁻⁷ per step instead of 10⁻¹⁶, irrelevant next to the O(10⁻³)
discretization error at 15–30 cells/λ but a real limit for very long runs or
> 60 dB dynamic range; (b) grid sizes bounded by GPU memory (~128³–160³ here vs
≥ 512³ offline); (c) material boundaries staircased at cell centers rather than
subcell-averaged. The physics core (Yee + leapfrog + CPML + ADE) is identical
to what a research FDTD code does — accuracy is dominated by resolution, which
is adjustable in the UI, not by the platform.

## 9. Visualization notes (display only — never affects the solver)

Fields are copied to a half-float linear-filterable atlas for volume
raymarching; the slice view, vector glyphs, probes and validation read the
full-precision 32-bit textures. Amplitude maps to color and opacity
(perceptually uniform viridis/inferno for |E|², diverging coolwarm for signed
components so wavefronts and the spatial oscillation at scale λ are directly
visible); clip planes, slice position, colormap, gain and opacity are
interactive. The time scrubber replays captured slice frames while paused
(FDTD is not time-reversible in the presence of loss/PML, so scrubbing is a
recording, not a re-simulation).

## References

* K. S. Yee, IEEE Trans. Antennas Propag. **14**, 302 (1966).
* A. Taflove & S. C. Hagness, *Computational Electrodynamics: The
  Finite-Difference Time-Domain Method*, 3rd ed., Artech House (2005).
* J. A. Roden & S. D. Gedney, "Convolutional PML (CPML)…", Microw. Opt.
  Technol. Lett. **27**, 334 (2000).
