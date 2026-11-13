// Weapon stats, procedural gun models (first-person and third-person), and the first-person
// viewmodel with sway, bob, recoil, ADS, reload and shell ejection.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TEX } from './textures.js';
import { clamp, damp, lerp } from './util.js';

export const WEAPONS = {
  ar: {
    id: 'ar', name: 'Tern-7', cls: 'Assault rifle', auto: true, rpm: 640, dmg: 25, head: 1.6, falloff: [35, 85, 0.72],
    mag: 30, reserve: 120, reload: 2.1, hip: 2.6, ads: 0.22, move: 1.8, bloom: 0.32, bloomMax: 2.2, recoil: 0.8, recoilYaw: 0.3,
    zoom: 1.35, adsTime: 0.2, pellets: 1, range: 260, prefRange: 26, moveMul: 1, slot: 'primary',
  },
  smg: {
    id: 'smg', name: 'Wasp', cls: 'SMG', auto: true, rpm: 900, dmg: 18, head: 1.4, falloff: [14, 42, 0.55],
    mag: 32, reserve: 160, reload: 1.8, hip: 2.9, ads: 0.55, move: 1.0, bloom: 0.22, bloomMax: 2.4, recoil: 0.52, recoilYaw: 0.4,
    zoom: 1.2, adsTime: 0.15, pellets: 1, range: 160, prefRange: 12, moveMul: 1.07, slot: 'primary',
  },
  shotgun: {
    id: 'shotgun', name: 'Breaker 12', cls: 'Shotgun', auto: false, action: 'pump', rpm: 72, dmg: 12, head: 1.3, falloff: [8, 26, 0.25],
    mag: 6, reserve: 30, reload: 0.5, shellReload: true, hip: 5.2, ads: 4.0, move: 0.6, bloom: 0, bloomMax: 0, recoil: 3.4, recoilYaw: 0.8,
    zoom: 1.12, adsTime: 0.2, pellets: 9, range: 70, prefRange: 6, moveMul: 1, slot: 'primary',
  },
  dmr: {
    id: 'dmr', name: 'Heron .338', cls: 'Marksman rifle', auto: false, action: 'bolt', rpm: 54, dmg: 90, head: 2.0, falloff: [120, 320, 0.85],
    mag: 5, reserve: 25, reload: 2.7, hip: 7, ads: 0.0, move: 3, bloom: 0, bloomMax: 0, recoil: 3.8, recoilYaw: 0.6,
    zoom: 4.2, adsTime: 0.3, pellets: 1, range: 420, prefRange: 45, moveMul: 0.93, scope: true, slot: 'primary',
  },
  pistol: {
    id: 'pistol', name: 'Mako P9', cls: 'Pistol', auto: false, rpm: 400, dmg: 26, head: 1.7, falloff: [18, 48, 0.6],
    mag: 12, reserve: 60, reload: 1.35, hip: 1.8, ads: 0.4, move: 0.8, bloom: 0.55, bloomMax: 2.5, recoil: 1.4, recoilYaw: 0.3,
    zoom: 1.2, adsTime: 0.14, pellets: 1, range: 130, prefRange: 14, moveMul: 1.1, slot: 'secondary',
  },
};

export const RARITY = [
  { name: 'Standard', color: '#c9cfd2', dmg: 1.0, recoil: 1.0, reload: 1.0 },
  { name: 'Refined', color: '#4fb3ff', dmg: 1.08, recoil: 0.88, reload: 0.94 },
  { name: 'Prime', color: '#f5b642', dmg: 1.16, recoil: 0.78, reload: 0.86 },
];

export function makeWeapon(id, rarity = 0) {
  const def = WEAPONS[id];
  return { def, id, rarity, mag: def.mag, reserve: def.reserve, cooldown: 0, reloadT: 0, bloom: 0, pumpT: 0 };
}

export function damageAt(w, dist, part) {
  const d = w.def;
  const [a, b, m] = d.falloff;
  const k = dist <= a ? 1 : dist >= b ? m : lerp(1, m, (dist - a) / (b - a));
  let dmg = d.dmg * k * RARITY[w.rarity].dmg;
  if (part === 'head') dmg *= d.head;
  else if (part === 'legs') dmg *= 0.85;
  return dmg;
}

/* ---------- gun geometry ---------- */

let GM = null;
function gunMats() {
  if (GM) return GM;
  GM = {
    metal: new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.34, metalness: 0.85 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x1b1c1d, roughness: 0.72, metalness: 0.08 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x6f6650, roughness: 0.7, metalness: 0.05 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5a3c26, roughness: 0.55, metalness: 0.0 }),
    dot: new THREE.MeshBasicMaterial({ color: 0xff3a2a }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0a1820, roughness: 0.05, metalness: 0.9, emissive: 0x0b2733, emissiveIntensity: 0.6 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.3, metalness: 1.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x8c1d17, roughness: 0.5 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 0.85 }),
    sleeve: new THREE.MeshStandardMaterial({ map: TEX.camoUrban.map, normalMap: TEX.camoUrban.normalMap, roughness: 0.9, color: 0xc8ccd0 }),
  };
  GM.sleeve.map.repeat.set(1, 1);
  return GM;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r = 0.006) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.45));
const cylZ = (r, len, seg = 14, r2) => new THREE.CylinderGeometry(r2 ?? r, r, len, seg).rotateX(Math.PI / 2);
const tubeZ = (r, len, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg, 1, true).rotateX(Math.PI / 2);
const rail = (len, y, z) => {
  const parts = [box(0.024, 0.008, len).translate(0, y, z)];
  for (let t = -len / 2 + 0.01; t < len / 2; t += 0.018) parts.push(box(0.027, 0.006, 0.008).translate(0, y + 0.006, z + t));
  return parts;
};
const slots = (x, y, z0, n, step) => {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(box(0.004, 0.016, 0.03).translate(x, y, z0 - i * step), box(0.004, 0.016, 0.03).translate(-x, y, z0 - i * step));
  return parts;
};

// part: [geometry | geometry[], x, y, z, rx, matKey, name]
const GUN_DEFS = {
  ar: {
    sight: [0, 0.124, -0.1], muzzle: [0, 0.04, -0.88], rightHand: [0, -0.075, 0.0], leftHand: [0, -0.005, -0.44],
    parts: () => [
      [rbox(0.068, 0.07, 0.36, 0.01), 0, 0.04, -0.13, 0, 'metal'],
      [rbox(0.06, 0.05, 0.21, 0.008), 0, -0.012, -0.1, 0, 'metal'],
      [box(0.052, 0.05, 0.075), 0, -0.04, -0.17, 0, 'metal'],
      [box(0.003, 0.026, 0.07), 0.035, 0.046, -0.1, 0, 'polymer'],
      [box(0.032, 0.012, 0.03), 0, 0.08, 0.035, 0, 'metal'],
      [rail(0.42, 0.079, -0.25), 0, 0, 0, 0, 'metal'],
      [[rbox(0.066, 0.068, 0.3, 0.014), ...slots(0.034, 0.0, 0.1, 5, 0.05)], 0, 0.035, -0.45, 0, 'accent'],
      [cylZ(0.011, 0.24), 0, 0.04, -0.72, 0, 'metal'],
      [box(0.03, 0.032, 0.03), 0, 0.048, -0.62, 0, 'metal'],
      [cylZ(0.017, 0.075, 12), 0, 0.04, -0.85, 0, 'metal'],
      [[box(0.03, 0.095, 0.074).rotateX(0.1).translate(0, -0.1, -0.165), box(0.03, 0.09, 0.07).rotateX(0.32).translate(0, -0.18, -0.145)], 0, 0, 0, 0, 'polymer', 'mag'],
      [rbox(0.032, 0.105, 0.048, 0.009), 0, -0.08, 0.0, -0.3, 'polymer'],
      [box(0.008, 0.006, 0.065), 0, -0.047, -0.055, 0, 'metal'],
      [box(0.004, 0.02, 0.006), 0, -0.033, -0.06, 0, 'metal'],
      [cylZ(0.016, 0.12), 0, 0.03, 0.1, 0, 'metal'],
      [rbox(0.042, 0.078, 0.17, 0.012), 0, 0.006, 0.2, 0, 'polymer'],
      [rbox(0.047, 0.116, 0.024, 0.008), 0, -0.008, 0.292, 0, 'rubber'],
      [box(0.03, 0.014, 0.06), 0, 0.092, -0.1, 0, 'metal'],
      [tubeZ(0.022, 0.05), 0, 0.124, -0.1, 0, 'metal'],
      [new THREE.TorusGeometry(0.022, 0.0035, 6, 22), 0, 0.124, -0.125, 0, 'metal'],
      [new THREE.SphereGeometry(0.0021, 8, 6), 0, 0.124, -0.12, 0, 'dot'],
    ],
  },
  smg: {
    sight: [0, 0.116, -0.08], muzzle: [0, 0.04, -0.41], rightHand: [0, -0.07, 0.02], leftHand: [0, -0.06, -0.24],
    parts: () => [
      [rbox(0.06, 0.085, 0.27, 0.01), 0, 0.035, -0.1, 0, 'metal'],
      [box(0.003, 0.02, 0.05), 0.031, 0.05, -0.07, 0, 'polymer'],
      [cylZ(0.02, 0.13, 16), 0, 0.04, -0.3, 0, 'polymer'],
      [cylZ(0.013, 0.05), 0, 0.04, -0.39, 0, 'metal'],
      [rbox(0.028, 0.2, 0.05, 0.006), 0, -0.13, -0.12, 0.05, 'polymer', 'mag'],
      [rbox(0.03, 0.095, 0.045, 0.008), 0, -0.07, 0.02, -0.25, 'polymer'],
      [box(0.008, 0.008, 0.18), 0.02, 0.0, 0.14, 0, 'metal'],
      [box(0.008, 0.008, 0.18), -0.02, 0.0, 0.14, 0, 'metal'],
      [rbox(0.05, 0.085, 0.014, 0.004), 0, -0.006, 0.23, 0, 'rubber'],
      [rbox(0.026, 0.075, 0.032, 0.008), 0, -0.045, -0.24, 0, 'accent'],
      [rail(0.22, 0.081, -0.12), 0, 0, 0, 0, 'metal'],
      [box(0.022, 0.01, 0.01), 0.035, 0.05, -0.18, 0, 'metal'],
      [box(0.03, 0.012, 0.05), 0, 0.093, -0.08, 0, 'metal'],
      [box(0.005, 0.042, 0.01), -0.019, 0.118, -0.08, 0, 'metal'],
      [box(0.005, 0.042, 0.01), 0.019, 0.118, -0.08, 0, 'metal'],
      [box(0.043, 0.006, 0.01), 0, 0.14, -0.08, 0, 'metal'],
      [new THREE.SphereGeometry(0.0021, 8, 6), 0, 0.116, -0.082, 0, 'dot'],
    ],
  },
  shotgun: {
    sight: [0, 0.088, -0.03], muzzle: [0, 0.05, -0.72], rightHand: [0, -0.07, 0.03], leftHand: [0, -0.02, -0.36],
    parts: () => [
      [rbox(0.064, 0.085, 0.24, 0.012), 0, 0.03, -0.08, 0, 'metal'],
      [box(0.003, 0.03, 0.07), 0.033, 0.04, -0.07, 0, 'polymer'],
      [cylZ(0.017, 0.52, 16), 0, 0.05, -0.45, 0, 'metal'],
      [cylZ(0.014, 0.38, 14), 0, 0.012, -0.39, 0, 'metal'],
      [cylZ(0.016, 0.02, 14), 0, 0.012, -0.585, 0, 'metal'],
      [rbox(0.058, 0.052, 0.16, 0.014), 0, 0.012, -0.36, 0, 'wood', 'pump'],
      [rbox(0.045, 0.082, 0.25, 0.014), 0, -0.015, 0.18, 0.06, 'wood'],
      [rbox(0.048, 0.1, 0.022, 0.006), 0, -0.022, 0.305, 0.06, 'rubber'],
      [rbox(0.035, 0.09, 0.05, 0.01), 0, -0.06, 0.03, -0.4, 'wood'],
      [box(0.004, 0.02, 0.004), 0, 0.076, -0.69, 0, 'metal'],
      [new THREE.SphereGeometry(0.0042, 8, 6), 0, 0.088, -0.69, 0, 'brass'],
      [box(0.02, 0.02, 0.012), 0, 0.077, -0.03, 0, 'metal'],
      [new THREE.TorusGeometry(0.008, 0.0025, 6, 16), 0, 0.088, -0.03, 0, 'metal'],
      [box(0.004, 0.045, 0.13), -0.034, 0.03, -0.08, 0, 'polymer'],
      [[0, 1, 2, 3].map((k) => cylZ(0.009, 0.042, 10).translate(-0.04, 0.03, -0.035 - k * 0.03).rotateZ(0)), 0, 0, 0, 0, 'shell'],
    ],
  },
  dmr: {
    sight: [0, 0.122, -0.05], muzzle: [0, 0.04, -0.88], rightHand: [0, -0.075, 0.04], leftHand: [0, -0.012, -0.36],
    parts: () => [
      [rbox(0.06, 0.08, 0.3, 0.01), 0, 0.03, -0.08, 0, 'metal'],
      [cylZ(0.013, 0.56, 14), 0, 0.04, -0.5, 0, 'metal'],
      [cylZ(0.021, 0.09, 12), 0, 0.04, -0.82, 0, 'metal'],
      [[rbox(0.058, 0.068, 0.3, 0.014), ...slots(0.03, 0.0, 0.1, 5, 0.05)], 0, 0.02, -0.36, 0, 'accent'],
      [rbox(0.05, 0.1, 0.32, 0.016), 0, -0.01, 0.2, 0, 'accent'],
      [rbox(0.04, 0.03, 0.14, 0.01), 0, 0.052, 0.16, 0, 'accent'],
      [rbox(0.052, 0.12, 0.024, 0.008), 0, -0.01, 0.37, 0, 'rubber'],
      [rbox(0.04, 0.08, 0.08, 0.008), 0, -0.05, -0.1, 0, 'polymer', 'mag'],
      [rbox(0.032, 0.09, 0.045, 0.009), 0, -0.07, 0.04, -0.3, 'polymer'],
      [cylZ(0.019, 0.26, 18), 0, 0.122, -0.08, 0, 'metal'],
      [cylZ(0.02, 0.07, 18, 0.03), 0, 0.122, -0.245, 0, 'metal'],
      [cylZ(0.024, 0.06, 18, 0.021), 0, 0.122, 0.075, 0, 'metal'],
      [cylZ(0.027, 0.003, 18), 0, 0.122, -0.281, 0, 'glass'],
      [new THREE.CylinderGeometry(0.011, 0.011, 0.03, 12), 0, 0.152, -0.08, 0, 'metal'],
      [new THREE.CylinderGeometry(0.011, 0.011, 0.03, 12).rotateZ(Math.PI / 2), 0.03, 0.122, -0.08, 0, 'metal'],
      [box(0.022, 0.05, 0.024), 0, 0.085, -0.16, 0, 'metal'],
      [box(0.022, 0.05, 0.024), 0, 0.085, 0.0, 0, 'metal'],
      [[new THREE.CylinderGeometry(0.006, 0.006, 0.06, 6).rotateZ(Math.PI / 2).translate(0.045, 0, 0), new THREE.SphereGeometry(0.012, 10, 8).translate(0.078, 0, 0)], 0, 0.04, 0.02, 0, 'metal', 'bolt'],
    ],
  },
  pistol: {
    sight: [0, 0.077, -0.07], muzzle: [0, 0.055, -0.18], rightHand: [0, -0.04, 0.0], leftHand: [-0.012, -0.05, -0.01],
    parts: () => [
      [[rbox(0.03, 0.035, 0.19, 0.006), ...[0, 1, 2, 3, 4, 5].map((k) => box(0.032, 0.022, 0.003).translate(0, 0.002, 0.07 - k * 0.008))], 0, 0.053, -0.07, 0, 'metal', 'slide'],
      [box(0.003, 0.014, 0.04), 0.0155, 0.058, -0.06, 0, 'polymer'],
      [rbox(0.028, 0.026, 0.155, 0.006), 0, 0.022, -0.06, 0, 'polymer'],
      [rbox(0.031, 0.112, 0.052, 0.01), 0, -0.04, 0.0, -0.22, 'polymer'],
      [rbox(0.034, 0.012, 0.056, 0.004), 0, -0.098, 0.013, -0.22, 'metal'],
      [box(0.006, 0.006, 0.05), 0, -0.004, -0.06, 0, 'polymer'],
      [cylZ(0.0065, 0.02, 10), 0, 0.055, -0.168, 0, 'metal'],
      [box(0.004, 0.009, 0.005), 0, 0.074, -0.155, 0, 'metal'],
      [new THREE.SphereGeometry(0.0018, 6, 6), 0, 0.077, -0.152, 0, 'dot'],
      [box(0.005, 0.009, 0.006), -0.007, 0.074, 0.012, 0, 'metal'],
      [box(0.005, 0.009, 0.006), 0.007, 0.074, 0.012, 0, 'metal'],
    ],
  },
};

function partGeo(geo) {
  if (!Array.isArray(geo)) return geo;
  const list = geo.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(list);
}

export function gunInfo(id) {
  return GUN_DEFS[id];
}

export function buildGunGroup(id) {
  const M = gunMats();
  const def = GUN_DEFS[id];
  const g = new THREE.Group();
  const named = {};
  for (const [geo, x, y, z, rx, mk, name] of def.parts()) {
    const m = new THREE.Mesh(partGeo(geo), M[mk]);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    if (name) named[name] = m;
  }
  return { group: g, named, def };
}

const mergedCache = {};
export function gunGeometry(id) {
  if (mergedCache[id]) return mergedCache[id];
  const geos = [];
  for (const [geo0, x, y, z, rx, mk] of GUN_DEFS[id].parts()) {
    if (mk === 'dot' || mk === 'glass') continue;
    const geo = partGeo(geo0);
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(1, 1, 1)));
    const n = g.attributes.position.count;
    const shade = mk === 'accent' ? [0.42, 0.38, 0.29] : mk === 'wood' ? [0.33, 0.21, 0.13] : mk === 'polymer' || mk === 'rubber' ? [0.09, 0.09, 0.09] : mk === 'shell' ? [0.4, 0.08, 0.06] : mk === 'brass' ? [0.6, 0.48, 0.2] : [0.2, 0.21, 0.22];
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set(shade, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geos.push(g);
  }
  mergedCache[id] = mergeGeometries(geos);
  return mergedCache[id];
}

/* ---------- first-person viewmodel ---------- */

function limb(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2), 4, 10), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

export class Viewmodel {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.guns = {};
    this.current = null;
    this.ads = 0;
    this.bobT = 0;
    this.sway = new THREE.Vector2();
    this.swayV = new THREE.Vector2();
    this.kick = 0;
    this.kickV = 0;
    this.kickRot = 0;
    this.kickRotV = 0;
    this.sprint = 0;
    this.equip = 1;
    this.land = 0;
    this.flashT = 0;
    this.casings = [];
    const M = gunMats();
    const flashMat = new THREE.SpriteMaterial({ map: TEX.flash, color: 0xffd6a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.flash = new THREE.Sprite(flashMat);
    this.flash.scale.setScalar(0.16);
    this.flash.visible = false;
    this.casingGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.022, 6);
    this.casingMat = M.brass;
  }

  getGun(id) {
    if (this.guns[id]) return this.guns[id];
    const M = gunMats();
    const g = buildGunGroup(id);
    const info = GUN_DEFS[id];
    const rh = new THREE.Vector3(...info.rightHand), lh = new THREE.Vector3(...info.leftHand);
    g.group.add(new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.1), M.glove).translateX(rh.x).translateY(rh.y).translateZ(rh.z));
    g.group.add(limb(rh, rh.clone().add(new THREE.Vector3(0.07, -0.2, 0.34)), 0.042, M.sleeve));
    if (id !== 'pistol') {
      const lg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.1), M.glove);
      lg.position.copy(lh).add(new THREE.Vector3(0, -0.025, 0));
      lg.rotation.z = 0.5;
      g.group.add(lg);
      g.group.add(limb(lh.clone().add(new THREE.Vector3(-0.02, -0.04, 0.02)), lh.clone().add(new THREE.Vector3(-0.2, -0.24, 0.32)), 0.042, M.sleeve));
    } else {
      const lg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.09), M.glove);
      lg.position.copy(lh);
      g.group.add(lg);
      g.group.add(limb(lh, lh.clone().add(new THREE.Vector3(-0.16, -0.22, 0.34)), 0.04, M.sleeve));
    }
    g.sight = new THREE.Vector3(...info.sight);
    g.muzzle = new THREE.Vector3(...info.muzzle);
    g.group.visible = false;
    for (const k in g.named) g.named[k].userData.base = g.named[k].position.clone();
    this.root.add(g.group);
    this.guns[id] = g;
    return g;
  }

  setWeapon(id) {
    if (this.current) this.current.group.visible = false;
    if (!id) { this.current = null; this.currentId = null; return; }
    this.current = this.getGun(id);
    this.current.group.visible = true;
    this.current.group.add(this.flash);
    this.flash.position.copy(this.current.muzzle).add(new THREE.Vector3(0, 0, -0.06));
    this.currentId = id;
    this.equip = 0;
  }

  fire(def, ads) {
    const k = ads > 0.5 ? 0.55 : 1;
    this.kickV += (def.recoil * 0.9 + 0.6) * k;
    this.kickRotV += (def.recoil * 1.2 + 0.4) * k;
    this.flashT = 0.045;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.scale.setScalar((def.id === 'shotgun' ? 0.26 : def.id === 'pistol' ? 0.12 : 0.18) * (0.8 + Math.random() * 0.4));
    if (def.id !== 'shotgun' || true) this.spawnCasing(def.id === 'shotgun' ? 1.6 : 1);
    if (this.current && this.current.named.slide) this.current.named.slide.userData.kick = 1;
  }

  spawnCasing(scale) {
    if (!this.current) return;
    let c = this.casings.find((x) => !x.alive);
    if (!c) {
      if (this.casings.length > 14) return;
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      this.root.add(mesh);
      c = { mesh, alive: false, v: new THREE.Vector3(), w: new THREE.Vector3(), t: 0 };
      this.casings.push(c);
    }
    const g = this.current.group;
    c.alive = true;
    c.t = 0;
    c.mesh.visible = true;
    c.mesh.scale.setScalar(scale);
    c.mesh.position.set(0.03, 0.06, -0.12).applyMatrix4(g.matrix);
    c.v.set(0.9 + Math.random() * 0.5, 0.9 + Math.random() * 0.6, 0.2 + Math.random() * 0.2);
    c.w.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
  }

  // st: { ads, speed, sprint, onGround, lookDX, lookDY, reload (0..1 or -1), crouch, slide, heal, hidden, scope }
  update(dt, st) {
    const g = this.current;
    if (!g) return;
    this.root.visible = !st.hidden;
    const def = st.def;
    this.ads = st.ads;
    this.equip = Math.min(1, this.equip + dt / 0.45);
    this.sprint = damp(this.sprint, st.sprint ? 1 : 0, 10, dt);
    // sway follows mouse with lag
    this.swayV.x += (-st.lookDX * 0.0009 - this.sway.x * 60) * dt;
    this.swayV.y += (st.lookDY * 0.0009 - this.sway.y * 60) * dt;
    this.swayV.multiplyScalar(Math.exp(-12 * dt));
    this.sway.x = clamp(this.sway.x + this.swayV.x, -0.06, 0.06);
    this.sway.y = clamp(this.sway.y + this.swayV.y, -0.06, 0.06);
    // recoil springs
    this.kickV += (-this.kick * 220 - this.kickV * 22) * dt;
    this.kick += this.kickV * dt;
    this.kickRotV += (-this.kickRot * 260 - this.kickRotV * 24) * dt;
    this.kickRot += this.kickRotV * dt;
    // bob
    const moving = st.onGround ? clamp(st.speed / 6, 0, 1.4) : 0;
    this.bobT += dt * (5 + st.speed * 1.35);
    const adsK = 1 - this.ads * 0.85;
    const bobX = Math.sin(this.bobT) * 0.012 * moving * adsK;
    const bobY = -Math.abs(Math.cos(this.bobT)) * 0.012 * moving * adsK;
    this.land = damp(this.land, 0, 8, dt);
    // base poses
    const hip = new THREE.Vector3(0.155, -0.175, -0.4);
    if (def.id === 'pistol') hip.set(0.13, -0.15, -0.4);
    const ads = new THREE.Vector3(-g.sight.x, -g.sight.y, -0.13 - (def.id === 'pistol' ? 0.2 : 0.12) - g.sight.z);
    if (def.scope) ads.z = -0.2 - g.sight.z;
    const p = hip.clone().lerp(ads, this.ads);
    p.x += bobX + this.sway.x * adsK;
    p.y += bobY + this.sway.y * adsK - this.land * 0.04;
    p.z += this.kick * 0.035;
    let rx = this.kickRot * 0.06 + this.sway.y * 0.6 * adsK;
    let ry = this.sway.x * 0.8 * adsK;
    let rz = (1 - this.ads) * 0.02 + bobX * 0.6;
    // sprint pose
    p.x += this.sprint * 0.05;
    p.y -= this.sprint * 0.06;
    rx -= this.sprint * 0.35;
    ry += this.sprint * 0.55;
    // crouch / slide tilt
    rz += (st.slide ? 0.25 : 0) + (st.crouch ? 0.04 : 0) * (1 - this.ads);
    // reload: dip and roll the gun
    if (st.reload >= 0) {
      const r = st.reload;
      const k = Math.sin(Math.min(1, r) * Math.PI);
      p.y -= k * 0.08;
      rx += k * 0.25;
      rz += k * 0.55;
      const mag = g.named.mag;
      if (mag) {
        const mk = r < 0.35 ? r / 0.35 : r < 0.65 ? 1 : 1 - (r - 0.65) / 0.35;
        mag.position.y = mag.userData.base.y - mk * 0.22;
        mag.visible = !(r > 0.3 && r < 0.6);
      }
    } else if (g.named.mag) {
      g.named.mag.position.copy(g.named.mag.userData.base);
      g.named.mag.visible = true;
    }
    // heal: lower weapon
    if (st.heal) { p.y -= 0.25; rx -= 0.6; }
    // equip
    const e = 1 - this.equip;
    p.y -= e * e * 0.3;
    rx -= e * e * 0.8;
    // pump / bolt / slide action
    if (g.named.pump) {
      const a = st.action;
      g.named.pump.position.z = g.named.pump.userData.base.z + Math.sin(clamp(a, 0, 1) * Math.PI) * 0.09;
    }
    if (g.named.bolt) {
      const a = st.action;
      g.named.bolt.position.z = g.named.bolt.userData.base.z + Math.sin(clamp(a, 0, 1) * Math.PI) * 0.07;
      rz += Math.sin(clamp(a, 0, 1) * Math.PI) * 0.2;
    }
    if (g.named.slide) {
      const s = g.named.slide;
      s.userData.kick = Math.max(0, (s.userData.kick || 0) - dt * 14);
      s.position.z = s.userData.base.z + s.userData.kick * 0.03;
    }
    g.group.position.copy(p);
    g.group.rotation.set(rx, ry, rz, 'YXZ');
    g.group.visible = !(def.scope && this.ads > 0.92);
    // flash
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    g.group.updateMatrix();
    for (const c of this.casings) {
      if (!c.alive) continue;
      c.t += dt;
      c.v.y -= 9 * dt;
      c.mesh.position.addScaledVector(c.v, dt);
      c.mesh.rotation.x += c.w.x * dt;
      c.mesh.rotation.y += c.w.y * dt;
      if (c.t > 0.7) { c.alive = false; c.mesh.visible = false; }
    }
  }

  landed(v) { this.land = Math.min(1.5, this.land + v); }
}
