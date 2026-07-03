"use strict";
/* ============================================================================
 * GLSL shader sources for the 3-D FDTD Maxwell solver and its renderer.
 *
 * UNITS CONVENTION (stated here and in the UI / METHODS.md):
 *   Normalized units with  c = eps0 = mu0 = eta0 = 1.
 *   One length unit is displayed as 1 micrometer (um);
 *   one time unit is therefore 1 um / c = 3.335641 fs.
 *   Material parameters eps_r, mu_r are relative (dimensionless);
 *   sigma and the Drude (omega_p, gamma) are in normalized 1/time units.
 *
 * FIELD STORAGE
 *   The 3-D Yee grid (N x N x N) is stored as a 2-D "atlas" texture:
 *   the N z-slices are tiled in a TX x TY grid of N x N tiles.
 *   Texel (i, j) of tile z holds the Yee cell (i, j, k = z):
 *     E.xyz = (Ex(i+1/2,j,k), Ey(i,j+1/2,k), Ez(i,j,k+1/2))
 *     H.xyz = (Hx(i,j+1/2,k+1/2), Hy(i+1/2,j,k+1/2), Hz(i+1/2,j+1/2,k))
 * ========================================================================= */

const SHADERS = (() => {

/* ---------------------------------------------------------------- common - */

const FS_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const COMMON = `
uniform int uN;         // grid size (cells per side)
uniform int uTX;        // atlas tiles per row
uniform int uBoundary;  // 0 = PML, 1 = PEC (reflecting), 2 = periodic

ivec2 atlasCoord(ivec3 p){
  return ivec2((p.z % uTX) * uN + p.x, (p.z / uTX) * uN + p.y);
}

// Fetch with boundary handling: outside the grid the field is 0 (PEC backing)
// unless boundaries are periodic, in which case indices wrap.
vec4 fetch3(sampler2D s, ivec3 p){
  if (uBoundary == 2) {
    // positive modulo via float mod (GLSL int % is undefined for negatives)
    p = ivec3(mod(vec3(p) + 0.5, float(uN)));
  } else {
    if (any(lessThan(p, ivec3(0))) || any(greaterThanEqual(p, ivec3(uN))))
      return vec4(0.0);
  }
  return texelFetch(s, atlasCoord(p), 0);
}

ivec3 cellOf(ivec2 frag){
  ivec2 tile = frag / uN;
  return ivec3(frag.x % uN, frag.y % uN, tile.y * uTX + tile.x);
}
`;

/* ------------------------------------------------------------------- PML - */
/* Convolutional PML (CPML, Roden & Gedney 2000) with kappa = 1 and a
 * complex-frequency-shifted alpha.  Coefficients are evaluated analytically
 * from the (staggered) cell coordinate along each axis:
 *   psi^n = b * psi^{n-1} + a * (dF/du)^n ,   term = dF/du + psi
 *   b = exp(-(sigma + alpha) dt),  a = sigma/(sigma+alpha) (b - 1)
 *   sigma(d) = sigma_max d^3,  alpha(d) = alpha_max (1 - d),  d in (0,1]
 */
const PML = `
uniform float uDx, uDt;
uniform float uPmlW;      // PML thickness in cells (0 disables)
uniform float uPmlSigMax; // sigma_max, normalized (0.8*(m+1)/dx, m = 3)
uniform float uPmlAlpha;  // alpha_max (CFS), normalized

vec2 cpml(float pos){
  if (uBoundary != 0 || uPmlW <= 0.5) return vec2(1.0, 0.0);
  float nf = float(uN) - 1.0;
  float d = 0.0;
  if      (pos < uPmlW)      d = (uPmlW - pos) / uPmlW;
  else if (pos > nf - uPmlW) d = (pos - (nf - uPmlW)) / uPmlW;
  if (d <= 0.0) return vec2(1.0, 0.0);
  d = min(d, 1.0);
  float sg = uPmlSigMax * d * d * d;
  float al = uPmlAlpha * (1.0 - d);
  float b  = exp(-(sg + al) * uDt);
  float a  = (sg + al > 1e-20) ? sg / (sg + al) * (b - 1.0) : 0.0;
  return vec2(b, a);
}
`;

/* --------------------------------------------------------------- sources - */
/* Sources are injected as electric current density J in the E-update and,
 * for the sheet sources (plane wave / Gaussian beam), a matched magnetic
 * current density M = d_hat x J in the H-update (Huygens pair), which makes
 * the sheet radiate in one direction only.  M is evaluated with the
 * space-time retardation of its staggered location (+dx/2 along the axis,
 * H-update time), so the backward wave cancels to discretization order.
 *
 * Per source (max 4):
 *   uSrcA = (type, axis, sign, enabled)   type: 0 dipole, 1 plane, 2 gauss
 *   uSrcB = (px, py, pz, amplitude)       position in cells
 *   uSrcC = (omega, phase, chi, ellip)    chi: pol. rotation, ellip: 0=lin..pi/4=circ
 *   uSrcD = (pulsed, t0, tau, waist)      tau in time units, waist in cells
 */
const SRC = `
uniform int   uNumSrc;
uniform vec4  uSrcA[4];
uniform vec4  uSrcB[4];
uniform vec4  uSrcC[4];
uniform vec4  uSrcD[4];
uniform float uT;       // time at which this pass's sources are evaluated

void srcBasis(int axis, out vec3 d, out vec3 u, out vec3 v){
  if      (axis == 0){ d = vec3(1,0,0); u = vec3(0,1,0); v = vec3(0,0,1); }
  else if (axis == 1){ d = vec3(0,1,0); u = vec3(0,0,1); v = vec3(1,0,0); }
  else               { d = vec3(0,0,1); u = vec3(1,0,0); v = vec3(0,1,0); }
}

float srcEnvelope(float t, float pulsed, float t0, float tau, float period){
  if (pulsed > 0.5){ float x = (t - t0) / tau; return exp(-x * x); }
  float r = t / (3.0 * period);            // smooth CW turn-on over 3 periods
  return r >= 1.0 ? 1.0 : r * r * (3.0 - 2.0 * r);
}

// Electric current density J of source i at cell p, evaluated at time t.
vec3 sourceJ(ivec3 p, float t, int i){
  vec4 A = uSrcA[i];
  if (A.w < 0.5 || t < 0.0) return vec3(0.0);
  vec4 B = uSrcB[i]; vec4 C = uSrcC[i]; vec4 D = uSrcD[i];
  int type = int(A.x); int axis = int(A.y); float sgn = A.z;
  vec3 d, u, v; srcBasis(axis, d, u, v); d *= sgn;
  float cchi = cos(C.z), schi = sin(C.z);
  vec3 u2 =  u * cchi + v * schi;
  vec3 v2 = -u * schi + v * cchi;
  float period = 6.28318530718 / C.x;
  float env = srcEnvelope(t, D.x, D.y, D.z, period);
  float s1 = sin(C.x * t + C.y) * env;   // in-phase
  float s2 = cos(C.x * t + C.y) * env;   // quadrature (+90 deg)
  float ce = cos(C.w), se = sin(C.w);
  float amp = B.w;

  if (type == 0) {
    // Hertzian dipole: point current at one cell; axis = d (the "direction"
    // control); ellipticity rotates the moment toward u2 -> rotating dipole.
    if (any(notEqual(p, ivec3(round(B.xyz))))) return vec3(0.0);
    return -(amp / uDx) * (d * (ce * s1) + u2 * (se * s2));
  }

  // Sheet sources: one cell-thick plane perpendicular to the axis.
  float posAxis = (axis == 0) ? B.x : (axis == 1) ? B.y : B.z;
  int   pi      = (axis == 0) ? p.x : (axis == 1) ? p.y : p.z;
  if (pi != int(round(posAxis))) return vec3(0.0);

  vec3  pc = vec3(p) - B.xyz;
  float g = 1.0;
  if (type == 2) {                       // Gaussian beam (waist at the sheet)
    float a = dot(pc, u), b = dot(pc, v);
    float w = max(D.w, 1.0);
    g = exp(-(a * a + b * b) / (w * w));
  } else if (uBoundary != 2) {           // plane wave: taper near the PML
    float m  = uPmlW + 3.0;
    float nf = float(uN) - 1.0;
    vec3 pf  = vec3(p);
    float ta = (axis == 0) ? pf.y : (axis == 1) ? pf.z : pf.x;
    float tb = (axis == 0) ? pf.z : (axis == 1) ? pf.x : pf.y;
    g  = smoothstep(m - 3.0, m + 3.0, ta) * smoothstep(m - 3.0, m + 3.0, nf - ta);
    g *= smoothstep(m - 3.0, m + 3.0, tb) * smoothstep(m - 3.0, m + 3.0, nf - tb);
  }
  // Volume current J = Js/dx with Js = -p_hat (A/eta) f  ->  plane wave of
  // E-amplitude exactly A (eta = 1 in normalized units).
  return -(amp / uDx) * g * (u2 * (ce * s1) + v2 * (se * s2));
}

vec3 totalJ(ivec3 p, float t){
  vec3 J = vec3(0.0);
  for (int i = 0; i < 4; i++){ if (i >= uNumSrc) break; J += sourceJ(p, t, i); }
  return J;
}

// Magnetic current for the Huygens pair: M = d_hat x J at the retarded time
// of the H sheet (staggered +dx/2 along the propagation axis).
vec3 totalM(ivec3 p, float t){
  vec3 M = vec3(0.0);
  for (int i = 0; i < 4; i++){
    if (i >= uNumSrc) break;
    vec4 A = uSrcA[i];
    if (A.w < 0.5 || int(A.x) == 0) continue;   // dipoles: no M
    int axis = int(A.y); float sgn = A.z;
    vec3 d, u, v; srcBasis(axis, d, u, v); d *= sgn;
    vec3 J = sourceJ(p, t - sgn * 0.5 * uDx, i); // c = 1 retardation
    M += cross(d, J);
  }
  return M;
}
`;

/* ------------------------------------------------------ fullscreen vertex - */

const V_FULLSCREEN = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ----------------------------------------------------------- H update ----
 * Faraday:  mu dH/dt = -(curl E + M)
 * Yee: forward differences of E; leapfrog half-step ahead of E.
 */
const F_STEP_H = FS_HEADER + COMMON + PML + SRC + `
uniform sampler2D uE, uH, uPa, uPb, uMat1;
layout(location = 0) out vec4 oH;
layout(location = 1) out vec4 oPa;
layout(location = 2) out vec4 oPb;

void main(){
  ivec3 p = cellOf(ivec2(gl_FragCoord.xy));
  if (p.z >= uN){ oH = vec4(0); oPa = vec4(0); oPb = vec4(0); return; }
  ivec2 ac = atlasCoord(p);

  vec3 E0  = texelFetch(uE, ac, 0).xyz;
  vec3 H0  = texelFetch(uH, ac, 0).xyz;
  vec3 Ex1 = fetch3(uE, p + ivec3(1,0,0)).xyz;
  vec3 Ey1 = fetch3(uE, p + ivec3(0,1,0)).xyz;
  vec3 Ez1 = fetch3(uE, p + ivec3(0,0,1)).xyz;

  float inv = 1.0 / uDx;
  float dEz_dy = (Ey1.z - E0.z) * inv;
  float dEy_dz = (Ez1.y - E0.y) * inv;
  float dEx_dz = (Ez1.x - E0.x) * inv;
  float dEz_dx = (Ex1.z - E0.z) * inv;
  float dEy_dx = (Ex1.y - E0.y) * inv;
  float dEx_dy = (Ey1.x - E0.x) * inv;

  // CPML coefficients at the H components' staggered (half-cell) positions
  vec2 abx = cpml(float(p.x) + 0.5);
  vec2 aby = cpml(float(p.y) + 0.5);
  vec2 abz = cpml(float(p.z) + 0.5);
  vec4 pa = texelFetch(uPa, ac, 0);
  vec4 pb = texelFetch(uPb, ac, 0);
  float pHxy = aby.x * pa.x + aby.y * dEz_dy;
  float pHxz = abz.x * pa.y + abz.y * dEy_dz;
  float pHyz = abz.x * pa.z + abz.y * dEx_dz;
  float pHyx = abx.x * pa.w + abx.y * dEz_dx;
  float pHzx = abx.x * pb.x + abx.y * dEy_dx;
  float pHzy = aby.x * pb.y + aby.y * dEx_dy;

  vec3 curlE = vec3(
    (dEz_dy + pHxy) - (dEy_dz + pHxz),
    (dEx_dz + pHyz) - (dEz_dx + pHyx),
    (dEy_dx + pHzx) - (dEx_dy + pHzy));

  float mur = max(texelFetch(uMat1, ac, 0).g, 1e-6);
  vec3 M = totalM(p, uT);
  vec3 H1 = H0 - (uDt / mur) * (curlE + M);

  oH  = vec4(H1, 0.0);
  oPa = vec4(pHxy, pHxz, pHyz, pHyx);
  oPb = vec4(pHzx, pHzy, 0.0, 0.0);
}`;

/* ----------------------------------------------------------- E update ----
 * Ampere-Maxwell:  eps dE/dt = curl H - sigma E - J_drude - J_source
 * Conductivity handled semi-implicitly (exponential-accurate ca/cb).
 * Drude dispersion via the auxiliary differential equation (ADE):
 *   dJd/dt + gamma Jd = eps0 wp^2 E
 */
const F_STEP_E = FS_HEADER + COMMON + PML + SRC + `
uniform sampler2D uE, uH, uPa, uPb, uJd, uMat1, uMat2;
layout(location = 0) out vec4 oE;
layout(location = 1) out vec4 oPa;
layout(location = 2) out vec4 oPb;
layout(location = 3) out vec4 oJd;

void main(){
  ivec3 p = cellOf(ivec2(gl_FragCoord.xy));
  if (p.z >= uN){ oE = vec4(0); oPa = vec4(0); oPb = vec4(0); oJd = vec4(0); return; }
  ivec2 ac = atlasCoord(p);

  vec3 E0  = texelFetch(uE, ac, 0).xyz;
  vec3 H0  = texelFetch(uH, ac, 0).xyz;
  vec3 Hxm = fetch3(uH, p - ivec3(1,0,0)).xyz;
  vec3 Hym = fetch3(uH, p - ivec3(0,1,0)).xyz;
  vec3 Hzm = fetch3(uH, p - ivec3(0,0,1)).xyz;

  float inv = 1.0 / uDx;
  float dHz_dy = (H0.z - Hym.z) * inv;
  float dHy_dz = (H0.y - Hzm.y) * inv;
  float dHx_dz = (H0.x - Hzm.x) * inv;
  float dHz_dx = (H0.z - Hxm.z) * inv;
  float dHy_dx = (H0.y - Hxm.y) * inv;
  float dHx_dy = (H0.x - Hym.x) * inv;

  // CPML coefficients at the E components' (integer) positions
  vec2 abx = cpml(float(p.x));
  vec2 aby = cpml(float(p.y));
  vec2 abz = cpml(float(p.z));
  vec4 pa = texelFetch(uPa, ac, 0);
  vec4 pb = texelFetch(uPb, ac, 0);
  float pExy = aby.x * pa.x + aby.y * dHz_dy;
  float pExz = abz.x * pa.y + abz.y * dHy_dz;
  float pEyz = abz.x * pa.z + abz.y * dHx_dz;
  float pEyx = abx.x * pa.w + abx.y * dHz_dx;
  float pEzx = abx.x * pb.x + abx.y * dHy_dx;
  float pEzy = aby.x * pb.y + aby.y * dHx_dy;

  vec3 curlH = vec3(
    (dHz_dy + pExy) - (dHy_dz + pExz),
    (dHx_dz + pEyz) - (dHz_dx + pEyx),
    (dHy_dx + pEzx) - (dHx_dy + pEzy));

  vec4 m1 = texelFetch(uMat1, ac, 0);
  float epsr  = max(m1.r, 1e-6);
  float sigma = m1.b;
  float flag  = m1.a;              // 0 dielectric, 1 PEC, 2 Drude

  // Drude ADE update (uses E^n; J averaged over the step)
  vec3 Jd0 = texelFetch(uJd, ac, 0).xyz;
  vec3 Jd1 = vec3(0.0), Javg = vec3(0.0);
  if (flag > 1.5) {
    vec2 m2 = texelFetch(uMat2, ac, 0).rg;   // (wp, gamma)
    float al = (1.0 - m2.g * uDt * 0.5) / (1.0 + m2.g * uDt * 0.5);
    float be = (m2.r * m2.r * uDt)      / (1.0 + m2.g * uDt * 0.5);
    Jd1  = al * Jd0 + be * E0;
    Javg = 0.5 * (Jd0 + Jd1);
  }

  vec3 Jsrc = totalJ(p, uT);

  float sd = sigma * uDt / (2.0 * epsr);
  float ca = (1.0 - sd) / (1.0 + sd);
  float cb = (uDt / epsr) / (1.0 + sd);
  vec3 E1 = ca * E0 + cb * (curlH - Javg - Jsrc);

  if (flag > 0.5 && flag < 1.5) { E1 = vec3(0.0); Jd1 = vec3(0.0); } // PEC

  // Tangential E = 0 on the outer wall (PEC backing behind the PML)
  if (uBoundary != 2) {
    if (p.x == 0 || p.x == uN - 1) { E1.y = 0.0; E1.z = 0.0; }
    if (p.y == 0 || p.y == uN - 1) { E1.x = 0.0; E1.z = 0.0; }
    if (p.z == 0 || p.z == uN - 1) { E1.x = 0.0; E1.y = 0.0; }
  }

  oE  = vec4(E1, 0.0);
  oPa = vec4(pExy, pExz, pEyz, pEyx);
  oPb = vec4(pEzx, pEzy, 0.0, 0.0);
  oJd = vec4(Jd1, 0.0);
}`;

/* --------------------------------------------- display copy (32F -> 16F) - */
/* The renderer samples a half-float copy of the field with LINEAR filtering
 * (guaranteed filterable in WebGL2); alpha carries |F|^2. Display only —
 * the solver always runs in 32-bit float. */
const F_DISPLAY = FS_HEADER + `
uniform sampler2D uF;
out vec4 o;
void main(){
  vec4 f = texelFetch(uF, ivec2(gl_FragCoord.xy), 0);
  o = vec4(f.xyz, dot(f.xyz, f.xyz));
}`;

/* ----------------------------------------------------- slice extraction - */
const F_EXTRACT = FS_HEADER + COMMON + `
uniform sampler2D uF;
uniform int uAxis, uIdx;
out vec4 o;
void main(){
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec3 p = (uAxis == 0) ? ivec3(uIdx, q.x, q.y)
          : (uAxis == 1) ? ivec3(q.x, uIdx, q.y)
                         : ivec3(q.x, q.y, uIdx);
  vec3 F = texelFetch(uF, atlasCoord(p), 0).xyz;
  o = vec4(F, dot(F, F));
}`;

/* -------------------------------------------------------------- probes - */
const F_PROBE = FS_HEADER + COMMON + `
uniform sampler2D uF;
uniform vec3 uProbes[96];
uniform int uCount;
out vec4 o;
void main(){
  int x = int(gl_FragCoord.x);
  if (x >= uCount){ o = vec4(0.0); return; }
  ivec3 p = ivec3(round(uProbes[x]));
  vec3 F = texelFetch(uF, atlasCoord(p), 0).xyz;
  o = vec4(F, dot(F, F));
}`;

/* ------------------------------------------------------------ colormaps - */
const CMAP = `
uniform int uCmap; // 0 viridis, 1 inferno, 2 coolwarm (diverging), 3 gray

vec3 cmap(int m, float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c[7];
  if (m == 0) {
    c[0]=vec3(0.267,0.005,0.329); c[1]=vec3(0.275,0.194,0.496);
    c[2]=vec3(0.213,0.359,0.552); c[3]=vec3(0.153,0.497,0.557);
    c[4]=vec3(0.122,0.633,0.530); c[5]=vec3(0.369,0.789,0.383);
    c[6]=vec3(0.993,0.906,0.144);
  } else if (m == 1) {
    c[0]=vec3(0.001,0.000,0.014); c[1]=vec3(0.183,0.037,0.352);
    c[2]=vec3(0.445,0.122,0.507); c[3]=vec3(0.705,0.214,0.401);
    c[4]=vec3(0.906,0.376,0.229); c[5]=vec3(0.988,0.645,0.040);
    c[6]=vec3(0.988,0.998,0.645);
  } else if (m == 2) {
    c[0]=vec3(0.230,0.299,0.754); c[1]=vec3(0.406,0.538,0.934);
    c[2]=vec3(0.602,0.731,0.999); c[3]=vec3(0.865,0.865,0.865);
    c[4]=vec3(0.968,0.720,0.612); c[5]=vec3(0.887,0.464,0.360);
    c[6]=vec3(0.706,0.016,0.150);
  } else {
    c[0]=vec3(0.0); c[1]=vec3(1.0/6.0); c[2]=vec3(2.0/6.0); c[3]=vec3(0.5);
    c[4]=vec3(4.0/6.0); c[5]=vec3(5.0/6.0); c[6]=vec3(1.0);
  }
  float x = t * 6.0;
  int i = int(min(x, 5.0));
  return mix(c[i], c[i + 1], x - float(i));
}
`;

/* ------------------------------------------------------ volume raymarch - */
const V_VOLUME = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const F_VOLUME = FS_HEADER + CMAP + `
uniform sampler2D uDisp;     // half-float display atlas (LINEAR)
uniform float uNf;           // grid size as float
uniform int   uTXv;          // atlas tiles per row
uniform vec2  uTexSize;      // atlas texture size in texels
uniform mat4  uInvVP;
uniform vec3  uCamPos;
uniform vec2  uViewport;
uniform vec3  uClipMin, uClipMax;   // clip box, fractions of the domain
uniform int   uSteps;
uniform int   uMode;         // 0 intensity |E|^2, 1 signed component
uniform int   uComp;         // 0..2 field component (mode 1)
uniform float uGain, uOpacity;
out vec4 o;

vec4 sampleAtlas(vec2 xy, int z){
  vec2 base = vec2(float(z % uTXv), float(z / uTXv));
  vec2 t = clamp(xy, vec2(0.5 / uNf), vec2(1.0 - 0.5 / uNf));
  return texture(uDisp, (base + t) * uNf / uTexSize);
}
vec4 sampleField(vec3 tc){
  float zf = tc.z * uNf - 0.5;
  float z0 = floor(zf);
  float fz = clamp(zf - z0, 0.0, 1.0);
  int i0 = int(clamp(z0,       0.0, uNf - 1.0));
  int i1 = int(clamp(z0 + 1.0, 0.0, uNf - 1.0));
  return mix(sampleAtlas(tc.xy, i0), sampleAtlas(tc.xy, i1), fz);
}

void main(){
  vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
  vec4 pw = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ro = uCamPos;
  vec3 rd = normalize(pw.xyz / pw.w - ro);
  rd = mix(rd, vec3(1e-6), vec3(lessThan(abs(rd), vec3(1e-6))));

  vec3 lo = uClipMin - 0.5, hi = uClipMax - 0.5;
  vec3 t1 = (lo - ro) / rd, t2 = (hi - ro) / rd;
  vec3 tn = min(t1, t2), tf = max(t1, t2);
  float t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float t3 = min(min(tf.x, tf.y), tf.z);
  if (t3 <= t0) discard;

  float dt = (t3 - t0) / float(uSteps);
  vec3 C = vec3(0.0); float A = 0.0;
  for (int i = 0; i < 512; i++){
    if (i >= uSteps) break;
    vec3 tc = ro + rd * (t0 + (float(i) + 0.5) * dt) + 0.5;
    vec4 f = sampleField(tc);
    float a; vec3 col;
    if (uMode == 0){
      float v = f.w * uGain;
      col = cmap(uCmap, clamp(v, 0.0, 1.0));
      a = clamp(v, 0.0, 1.0);
    } else if (uMode == 2){
      float v = sqrt(max(f.w, 0.0)) * uGain;
      col = cmap(uCmap, clamp(v, 0.0, 1.0));
      a = clamp(v, 0.0, 1.0);
    } else {
      float v = f[uComp] * uGain;
      col = cmap(uCmap, clamp(v * 0.5 + 0.5, 0.0, 1.0));
      a = clamp(abs(v), 0.0, 1.0);
    }
    a = max(a - 0.04, 0.0) * 1.042;              // cut low-level haze
    a = clamp(a * uOpacity * 90.0 * dt, 0.0, 1.0);
    C += (1.0 - A) * a * col;
    A += (1.0 - A) * a;
    if (A > 0.98) break;
  }
  if (A <= 0.003) discard;
  o = vec4(C, A);
}`;

/* -------------------------------------------------------- slice display - */
const V_SLICE = `#version 300 es
uniform mat4 uVP;
uniform int uAxis;
uniform float uFrac;
out vec2 vAB;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vAB = c;
  vec3 p = (uAxis == 0) ? vec3(uFrac - 0.5, c.x - 0.5, c.y - 0.5)
         : (uAxis == 1) ? vec3(c.x - 0.5, uFrac - 0.5, c.y - 0.5)
                        : vec3(c.x - 0.5, c.y - 0.5, uFrac - 0.5);
  gl_Position = uVP * vec4(p, 1.0);
}`;

const F_SLICE = FS_HEADER + `precision highp sampler2DArray;
` + COMMON + CMAP + `
uniform sampler2DArray uHist;
uniform float uLayer;
uniform sampler2D uMat1;
uniform int uAxis, uIdx;
uniform int uMode, uComp;
uniform float uGain, uAlpha;
in vec2 vAB;
out vec4 o;
void main(){
  vec4 f = texture(uHist, vec3(vAB, uLayer));
  vec3 col;
  if      (uMode == 0) col = cmap(uCmap, clamp(f.w * uGain, 0.0, 1.0));
  else if (uMode == 2) col = cmap(uCmap, clamp(sqrt(max(f.w, 0.0)) * uGain, 0.0, 1.0));
  else                 col = cmap(uCmap, clamp(f[uComp] * uGain * 0.5 + 0.5, 0.0, 1.0));

  // material overlay so obstacles / dielectrics are visible on the slice
  ivec2 q = ivec2(clamp(vAB, 0.0, 0.9999) * float(uN));
  ivec3 p = (uAxis == 0) ? ivec3(uIdx, q.x, q.y)
          : (uAxis == 1) ? ivec3(q.x, uIdx, q.y)
                         : ivec3(q.x, q.y, uIdx);
  vec4 m = texelFetch(uMat1, atlasCoord(p), 0);
  if (m.a > 0.5 && m.a < 1.5)      col = mix(col, vec3(0.72, 0.72, 0.75), 0.85); // PEC
  else if (m.a > 1.5)              col = mix(col, vec3(0.79, 0.56, 0.35), 0.45); // Drude
  else if (m.r > 1.001 || m.b > 0.0) col = mix(col, vec3(0.45, 0.62, 0.85), 0.22); // dielectric
  o = vec4(col, uAlpha);
}`;

/* ------------------------------------------------------- vector glyphs - */
const V_GLYPH = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + COMMON + CMAP + `
uniform sampler2D uF;        // raw field atlas (32F)
uniform mat4 uVP;
uniform int uAxis, uIdx, uStride;
uniform float uGain, uScaleLen;
out vec3 vColor;
void main(){
  int n = uN / uStride;
  int a = gl_InstanceID % n;
  int b = gl_InstanceID / n;
  int ca = a * uStride + uStride / 2;
  int cb = b * uStride + uStride / 2;
  ivec3 cell = (uAxis == 0) ? ivec3(uIdx, ca, cb)
             : (uAxis == 1) ? ivec3(ca, uIdx, cb)
                            : ivec3(ca, cb, uIdx);
  vec3 F = texelFetch(uF, atlasCoord(cell), 0).xyz;
  float m = length(F);
  vec3 dir = (m > 1e-20) ? F / m : vec3(0.0);
  float L = clamp(m * uGain, 0.0, 1.0) * uScaleLen;
  vec3 cpos = (vec3(cell) + 0.5) / float(uN) - 0.5;
  vec3 pos = cpos + dir * L * ((gl_VertexID == 0) ? -0.5 : 0.5);
  vColor = cmap(uCmap, clamp(m * uGain, 0.0, 1.0));
  gl_Position = uVP * vec4(pos, 1.0);
}`;

const F_GLYPH = FS_HEADER + `
in vec3 vColor;
out vec4 o;
void main(){ o = vec4(vColor, 1.0); }`;

/* ------------------------------------------------------------ lines ---- */
const V_LINES = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uScaleV, uOffset;
void main(){ gl_Position = uVP * vec4(aPos * uScaleV + uOffset, 1.0); }`;

const F_LINES = FS_HEADER + `
uniform vec4 uColor;
out vec4 o;
void main(){ o = uColor; }`;

return {
  V_FULLSCREEN, F_STEP_H, F_STEP_E, F_DISPLAY, F_EXTRACT, F_PROBE,
  V_VOLUME, F_VOLUME, V_SLICE, F_SLICE, V_GLYPH, F_GLYPH, V_LINES, F_LINES,
};
})();
