// Rendering: renderer + post-processing, procedural sky, the floodwater shader, world meshes,
// and a material patch that draws the "floodline" (the next tide level) onto every surface.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEX } from './textures.js';
import { smoothstep, lerp, clamp, mulberry32, makeSimplex } from './util.js';

/* ---------- global shader patches ---------- */

THREE.ShaderChunk.fog_pars_vertex = `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogPos;
#endif`;
THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogPos = mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogPos;
  uniform vec3 uFogSunView;
  uniform vec3 uFogSunColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  float fogSun = pow( max( dot( normalize( vFogPos ), uFogSunView ), 0.0 ), 6.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, mix( fogColor, uFogSunColor, fogSun ), fogFactor );
#endif`;

export const U = {
  fogSunView: { value: new THREE.Vector3(0, 0, -1) },
  fogSunColor: { value: new THREE.Color() },
  wet: { value: -100 },
  next: { value: 0 },
  alert: { value: 0 },
  time: { value: 0 },
  level: { value: 0 },
  wind: { value: 0.06 },
};

export function patchMaterial(mat, opt = {}) {
  const flood = opt.flood !== false;
  const wind = opt.wind || 0;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFogSunView = U.fogSunView;
    sh.uniforms.uFogSunColor = U.fogSunColor;
    if (flood) {
      sh.uniforms.uWet = U.wet;
      sh.uniforms.uNext = U.next;
      sh.uniforms.uAlert = U.alert;
      sh.uniforms.uFlTime = U.time;
      sh.uniforms.uLevel = U.level;
    }
    if (wind) {
      sh.uniforms.uTimeW = U.time;
      sh.uniforms.uWindAmt = { value: wind };
    }
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFlW;\n' + (wind ? 'uniform float uTimeW; uniform float uWindAmt;\n' : ''));
    if (wind) {
      vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ipw = instanceMatrix[3].xyz;
      #else
        vec3 ipw = vec3(0.0);
      #endif
      float sway = (sin(uTimeW * 1.7 + ipw.x * 0.35 + ipw.z * 0.27) + sin(uTimeW * 2.9 + ipw.z * 0.5 + ipw.x * 0.2) * 0.4) * uWindAmt * max(position.y, 0.0);
      transformed.x += sway; transformed.z += sway * 0.6;`);
    }
    vs = vs.replace('#include <fog_vertex>', `#include <fog_vertex>
      vec4 flw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        flw = instanceMatrix * flw;
      #endif
      flw = modelMatrix * flw;
      vFlW = flw.xyz;`);
    sh.vertexShader = vs;
    let fs = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFlW;\n' + (flood ? 'uniform float uWet; uniform float uNext; uniform float uAlert; uniform float uFlTime; uniform float uLevel;\n' : ''));
    if (flood) {
      fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float flWet = smoothstep(uWet + 0.08, uWet - 0.3, vFlW.y);
        diffuseColor.rgb *= mix(1.0, 0.5, flWet);
        roughnessFactor = mix(roughnessFactor, 0.22, flWet);`);
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float flD = abs(vFlW.y - uNext);
        float flW = clamp(fwidth(vFlW.y) * 1.2, 0.01, 0.07);
        float flLine = 1.0 - smoothstep(flW, flW * 2.2, flD);
        float flBelow = step(vFlW.y, uNext) * step(uLevel, vFlW.y) * (1.0 - smoothstep(0.0, 2.2, uNext - vFlW.y));
        float flStripe = step(0.62, fract((vFlW.x + vFlW.z) * 0.45 - uFlTime * 0.35));
        float flPulse = 0.75 + 0.25 * sin(uFlTime * 5.0);
        totalEmissiveRadiance += vec3(1.0, 0.33, 0.08) * uAlert * (flLine * 2.2 * flPulse + flBelow * flStripe * 0.07);`);
    }
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'fl' + (flood ? 1 : 0) + '_' + wind;
  return mat;
}

/* ---------- sky ---------- */

const SKY_GLSL = `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunFog;
uniform vec3 uSunCol;
uniform vec3 uCloudCol;
uniform float uCloudCover;
uniform float uTime;
uniform sampler2D uCloudTex;
vec3 atmos(vec3 d) {
  float s = max(dot(d, uSunDir), 0.0);
  return mix(uHorizon, uSunFog, pow(s, 6.0));
}
vec3 skyColor(vec3 d, float clouds) {
  float y = d.y;
  vec3 hor = atmos(d);
  vec3 col = mix(hor, uZenith, pow(clamp(y, 0.0, 1.0), 0.55));
  col = mix(col, hor * 0.5, smoothstep(0.0, -0.3, y));
  float s = max(dot(d, uSunDir), 0.0);
  vec3 sun = uSunCol * (pow(s, 3000.0) * 40.0 + pow(s, 220.0) * 0.35 + pow(s, 12.0) * 0.07);
  float cov = 0.0;
  if (clouds > 0.5 && y > 0.0) {
    vec2 p = d.xz / (y + 0.1) * 0.3;
    float n = texture2D(uCloudTex, p * 0.22 + vec2(uTime * 0.0035, uTime * 0.0012)).r;
    float n2 = texture2D(uCloudTex, p * 0.8 - vec2(uTime * 0.006, 0.0)).g;
    float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, n * 0.78 + n2 * 0.3);
    float fade = smoothstep(0.0, 0.2, y);
    vec3 cc = mix(uCloudCol * 0.5, uCloudCol * 1.1, n2) + uSunCol * pow(s, 5.0) * 0.35;
    cc += uSunCol * pow(s, 18.0) * (1.0 - c) * 1.6;
    cov = c * fade * 0.94;
    col = mix(col, cc, cov);
  }
  col += sun * (1.0 - cov * 0.97);
  return col;
}
`;

function skyMaterial(clouds) {
  return new THREE.ShaderMaterial({
    uniforms: SKY_UNIFORMS,
    vertexShader: `varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: SKY_GLSL + `varying vec3 vDir;
      void main() { gl_FragColor = vec4(skyColor(normalize(vDir), ${clouds ? '1.0' : '0.0'}), 1.0); }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

const SKY_UNIFORMS = {
  uSunDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSunFog: { value: new THREE.Color() },
  uSunCol: { value: new THREE.Color() },
  uCloudCol: { value: new THREE.Color() },
  uCloudCover: { value: 0.5 },
  uTime: U.time,
  uCloudTex: { value: null },
};

export const SKIES = {
  dusk: {
    sunElev: 9, sunAz: 250, zenith: '#24477a', horizon: '#d6ad8c', sunFog: '#eea06a', sunColor: '#ffcf9a',
    sunInt: 3.6, hemiSky: '#a3b8d6', hemiGround: '#5e4b38', hemiInt: 0.4, fog: 0.0046, envInt: 0.75,
    clouds: 0.42, cloudColor: '#e0bba2', exposure: 0.92, wind: 0.05, rain: 0,
  },
  storm: {
    sunElev: 14, sunAz: 128, zenith: '#3d5670', horizon: '#a9aba6', sunFog: '#f0c995', sunColor: '#ffe2b8',
    sunInt: 3.3, hemiSky: '#aebccb', hemiGround: '#4a4436', hemiInt: 0.35, fog: 0.0034, envInt: 0.7,
    clouds: 0.62, cloudColor: '#b9bec4', exposure: 1.0, wind: 0.09, rain: 1,
  },
};

/* ---------- water ---------- */

const WATER_UNIFORMS = {
  uTime: U.time,
  uLevel: U.level,
  uNormalTex: { value: null },
  uFoamTex: { value: null },
  uHeightTex: { value: null },
  uHalf: { value: 100 },
  uFogDensity: { value: 0.005 },
  uSurge: { value: 0 },
  uLight: { value: 1 },
};

function waterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...SKY_UNIFORMS, ...WATER_UNIFORMS },
    vertexShader: `varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: SKY_GLSL + `
      uniform float uLevel; uniform sampler2D uNormalTex; uniform sampler2D uFoamTex; uniform sampler2D uHeightTex;
      uniform float uHalf; uniform float uFogDensity; uniform float uSurge; uniform float uLight;
      varying vec3 vW;
      vec3 nrmAt(vec2 uv, float dist) {
        vec3 n1 = texture2D(uNormalTex, uv * 0.045 + vec2(uTime * 0.013, uTime * 0.008)).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormalTex, uv * 0.12 + vec2(-uTime * 0.021, uTime * 0.016)).xyz * 2.0 - 1.0;
        vec3 n3 = texture2D(uNormalTex, uv * 0.009 + vec2(uTime * 0.004, -uTime * 0.003)).xyz * 2.0 - 1.0;
        vec2 t = n1.xy + n2.xy * 0.55 + n3.xy * 1.3;
        float k = (0.32 + uSurge * 0.4) / (1.0 + dist * 0.006);
        return normalize(vec3(t.x * k, 1.0, t.y * k));
      }
      void main() {
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec3 N = nrmAt(vW.xz, dist);
        bool below = cameraPosition.y < uLevel;
        vec2 huv = (vW.xz + uHalf) / (2.0 * uHalf);
        float ground = texture2D(uHeightTex, clamp(huv, 0.0, 1.0)).r;
        float depth = uLevel - ground;
        if (below) {
          N = -N;
          float f = pow(1.0 - max(dot(V, N), 0.0), 3.0);
          vec3 c = mix(vec3(0.03, 0.16, 0.17), vec3(0.12, 0.3, 0.3) * uLight, f);
          gl_FragColor = vec4(c, 0.92);
          return;
        }
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 sky = skyColor(R, 1.0);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
        vec3 shallow = vec3(0.1, 0.2, 0.16), deepc = vec3(0.012, 0.06, 0.07);
        vec3 body = mix(shallow, deepc, smoothstep(0.0, 7.0, depth)) * uLight;
        body += uSunCol * 0.03 * max(dot(N, uSunDir), 0.0);
        vec3 col = mix(body, sky, fres);
        float sd = max(dot(R, uSunDir), 0.0);
        col += uSunCol * (pow(sd, 900.0) * 14.0 + pow(sd, 80.0) * 0.35);
        vec4 fn = texture2D(uFoamTex, vW.xz * 0.07 + vec2(uTime * 0.012, -uTime * 0.008));
        vec4 fn2 = texture2D(uFoamTex, vW.xz * 0.19 - vec2(uTime * 0.02, uTime * 0.01));
        float shore = 1.0 - smoothstep(0.0, 0.32 + fn.g * 0.35, depth);
        float wave = 0.5 + 0.5 * sin(depth * 9.0 - uTime * 1.8 + fn.g * 4.0);
        float foam = shore * smoothstep(0.42, 0.78, fn.r * 0.7 + fn2.r * 0.45 + wave * 0.25);
        foam = max(foam, uSurge * smoothstep(0.86, 1.0, fn2.r * fn.r * 1.7) * 0.4);
        col = mix(col, vec3(0.8, 0.84, 0.82) * uLight, foam * 0.8);
        float alpha = mix(0.5, 0.97, smoothstep(0.0, 2.5, depth));
        alpha = max(alpha, foam);
        alpha = max(alpha, fres);
        alpha *= smoothstep(-0.05, 0.08, depth + 0.1);
        float ff = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        col = mix(col, atmos(-V), ff);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/* ---------- structure materials ---------- */

const MAT_DEFS = {
  concrete: { t: 'concrete', color: 0xcfc9be, rough: 0.92, scale: 4 },
  concreteDark: { t: 'concrete', color: 0x928d85, rough: 0.95, scale: 4 },
  plaster: { t: 'concrete', color: 0xe8d4b0, rough: 0.9, scale: 3 },
  plasterBlue: { t: 'concrete', color: 0xaac3c8, rough: 0.9, scale: 3 },
  siding: { t: 'contWhite', color: 0xb9bec0, rough: 0.5, metal: 0.35, scale: 2.6 },
  contRed: { t: 'contRed', rough: 0.52, metal: 0.3, scale: 2.6 },
  contBlue: { t: 'contBlue', rough: 0.52, metal: 0.3, scale: 2.6 },
  contGreen: { t: 'contGreen', rough: 0.52, metal: 0.3, scale: 2.6 },
  contOrange: { t: 'contOrange', rough: 0.52, metal: 0.3, scale: 2.6 },
  contWhite: { t: 'contWhite', rough: 0.52, metal: 0.3, scale: 2.6 },
  paintYellow: { t: 'paintYellow', rough: 0.5, metal: 0.35, scale: 3 },
  paintSteel: { t: 'paintSteel', rough: 0.45, metal: 0.55, scale: 3 },
  paintWhite: { t: 'paintWhite', rough: 0.6, metal: 0.15, scale: 3 },
  paintRed: { t: 'paintRed', rough: 0.5, metal: 0.3, scale: 3 },
  wood: { t: 'wood', color: 0xd8ccb8, rough: 0.85, scale: 2.4 },
  rock: { t: 'rock', rough: 0.9, scale: 3 },
  bark: { t: 'bark', rough: 0.9, scale: 2 },
};

const matCache = {};
export function structMat(name) {
  if (matCache[name]) return matCache[name];
  const d = MAT_DEFS[name] || MAT_DEFS.concrete;
  const tex = TEX[d.t];
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    color: d.color ?? 0xffffff,
    roughness: d.rough,
    metalness: d.metal || 0,
    vertexColors: true,
  });
  patchMaterial(m);
  m.userData.scale = d.scale;
  matCache[name] = m;
  return m;
}

const plainCache = {};
export function plainMat(key, params, opt) {
  if (plainCache[key]) return plainCache[key];
  const m = new THREE.MeshStandardMaterial(params);
  patchMaterial(m, opt);
  plainCache[key] = m;
  return m;
}

/* ---------- geometry builders ---------- */

function boxFaces(b) {
  const { x0, y0, z0, x1, y1, z1 } = b;
  return [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 'zy'],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], 'zy'],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 'xz'],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 'xz'],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 'xy'],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 'xy'],
  ];
}

function buildStructures(world) {
  const acc = {};
  for (const b of world.boxes) {
    if (!b.visible) continue;
    const a = acc[b.mat] || (acc[b.mat] = { p: [], n: [], uv: [], c: [], i: [] });
    const scale = (MAT_DEFS[b.mat] || MAT_DEFS.concrete).scale;
    const tall = b.y1 - b.y0 > 1.2;
    for (const [n, q, plane] of boxFaces(b)) {
      const base = a.p.length / 3;
      for (const v of q) {
        a.p.push(v[0], v[1], v[2]);
        a.n.push(n[0], n[1], n[2]);
        if (plane === 'zy') a.uv.push(v[2] / scale, v[1] / scale);
        else if (plane === 'xz') a.uv.push(v[0] / scale, v[2] / scale);
        else a.uv.push(v[0] / scale, v[1] / scale);
        let k = 1;
        if (tall) k = 0.6 + 0.4 * smoothstep(0, 2.6, v[1] - b.y0);
        if (n[1] < 0) k *= 0.6;
        a.c.push(k, k, k);
      }
      a.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const meshes = [];
  for (const mat in acc) {
    const a = acc[mat];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(a.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(a.c, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(a.i), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, structMat(mat));
    m.castShadow = true;
    m.receiveShadow = true;
    meshes.push(m);
  }
  return meshes;
}

const C = (hex) => new THREE.Color(hex);
const TERRAIN_COLS = {
  silt: C('#3d3a30'), sand: C('#a89a76'), grass: C('#58653a'), mud: C('#5c503b'), dry: C('#7d7550'),
  rock: C('#6c675e'), high: C('#79776c'), asphalt: C('#3e3e3f'), concrete: C('#6f6c66'), dirt: C('#6b5a41'),
};

function buildTerrain(world) {
  const N = world.N, cell = world.cell, half = world.half;
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2);
  const noise = world.noise2;
  const tmp = new THREE.Color(), tmp2 = new THREE.Color();
  const nrm = { x: 0, y: 1, z: 0 };
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const x = -half + ix * cell, z = -half + iz * cell, h = world.heights[i];
      pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
      uv[i * 2] = x / 7; uv[i * 2 + 1] = z / 7;
      world.normalAt(x, z, nrm);
      const n1 = noise(x * 0.04, z * 0.04) * 0.5 + 0.5;
      const n2 = noise(x * 0.15 + 30, z * 0.15) * 0.5 + 0.5;
      tmp.copy(TERRAIN_COLS.silt);
      tmp.lerp(TERRAIN_COLS.sand, smoothstep(-0.8, 0.5, h));
      tmp2.copy(TERRAIN_COLS.grass).lerp(TERRAIN_COLS.mud, smoothstep(0.45, 0.75, n1));
      tmp.lerp(tmp2, smoothstep(0.7, 1.9, h + n2 * 0.6));
      tmp.lerp(TERRAIN_COLS.dry, smoothstep(14, 26, h + n1 * 6) * 0.8);
      tmp.lerp(TERRAIN_COLS.high, smoothstep(32, 40, h));
      tmp.lerp(TERRAIN_COLS.rock, smoothstep(0.86, 0.66, nrm.y + n2 * 0.06));
      const { pad, w } = world.padAt(x, z);
      if (pad && w > 0) tmp.lerp(TERRAIN_COLS[pad.mat] || TERRAIN_COLS.dirt, smoothstep(0.1, 0.9, w) * (0.75 + n2 * 0.25));
      const v = 1.25 + (n2 - 0.5) * 0.25;
      col[i * 3] = tmp.r * v; col[i * 3 + 1] = tmp.g * v; col[i * 3 + 2] = tmp.b * v;
    }
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < N - 1; iz++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const a = iz * N + ix, b = a + N, c = a + 1, d = a + N + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, plainMat('terrain', {
    vertexColors: true, map: TEX.terrain.map, normalMap: TEX.terrain.normalMap, normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.93, metalness: 0,
  }));
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}

function heightTexture(world) {
  const N = world.N;
  const data = new Uint16Array(N * N);
  for (let i = 0; i < N * N; i++) data[i] = THREE.DataUtils.toHalfFloat(world.heights[i]);
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const n = makeSimplex(seed);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + n(x * 1.3 + seed, z * 1.3 + y) * 0.22 + n(x * 3.1, y * 3.1 + z) * 0.08;
    p.setXYZ(i, x * d * (1.1 + (seed % 3) * 0.1), y * d * 0.72, z * d);
  }
  g.computeVertexNormals();
  return g;
}

function pineGeometry() {
  const parts = [];
  const rng = mulberry32(77);
  const layers = 5;
  for (let l = 0; l < layers; l++) {
    const r = 1.9 - l * 0.32, h = 2.2 - l * 0.18;
    const cone = new THREE.ConeGeometry(r, h, 9, 1, true);
    cone.translate((rng() - 0.5) * 0.15, 1.8 + l * 1.05 + h / 2, (rng() - 0.5) * 0.15);
    const c = [];
    const p = cone.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) - (1.8 + l * 1.05)) / h;
      const k = 0.45 + t * 0.6;
      c.push(0.18 * k, 0.27 * k, 0.16 * k);
    }
    cone.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    parts.push(cone);
  }
  return mergeGeometries(parts);
}

function deadTreeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.12, 0.26, 4.2, 7);
  trunk.translate(0, 2.1, 0);
  parts.push(trunk);
  const rng = mulberry32(55);
  for (let k = 0; k < 5; k++) {
    const len = 1 + rng() * 1.2;
    const b = new THREE.CylinderGeometry(0.03, 0.08, len, 5);
    b.translate(0, len / 2, 0);
    b.rotateZ(0.6 + rng() * 0.5);
    b.rotateY(rng() * Math.PI * 2);
    b.translate(0, 1.8 + k * 0.45, 0);
    parts.push(b);
  }
  return mergeGeometries(parts);
}

function grassGeometry() {
  const a = new THREE.PlaneGeometry(1, 1);
  a.translate(0, 0.5, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const c = a.clone();
  c.rotateY(Math.PI / 4);
  const g = mergeGeometries([a, b, c]);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

function instanced(geo, mat, list, fn, shadow = true) {
  if (!list.length) return null;
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  const o = new THREE.Object3D();
  list.forEach((it, i) => {
    fn(o, it);
    o.updateMatrix();
    m.setMatrixAt(i, o.matrix);
  });
  m.instanceMatrix.needsUpdate = true;
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}

/* ---------- renderer ---------- */

export const QUALITY = {
  low: { pr: 0.75, shadows: false, shadowSize: 1024, bloom: false, msaa: 0, grass: 0, fxaa: true },
  medium: { pr: 1, shadows: true, shadowSize: 2048, bloom: true, msaa: 0, grass: 0.45, fxaa: true },
  high: { pr: 1.5, shadows: true, shadowSize: 4096, bloom: true, msaa: 4, grass: 1, fxaa: false },
};

export class Renderer {
  constructor(canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.r = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.06, 2600);
    this.camera.rotation.order = 'YXZ';
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
    this.quality = QUALITY.medium;
    this.qualityName = 'medium';

    this.sunDir = new THREE.Vector3(0, 0.3, -1).normalize();
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.scene.add(this.hemi);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 14, 2);
    this.scene.add(this.flashLight);

    this.vmSun = new THREE.DirectionalLight(0xffffff, 2);
    this.vmScene.add(this.vmSun, new THREE.HemisphereLight(0xbcd0e0, 0x40382e, 0.95));
    this.vmFlash = new THREE.PointLight(0xffb060, 0, 3, 2);
    this.vmFlash.position.set(0.1, -0.05, -0.7);
    this.vmScene.add(this.vmFlash);

    SKY_UNIFORMS.uCloudTex.value = TEX.clouds.map;
    TEX.clouds.map.wrapS = TEX.clouds.map.wrapT = THREE.RepeatWrapping;
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), skyMaterial(true));
    this.skyMesh.renderOrder = -1000;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    WATER_UNIFORMS.uNormalTex.value = TEX.waterNormal.normalMap;
    WATER_UNIFORMS.uFoamTex.value = TEX.foam.map;
    TEX.foam.map.colorSpace = THREE.NoColorSpace;
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(5200, 5200, 1, 1), waterMaterial());
    this.water.rotation.x = -Math.PI / 2;
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.scene.add(this.water);

    this.scene.fog = new THREE.FogExp2(0xaaaaaa, 0.005);
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(true)));

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);
    this.animated = [];
    this.post = { vignette: 1.15, damage: 0, under: 0, flash: 0, sat: 1.05, chill: 0 };
    this.buildComposer();
    this.resize();
  }

  buildComposer() {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    const q = this.quality;
    const size = this.r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: q.msaa });
    const comp = new EffectComposer(this.r, rt);
    comp.addPass(new RenderPass(this.scene, this.camera));
    const vm = new RenderPass(this.vmScene, this.vmCamera);
    vm.clear = false;
    vm.clearDepth = true;
    comp.addPass(vm);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.55, 0.92);
    this.bloom.enabled = q.bloom;
    comp.addPass(this.bloom);
    this.grade = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null }, uVig: { value: 1.1 }, uDamage: { value: 0 }, uUnder: { value: 0 }, uFlash: { value: 0 },
        uSat: { value: 1 }, uTime: { value: 0 }, uChill: { value: 0 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig, uDamage, uUnder, uFlash, uSat, uTime, uChill; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          vec2 d = vUv - 0.5;
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 col = c.rgb;
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uSat - uDamage * 0.5);
          col = mix(col, vec3(0.02, 0.13, 0.14) * (0.4 + l * 2.0), uUnder * 0.78);
          float r = length(d);
          col *= 1.0 - r * r * uVig;
          float edge = smoothstep(0.28, 0.78, r * 1.35);
          col = mix(col, vec3(0.35, 0.01, 0.01), edge * uDamage);
          col = mix(col, col * vec3(0.7, 0.9, 1.1) + vec3(0.02, 0.05, 0.07), edge * uChill);
          col += vec3(1.0, 0.85, 0.7) * uFlash;
          col += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.012;
          gl_FragColor = vec4(col, c.a);
        }`,
    });
    comp.addPass(this.grade);
    comp.addPass(new OutputPass());
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaa.enabled = q.fxaa;
    comp.addPass(this.fxaa);
    this.composer = comp;
    this.resize();
  }

  setQuality(name) {
    this.qualityName = name;
    this.quality = QUALITY[name] || QUALITY.medium;
    this.r.shadowMap.enabled = this.quality.shadows;
    this.sun.castShadow = this.quality.shadows;
    this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    this.buildComposer();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pr);
    this.r.setPixelRatio(pr);
    this.r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    }
  }

  setSky(name) {
    const s = SKIES[name];
    this.skyPreset = s;
    const el = (s.sunElev * Math.PI) / 180, az = (s.sunAz * Math.PI) / 180;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    SKY_UNIFORMS.uSunDir.value.copy(this.sunDir);
    SKY_UNIFORMS.uZenith.value.set(s.zenith);
    SKY_UNIFORMS.uHorizon.value.set(s.horizon);
    SKY_UNIFORMS.uSunFog.value.set(s.sunFog);
    SKY_UNIFORMS.uSunCol.value.set(s.sunColor);
    SKY_UNIFORMS.uCloudCol.value.set(s.cloudColor);
    SKY_UNIFORMS.uCloudCover.value = s.clouds;
    this.scene.fog.color.set(s.horizon);
    this.scene.fog.density = s.fog;
    WATER_UNIFORMS.uFogDensity.value = s.fog;
    U.fogSunColor.value.set(s.sunFog);
    U.wind.value = s.wind;
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sunInt;
    this.vmSun.color.set(s.sunColor);
    this.vmSun.intensity = s.sunInt * 0.6;
    this.hemi.color.set(s.hemiSky);
    this.hemi.groundColor.set(s.hemiGround);
    this.hemi.intensity = s.hemiInt;
    this.r.toneMappingExposure = s.exposure;
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 100);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = s.envInt;
    this.vmScene.environment = this.envRT.texture;
    this.vmScene.environmentIntensity = s.envInt;
  }

  clearWorld() {
    for (const o of this.worldGroup.children.slice()) {
      this.worldGroup.remove(o);
      o.traverse((c) => { if (c.geometry) c.geometry.dispose(); });
    }
    this.animated.length = 0;
    if (WATER_UNIFORMS.uHeightTex.value) WATER_UNIFORMS.uHeightTex.value.dispose();
  }

  buildWorld(world) {
    this.clearWorld();
    const G = this.worldGroup;
    G.add(buildTerrain(world));
    for (const m of buildStructures(world)) G.add(m);
    WATER_UNIFORMS.uHeightTex.value = heightTexture(world);
    WATER_UNIFORMS.uHalf.value = world.half;
    this.buildProps(world);
    this.buildVegetation(world);
    this.setSky(world.sky);
    // seabed beyond the heightfield
    const sea = new THREE.Mesh(new THREE.RingGeometry(world.half * 0.98, 2600, 48, 1), plainMat('seabed', { color: 0x2b2a24, roughness: 1 }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = world.heightAt(world.half, world.half) - 0.5;
    G.add(sea);
  }

  buildProps(world) {
    const G = this.worldGroup;
    const steel = structMat('paintSteel'), white = structMat('paintWhite'), yellow = structMat('paintYellow'), red = structMat('paintRed');
    const rubber = plainMat('rubber', { color: 0x161616, roughness: 0.9 });
    const glass = plainMat('glass', { color: 0x1a2328, roughness: 0.08, metalness: 0.6 });
    const woodM = structMat('wood');
    const groups = {};
    const add = (key, geo, mat, shadow = true) => {
      const g = groups[key] || (groups[key] = { geos: [], mat, shadow });
      g.geos.push(geo);
    };
    const withColor = (geo) => {
      const n = geo.attributes.position.count;
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      return geo.index ? geo.toNonIndexed() : geo;
    };
    const tr = (geo, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
      geo.applyMatrix4(m);
      return geo;
    };
    for (const p of world.props) {
      switch (p.kind) {
        case 'wheel': add('wheel', tr(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14).rotateX(Math.PI / 2), p.x, p.y, p.z, p.yaw), rubber); break;
        case 'carGlass': {
          add('glass', tr(new THREE.BoxGeometry(1.9, 0.46, 1.64), p.x, p.y + 1.4, p.z, p.yaw), glass);
          add('glass', tr(new THREE.BoxGeometry(2.24, 0.44, 1.4), p.x, p.y + 1.4, p.z, p.yaw), glass);
          break;
        }
        case 'pipe': {
          const len = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
          const alongX = Math.abs(p.x1 - p.x0) > Math.abs(p.z1 - p.z0);
          const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
          const g = new THREE.CylinderGeometry(p.r, p.r, len, 20);
          g.rotateZ(Math.PI / 2);
          add('steel', withColor(tr(g, cx, p.y, cz, alongX ? 0 : Math.PI / 2)), steel);
          for (let t = 0; t <= len; t += 4) {
            const f = new THREE.CylinderGeometry(p.r * 1.12, p.r * 1.12, 0.18, 20).rotateZ(Math.PI / 2);
            const fx = alongX ? Math.min(p.x0, p.x1) + t : p.x0, fz = alongX ? p.z0 : Math.min(p.z0, p.z1) + t;
            add('steel', withColor(tr(f, fx, p.y, fz, alongX ? 0 : Math.PI / 2)), steel);
          }
          break;
        }
        case 'tank':
        case 'silo': {
          const isSilo = p.kind === 'silo';
          add(isSilo ? 'steel' : 'white', withColor(tr(new THREE.CylinderGeometry(p.r, p.r, p.h, 36, 4), p.x, p.y + p.h / 2, p.z)), isSilo ? steel : white);
          if (isSilo) add('steel', withColor(tr(new THREE.SphereGeometry(p.r, 36, 10, 0, Math.PI * 2, 0, Math.PI / 2), p.x, p.y + p.h, p.z)), steel);
          else add('white', withColor(tr(new THREE.ConeGeometry(p.r * 1.02, 1.2, 36), p.x, p.y + p.h + 0.6, p.z)), white);
          for (let k = 1; k < 3; k++) add('steel', withColor(tr(new THREE.TorusGeometry(p.r + 0.04, 0.06, 6, 36).rotateX(Math.PI / 2), p.x, p.y + (p.h * k) / 3, p.z)), steel);
          break;
        }
        case 'post':
          add('wood', withColor(tr(new THREE.CylinderGeometry(0.16, 0.2, p.y1 - p.y0, 8), p.x, (p.y0 + p.y1) / 2, p.z)), woodM);
          break;
        case 'cable':
          add('steel', withColor(tr(new THREE.CylinderGeometry(0.03, 0.03, p.len, 4), p.x, p.y - p.len / 2, p.z)), steel);
          add('yellow', withColor(tr(new THREE.BoxGeometry(0.8, 1.0, 0.5), p.x, p.y - p.len - 0.4, p.z)), yellow);
          break;
        case 'vent': {
          add('steel', withColor(tr(new THREE.CylinderGeometry(1.35, 1.5, 0.5, 24, 1, true), p.x, p.y + 0.1, p.z)), steel);
          add('steel', withColor(tr(new THREE.TorusGeometry(1.4, 0.12, 8, 24).rotateX(Math.PI / 2), p.x, p.y + 0.35, p.z)), steel);
          const glow = new THREE.Mesh(new THREE.CircleGeometry(1.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7ff6ff, transparent: true, opacity: 0.85, fog: true }));
          glow.position.set(p.x, p.y + 0.15, p.z);
          G.add(glow);
          this.animated.push({ type: 'vent', mesh: glow, t: Math.random() * 6 });
          break;
        }
        case 'mast': {
          for (let y = 3; y < p.h; y += 3) {
            for (const [dx, dz, ry] of [[0, -1.3, 0], [0, 1.3, 0], [-1.3, 0, Math.PI / 2], [1.3, 0, Math.PI / 2]]) {
              add('red', withColor(tr(new THREE.BoxGeometry(2.6, 0.12, 0.12), p.x + dx, p.y + y, p.z + dz, ry)), red);
              add('red', withColor(tr(new THREE.BoxGeometry(3.6, 0.08, 0.08), p.x + dx, p.y + y - 1.5, p.z + dz, ry, 0, 0.83)), red);
            }
          }
          add('steel', withColor(tr(new THREE.CylinderGeometry(0.08, 0.08, 6, 6), p.x, p.y + p.h + 3, p.z)), steel);
          add('white', withColor(tr(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 16).rotateX(Math.PI / 2), p.x, p.y + p.h - 4, p.z + 1.5)), white);
          const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
          beacon.position.set(p.x, p.y + p.h + 6.2, p.z);
          G.add(beacon);
          this.animated.push({ type: 'blink', mesh: beacon, t: 0 });
          break;
        }
        case 'lighthouse': {
          const H = 22;
          for (let k = 0; k < 6; k++) {
            const y0 = (k * H) / 6, y1 = ((k + 1) * H) / 6;
            const r0 = 3 - (y0 / H) * 0.8, r1 = 3 - (y1 / H) * 0.8;
            add(k % 2 ? 'red' : 'white', withColor(tr(new THREE.CylinderGeometry(r1, r0, y1 - y0, 32), p.x, p.y + (y0 + y1) / 2, p.z)), k % 2 ? red : white);
          }
          add('steel', withColor(tr(new THREE.CylinderGeometry(3.0, 3.0, 0.3, 32), p.x, p.y + H + 0.15, p.z)), steel);
          add('red', withColor(tr(new THREE.ConeGeometry(1.9, 1.8, 24), p.x, p.y + H + 3.9, p.z)), red);
          const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.6, 20), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffdca0, emissiveIntensity: 3.5, roughness: 0.2 }));
          lamp.position.set(p.x, p.y + H + 1.6, p.z);
          G.add(lamp);
          const beamGeo = new THREE.ConeGeometry(6, 60, 24, 1, true);
          beamGeo.translate(0, -30, 0);
          beamGeo.rotateZ(Math.PI / 2);
          const beamMat = new THREE.MeshBasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true });
          const beam = new THREE.Group();
          const b1 = new THREE.Mesh(beamGeo, beamMat);
          const b2 = new THREE.Mesh(beamGeo, beamMat);
          b2.rotation.y = Math.PI;
          beam.add(b1, b2);
          beam.position.copy(lamp.position);
          G.add(beam);
          this.animated.push({ type: 'spin', mesh: beam, speed: 0.6 });
          break;
        }
        case 'dish': {
          const dish = new THREE.SphereGeometry(4, 28, 10, 0, Math.PI * 2, 0, 0.75);
          dish.rotateX(-Math.PI / 2 + 0.6);
          add('white', withColor(tr(dish, p.x, p.y + 4.2, p.z, p.yaw)), white);
          add('steel', withColor(tr(new THREE.CylinderGeometry(0.5, 0.9, 3.4, 10), p.x, p.y + 1.7, p.z)), steel);
          break;
        }
      }
    }
    const keyMat = { wheel: rubber, glass, steel, white, yellow, red, wood: woodM };
    for (const key in groups) {
      const g = groups[key];
      const geos = g.geos.map((x) => (x.index ? x.toNonIndexed() : x));
      for (const x of geos) {
        if (!x.attributes.color) x.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(x.attributes.position.count * 3).fill(1), 3));
        if (!x.attributes.uv) x.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
      }
      const merged = mergeGeometries(geos);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, keyMat[key] || g.mat);
      m.castShadow = g.shadow;
      m.receiveShadow = true;
      G.add(m);
    }
  }

  buildVegetation(world) {
    const G = this.worldGroup;
    const rockMat = plainMat('rock', { map: TEX.rock.map, normalMap: TEX.rock.normalMap, color: 0xb9b2a6, roughness: 0.92 });
    const rockGeos = [rockGeometry(1), rockGeometry(2), rockGeometry(3)];
    for (let v = 0; v < 3; v++) {
      const list = world.inst.rock.filter((r) => r.v === v);
      const m = instanced(rockGeos[v], rockMat, list, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.setScalar(it.s); });
      if (m) G.add(m);
    }
    const rubMat = plainMat('rubble', { map: TEX.concrete.map, normalMap: TEX.concrete.normalMap, color: 0xa29d94, roughness: 0.95 });
    for (let v = 0; v < 3; v++) {
      const list = world.inst.rubble.filter((r) => r.v === v);
      const m = instanced(rockGeos[v], rubMat, list, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(it.ry * 0.3, it.ry, 0); o.scale.set(it.s * 1.4, it.s, it.s); });
      if (m) G.add(m);
    }
    if (world.inst.barrel.length) {
      const bg = new THREE.CylinderGeometry(0.3, 0.3, 0.92, 18, 1);
      bg.translate(0, 0.46, 0);
      const ribs = [];
      for (const yy of [0.3, 0.62]) ribs.push(new THREE.TorusGeometry(0.305, 0.016, 5, 18).rotateX(Math.PI / 2).translate(0, yy, 0));
      const geo = mergeGeometries([bg.toNonIndexed(), ...ribs.map((r) => r.toNonIndexed())]);
      const cols = [0x2e4f7a, 0x7a2a1f, 0x3d5a2e];
      for (let c = 0; c < 3; c++) {
        const list = world.inst.barrel.filter((b) => b.c === c);
        const mat = plainMat('barrel' + c, { map: TEX.paintSteel.map, normalMap: TEX.paintSteel.normalMap, color: cols[c], roughness: 0.55, metalness: 0.4 });
        const m = instanced(geo, mat, list, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.setScalar(1); });
        if (m) G.add(m);
      }
    }
    const barkMat = plainMat('bark', { map: TEX.bark.map, normalMap: TEX.bark.normalMap, color: 0x9a8a78, roughness: 0.95 });
    const trunk = new THREE.CylinderGeometry(0.13, 0.28, 5, 7);
    trunk.translate(0, 2.5, 0);
    const pt = instanced(trunk, barkMat, world.inst.pine, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.setScalar(it.s); });
    if (pt) G.add(pt);
    const folMat = plainMat('foliage', { map: TEX.foliage.map, normalMap: TEX.foliage.normalMap, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }, { wind: 0.025 });
    const pf = instanced(pineGeometry(), folMat, world.inst.pine, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.setScalar(it.s); });
    if (pf) G.add(pf);
    const deadMat = plainMat('deadwood', { map: TEX.bark.map, color: 0x8d8478, roughness: 0.95 });
    const dt = instanced(deadTreeGeometry(), deadMat, world.inst.dead, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.setScalar(it.s); });
    if (dt) G.add(dt);

    const density = this.quality.grass;
    if (density > 0) {
      const target = Math.floor((world.id === 'saltreach' ? 36000 : 6000) * density);
      const rng = mulberry32(world.def.seed + 5);
      const list = [];
      const nrm = { x: 0, y: 1, z: 0 };
      const out = [];
      for (let k = 0; k < target * 4 && list.length < target; k++) {
        const x = (rng() - 0.5) * world.bx * 2, z = (rng() - 0.5) * world.bz * 2;
        const h = world.heightAt(x, z);
        if (h < 0.6 || h > 36) continue;
        if (world.noise2(x * 0.05, z * 0.05) < -0.15) continue;
        world.normalAt(x, z, nrm);
        if (nrm.y < 0.86) continue;
        const { w } = world.padAt(x, z);
        if (w > 0.3) continue;
        world.queryBoxes(x - 0.4, h - 0.5, z - 0.4, x + 0.4, h + 1, z + 0.4, out);
        if (out.length) continue;
        list.push({ x, y: h - 0.05, z, s: 0.55 + rng() * 0.6, ry: rng() * Math.PI });
      }
      const grassMat = plainMat('grass', { map: TEX.grass, alphaTest: 0.45, side: THREE.DoubleSide, color: 0xc8c8b0, roughness: 1 }, { wind: 0.12 });
      const gm = instanced(grassGeometry(), grassMat, list, (o, it) => { o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry, 0); o.scale.set(it.s * 1.1, it.s * 0.62, it.s * 1.1); }, false);
      if (gm) { gm.receiveShadow = true; G.add(gm); }
    }
  }

  update(dt, focus) {
    U.time.value += dt;
    const cam = this.camera;
    cam.updateMatrixWorld();
    U.fogSunView.value.copy(this.sunDir).transformDirection(cam.matrixWorldInverse);
    this.skyMesh.position.copy(cam.position);
    this.water.position.set(cam.position.x, U.level.value, cam.position.z);
    // shadow follows the focus point, snapped to texels to avoid shimmering
    const ext = 70;
    const sc = this.sun.shadow.camera;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 500;
      sc.updateProjectionMatrix();
    }
    const tex = (ext * 2) / this.quality.shadowSize;
    const fx = Math.round(focus.x / tex) * tex, fz = Math.round(focus.z / tex) * tex;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 200, focus.y + this.sunDir.y * 200, fz + this.sunDir.z * 200);
    this.vmSun.position.copy(this.sunDir).applyQuaternion(cam.quaternion.clone().invert()).multiplyScalar(5);
    for (const a of this.animated) {
      if (a.type === 'spin') a.mesh.rotation.y += a.speed * dt;
      else if (a.type === 'blink') { a.t += dt; a.mesh.visible = a.t % 1.6 < 0.8; }
      else if (a.type === 'vent') { a.t += dt; a.mesh.material.opacity = 0.55 + 0.35 * Math.sin(a.t * 3); }
    }
    const g = this.grade.material.uniforms;
    g.uVig.value = this.post.vignette;
    g.uDamage.value = this.post.damage;
    g.uUnder.value = this.post.under;
    g.uFlash.value = this.post.flash;
    g.uSat.value = this.post.sat;
    g.uChill.value = this.post.chill;
    g.uTime.value = U.time.value % 100;
    WATER_UNIFORMS.uLight.value = this.skyPreset ? 1 : 1;
  }

  setSurge(v) { WATER_UNIFORMS.uSurge.value = v; }

  render() {
    this.composer.render();
  }
}
