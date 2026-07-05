// Custom GLSL materials.
//
// Lighting is computed analytically against the Sun as an *extended disk*:
// each planet/moon fragment computes the visible fraction of the solar disk
// after occlusion by up to 4 spherical occluders (circle-circle overlap).
// Solar eclipses therefore show real umbra/penumbra/antumbra structure on
// planetary surfaces, and lunar eclipses darken the Moon — all emerging
// from the ephemeris geometry, not scripted.
//
// All materials include three.js logdepthbuf chunks (the renderer runs with
// a logarithmic depth buffer to cope with 1:1 solar-system depth range).

import * as THREE from '../vendor/three.module.js';

export const MAX_OCCLUDERS = 4;

const eclipseCommon = /* glsl */`
  // fraction of the sun's disk visible from point P (1 = full sun)
  // occluders: xyz = center (scene units, focus-relative), w = radius
  uniform vec3 uSunPos;
  uniform float uSunRadius;
  uniform vec4 uOccluders[${MAX_OCCLUDERS}];
  uniform int uOccCount;
  uniform float uEclipseOn;

  float diskOverlapFrac(float rs, float ro, float d) {
    // normalized by sun disk area (pi rs^2)
    if (d >= rs + ro) return 0.0;
    if (d <= abs(ro - rs)) {
      if (ro >= rs) return 1.0;
      return (ro * ro) / (rs * rs);
    }
    float d1 = (d * d + rs * rs - ro * ro) / (2.0 * d);
    float d2 = d - d1;
    float a1 = rs * rs * acos(clamp(d1 / rs, -1.0, 1.0)) - d1 * sqrt(max(0.0, rs * rs - d1 * d1));
    float a2 = ro * ro * acos(clamp(d2 / ro, -1.0, 1.0)) - d2 * sqrt(max(0.0, ro * ro - d2 * d2));
    return (a1 + a2) / (3.14159265 * rs * rs);
  }

  float sunVisibility(vec3 P) {
    vec3 toSun = uSunPos - P;
    float dSun = length(toSun);
    vec3 sDir = toSun / dSun;
    float rs = asin(clamp(uSunRadius / dSun, 0.0, 1.0));
    float vis = 1.0;
    if (uEclipseOn > 0.5) {
      for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
        if (i >= uOccCount) break;
        vec3 toOcc = uOccluders[i].xyz - P;
        float dOcc = length(toOcc);
        if (dOcc >= dSun || dOcc < uOccluders[i].w) continue;
        float ro = asin(clamp(uOccluders[i].w / dOcc, 0.0, 1.0));
        float sep = acos(clamp(dot(sDir, toOcc / dOcc), -1.0, 1.0));
        vis *= 1.0 - diskOverlapFrac(rs, ro, sep);
      }
    }
    return vis;
  }
`;

const ringShadowCommon = /* glsl */`
  uniform float uRingOn;
  uniform vec3 uRingCenter;
  uniform vec3 uRingNormal;
  uniform float uRingInner;
  uniform float uRingOuter;
  uniform sampler2D tRingAlpha;

  float ringShadow(vec3 P, vec3 sunDir) {
    if (uRingOn < 0.5) return 1.0;
    float denom = dot(sunDir, uRingNormal);
    if (abs(denom) < 1e-6) return 1.0;
    float t = dot(uRingCenter - P, uRingNormal) / denom;
    if (t <= 0.0) return 1.0;
    vec3 q = P + sunDir * t - uRingCenter;
    float r = length(q);
    if (r < uRingInner || r > uRingOuter) return 1.0;
    float u = (r - uRingInner) / (uRingOuter - uRingInner);
    float a = texture2D(tRingAlpha, vec2(u, 0.5)).a;
    return 1.0 - a * 0.92;
  }
`;

const planetVert = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const planetFrag = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  #ifdef USE_NIGHT
  uniform sampler2D nightMap;
  #endif
  uniform float uTwilight;    // terminator softness (rad-ish in mu units)
  uniform float uAmbient;
  uniform vec3 uSunColor;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  ${eclipseCommon}
  ${ringShadowCommon}
  void main() {
    #include <logdepthbuf_fragment>
    vec3 N = normalize(vNormal);
    vec3 toSun = uSunPos - vWorldPos;
    vec3 L = normalize(toSun);
    float mu = dot(N, L);
    float day = smoothstep(-uTwilight, uTwilight * 1.6, mu) * max(mu, 0.0) * 0.92 + 0.08 * smoothstep(-uTwilight, uTwilight * 1.6, mu);
    float vis = sunVisibility(vWorldPos) * ringShadow(vWorldPos, L);
    vec3 base = texture2D(map, vUv).rgb;
    vec3 col = base * (day * vis * uSunColor + uAmbient);
    #ifdef USE_NIGHT
    float darkness = 1.0 - smoothstep(-uTwilight, uTwilight, mu);
    // city lights also visible inside deep umbra during an eclipse
    darkness = max(darkness, (1.0 - vis) * step(mu, 0.05));
    col += texture2D(nightMap, vUv).rgb * darkness * 0.85;
    #endif
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function makePlanetMaterial(tex, nightTex) {
  const uniforms = {
    map: { value: tex },
    uSunPos: { value: new THREE.Vector3() },
    uSunRadius: { value: 0.6957 },
    uOccluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uOccCount: { value: 0 },
    uEclipseOn: { value: 1 },
    uTwilight: { value: 0.03 },
    uAmbient: { value: 0.008 },
    uSunColor: { value: new THREE.Color(1.0, 0.99, 0.96) },
    uRingOn: { value: 0 },
    uRingCenter: { value: new THREE.Vector3() },
    uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
    uRingInner: { value: 0 },
    uRingOuter: { value: 1 },
    tRingAlpha: { value: null },
  };
  if (nightTex) uniforms.nightMap = { value: nightTex };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: planetVert,
    fragmentShader: planetFrag,
    defines: nightTex ? { USE_NIGHT: '' } : {},
  });
}

// ---- emissive body (Sun) ----
export function makeSunMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex } },
    vertexShader: planetVert,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 c = texture2D(map, vUv).rgb;
        // seen from space (no atmosphere) the Sun is a brilliant
        // yellowish-white: push the orange texture strongly toward white
        c = mix(c, vec3(1.0, 0.985, 0.94), 0.62);
        // gentle limb darkening
        vec3 V = normalize(cameraPosition - vWorldPos);
        float limb = pow(max(dot(normalize(vNormal), V), 0.0), 0.4);
        gl_FragColor = vec4(c * (0.75 + 0.45 * limb) * 1.55, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

// ---- rings ----
const ringVert = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const ringFrag = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 uNormal;        // ring plane normal (world)
  uniform float uOpacity;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  ${eclipseCommon}
  void main() {
    #include <logdepthbuf_fragment>
    vec4 tex = texture2D(map, vec2(vUv.x, 0.5));
    if (tex.a < 0.003) discard;
    vec3 toSun = normalize(uSunPos - vWorldPos);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float face = abs(dot(uNormal, toSun));
    float sameSide = step(0.0, dot(uNormal, toSun) * dot(uNormal, V));
    // lit side: reflection; unlit side: transmission (thinner => brighter)
    float lit = mix(0.22 * (1.0 - tex.a * 0.6), 0.35 + 0.65 * face, sameSide);
    float vis = sunVisibility(vWorldPos);
    vec3 col = tex.rgb * (lit * vis + 0.012);
    gl_FragColor = vec4(col, tex.a * uOpacity);
    #include <colorspace_fragment>
  }
`;

export function makeRingMaterial(tex, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      uNormal: { value: new THREE.Vector3(0, 1, 0) },
      uOpacity: { value: opacity },
      uSunPos: { value: new THREE.Vector3() },
      uSunRadius: { value: 0.6957 },
      uOccluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uOccCount: { value: 0 },
      uEclipseOn: { value: 1 },
    },
    vertexShader: ringVert,
    fragmentShader: ringFrag,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// ---- atmosphere rim ----
export function makeAtmosphereMaterial(color, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(...color) },
      uIntensity: { value: intensity },
      uSunPos: { value: new THREE.Vector3() },
    },
    vertexShader: planetVert,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform vec3 uSunPos;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunPos - vWorldPos);
        float rim = pow(1.0 - abs(dot(N, V)), 3.0);
        float day = smoothstep(-0.25, 0.25, dot(N, L));
        gl_FragColor = vec4(uColor, rim * uIntensity * (0.06 + 0.94 * day));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
  });
}

// ---- belts: per-particle Keplerian propagation in the vertex shader ----
// Attributes: aElems1 = (a [AU], e, inc, node), aElems2 = (peri, M0, n [rad/day], shade)
// This is the performance trick that lets 40k+ particles orbit correctly
// with zero per-frame CPU cost: one uniform (uT) drives them all.
const beltVert = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aElems1;
  attribute vec4 aElems2;
  uniform float uT;            // days since J2000
  uniform vec3 uFocus;         // focus position, scene units (heliocentric)
  uniform float uUnitsPerAU;
  uniform float uSize;
  varying float vShade;
  varying float vDepthFade;
  void main() {
    float a = aElems1.x, e = aElems1.y, inc = aElems1.z, node = aElems1.w;
    float peri = aElems2.x, M0 = aElems2.y, n = aElems2.z;
    vShade = aElems2.w;
    float M = mod(M0 + n * uT, 6.28318530718);
    float E = M + e * sin(M);
    for (int i = 0; i < 4; i++) {
      E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E));
    }
    float xp = a * (cos(E) - e);
    float yp = a * sqrt(1.0 - e * e) * sin(E);
    float cw = cos(peri), sw = sin(peri);
    float ci = cos(inc), si = sin(inc);
    float cO = cos(node), sO = sin(node);
    float x1 = cw * xp - sw * yp;
    float y1 = sw * xp + cw * yp;
    vec3 ecl = vec3(cO * x1 - sO * ci * y1, sO * x1 + cO * ci * y1, si * y1);
    // ecliptic -> scene: (x, z, -y)
    vec3 scenePos = vec3(ecl.x, ecl.z, -ecl.y) * uUnitsPerAU - uFocus;
    vec4 mv = viewMatrix * vec4(scenePos, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = length(mv.xyz);
    gl_PointSize = clamp(uSize * 55.0 / sqrt(max(dist, 0.1)), 0.7, 2.4);
    vDepthFade = smoothstep(0.02, 0.6, dist);   // hide when extremely close
    #include <logdepthbuf_vertex>
  }
`;

const beltFrag = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  varying float vShade;
  varying float vDepthFade;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c) * 4.0;
    if (r2 > 1.0) discard;
    vec3 col = mix(uColorA, uColorB, vShade);
    // soft-edged specks so the belt reads as haze, not highlighted dots
    gl_FragColor = vec4(col, uOpacity * vDepthFade * smoothstep(1.0, 0.35, r2));
    #include <colorspace_fragment>
  }
`;

export function makeBeltMaterial(colorA, colorB, opacity, size) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 0 },
      uFocus: { value: new THREE.Vector3() },
      uUnitsPerAU: { value: 149.5978707 },
      uSize: { value: size },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uOpacity: { value: opacity },
    },
    vertexShader: beltVert,
    fragmentShader: beltFrag,
    transparent: true,
    depthWrite: false,
  });
}

// ---- sky sphere: NASA Tycho star map sampled by direction (EQJ frame) ----
export function makeSkyMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      uBrightness: { value: 1.0 },
      uEqjFromScene: { value: new THREE.Matrix3() },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w * 0.999999;  // pin to far plane
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      uniform float uBrightness;
      uniform mat3 uEqjFromScene;
      varying vec3 vDir;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 d = normalize(uEqjFromScene * normalize(vDir));
        float ra = atan(d.y, d.x);            // -pi..pi
        float dec = asin(clamp(d.z, -1.0, 1.0));
        // map centered at RA 0h, RA increasing leftward
        float u = fract(0.5 - ra / 6.28318530718);
        float v = 0.5 + dec / 3.14159265359;
        vec3 c = texture2D(map, vec2(u, v)).rgb;
        gl_FragColor = vec4(c * uBrightness, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
}
