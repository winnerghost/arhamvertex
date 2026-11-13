// Soldier models built from primitives, with procedural walk/crouch/aim animation,
// two-bone IK arms that hold the weapon, a collapse on death and a glider for the drop.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEX } from './textures.js';
import { gunGeometry, gunInfo } from './weapons.js';
import { patchMaterial } from './render.js';
import { clamp, damp } from './util.js';

export const TEAM_LOOKS = [
  { camo: 'camoUrban', vest: 0x2f363a, helmet: 0x394246, accent: 0x34e0cf },
  { camo: 'camoDesert', vest: 0x7a6a50, helmet: 0x857657, accent: 0xff6a2b },
  { camo: 'camoWood', vest: 0x3d4630, helmet: 0x4a5238, accent: 0xb6ff4d },
  { camo: 'camoUrban', vest: 0x25272b, helmet: 0x1f2125, accent: 0xff3b6b },
  { camo: 'camoDesert', vest: 0x5e5446, helmet: 0x6e6252, accent: 0xffd23f },
  { camo: 'camoWood', vest: 0x2c3326, helmet: 0x343b2c, accent: 0x6aa9ff },
  { camo: 'camoUrban', vest: 0x4a4038, helmet: 0x51473e, accent: 0xd38cff },
  { camo: 'camoDesert', vest: 0x494b44, helmet: 0x575950, accent: 0xff9d2e },
];

let G = null;
function geos() {
  if (G) return G;
  const gear = [];
  const vest = new RoundedBoxGeometry(0.47, 0.37, 0.31, 2, 0.05);
  vest.translate(0, 0.27, 0.0);
  for (const x of [-0.25, 0.25]) {
    const pad = new RoundedBoxGeometry(0.13, 0.08, 0.17, 1, 0.03);
    pad.translate(x, 0.47, 0);
    gear.push(pad);
  }
  gear.push(vest);
  for (const x of [-0.11, 0, 0.11]) {
    const p = new RoundedBoxGeometry(0.085, 0.11, 0.06, 1, 0.015);
    p.translate(x, 0.18, 0.18);
    gear.push(p);
  }
  const pack = new RoundedBoxGeometry(0.32, 0.4, 0.17, 2, 0.05);
  pack.translate(0, 0.31, -0.22);
  gear.push(pack);
  const radio = new THREE.BoxGeometry(0.06, 0.14, 0.05);
  radio.translate(0.16, 0.42, -0.12);
  gear.push(radio);
  const ant = new THREE.CylinderGeometry(0.006, 0.006, 0.3, 4);
  ant.translate(0.17, 0.62, -0.13);
  gear.push(ant);
  const belt = new RoundedBoxGeometry(0.4, 0.07, 0.27, 1, 0.025);
  belt.translate(0, 0.0, 0);
  gear.push(belt);
  const helmet = new THREE.SphereGeometry(0.152, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.56);
  helmet.scale(1, 0.92, 1.1);
  helmet.translate(0, 0.135, -0.005);
  const mount = new THREE.BoxGeometry(0.05, 0.04, 0.03);
  mount.translate(0, 0.21, 0.15);
  const ear1 = new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10).rotateZ(Math.PI / 2);
  ear1.translate(0.135, 0.1, 0);
  const ear2 = ear1.clone().translate(-0.27, 0, 0);
  G = {
    pelvis: new RoundedBoxGeometry(0.36, 0.19, 0.24, 2, 0.06),
    thigh: new THREE.CapsuleGeometry(0.104, 0.26, 4, 12).translate(0, -0.21, 0),
    shin: new THREE.CapsuleGeometry(0.082, 0.28, 4, 12).translate(0, -0.21, 0),
    knee: new RoundedBoxGeometry(0.11, 0.12, 0.08, 1, 0.03).translate(0, 0.0, 0.07),
    boot: new RoundedBoxGeometry(0.135, 0.13, 0.29, 2, 0.035).translate(0, -0.41, 0.05),
    torso: new RoundedBoxGeometry(0.42, 0.46, 0.25, 2, 0.07).translate(0, 0.24, 0),
    gear: mergeGeometries(gear.map((g) => (g.index ? g.toNonIndexed() : g))),
    head: new THREE.SphereGeometry(0.118, 16, 12).translate(0, 0.12, 0),
    helmet: mergeGeometries([helmet, mount, ear1, ear2].map((g) => (g.index ? g.toNonIndexed() : g))),
    visor: new RoundedBoxGeometry(0.19, 0.05, 0.05, 1, 0.018).translate(0, 0.14, 0.098),
    upper: new THREE.CapsuleGeometry(0.078, 0.17, 4, 10),
    fore: new THREE.CapsuleGeometry(0.066, 0.16, 4, 10),
    glove: new RoundedBoxGeometry(0.08, 0.09, 0.11, 1, 0.025),
    wing: (() => {
      const w = new THREE.BoxGeometry(2.2, 0.03, 0.8, 10, 1, 1);
      const p = w.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - Math.pow(p.getX(i) / 1.1, 2) * 0.3);
      w.computeVertexNormals();
      w.translate(0, 1.0, 0);
      return w;
    })(),
  };
  return G;
}

const lookMats = {};
function mats(look) {
  const key = look.camo + look.vest + '_' + look.accent;
  if (lookMats[key]) return lookMats[key];
  const t = TEX[look.camo];
  const m = {
    fabric: new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughness: 0.92 }),
    gear: new THREE.MeshStandardMaterial({ map: TEX.cordura.map, normalMap: TEX.cordura.normalMap, color: look.vest, roughness: 0.85 }),
    helmet: new THREE.MeshStandardMaterial({ color: look.helmet, roughness: 0.6, metalness: 0.1 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.9 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x2b241d, roughness: 0.8 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x0b0d0e, emissive: look.accent, emissiveIntensity: 0.9, roughness: 0.12, metalness: 0.7 }),
    gun: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 }),
    wing: new THREE.MeshStandardMaterial({ color: new THREE.Color(look.accent).multiplyScalar(0.55), map: TEX.cordura.map, roughness: 0.7, side: THREE.DoubleSide }),
  };
  for (const k in m) patchMaterial(m[k], { flood: false });
  lookMats[key] = m;
  return m;
}

const Y = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
const POLE_R = new THREE.Vector3(-0.6, -1, -0.3).normalize();
const POLE_L = new THREE.Vector3(0.7, -1, -0.2).normalize();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3(), _t = new THREE.Vector3();

function solveIK(S, T, a, b, pole, outE) {
  _d.subVectors(T, S);
  let L = _d.length();
  const dir = _d.normalize();
  L = clamp(L, Math.abs(a - b) + 0.001, a + b - 0.001);
  const x = (a * a - b * b + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(a * a - x * x, 0));
  _p.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  outE.copy(S).addScaledVector(dir, x).addScaledVector(_p, h);
  return outE;
}

function placeLimb(mesh, a, b) {
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _t.subVectors(b, a).normalize();
  mesh.quaternion.setFromUnitVectors(Y, _t);
}

export class Soldier {
  constructor(look, gunId = 'ar') {
    const g = geos();
    const M = mats(look);
    this.M = M;
    const mesh = (geo, mat, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = true;
      return m;
    };
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.hips = new THREE.Group();
    this.hips.position.y = 0.95;
    this.body.add(this.hips);
    this.hips.add(mesh(g.pelvis, M.fabric));
    const leg = (x) => {
      const hip = new THREE.Group();
      hip.position.set(x, -0.04, 0);
      hip.add(mesh(g.thigh, M.fabric));
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      knee.add(mesh(g.shin, M.fabric));
      knee.add(mesh(g.boot, M.boot));
      knee.add(mesh(g.knee, M.gear, false));
      hip.add(knee);
      this.hips.add(hip);
      return { hip, knee };
    };
    this.legL = leg(0.11);
    this.legR = leg(-0.11);
    this.spine = new THREE.Group();
    this.spine.position.y = 0.05;
    this.hips.add(this.spine);
    this.spine.add(mesh(g.torso, M.fabric));
    this.spine.add(mesh(g.gear, M.gear));
    this.neck = new THREE.Group();
    this.neck.position.y = 0.5;
    this.spine.add(this.neck);
    this.neck.add(mesh(g.head, M.dark));
    this.neck.add(mesh(g.helmet, M.helmet));
    this.visor = mesh(g.visor, M.visor, false);
    this.neck.add(this.visor);
    this.shoulderR = new THREE.Vector3(-0.25, 0.44, 0.0);
    this.shoulderL = new THREE.Vector3(0.25, 0.44, 0.0);
    this.armR = { up: mesh(g.upper, M.fabric), fore: mesh(g.fore, M.fabric), hand: mesh(g.glove, M.dark, false) };
    this.armL = { up: mesh(g.upper, M.fabric), fore: mesh(g.fore, M.fabric), hand: mesh(g.glove, M.dark, false) };
    for (const a of [this.armR, this.armL]) this.spine.add(a.up, a.fore, a.hand);
    this.gunMount = new THREE.Group();
    this.gunMount.position.set(-0.08, 0.33, 0.24);
    this.spine.add(this.gunMount);
    this.gun = mesh(gunGeometry(gunId), M.gun);
    this.gun.rotation.y = Math.PI;
    this.gunMount.add(this.gun);
    this.wing = mesh(g.wing, M.wing);
    this.wing.position.y = 0.9;
    this.wing.visible = false;
    this.spine.add(this.wing);
    this.gunId = gunId;
    this.setGun(gunId);
    this.phase = Math.random() * 6;
    this.crouch = 0;
    this.kick = 0;
    this.deathT = -1;
    this.reloadK = 0;
    this.tag = null;
  }

  setGun(id) {
    if (!id) { this.gun.visible = false; return; }
    this.gun.visible = true;
    if (id !== this.gunId) {
      this.gun.geometry = gunGeometry(id);
      this.gunId = id;
    }
    const info = gunInfo(id);
    // gun is rotated 180deg around Y, so local (x,y,z) -> (-x, y, -z)
    this.handR = new THREE.Vector3(-info.rightHand[0], info.rightHand[1], -info.rightHand[2]);
    this.handL = new THREE.Vector3(-info.leftHand[0], info.leftHand[1], -info.leftHand[2]);
    this.updateArms(0);
  }

  updateArms(reload) {
    const kickZ = -this.kick * 0.04;
    const ax = this.gunMount.rotation.x;
    const rT = this.handR.clone().applyAxisAngle(XAXIS, ax).add(this.gunMount.position);
    rT.z += kickZ;
    const lT = this.handL.clone().applyAxisAngle(XAXIS, ax).add(this.gunMount.position);
    lT.z += kickZ;
    if (reload > 0) {
      const k = Math.sin(Math.min(1, reload) * Math.PI);
      lT.lerp(new THREE.Vector3(rT.x + 0.06, rT.y - 0.12, rT.z - 0.1), k);
    }
    this.limbPair(this.armR, this.shoulderR, rT, POLE_R);
    this.limbPair(this.armL, this.shoulderL, lT, POLE_L);
  }

  limbPair(arm, S, T, pole) {
    solveIK(S, T, 0.3, 0.29, pole, _e);
    placeLimb(arm.up, S, _e);
    placeLimb(arm.fore, _e, T);
    arm.hand.position.copy(T);
    arm.hand.quaternion.copy(arm.fore.quaternion);
  }

  setTag(sprite) {
    if (this.tag) this.root.remove(this.tag);
    this.tag = sprite;
    if (sprite) { sprite.position.y = 2.15; this.root.add(sprite); }
  }

  // s: { x,y,z, yaw, pitch, vx, vz, onGround, crouch, alive, firing, reload (0..1|-1), gliding, swimming, near }
  update(dt, s) {
    const r = this.root;
    r.position.set(s.x, s.y, s.z);
    r.rotation.y = s.yaw;
    this.wing.visible = !!s.gliding && s.alive;
    if (!s.alive) {
      if (this.deathT < 0) {
        this.deathT = 0;
        this.fallDir = s.fallDir || -1;
        this.gun.visible = false;
        if (this.tag) this.tag.visible = false;
      }
      this.deathT += dt;
      const t = this.deathT;
      const k = clamp((t - 0.12) / 0.55, 0, 1);
      const e = k * k;
      this.body.rotation.x = this.fallDir * e * 1.42;
      this.body.position.y = -e * 0.12 - Math.max(0, t - 8) * 0.25;
      this.hips.position.y = 0.95 - clamp(t / 0.25, 0, 1) * 0.25;
      this.legL.hip.rotation.x = -0.5 * clamp(t / 0.25, 0, 1);
      this.legR.hip.rotation.x = -0.2;
      this.legL.knee.rotation.x = 0.9 * clamp(t / 0.25, 0, 1);
      this.spine.rotation.x = 0.3 * e;
      this.neck.rotation.x = 0.4 * e;
      this.visor.material = this.M.dark;
      return;
    }
    if (this.deathT >= 0) {
      this.deathT = -1;
      this.body.rotation.x = 0;
      this.body.position.y = 0;
      this.visor.material = this.M.visor;
      if (this.tag) this.tag.visible = true;
    }
    if (!s.near) {
      this.spine.rotation.x = -s.pitch * 0.55;
      return;
    }
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const fwd = s.vx * fx + s.vz * fz;
    const side = s.vx * fz - s.vz * fx;
    const speed = Math.hypot(s.vx, s.vz);
    this.crouch = damp(this.crouch, s.crouch ? 1 : 0, 10, dt);
    const moving = s.onGround && speed > 0.3;
    this.phase += dt * (moving ? 2.4 + speed * 1.05 : 0);
    const amp = moving ? Math.min(speed / 5, 1) * 0.65 : 0;
    const sw = Math.sin(this.phase);
    const fwdK = speed > 0.1 ? fwd / speed : 1, sideK = speed > 0.1 ? side / speed : 0;
    const cr = this.crouch;
    let hipL = -sw * amp * fwdK, hipR = sw * amp * fwdK;
    const legSideL = sw * amp * sideK * 0.45, legSideR = -sw * amp * sideK * 0.45;
    let kneeL = Math.max(0, Math.sin(this.phase + 1.2)) * amp * 1.4;
    let kneeR = Math.max(0, Math.sin(this.phase + 1.2 + Math.PI)) * amp * 1.4;
    if (!s.onGround) {
      hipL = -0.5; hipR = 0.2; kneeL = 0.9; kneeR = 0.5;
      if (s.gliding) { hipL = 0.2; hipR = 0.25; kneeL = 0.4; kneeR = 0.5; }
    }
    if (s.swimming) { hipL = Math.sin(this.phase * 2) * 0.4; hipR = -hipL; kneeL = 0.3; kneeR = 0.3; this.phase += dt * 3; }
    this.legL.hip.rotation.x = hipL * (1 - cr) + cr * -1.15;
    this.legR.hip.rotation.x = hipR * (1 - cr) + cr * -0.55;
    this.legL.hip.rotation.z = legSideL;
    this.legR.hip.rotation.z = legSideR;
    this.legL.knee.rotation.x = kneeL * (1 - cr) + cr * 1.75;
    this.legR.knee.rotation.x = kneeR * (1 - cr) + cr * 1.65;
    this.hips.position.y = 0.95 - Math.abs(Math.cos(this.phase)) * 0.035 * amp - cr * 0.34 - (s.swimming ? 0.2 : 0);
    this.kick = damp(this.kick, 0, 18, dt);
    if (s.firing) this.kick = 1;
    this.spine.rotation.x = -s.pitch * 0.55 + cr * 0.18 + amp * 0.06;
    this.spine.rotation.y = 0;
    this.neck.rotation.x = -s.pitch * 0.25 - cr * 0.1;
    this.gunMount.rotation.x = -s.pitch * 0.2;
    if (s.gliding) {
      this.spine.rotation.x = 0.5;
      this.gunMount.rotation.x = 0;
    }
    this.reloadK = s.reload;
    this.updateArms(s.reload);
  }
}

export function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '600 26px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(text.toUpperCase(), 128, 22);
  ctx.fillStyle = color;
  ctx.fillText(text.toUpperCase(), 128, 22);
  ctx.beginPath();
  ctx.moveTo(128, 60);
  ctx.lineTo(120, 46);
  ctx.lineTo(136, 46);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, fog: false }));
  s.scale.set(0.13, 0.0325, 1);
  s.renderOrder = 10;
  return s;
}
