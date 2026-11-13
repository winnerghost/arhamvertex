// Game simulation: entities, character physics, hitscan combat, the tide, loot and crates,
// grenades, arena rounds and battle royale flow.
import * as THREE from 'three';
import { World } from './world.js';
import { Soldier, TEAM_LOOKS, nameTag } from './characters.js';
import { WEAPONS, RARITY, makeWeapon, damageAt, gunGeometry } from './weapons.js';
import { U } from './render.js';
import { TEX } from './textures.js';
import { BotBrain, weaponScore } from './bots.js';
import { clamp, lerp, smoothstep, damp, shuffle, wrapAngle } from './util.js';

export const MODES = {
  a1: { id: 'a1', kind: 'arena', teamSize: 1, label: '1v1', map: 'spillway', rounds: 3 },
  a2: { id: 'a2', kind: 'arena', teamSize: 2, label: '2v2', map: 'spillway', rounds: 3 },
  a3: { id: 'a3', kind: 'arena', teamSize: 3, label: '3v3', map: 'spillway', rounds: 3 },
  a4: { id: 'a4', kind: 'arena', teamSize: 4, label: '4v4', map: 'spillway', rounds: 3 },
  solo: { id: 'solo', kind: 'royale', teamSize: 1, total: 24, label: 'Solo', map: 'saltreach' },
  duos: { id: 'duos', kind: 'royale', teamSize: 2, total: 24, label: 'Duos', map: 'saltreach' },
  squads: { id: 'squads', kind: 'royale', teamSize: 4, total: 24, label: 'Squads', map: 'saltreach' },
};

const NAMES = ['Kestrel', 'Vanta', 'Rook', 'Juno', 'Brine', 'Halyard', 'Cinder', 'Moth', 'Ferro', 'Quill', 'Sable', 'Tamsin', 'Corvo', 'Pike',
  'Wren', 'Orrin', 'Skerry', 'Fathom', 'Gale', 'Ledger', 'Marrow', 'Nadir', 'Osprey', 'Petrel', 'Rime', 'Shoal', 'Tarn', 'Umber', 'Vesper',
  'Wick', 'Yarrow', 'Zephyr', 'Lantern', 'Basalt', 'Cobalt', 'Drift', 'Ember', 'Flint', 'Grebe', 'Heron', 'Ibis', 'Jetty'];

const GRAV = 20, JUMP = 6.4, STEP = 0.46;
export const GUNS = ['ar', 'smg', 'shotgun', 'dmr', 'pistol'];
const KINDS = ['none', 'terrain', 'concrete', 'metal', 'wood', 'water', 'flesh', 'shield'];
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// Fill each team with the humans in the room first, then bots.
// pref 'together' groups humans on the same team; 'versus' spreads them across teams.
export function buildRoster(m, humans, pref) {
  const teams = m.kind === 'arena' ? 2 : Math.floor(m.total / m.teamSize);
  const slots = Array.from({ length: teams }, () => []);
  let t = 0;
  for (const h of humans) {
    if (pref === 'together') {
      while (t < teams && slots[t].length >= m.teamSize) t++;
      if (t >= teams) break;
      slots[t].push(h);
    } else {
      let tries = 0;
      while (slots[t % teams].length >= m.teamSize && tries < teams) { t++; tries++; }
      if (tries >= teams) break;
      slots[t % teams].push(h);
      t++;
    }
  }
  const names = shuffle(Math.random, NAMES.slice());
  let ni = 0;
  const roster = [];
  for (let k = 0; k < teams; k++) {
    for (let j = 0; j < m.teamSize; j++) {
      const h = slots[k][j];
      roster.push(h ? { name: h.name, team: k, hid: h.hid, loadout: h.loadout } : { name: names[ni++ % names.length], team: k, hid: -1 });
    }
  }
  return roster;
}
const LOOT_WEAPONS = [['ar', 0.28], ['smg', 0.24], ['shotgun', 0.2], ['dmr', 0.12], ['pistol', 0.16]];

function weighted(list, r) {
  let s = 0;
  for (const [k, w] of list) { s += w; if (r < s) return k; }
  return list[list.length - 1][0];
}

function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

function rayCyl(o, d, cx, cz, r, y0, y1) {
  const px = o.x - cx, pz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let t = Infinity;
  if (a > 1e-8) {
    const b = 2 * (px * d.x + pz * d.z), c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t0 = (-b - Math.sqrt(disc)) / (2 * a);
      if (t0 > 0) {
        const y = o.y + d.y * t0;
        if (y >= y0 && y <= y1) t = t0;
      }
    }
  }
  if (Math.abs(d.y) > 1e-6) {
    for (const yc of [y1, y0]) {
      const tc = (yc - o.y) / d.y;
      if (tc > 0 && tc < t) {
        const x = px + d.x * tc, z = pz + d.z * tc;
        if (x * x + z * z <= r * r) t = tc;
      }
    }
  }
  return t;
}

function matKind(mat) {
  if (!mat) return 'concrete';
  if (mat.startsWith('cont') || mat.startsWith('paint') || mat === 'siding') return 'metal';
  if (mat === 'wood' || mat === 'bark') return 'wood';
  return 'concrete';
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d = new THREE.Vector3();

export class Game {
  constructor({ renderer, audio, hud, fx, settings }) {
    this.R = renderer;
    this.audio = audio;
    this.hud = hud;
    this.fx = fx;
    this.settings = settings;
    this.scene = renderer.scene;
    this.ents = [];
    this.loot = [];
    this.crates = [];
    this.grenades = [];
    this.world = null;
    this.time = 0;
    this.state = 'idle';
    this.stateT = 0;
    this.frozen = false;
    this.pathBudget = 3;
    this._q = [];
    this._q2 = [];
    this._hit = { n: { x: 0, y: 1, z: 0 } };
    this._hs = { n: { x: 0, y: 1, z: 0 }, t: 0, kind: 'none', target: null, part: '' };
    this.tide = { level: 0, next: 0, timeToNext: 99, sub: 'wait', phase: 0, t: 0, dps: 1, alert: 0 };
    this.lootGroup = new THREE.Group();
    this.scene.add(this.lootGroup);
    this.entGroup = new THREE.Group();
    this.scene.add(this.entGroup);
    this.lootMats = null;
    this.events = [];
  }

  /* ---------- setup ---------- */

  loadMap(id) {
    if (this.world && this.world.id === id) return this.world;
    this.world = new World(id);
    this.R.buildWorld(this.world);
    this.fx.setFog(this.R.scene.fog.density);
    this.fx.setRain(!!this.R.skyPreset.rain);
    return this.world;
  }

  clear() {
    for (const e of this.ents) this.entGroup.remove(e.model.root);
    this.ents = [];
    for (const it of this.loot) this.lootGroup.remove(it.mesh);
    for (const c of this.crates) this.lootGroup.remove(c.mesh);
    for (const g of this.grenades) this.scene.remove(g.mesh);
    this.loot = [];
    this.crates = [];
    this.grenades = [];
    this.fx.clear();
    this.player = null;
    this.spectate = null;
  }

  start(modeId, opts) {
    this.mode = MODES[modeId];
    this.opts = opts;
    this.role = opts.role || 'solo';
    this.loadMap(this.mode.map);
    this.clear();
    this.time = 0;
    this.result = null;
    this.resultT = 0;
    this.placements = {};
    this.events.length = 0;
    const m = this.mode;
    this.teamCount = m.kind === 'arena' ? 2 : Math.floor(m.total / m.teamSize);
    const myHid = opts.myHid ?? 0;
    const roster = opts.roster || buildRoster(m, [{ hid: 0, name: 'You' }], 'versus');
    for (const r of roster) {
      const look = TEAM_LOOKS[m.kind === 'arena' ? r.team : r.team % TEAM_LOOKS.length];
      const e = this.spawnEnt({ name: r.name, team: r.team, isPlayer: r.hid === myHid, look, hid: r.hid });
      e.loadout = r.loadout || 'ar';
      if (e.isPlayer) this.player = e;
    }
    for (const e of this.ents) {
      if (e.team === this.player.team && !e.isPlayer) e.model.setTag(nameTag(e.name, e.hid >= 0 ? '#f2b54a' : '#7ff0e4'));
    }
    this.score = [0, 0];
    this.round = 0;
    if (this.role === 'client') {
      this.state = 'pre';
      this.stateT = 99;
      this.frozen = true;
      this.resetTide();
      return;
    }
    if (m.kind === 'arena') this.startRound();
    else this.setupRoyale();
  }

  spawnEnt({ name, team, isPlayer, look, hid = -1 }) {
    const e = {
      id: this.ents.length, name, team, isPlayer, look,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), wish: new THREE.Vector2(),
      yaw: 0, pitch: 0, radius: 0.34, height: 1.8, onGround: false, coyote: 0,
      crouch: false, sliding: 0, swimming: false, wading: false, gliding: false, diving: false,
      wantJump: false, wantCrouch: false, sprinting: false,
      health: 100, armor: 0, alive: true, weapons: [null, null, null], slot: 0,
      medkits: 0, grenades: 0, healT: -1, throwCd: 0,
      stats: { kills: 0, deaths: 0, dmg: 0, shots: 0, hits: 0, heads: 0 },
      lastHitT: -99, lastDamager: null, tideAcc: 0, stepT: 0, firedT: -99, eyeH: 1.62, fallDir: -1,
      model: new Soldier(look, 'pistol'),
    };
    e.hid = hid;
    e.puppet = !isPlayer && (this.role === 'client' || hid >= 0);
    e.model.root.visible = !isPlayer;
    this.entGroup.add(e.model.root);
    if (!isPlayer && !e.puppet) e.ai = new BotBrain(this, e, this.opts.difficulty);
    if (this.mode.kind === 'royale') e.ai && (e.ai.range = 170);
    this.ents.push(e);
    return e;
  }

  resetEnt(e) {
    e.alive = true;
    e.health = 100;
    e.armor = 0;
    e.vel.set(0, 0, 0);
    e.wish.set(0, 0);
    e.crouch = false;
    e.height = 1.8;
    e.sliding = 0;
    e.healT = -1;
    e.gliding = false;
    e.tideAcc = 0;
    e.lastHitT = -99;
    e.lastDamager = null;
    e.model.deathT = -1;
    e.model.body.rotation.x = 0;
    e.model.body.position.y = 0;
    e.model.root.visible = !e.isPlayer;
    e.net = null;
    e.deadSince = 0;
    if (e.ai) e.ai.reset();
  }

  startRound() {
    this.round++;
    const w = this.world;
    this.resetTide();
    this.fx.clear();
    for (const g of this.grenades) this.scene.remove(g.mesh);
    this.grenades = [];
    const counters = [0, 0];
    const lanes = [
      [{ x: -30, z: 18 }, { x: -25, z: 5 }, { x: -20, z: -24 }, { x: -8, z: 32 }],
      [{ x: 30, z: -18 }, { x: 25, z: -5 }, { x: 20, z: 24 }, { x: 8, z: -32 }],
    ];
    for (const e of this.ents) {
      this.resetEnt(e);
      const sp = w.teamSpawns[e.team][counters[e.team]++ % 4];
      e.pos.set(sp.x, w.groundBelow(sp.x, sp.z, 0.3, 50), sp.z);
      e.yaw = sp.yaw;
      e.pitch = 0;
      const primary = e.isPlayer ? this.opts.loadout : e.hid >= 0 ? e.loadout : ['ar', 'smg', 'ar', 'shotgun', 'dmr', 'smg'][Math.floor(Math.random() * 6)];
      if (e.isPlayer || e.hid >= 0 || this.round === 1 || !e.weapons[0]) e.weapons = [makeWeapon(primary, 1), makeWeapon('pistol', 1), null];
      for (const wp of e.weapons) if (wp) { wp.mag = wp.def.mag; wp.reserve = e.ai ? 999 : wp.def.reserve; wp.reloadT = 0; wp.cooldown = 0; }
      e.slot = 0;
      e.grenades = 1;
      e.medkits = 0;
      e.model.setGun(e.weapons[0].id);
      if (e.ai) e.ai.lane = lanes[e.team][Math.floor(Math.random() * 4)];
    }
    this.spectate = null;
    this.state = 'pre';
    this.stateT = 3.5;
    this.frozen = true;
    this.hud.roundIntro(this.round, this.score, this.mode);
    this.emit('roundStart');
    this.netOut({ t: 'round', round: this.round, score: this.score, ents: this.ents.map((e) => [e.id, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r3(e.yaw)]) });
  }

  setupRoyale() {
    const w = this.world;
    this.resetTide();
    const rng = Math.random;
    this.lootBatch = [];
    // loot
    for (const s of w.lootSpots) {
      const r = rng();
      const rar = () => { const x = rng(); return x < 0.6 ? 0 : x < 0.9 ? 1 : 2; };
      if (r < 0.48) {
        const id = weighted(LOOT_WEAPONS, rng());
        this.addLoot('weapon', s, { id, rarity: rar() });
        if (rng() < 0.5) this.addLoot('ammo', { x: s.x + 0.6, y: s.y, z: s.z + 0.3 });
      } else if (r < 0.68) this.addLoot('ammo', s);
      else if (r < 0.82) this.addLoot('medkit', s);
      else if (r < 0.94) this.addLoot('armor', s);
      else this.addLoot('grenade', s);
    }
    for (const c of w.crateSpots) this.addCrate(c);
    // drop: everyone starts in the air
    const zones = w.dropZones;
    const humanStart = {};
    for (const e of this.ents) {
      this.resetEnt(e);
      e.weapons = [makeWeapon('pistol', 0), null, null];
      e.weapons[0].reserve = e.ai ? 999 : 36;
      e.slot = 0;
      e.grenades = 0;
      e.medkits = 0;
      e.model.setGun('pistol');
      e.gliding = true;
    }
    const teamZone = {};
    const humanTeams = new Set(this.ents.filter((e) => e.hid >= 0).map((e) => e.team));
    for (const e of this.ents) {
      if (humanTeams.has(e.team)) {
        if (!humanStart[e.team]) {
          const a = rng() * Math.PI * 2;
          humanStart[e.team] = { x: Math.cos(a) * 150, z: Math.sin(a) * 150, n: 0 };
        }
        const hs = humanStart[e.team];
        const off = hs.n++ * 4;
        e.pos.set(hs.x + off, 175 - (e.hid >= 0 ? 0 : 3), hs.z + off * 0.5);
        e.yaw = Math.atan2(-hs.x, -hs.z);
        continue;
      }
      if (!teamZone[e.team]) {
        if (rng() < 0.5 && zones.length) {
          const z = zones[Math.floor(rng() * zones.length)];
          const ang = rng() * Math.PI * 2, d = rng() * z.r * 1.3;
          teamZone[e.team] = { x: z.x + Math.cos(ang) * d, z: z.z + Math.sin(ang) * d };
        } else {
          const p = w.findHighGround(0, 0, 2.5, rng, 30, 3);
          teamZone[e.team] = { x: p.x, z: p.z };
        }
      }
      const tz = teamZone[e.team];
      const tx = tz.x + (rng() - 0.5) * 10, tzz = tz.z + (rng() - 0.5) * 10;
      e.dropTarget = { x: tx, z: tzz };
      e.pos.set(tx + (rng() - 0.5) * 80, 120 + rng() * 60, tzz + (rng() - 0.5) * 80);
      e.yaw = rng() * Math.PI * 2;
    }
    this.state = 'live';
    this.frozen = false;
    this.placements = {};
    this.hud.banner(this.dropHint(), 'info', 5);
    this.emit('roundStart');
    this.netOut({ t: 'setup', loot: this.lootBatch, ents: this.ents.map((e) => [e.id, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r3(e.yaw)]) });
    this.lootBatch = null;
  }

  dropHint() {
    return this.touchMode ? 'Drop in. Steer with the stick, push it fully to dive' : 'Drop in. Steer with WASD, hold Shift to dive';
  }

  resetTide() {
    const T = this.world.tide;
    const p0 = T.phases[0];
    this.tide = { level: T.start, next: p0.to, phase: 0, sub: 'wait', t: p0.wait, from: T.start, dps: T.baseDps, timeToNext: p0.wait, alert: 0.3, warned: false };
    U.level.value = T.start;
    U.next.value = p0.to;
    U.wet.value = T.start + 0.35;
  }

  /* ---------- loot ---------- */

  ensureLootAssets() {
    if (this.lootMats) return;
    this.lootMats = {
      gun: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6 }),
      beams: RARITY.map((r) => new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })),
      rings: RARITY.map((r) => new THREE.MeshBasicMaterial({ color: r.color, map: TEX.glow, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })),
      ammo: new THREE.MeshStandardMaterial({ color: 0x4f5a34, roughness: 0.7 }),
      white: new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.5 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc8261c, roughness: 0.5, emissive: 0x400000 }),
      plate: new THREE.MeshStandardMaterial({ color: 0x4d6878, roughness: 0.35, metalness: 0.6, emissive: 0x0c2a3a }),
      nade: new THREE.MeshStandardMaterial({ color: 0x3f4a2c, roughness: 0.6 }),
      crate: new THREE.MeshStandardMaterial({ color: 0x2c3438, roughness: 0.45, metalness: 0.6 }),
      crateGlow: new THREE.MeshBasicMaterial({ color: 0x5ff2ff }),
      crateGlowOff: new THREE.MeshBasicMaterial({ color: 0x223034 }),
    };
    this.beamGeo = new THREE.CylinderGeometry(0.05, 0.12, 2.2, 8, 1, true).translate(0, 1.1, 0);
    this.ringGeo = new THREE.PlaneGeometry(1.2, 1.2).rotateX(-Math.PI / 2);
  }

  addLoot(type, p, o = {}) {
    this.ensureLootAssets();
    const M = this.lootMats;
    const g = new THREE.Group();
    const item = { type, pos: new THREE.Vector3(p.x, p.y, p.z), mesh: g, taken: false, id: o.id, rarity: o.rarity || 0, mag: o.mag, reserve: o.reserve, spin: Math.random() * 6 };
    const inner = new THREE.Group();
    g.add(inner);
    item.inner = inner;
    if (type === 'weapon') {
      const m = new THREE.Mesh(gunGeometry(o.id), M.gun);
      m.scale.setScalar(1.35);
      m.rotation.z = 0.25;
      inner.add(m);
      g.add(new THREE.Mesh(this.beamGeo, M.beams[item.rarity]));
      const ring = new THREE.Mesh(this.ringGeo, M.rings[item.rarity]);
      ring.position.y = 0.03;
      g.add(ring);
    } else if (type === 'ammo') {
      inner.add(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.2, 0.22), M.ammo));
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.24), M.ammo);
      lid.position.y = 0.11;
      inner.add(lid);
    } else if (type === 'medkit') {
      inner.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.26), M.white));
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.012, 0.05), M.red);
      c1.position.y = 0.105;
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.18), M.red);
      c2.position.y = 0.105;
      inner.add(c1, c2);
    } else if (type === 'armor') {
      const pl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.38, 0.05), M.plate);
      pl.rotation.x = -0.3;
      inner.add(pl);
    } else if (type === 'grenade') {
      inner.add(new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), M.nade));
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 8), M.ammo);
      t.position.y = 0.08;
      inner.add(t);
    }
    if (type !== 'weapon') {
      const ring = new THREE.Mesh(this.ringGeo, M.rings[0]);
      ring.scale.setScalar(0.6);
      ring.position.y = 0.03;
      g.add(ring);
    }
    inner.position.y = 0.45;
    g.position.copy(item.pos);
    this.lootGroup.add(g);
    item.index = this.loot.length;
    this.loot.push(item);
    if (this.role === 'host' && !o.silent) {
      const rec = [type, r2(p.x), r2(p.y), r2(p.z), o.id || '', item.rarity, o.mag ?? -1, o.reserve ?? -1];
      if (this.lootBatch) this.lootBatch.push(rec);
      else this.netOut({ t: 'loot', l: rec });
    }
    return item;
  }

  addLootRec(rec) {
    const [type, x, y, z, id, rarity, mag, reserve] = rec;
    return this.addLoot(type, { x, y, z }, { id: id || undefined, rarity, mag: mag >= 0 ? mag : undefined, reserve: reserve >= 0 ? reserve : undefined, silent: true });
  }

  takeLoot(it) {
    if (it.taken) return;
    it.taken = true;
    this.lootGroup.remove(it.mesh);
    if (this.role === 'host') this.netOut({ t: 'taken', i: it.index });
  }

  canTake(e, it) {
    if (it.type === 'medkit') return e.medkits < 3;
    if (it.type === 'armor') return e.armor < 100;
    if (it.type === 'grenade') return e.grenades < 3;
    return true;
  }

  addCrate(p) {
    this.ensureLootAssets();
    const M = this.lootMats;
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.75), M.crate);
    base.position.y = 0.3;
    base.castShadow = true;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.14, 0.79), M.crate);
    lid.position.y = 0.67;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.04, 0.81), M.crateGlow);
    strip.position.y = 0.6;
    g.add(base, lid, strip);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = Math.random() * Math.PI;
    this.lootGroup.add(g);
    this.crates.push({ pos: new THREE.Vector3(p.x, p.y, p.z), mesh: g, lid, strip, opened: false });
  }

  openCrate(e, c, visualOnly) {
    if (c.opened) return;
    if (this.role === 'client' && !visualOnly) {
      if (!(c.pendingT > this.time - 1)) { c.pendingT = this.time; this.netOut({ t: 'crate', i: this.crates.indexOf(c) }); }
      return;
    }
    c.opened = true;
    c.lid.position.set(0, 0.5, -0.5);
    c.lid.rotation.x = -1.1;
    c.strip.material = this.lootMats.crateGlowOff;
    if (visualOnly) return;
    this.netOut({ t: 'crate', i: this.crates.indexOf(c) });
    const r = Math.random();
    const id = weighted([['ar', 0.3], ['smg', 0.22], ['shotgun', 0.22], ['dmr', 0.26]], Math.random());
    const ang = c.mesh.rotation.y;
    const at = (k) => ({ x: c.pos.x + Math.cos(ang + k) * 1.1, y: c.pos.y, z: c.pos.z + Math.sin(ang + k) * 1.1 });
    this.addLoot('weapon', at(0), { id, rarity: r < 0.55 ? 1 : 2 });
    this.addLoot('ammo', at(1.6));
    this.addLoot(Math.random() < 0.5 ? 'armor' : 'medkit', at(3.1));
    if (Math.random() < 0.5) this.addLoot('grenade', at(4.6));
    if (e.isPlayer) this.audio.pickup();
  }

  pickup(e, it, granted) {
    if (it.taken && !granted) return false;
    if (!this.canTake(e, it)) return false;
    if (this.role === 'client' && e.isPlayer && !granted) {
      if (!(it.pendingT > this.time - 1)) { it.pendingT = this.time; this.netOut({ t: 'pick', i: it.index }); }
      return true;
    }
    switch (it.type) {
      case 'weapon': {
        const w = makeWeapon(it.id, it.rarity);
        if (it.mag !== undefined) w.mag = it.mag;
        w.reserve = e.ai ? 999 : (it.reserve ?? w.def.mag * 2);
        let slot = e.weapons.indexOf(null);
        if (slot < 0) {
          if (e.isPlayer) slot = e.slot;
          else {
            let worst = 0, ws = Infinity;
            e.weapons.forEach((x, i) => { const s = weaponScore(x); if (s < ws) { ws = s; worst = i; } });
            slot = worst;
          }
          const old = e.weapons[slot];
          if (old) {
            const dp = { x: r2(e.pos.x + (Math.random() - 0.5)), y: r2(this.world.groundBelow(e.pos.x, e.pos.z, 0.2, e.pos.y + 0.5)), z: r2(e.pos.z + (Math.random() - 0.5)) };
            const o = { id: old.id, rarity: old.rarity, mag: old.mag, reserve: e.ai ? old.def.mag : old.reserve };
            if (this.role === 'client') this.netOut({ t: 'drop', l: ['weapon', dp.x, dp.y, dp.z, o.id, o.rarity, o.mag, o.reserve] });
            else this.addLoot('weapon', dp, o);
          }
        }
        e.weapons[slot] = w;
        this.switchWeapon(e, slot, true);
        break;
      }
      case 'ammo':
        for (const w of e.weapons) if (w) w.reserve = Math.min(w.def.reserve * 1.5, w.reserve + w.def.mag * 2);
        break;
      case 'medkit':
        if (e.medkits >= 3) return false;
        e.medkits++;
        break;
      case 'armor':
        if (e.armor >= 100) return false;
        e.armor = Math.min(100, e.armor + 50);
        break;
      case 'grenade':
        if (e.grenades >= 3) return false;
        e.grenades++;
        break;
    }
    if (!granted) this.takeLoot(it);
    if (e.isPlayer) {
      this.audio.pickup();
      this.hud.toast(this.lootLabel(it));
    }
    return true;
  }

  lootLabel(it) {
    if (it.type === 'weapon') return `${RARITY[it.rarity].name} ${WEAPONS[it.id].name}`;
    return { ammo: 'Ammo box', medkit: 'Patch kit', armor: 'Armor plate', grenade: 'Frag grenade' }[it.type];
  }

  dropLoot(e) {
    const p = e.pos;
    const y = this.world.groundBelow(p.x, p.z, 0.3, p.y + 0.5);
    let k = 0;
    const at = () => { k++; const a = k * 2.1; return { x: p.x + Math.cos(a) * 0.9, y, z: p.z + Math.sin(a) * 0.9 }; };
    for (const w of e.weapons) if (w && !(w.id === 'pistol' && w.rarity === 0)) this.addLoot('weapon', at(), { id: w.id, rarity: w.rarity, mag: w.mag, reserve: w.def.mag * 2 });
    this.addLoot('ammo', at());
    if (e.medkits > 0) this.addLoot('medkit', at());
    if (e.grenades > 0) this.addLoot('grenade', at());
  }

  /* ---------- weapons ---------- */

  cur(e) { return e.weapons[e.slot]; }

  switchWeapon(e, slot, force) {
    if (!e.weapons[slot] || (slot === e.slot && !force)) return;
    const old = e.weapons[e.slot];
    if (old) old.reloadT = 0;
    e.slot = slot;
    const w = e.weapons[slot];
    w.cooldown = Math.max(w.cooldown, 0.42);
    w.reloadT = 0;
    e.healT = -1;
    e.model.setGun(w.id);
    if (e.isPlayer) this.emit('weapon');
  }

  startReload(e) {
    const w = this.cur(e);
    if (!w || w.reloadT > 0 || w.mag >= w.def.mag || w.reserve <= 0) return;
    const t = w.def.shellReload ? w.def.reload : w.def.reload * RARITY[w.rarity].reload;
    w.reloadT = t;
    w.reloadTotal = t;
    if (e.isPlayer) this.audio.reload(w.id, t);
  }

  updateWeapon(e, dt) {
    const w = this.cur(e);
    e.throwCd = Math.max(0, e.throwCd - dt);
    if (!w) return;
    w.cooldown -= dt;
    w.bloom = Math.max(0, w.bloom - dt * 4);
    if (w.actionT > 0) w.actionT -= dt;
    if (w.reloadT > 0) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        if (w.def.shellReload) {
          w.mag++;
          w.reserve--;
          if (w.mag < w.def.mag && w.reserve > 0) { w.reloadT = w.def.reload; w.reloadTotal = w.def.reload; if (e.isPlayer) this.audio.click(2400, 0.3, 0.03); }
          else w.reloadT = 0;
        } else {
          const take = Math.min(w.def.mag - w.mag, w.reserve);
          w.mag += take;
          w.reserve -= take;
          w.reloadT = 0;
        }
      }
    }
  }

  eyePos(e, out) {
    return out.set(e.pos.x, e.pos.y + (e.isPlayer ? e.eyeH : e.crouch ? 1.05 : 1.6), e.pos.z);
  }
  headY(e) { return e.pos.y + (e.crouch ? 1.13 : 1.6); }
  chestY(e) { return e.pos.y + (e.crouch ? 0.82 : 1.22); }

  canSee(eye, o) {
    const tx = o.pos.x, tz = o.pos.z;
    for (const ty of [this.chestY(o), this.headY(o)]) {
      const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.01) return true;
      const t = this.world.raycast(eye.x, eye.y, eye.z, dx / d, dy / d, dz / d, d, null);
      if (t >= d - 0.35) return true;
    }
    return false;
  }

  spreadDir(dir, spread, out) {
    if (spread <= 0) return out.copy(dir);
    const r = spread * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    const up = Math.abs(dir.y) > 0.95 ? _v2.set(1, 0, 0) : _v2.set(0, 1, 0);
    const right = _v.crossVectors(dir, up).normalize();
    const u = up.crossVectors(right, dir).normalize();
    const tr = Math.tan(r);
    return out.copy(dir).addScaledVector(right, Math.cos(a) * tr).addScaledVector(u, Math.sin(a) * tr).normalize();
  }

  hitscan(shooter, o, d, maxDist, out) {
    const w = this.world;
    const hit = this._hit;
    const t = w.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxDist, hit);
    out.target = null;
    out.part = '';
    if (t < Infinity) {
      out.t = t;
      out.kind = hit.type === 'terrain' ? 'terrain' : matKind(hit.box && hit.box.mat);
      out.n.x = hit.n.x; out.n.y = hit.n.y; out.n.z = hit.n.z;
    } else {
      out.t = maxDist;
      out.kind = 'none';
    }
    const L = this.tide.level;
    if (o.y > L && d.y < 0) {
      const tw = (L - o.y) / d.y;
      if (tw < out.t) { out.t = tw; out.kind = 'water'; out.n.x = 0; out.n.y = 1; out.n.z = 0; }
    }
    for (const e of this.ents) {
      if (e === shooter || !e.alive) continue;
      const vx = e.pos.x - o.x, vy = e.pos.y + 0.9 - o.y, vz = e.pos.z - o.z;
      const proj = vx * d.x + vy * d.y + vz * d.z;
      if (proj < 0 || proj > out.t + 1.5) continue;
      const px = vx - d.x * proj, py = vy - d.y * proj, pz = vz - d.z * proj;
      if (px * px + py * py + pz * pz > 4.8) continue;
      const th = raySphere(o, d, e.pos.x, this.headY(e), e.pos.z, 0.17);
      const top = e.crouch ? 1.0 : 1.43;
      const tb = rayCyl(o, d, e.pos.x, e.pos.z, 0.3, e.pos.y + 0.02, e.pos.y + top);
      if (th < out.t && th <= tb) { out.t = th; out.target = e; out.part = 'head'; }
      else if (tb < out.t) {
        out.t = tb;
        out.target = e;
        out.part = o.y + d.y * tb < e.pos.y + 0.8 ? 'legs' : 'body';
      }
    }
    return out;
  }

  fireShot(e, w, origin, dir, spread, muzzle) {
    const def = w.def;
    w.mag--;
    w.cooldown = 60 / def.rpm;
    if (def.action) w.actionT = 60 / def.rpm;
    w.bloom = Math.min(def.bloomMax, w.bloom + def.bloom);
    e.stats.shots++;
    e.firedT = this.time;
    e.healT = -1;
    const client = this.role === 'client';
    let anyHit = false, head = false, killed = false;
    const dmgBy = new Map();
    const end = _v.clone();
    const ends = [], hits = [];
    for (let p = 0; p < def.pellets; p++) {
      const d = this.spreadDir(dir, spread, _d);
      const h = this.hitscan(e, origin, d, def.range, this._hs);
      end.copy(origin).addScaledVector(d, h.t);
      ends.push([r2(end.x), r2(end.y), r2(end.z), KINDS.indexOf(h.target ? (h.target.armor > 0 ? 'shield' : 'flesh') : h.kind), r2(h.n.x), r2(h.n.y), r2(h.n.z)]);
      if (h.target) {
        const dmg = damageAt(w, h.t, h.part) * (e.ai ? e.ai.skill.dmg : 1);
        const tgt = h.target;
        let res;
        if (client) {
          hits.push([tgt.id, h.part, r2(dmg)]);
          res = { killed: false, shield: tgt.armor > 0 };
        } else res = this.damage(tgt, dmg, e, h.part, d, def.name, true);
        anyHit = true;
        if (h.part === 'head') head = true;
        if (res.killed) killed = true;
        const acc = dmgBy.get(tgt) || { dmg: 0, head: false, shield: false, pos: end.clone() };
        acc.dmg += dmg; acc.head = acc.head || h.part === 'head'; acc.shield = acc.shield || res.shield;
        dmgBy.set(tgt, acc);
        this.fx.impact(end, { x: -d.x, y: -d.y, z: -d.z }, res.shield ? 'shield' : 'flesh');
      } else if (h.kind !== 'none') {
        this.fx.impact(end, h.n, h.kind);
      }
      if (p === 0 || (p % 3 === 0)) this.fx.tracer(muzzle, end, e.isPlayer ? 0.018 : 0.028, e.isPlayer ? 0.7 : 1);
    }
    if (anyHit) e.stats.hits++;
    if (e.isPlayer) {
      for (const [tgt, a] of dmgBy) this.hud.damageNumber(a.pos, Math.round(a.dmg), a.head, a.shield);
      if (anyHit) { this.hud.hitmarker(head, killed); this.audio.hit(head, killed); }
      this.audio.shot(def.id);
    } else {
      const cam = this.R.camera.position;
      const dist = cam.distanceTo(e.pos);
      if (dist < 600) this.audio.shot(def.id, muzzle, dist);
      this.fx.muzzle(muzzle, dir, def.id === 'shotgun' ? 1.3 : 1);
      this.R.flashAt = { pos: muzzle.clone(), t: 0.05 };
    }
    for (const o of this.ents) {
      if (!o.ai || !o.alive || o.team === e.team) continue;
      if (o.pos.distanceToSquared(e.pos) < 95 * 95) o.ai.onNoise(e.pos);
    }
    const m = [r2(muzzle.x), r2(muzzle.y), r2(muzzle.z)];
    if (client) this.netOut({ t: 'fire', w: def.id, m, ends, hits });
    else this.netOut({ t: 'shot', by: e.id, w: def.id, m, ends });
  }

  // Tracers, impacts, muzzle flash and sound for a shot fired by someone on another device.
  shotFx(e, wid, m, ends) {
    const muzzle = new THREE.Vector3(m[0], m[1], m[2]);
    const p = new THREE.Vector3();
    ends.forEach((x, i) => {
      p.set(x[0], x[1], x[2]);
      const kind = KINDS[x[3]] || 'none';
      if (kind !== 'none') this.fx.impact(p, { x: x[4], y: x[5], z: x[6] }, kind);
      if (i === 0 || i % 3 === 0) this.fx.tracer(muzzle, p, 0.028, 1);
    });
    const dir = p.clone().sub(muzzle).normalize();
    const cam = this.R.camera.position;
    const dist = cam.distanceTo(muzzle);
    if (dist < 600) this.audio.shot(wid, muzzle, dist);
    this.fx.muzzle(muzzle, dir, wid === 'shotgun' ? 1.3 : 1);
    this.R.flashAt = { pos: muzzle, t: 0.05 };
    if (e) { e.model.kick = 1; e.firedT = this.time; }
  }

  botFire(e, w, spread) {
    const eye = this.eyePos(e, new THREE.Vector3());
    const dir = new THREE.Vector3(Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), Math.cos(e.yaw) * Math.cos(e.pitch));
    const right = new THREE.Vector3(-Math.cos(e.yaw), 0, Math.sin(e.yaw));
    const muzzle = eye.clone().addScaledVector(dir, 0.8).addScaledVector(right, 0.1).add(new THREE.Vector3(0, -0.18, 0));
    e.model.kick = 1;
    this.fireShot(e, w, eye, dir, spread, muzzle);
  }

  damage(t, amount, by, part, dir, cause, bullet) {
    if (this.role === 'client') return { killed: false, shield: false };
    if (!t.alive || this.state === 'roundEnd' || this.state === 'over' || this.state === 'pre') return { killed: false, shield: false };
    if (by && by !== t && by.team === t.team) return { killed: false, shield: false };
    let dmg = amount, shield = false;
    if (cause !== 'tide' && t.armor > 0) {
      const a = Math.min(t.armor, dmg);
      t.armor -= a;
      dmg -= a;
      shield = true;
    }
    t.health -= dmg;
    if (cause !== 'tide') {
      t.lastHitT = this.time;
      t.healT = -1;
    }
    if (by && by !== t) {
      by.stats.dmg += amount;
      if (part === 'head') by.stats.heads++;
      t.lastDamager = by;
      t.lastDamagerT = this.time;
    }
    if (t.ai) t.ai.onDamaged(by);
    if (t.isPlayer) this.hurtFx(by ? by.pos : null, amount, cause === 'tide', bullet);
    else if (t.hid >= 0) this.netOut({ t: 'hurt', a: r2(amount), f: by ? [r2(by.pos.x), r2(by.pos.z)] : null, c: cause === 'tide' ? 1 : 0, b: bullet ? 1 : 0 }, { to: t.hid });
    if (t.health <= 0) {
      let killer = by;
      if (!killer && t.lastDamager && this.time - (t.lastDamagerT || -99) < 12) killer = t.lastDamager;
      this.kill(t, killer, part === 'head', cause, dir);
      return { killed: true, shield };
    }
    return { killed: false, shield };
  }

  hurtFx(from, amount, tide, bullet) {
    this.hud.hurt(from, tide);
    if (!tide) this.audio.hurt();
    this.R.post.damagePulse = Math.min(1, (this.R.post.damagePulse || 0) + amount / 60);
    if (bullet) this.emit('shake', 0.25);
  }

  kill(e, by, head, cause, dir, fromNet) {
    if (!e.alive) return;
    e.alive = false;
    e.health = 0;
    e.stats.deaths++;
    e.deathTime = this.time;
    e.healT = -1;
    e.gliding = false;
    e.vel.set(0, 0, 0);
    if (by && by !== e) by.stats.kills++;
    if (dir) e.fallDir = dir.x * Math.sin(e.yaw) + dir.z * Math.cos(e.yaw) > 0 ? 1 : -1;
    e.model.fallDir = e.fallDir;
    e.model.root.visible = true;
    this.hud.killfeed(by && by !== e ? by : null, e, cause, head, this.player);
    if (by && by.isPlayer && by !== e) {
      this.hud.killNotice(e.name, head);
      if (this.role === 'client') { this.hud.hitmarker(head, true); this.audio.hit(head, true); }
    }
    if (e.isPlayer) this.onPlayerDeath(by);
    if (fromNet || this.role === 'client') return;
    this.netOut({ t: 'kill', v: e.id, k: by ? by.id : -1, c: cause, h: head ? 1 : 0, d: e.fallDir });
    if (this.mode.kind === 'royale') this.dropLoot(e);
    this.checkElimination();
  }

  onPlayerDeath(by) {
    this.emit('playerDeath', by);
    this.deathCam = { by, t: 0 };
    const mate = this.ents.find((o) => o.alive && o.team === this.player.team && !o.isPlayer);
    this.spectate = mate || null;
  }

  aliveTeams() {
    const set = new Set();
    for (const e of this.ents) if (e.alive) set.add(e.team);
    return [...set];
  }

  teamLeader(team) {
    if (this.player && this.player.team === team && this.player.alive) return this.player;
    for (const e of this.ents) if (e.team === team && e.alive && e.hid >= 0) return e;
    for (const e of this.ents) if (e.team === team && e.alive) return e;
    return null;
  }

  checkElimination() {
    const alive = this.aliveTeams();
    if (this.mode.kind === 'arena') {
      if (this.state !== 'live') return;
      if (alive.length <= 1) this.endRound(alive.length ? alive[0] : -1);
      return;
    }
    // royale placements
    if (this.state !== 'live') return;
    for (let t = 0; t < this.teamCount; t++) {
      if (!alive.includes(t) && this.placements[t] === undefined) this.placeTeam(t, alive.length + 1);
    }
    if (alive.length === 1) this.placeTeam(alive[0], 1);
    if (alive.length <= 1) {
      this.state = 'over';
      this.netOut({ t: 'over' });
      if (!this.result) this.finishRoyale(false, alive.length + 1);
    }
  }

  placeTeam(t, place) {
    if (this.placements[t] !== undefined) return;
    this.placements[t] = place;
    this.netOut({ t: 'placed', team: t, place });
    if (t === this.player.team) this.finishRoyale(place === 1, place);
  }

  finishRoyale(win, place) {
    if (this.result) return;
    this.result = { win, place, teams: this.teamCount, kind: 'royale' };
    this.resultT = win ? 3.5 : 3;
    this.audio.sting(win);
    this.hud.banner(win ? 'Last team above water' : `Eliminated — #${place}`, win ? 'win' : 'lose', 3);
    if (this.role === 'solo') this.state = 'over';
  }

  endRound(winner) {
    this.state = 'roundEnd';
    this.stateT = 4;
    if (winner >= 0) this.score[winner]++;
    const me = this.player.team, them = 1 - me;
    const won = winner === me;
    const done = this.score[0] >= this.mode.rounds || this.score[1] >= this.mode.rounds;
    this.audio.sting(won);
    this.netOut({ t: 'rend', w: winner });
    if (done) {
      const win = this.score[me] > this.score[them];
      this.result = { win, score: [this.score[me], this.score[them]], kind: 'arena' };
      this.hud.banner(win ? 'Match won' : 'Match lost', win ? 'win' : 'lose', 3.5);
    } else {
      this.hud.banner(winner < 0 ? 'Round drawn — the tide took everyone' : won ? 'Round won' : 'Round lost', won ? 'win' : 'lose', 3.5);
    }
    this.hud.score(this.score, this.mode);
  }

  /* ---------- grenades ---------- */

  throwGrenade(e, dir) {
    if (e.grenades <= 0 || e.throwCd > 0 || !e.alive) return;
    e.grenades--;
    e.throwCd = 1;
    const eye = this.eyePos(e, new THREE.Vector3());
    const d = dir.clone();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), this.lootMats ? this.lootMats.nade : new THREE.MeshStandardMaterial({ color: 0x3f4a2c }));
    mesh.castShadow = true;
    this.scene.add(mesh);
    const vel = d.multiplyScalar(17).add(new THREE.Vector3(0, 3.5, 0)).addScaledVector(e.vel, 0.5);
    const pos = eye.addScaledVector(dir, 0.4);
    const visual = this.role === 'client';
    this.grenades.push({ pos, vel, fuse: 2.3, owner: e, mesh, splashed: false, visual });
    if (e.isPlayer) this.audio.click(900, 0.3, 0.05);
    const msg = { t: 'nade', by: e.id, p: [r2(pos.x), r2(pos.y), r2(pos.z)], v: [r2(vel.x), r2(vel.y), r2(vel.z)] };
    if (visual) this.netOut(msg);
    else this.netOut(msg, { except: e.hid });
  }

  spawnGrenade(owner, p, v, visual) {
    this.ensureLootAssets();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), this.lootMats.nade);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.grenades.push({ pos: new THREE.Vector3(p[0], p[1], p[2]), vel: new THREE.Vector3(v[0], v[1], v[2]), fuse: 2.3, owner, mesh, splashed: false, visual });
  }

  updateGrenades(dt) {
    const w = this.world, hit = { n: { x: 0, y: 1, z: 0 } };
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vel.y -= GRAV * dt;
      const L = this.tide.level;
      if (g.pos.y < L) {
        g.vel.multiplyScalar(Math.exp(-4 * dt));
        if (!g.splashed) { g.splashed = true; this.fx.splash(g.pos, 0.8); }
      }
      const step = g.vel.length() * dt;
      if (step > 0.0001) {
        const d = _d.copy(g.vel).normalize();
        const t = w.raycast(g.pos.x, g.pos.y, g.pos.z, d.x, d.y, d.z, step + 0.07, hit);
        if (t < step + 0.07) {
          g.pos.addScaledVector(d, Math.max(0, t - 0.07));
          const n = hit.n;
          const vn = g.vel.x * n.x + g.vel.y * n.y + g.vel.z * n.z;
          g.vel.x -= 2 * vn * n.x; g.vel.y -= 2 * vn * n.y; g.vel.z -= 2 * vn * n.z;
          g.vel.multiplyScalar(0.38);
          if (g.vel.length() > 2 && g.owner.isPlayer) this.audio.click(700, 0.15, 0.04);
        } else g.pos.addScaledVector(d, step);
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += dt * 8;
      if (g.fuse <= 0) {
        if (!g.visual) this.explode(g.pos, g.owner);
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }
  }

  explosionFx(p) {
    this.fx.explosion(p);
    const cam = this.R.camera.position;
    const dist = cam.distanceTo(p);
    this.audio.explosion(p, dist);
    this.R.flashAt = { pos: p.clone().add(new THREE.Vector3(0, 0.6, 0)), t: 0.18, big: true };
    if (dist < 30) this.emit('shake', (1 - dist / 30) * 1.2);
  }

  explode(p, owner) {
    this.explosionFx(p);
    this.netOut({ t: 'boom', p: [r2(p.x), r2(p.y), r2(p.z)] });
    const R = 7.5;
    for (const e of this.ents) {
      if (!e.alive) continue;
      const cy = this.chestY(e);
      const dx = e.pos.x - p.x, dy = cy - p.y, dz = e.pos.z - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > R) continue;
      const t = this.world.raycast(p.x, p.y + 0.3, p.z, dx / d, (dy - 0.3) / d, dz / d, d, null);
      const cover = t < d - 0.4 ? 0.3 : 1;
      const dmg = 125 * Math.pow(1 - d / R, 1.25) * cover;
      if (dmg > 1) this.damage(e, dmg, owner === e ? null : owner, 'body', new THREE.Vector3(dx, 0, dz).normalize(), 'Frag grenade');
      if (e === owner && dmg > 1 && e.isPlayer) this.hud.toast('Your grenade hurt you');
    }
    for (const o of this.ents) if (o.ai && o.alive) o.ai.onNoise(p);
  }

  /* ---------- healing ---------- */

  startHeal(e) {
    if (e.medkits <= 0 || e.health >= 100 || e.healT >= 0 || !e.alive) return;
    e.healT = 0;
    const w = this.cur(e);
    if (w) w.reloadT = 0;
  }

  updateHeal(e, dt) {
    if (e.healT < 0) return;
    e.healT += dt;
    if (e.healT >= 2.6) {
      e.healT = -1;
      e.medkits--;
      e.health = Math.min(100, e.health + 50);
      if (e.isPlayer) this.audio.tone(520, 0.3, 'triangle', 0.15, 0, null, 300);
      if (e.isPlayer && this.role === 'client') this.netOut({ t: 'heal' });
    }
  }

  /* ---------- tide ---------- */

  tideUpdate(dt) {
    const T = this.world.tide, td = this.tide;
    const ph = T.phases[td.phase];
    if (ph) {
      if (td.sub === 'wait') {
        td.t -= dt;
        td.timeToNext = td.t;
        if (td.t <= 10 && !td.warned) {
          td.warned = true;
          this.hud.banner(`Tide surge in 10 seconds — get above ${ph.to.toFixed(1)} m`, 'warn', 3);
          this.audio.beep(false);
          this.audio.beep(true);
        }
        if (td.t <= 0) {
          td.sub = 'rise';
          td.t = 0;
          td.from = td.level;
          td.dps = ph.dps;
          this.audio.horn();
          this.hud.banner('The tide is rising', 'alert', 3);
          this.emit('surge');
        }
      } else {
        td.t += dt;
        const k = clamp(td.t / ph.rise, 0, 1);
        td.level = lerp(td.from, ph.to, smoothstep(0, 1, k));
        td.timeToNext = 0;
        if (k >= 1) {
          td.phase++;
          td.warned = false;
          const nx = T.phases[td.phase];
          if (nx) { td.sub = 'wait'; td.t = nx.wait; td.next = nx.to; td.timeToNext = nx.wait; }
          else { td.sub = 'done'; td.next = td.level; td.timeToNext = 999; }
        }
      }
    }
    const target = td.sub === 'rise' ? 1 : td.sub === 'done' ? 0 : td.timeToNext < 25 ? 0.55 + 0.45 * (1 - td.timeToNext / 25) : 0.3;
    td.alert = damp(td.alert, target, 3, dt);
    U.level.value = td.level;
    U.next.value = td.next;
    U.alert.value = td.alert;
    U.wet.value = td.level + 0.35;
    this.R.setSurge(td.sub === 'rise' ? 1 : 0);
  }

  /* ---------- physics ---------- */

  freeAt(e, x, y, z) {
    const r = e.radius;
    this.world.queryBoxes(x - r, y + 0.01, z - r, x + r, y + e.height, z + r, this._q2);
    return this._q2.length === 0;
  }

  stepAxis(e, axis, d) {
    if (!d) return;
    const p = e.pos, r = e.radius;
    if (axis === 0) p.x += d; else p.z += d;
    const out = this._q;
    this.world.queryBoxes(p.x - r, p.y + 0.01, p.z - r, p.x + r, p.y + e.height, p.z + r, out);
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (!(b.x1 > p.x - r && b.x0 < p.x + r && b.z1 > p.z - r && b.z0 < p.z + r && b.y1 > p.y + 0.01 && b.y0 < p.y + e.height)) continue;
      const up = b.y1 - p.y;
      if (up > 0 && up <= STEP && (e.groundFlag || e.swimming) && this.freeAt(e, p.x, b.y1, p.z)) {
        p.y = b.y1;
        e.stepUp = (e.stepUp || 0) + up;
        continue;
      }
      if (axis === 0) { p.x = d > 0 ? b.x0 - r - 0.001 : b.x1 + r + 0.001; e.vel.x = 0; }
      else { p.z = d > 0 ? b.z0 - r - 0.001 : b.z1 + r + 0.001; e.vel.z = 0; }
    }
  }

  stepY(e, d) {
    const p = e.pos, r = e.radius;
    p.y += d;
    const out = this._q;
    this.world.queryBoxes(p.x - r, p.y, p.z - r, p.x + r, p.y + e.height, p.z + r, out);
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (!(b.x1 > p.x - r && b.x0 < p.x + r && b.z1 > p.z - r && b.z0 < p.z + r && b.y1 > p.y && b.y0 < p.y + e.height)) continue;
      if (d <= 0) { p.y = b.y1; if (e.vel.y < 0) e.vel.y = 0; e.onGround = true; }
      else { p.y = b.y0 - e.height - 0.001; if (e.vel.y > 0) e.vel.y = 0; }
    }
    const h = this.world.heightAt(p.x, p.z);
    if (p.y < h) { p.y = h; if (e.vel.y < 0) e.vel.y = 0; e.onGround = true; }
  }

  move(e, dx, dy, dz) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz), Math.abs(dy)) / 0.28));
    for (let i = 0; i < n; i++) {
      this.stepAxis(e, 0, dx / n);
      this.stepAxis(e, 2, dz / n);
      this.stepY(e, dy / n);
    }
  }

  physics(e, dt) {
    const w = this.world;
    const level = this.tide.level;
    const wantCrouch = (e.wantCrouch || e.sliding > 0) && !e.swimming && !e.gliding;
    if (wantCrouch !== e.crouch) {
      if (wantCrouch) { e.crouch = true; e.height = 1.25; }
      else {
        e.height = 1.8;
        if (this.freeAt(e, e.pos.x, e.pos.y, e.pos.z)) e.crouch = false;
        else e.height = 1.25;
      }
    }
    const depth = level - e.pos.y;
    e.swimming = !e.gliding && depth > 1.3;
    e.wading = !e.gliding && depth > 0.3;
    const wasGround = e.onGround;
    e.groundFlag = wasGround || e.coyote > 0;
    let mul = e.swimming ? 0.55 : e.wading ? 0.75 : 1;
    const tx = e.wish.x * mul, tz = e.wish.y * mul;
    if (e.gliding) {
      const desc = e.diving ? 24 : 8.5;
      e.vel.y = damp(e.vel.y, -desc, 3, dt);
      e.vel.x = damp(e.vel.x, tx, 1.6, dt);
      e.vel.z = damp(e.vel.z, tz, 1.6, dt);
    } else if (e.sliding > 0) {
      e.sliding -= dt;
      const f = Math.exp(-1.6 * dt);
      e.vel.x *= f;
      e.vel.z *= f;
      e.vel.y -= GRAV * dt;
    } else if (e.onGround || e.swimming) {
      const a = 1 - Math.exp(-13 * dt);
      e.vel.x += (tx - e.vel.x) * a;
      e.vel.z += (tz - e.vel.z) * a;
    } else {
      const a = 1 - Math.exp(-2.5 * dt);
      e.vel.x += (tx - e.vel.x) * a;
      e.vel.z += (tz - e.vel.z) * a;
    }
    if (!e.gliding) {
      if (e.swimming) {
        const ty = level - 1.32;
        e.vel.y = (ty - e.pos.y) * 4 + (e.wantJump ? 1.2 : 0);
      } else {
        if (e.wantJump && (e.onGround || e.coyote > 0) && !e.crouch && e.sliding <= 0) {
          e.vel.y = JUMP;
          e.onGround = false;
          e.coyote = 0;
          e.jumped = true;
        }
        e.vel.y = Math.max(-45, e.vel.y - GRAV * dt);
      }
    }
    const vyBefore = e.vel.y;
    e.onGround = false;
    this.move(e, e.vel.x * dt, e.vel.y * dt, e.vel.z * dt);
    if (e.vel.y <= 0.01 && !e.swimming) {
      const gb = w.groundBelow(e.pos.x, e.pos.z, e.radius * 0.75, e.pos.y + 0.05);
      const gap = e.pos.y - gb;
      if (gap < 0.04 || (wasGround && !e.jumped && gap < 0.55)) {
        e.pos.y = gb;
        e.onGround = true;
        if (e.vel.y < 0) e.vel.y = 0;
      }
    }
    if (e.onGround) e.jumped = false;
    if (!wasGround && e.onGround) e.landV = -vyBefore;
    e.coyote = e.onGround ? 0.12 : Math.max(0, e.coyote - dt);
    if (e.gliding && (e.onGround || e.pos.y < level + 0.3)) {
      e.gliding = false;
      e.landV = 8;
      e.landedT = this.time;
      if (e.isPlayer) this.emit('landed');
    }
    if (Math.abs(e.pos.x) > w.bx - 0.5) { e.pos.x = Math.sign(e.pos.x) * (w.bx - 0.5); e.vel.x = 0; }
    if (Math.abs(e.pos.z) > w.bz - 0.5) { e.pos.z = Math.sign(e.pos.z) * (w.bz - 0.5); e.vel.z = 0; }
    // vents
    if (e.onGround) {
      for (const v of w.vents) {
        if (Math.abs(e.pos.y - v.y) < 1.2 && Math.hypot(e.pos.x - v.x, e.pos.z - v.z) < 1.35) {
          e.vel.y = v.power;
          e.onGround = false;
          e.jumped = true;
          if (e.isPlayer) { this.audio.whoosh(); this.emit('vent'); }
        }
      }
    }
  }

  /* ---------- main update ---------- */

  emit(type, data) { this.events.push({ type, data }); }

  update(dt) {
    if (this.state === 'idle') return;
    this.time += dt;
    this.pathBudget = 3;
    if (this.state === 'pre') {
      this.stateT -= dt;
      const n = Math.ceil(this.stateT - 0.5);
      if (n !== this.lastCount && n >= 1 && n <= 3) { this.lastCount = n; this.audio.beep(false); this.hud.countdown(n); }
      if (this.stateT <= 0.5) {
        this.state = 'live';
        this.frozen = false;
        this.lastCount = null;
        this.audio.beep(true);
        this.hud.countdown('Fight');
      }
    } else if (this.state === 'live' || this.state === 'roundEnd' || this.state === 'over') {
      if (this.role === 'client') this.tideClient(dt);
      else this.tideUpdate(dt);
    }
    if (this.state === 'roundEnd') {
      this.stateT -= dt;
      if (this.stateT <= 0) {
        if (this.result) { this.state = 'done'; this.emit('matchDone', this.result); }
        else if (this.role !== 'client') this.startRound();
      }
    }
    if (this.resultT > 0) {
      this.resultT -= dt;
      if (this.resultT <= 0) this.emit('matchDone', this.result);
    }

    for (const e of this.ents) {
      if (!e.alive) continue;
      if (e.puppet) {
        this.updatePuppet(e, dt);
      } else {
        if (e.ai && !this.frozen) {
          if (e.gliding) this.glideBot(e, dt);
          else e.ai.update(dt);
        }
        if (this.frozen) { e.wish.set(0, 0); e.wantJump = false; }
        this.updateWeapon(e, dt);
        this.updateHeal(e, dt);
        this.physics(e, dt);
      }
      // tide damage
      const depth = this.tide.level - e.pos.y;
      if (this.role !== 'client' && depth > 0.2 && !e.gliding && this.state !== 'pre') {
        e.tideAcc += this.tide.dps * (depth > 1 ? 1 : 0.6) * dt;
        if (e.tideAcc >= 4) {
          const d = Math.floor(e.tideAcc);
          e.tideAcc -= d;
          this.damage(e, d, null, 'body', null, 'tide');
        }
      } else e.tideAcc = Math.max(0, e.tideAcc - dt);
      if (!e.alive) continue;
      // arena health regen
      if (this.role !== 'client' && this.mode.kind === 'arena' && e.health < 100 && this.time - e.lastHitT > 4.5 && depth < 0.2) e.health = Math.min(100, e.health + 28 * dt);
      // bots pick things up
      if (e.ai && this.mode.kind === 'royale') {
        for (const it of this.loot) {
          if (it.taken || Math.abs(it.pos.x - e.pos.x) > 1.6 || Math.abs(it.pos.z - e.pos.z) > 1.6 || Math.abs(it.pos.y - e.pos.y) > 1.6) continue;
          if (e.ai.wants(it) || it.type === 'ammo') this.pickup(e, it);
        }
        for (const c of this.crates) if (!c.opened && c.pos.distanceToSquared(e.pos) < 3.6) this.openCrate(e, c);
      }
      // footsteps
      const sp = Math.hypot(e.vel.x, e.vel.z);
      if ((e.onGround || e.swimming) && sp > 1.2) {
        e.stepT += sp * dt;
        if (e.stepT > (e.sprinting ? 2.3 : 1.8)) {
          e.stepT = 0;
          const cam = this.R.camera.position;
          const dist = cam.distanceTo(e.pos);
          if (e.isPlayer) this.audio.step(null, e.wading, e.crouch ? 0.06 : 0.12);
          else if (dist < 35) this.audio.step(e.pos, e.wading, e.crouch ? 0.15 : 0.32, dist);
          if (e.wading && dist < 40) this.fx.footSplash(e.pos);
        }
      }
      if (e.landV > 6) {
        if (e.isPlayer) { this.audio.thud(Math.min(0.6, e.landV / 25)); this.emit('land', e.landV); }
        if (e.wading) this.fx.splash(e.pos, 0.8);
      }
      e.landV = 0;
    }
    this.updateGrenades(dt);
    // loot animation
    for (const it of this.loot) {
      if (it.taken) continue;
      it.spin += dt;
      it.inner.rotation.y = it.spin * 0.8;
      it.inner.position.y = 0.45 + Math.sin(it.spin * 2) * 0.05;
    }
    // vent steam near the camera
    this.steamT = (this.steamT || 0) - dt;
    if (this.steamT <= 0) {
      this.steamT = 0.07;
      const cam = this.R.camera.position;
      for (const v of this.world.vents) if (Math.abs(v.x - cam.x) < 80 && Math.abs(v.z - cam.z) < 80 && v.y > this.tide.level) this.fx.steam(v);
    }
    // models
    const cam = this.R.camera.position;
    for (const e of this.ents) {
      const m = e.model;
      if (e.isPlayer && e.alive) { m.root.visible = false; continue; }
      if (!e.alive && this.time - e.deathTime > 10) { m.root.visible = false; continue; }
      const dist = cam.distanceTo(e.pos);
      m.root.visible = dist < 420;
      if (!m.root.visible) continue;
      const w = this.cur(e);
      const far = this.R.qualityName === 'low' ? 200 : 420;
      if (dist > far) { m.root.visible = false; continue; }
      m.update(dt, {
        x: e.pos.x, y: e.pos.y, z: e.pos.z, yaw: e.yaw, pitch: e.pitch, vx: e.vel.x, vz: e.vel.z,
        onGround: e.onGround, crouch: e.crouch, alive: e.alive, gliding: e.gliding, swimming: e.swimming,
        reload: e.puppet ? (e.netReload ?? -1) : w && w.reloadT > 0 ? 1 - w.reloadT / (w.reloadTotal || 1) : -1, near: dist < 70, fallDir: e.fallDir,
      });
    }
  }

  glideBot(e, dt) {
    let tx = e.dropTarget ? e.dropTarget.x : e.pos.x, tz = e.dropTarget ? e.dropTarget.z : e.pos.z;
    const lead = this.ents.find((o) => o.team === e.team && o.hid >= 0 && o.alive);
    if (lead) {
      tx = lead.pos.x + (e.id % 2 ? 4 : -4);
      tz = lead.pos.z + (e.id % 3 ? 4 : -3);
      e.diving = lead.isPlayer ? lead.diving : lead.vel.y < -15;
    } else e.diving = e.pos.y - this.world.heightAt(e.pos.x, e.pos.z) > 60;
    const dx = tx - e.pos.x, dz = tz - e.pos.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(16, d * 0.6);
    e.wish.set(d > 0.1 ? (dx / d) * sp : 0, d > 0.1 ? (dz / d) * sp : 0);
    if (d > 1) e.yaw = Math.atan2(dx, dz);
  }

  stats(e) {
    const s = e.stats;
    return { kills: s.kills, deaths: s.deaths, dmg: Math.round(s.dmg), acc: s.shots ? Math.round((s.hits / s.shots) * 100) : 0, heads: s.heads };
  }

  /* ---------- online play ---------- */
  // The host owns the match. Clients simulate only their own player, render everyone else from
  // snapshots, and report their shots (hits are judged on the shooter's screen).

  netOut(msg, opts) {
    if (this.role === 'solo' || !this.netSend) return;
    this.netSend(msg, opts);
  }

  makeSnapshot() {
    const td = this.tide;
    return {
      t: 's', st: this.state, stT: r2(this.stateT), rd: this.round,
      td: [r2(td.level), r2(td.next), td.sub === 'rise' ? 1 : td.sub === 'done' ? 2 : 0, r2(td.timeToNext), td.phase],
      e: this.ents.map((e) => {
        const w = this.cur(e);
        const f = (e.alive ? 1 : 0) | (e.crouch ? 2 : 0) | (e.gliding ? 4 : 0) | (e.onGround ? 8 : 0) | (e.swimming ? 16 : 0) | (e.sprinting ? 32 : 0);
        const reload = e.puppet ? (e.netReload ?? -1) : w && w.reloadT > 0 ? 1 - w.reloadT / (w.reloadTotal || 1) : -1;
        const gun = e.puppet ? (e.netGun ?? GUNS.indexOf(e.model.gunId)) : w ? GUNS.indexOf(w.id) : -1;
        return [e.id, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r3(e.yaw), r3(e.pitch), r2(e.vel.x), r2(e.vel.z), f,
          Math.ceil(Math.max(0, e.health)), Math.ceil(e.armor), gun, reload >= 0 ? Math.round(reload * 100) : -1, e.stats.kills, e.stats.deaths];
      }),
    };
  }

  makeClientState() {
    const e = this.player;
    const w = this.cur(e);
    const f = (e.crouch ? 2 : 0) | (e.gliding ? 4 : 0) | (e.onGround ? 8 : 0) | (e.swimming ? 16 : 0) | (e.sprinting ? 32 : 0);
    return {
      t: 'c', p: [r2(e.pos.x), r2(e.pos.y), r2(e.pos.z)], v: [r2(e.vel.x), r2(e.vel.z)], y: r3(e.yaw), pi: r3(e.pitch), f,
      g: w ? GUNS.indexOf(w.id) : -1, r: w && w.reloadT > 0 ? Math.round((1 - w.reloadT / (w.reloadTotal || 1)) * 100) : -1,
      w: e.weapons.map((x) => (x ? [x.id, x.rarity, x.mag] : null)), md: e.medkits, gr: e.grenades,
    };
  }

  setNetTarget(e, x, y, z, yaw, pitch, vx, vz, f) {
    const n = e.net || (e.net = {});
    n.x = x; n.y = y; n.z = z; n.yaw = yaw; n.pitch = pitch; n.vx = vx; n.vz = vz; n.f = f; n.at = this.time;
  }

  updatePuppet(e, dt) {
    const n = e.net;
    if (!n) return;
    const age = Math.min(0.2, this.time - n.at);
    const tx = n.x + n.vx * age, tz = n.z + n.vz * age;
    const dx = tx - e.pos.x, dy = n.y - e.pos.y, dz = tz - e.pos.z;
    if (dx * dx + dy * dy + dz * dz > 36) e.pos.set(tx, n.y, tz);
    else {
      const k = 1 - Math.exp(-16 * dt);
      e.pos.x += dx * k;
      e.pos.y += dy * k;
      e.pos.z += dz * k;
    }
    e.vel.set(n.vx, 0, n.vz);
    const ky = 1 - Math.exp(-20 * dt);
    e.yaw += wrapAngle(n.yaw - e.yaw) * ky;
    e.pitch += (n.pitch - e.pitch) * ky;
    e.crouch = !!(n.f & 2);
    e.gliding = !!(n.f & 4);
    e.onGround = !!(n.f & 8);
    e.swimming = !!(n.f & 16);
    e.sprinting = !!(n.f & 32);
    e.height = e.crouch ? 1.25 : 1.8;
    e.wading = this.tide.level - e.pos.y > 0.3;
  }

  onClientMsg(msg, hid) {
    const e = this.ents.find((o) => o.hid === hid);
    if (!e || this.state === 'idle') return;
    switch (msg.t) {
      case 'c': {
        if (!e.alive || !Array.isArray(msg.p)) return;
        this.setNetTarget(e, msg.p[0], msg.p[1], msg.p[2], msg.y, msg.pi, msg.v[0], msg.v[1], msg.f);
        e.netReload = msg.r >= 0 ? msg.r / 100 : -1;
        e.netGun = msg.g;
        if (msg.g >= 0 && GUNS[msg.g] !== e.model.gunId) e.model.setGun(GUNS[msg.g]);
        const key = JSON.stringify(msg.w);
        if (key !== e.netWeapons && Array.isArray(msg.w)) {
          e.netWeapons = key;
          e.weapons = msg.w.slice(0, 3).map((x) => {
            if (!x || !WEAPONS[x[0]]) return null;
            const w = makeWeapon(x[0], clamp(x[1] | 0, 0, 2));
            w.mag = x[2];
            return w;
          });
          while (e.weapons.length < 3) e.weapons.push(null);
          e.slot = Math.max(0, e.weapons.findIndex((x) => x && GUNS.indexOf(x.id) === msg.g));
        }
        e.medkits = msg.md | 0;
        e.grenades = msg.gr | 0;
        break;
      }
      case 'fire': {
        const def = WEAPONS[msg.w];
        if (!e.alive || !def) return;
        e.stats.shots++;
        e.firedT = this.time;
        const muzzle = new THREE.Vector3(msg.m[0], msg.m[1], msg.m[2]);
        const max = def.dmg * def.head * RARITY[2].dmg * 1.05;
        let hit = false;
        for (const [id, part, dmg] of msg.hits || []) {
          const t = this.ents[id];
          if (!t || !t.alive || t.team === e.team) continue;
          const dir = t.pos.clone().sub(muzzle).normalize();
          this.damage(t, clamp(Number(dmg) || 0, 0, max), e, part === 'head' || part === 'legs' ? part : 'body', dir, def.name, true);
          hit = true;
        }
        if (hit) e.stats.hits++;
        this.shotFx(e, def.id, msg.m, msg.ends || []);
        for (const o of this.ents) if (o.ai && o.alive && o.team !== e.team && o.pos.distanceToSquared(e.pos) < 95 * 95) o.ai.onNoise(e.pos);
        this.netOut({ t: 'shot', by: e.id, w: def.id, m: msg.m, ends: msg.ends || [] }, { except: hid });
        break;
      }
      case 'pick': {
        const it = this.loot[msg.i];
        if (!it || it.taken || !e.alive || it.pos.distanceTo(e.pos) > 4.5 || !this.canTake(e, it)) return;
        if (it.type === 'armor') e.armor = Math.min(100, e.armor + 50);
        this.takeLoot(it);
        this.netOut({ t: 'grant', i: it.index }, { to: hid });
        break;
      }
      case 'drop': {
        const [type, x, y, z, id, rarity, mag, reserve] = msg.l || [];
        if (type === 'weapon' && WEAPONS[id]) this.addLoot('weapon', { x, y, z }, { id, rarity: clamp(rarity | 0, 0, 2), mag, reserve });
        break;
      }
      case 'crate': {
        const c = this.crates[msg.i];
        if (c && !c.opened && e.alive && c.pos.distanceTo(e.pos) < 4.5) this.openCrate(e, c);
        break;
      }
      case 'heal':
        if (e.alive) e.health = Math.min(100, e.health + 50);
        break;
      case 'nade':
        if (!e.alive) return;
        this.spawnGrenade(e, msg.p, msg.v, false);
        this.netOut({ t: 'nade', by: e.id, p: msg.p, v: msg.v }, { except: hid });
        break;
    }
  }

  onHostMsg(msg) {
    switch (msg.t) {
      case 's': this.applySnapshot(msg); break;
      case 'round': this.applyRound(msg); break;
      case 'setup': this.applySetup(msg); break;
      case 'shot': this.shotFx(this.ents[msg.by], msg.w, msg.m, msg.ends); break;
      case 'kill': {
        const v = this.ents[msg.v];
        if (!v) break;
        v.fallDir = msg.d || -1;
        this.kill(v, msg.k >= 0 ? this.ents[msg.k] : null, !!msg.h, msg.c, null, true);
        break;
      }
      case 'hurt': this.hurtFx(msg.f ? new THREE.Vector3(msg.f[0], 0, msg.f[1]) : null, msg.a, !!msg.c, !!msg.b); break;
      case 'loot': this.addLootRec(msg.l); break;
      case 'taken': {
        const it = this.loot[msg.i];
        if (it && !it.taken) { it.taken = true; this.lootGroup.remove(it.mesh); }
        break;
      }
      case 'grant': {
        const it = this.loot[msg.i];
        if (it) this.pickup(this.player, it, true);
        break;
      }
      case 'crate': {
        const c = this.crates[msg.i];
        if (c) this.openCrate(null, c, true);
        break;
      }
      case 'nade': if (this.ents[msg.by]) this.spawnGrenade(this.ents[msg.by], msg.p, msg.v, true); break;
      case 'boom': {
        const p = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        this.explosionFx(p);
        let bi = -1, bd = 16;
        this.grenades.forEach((g, i) => { const d = g.pos.distanceToSquared(p); if (d < bd) { bd = d; bi = i; } });
        if (bi >= 0) { this.scene.remove(this.grenades[bi].mesh); this.grenades.splice(bi, 1); }
        break;
      }
      case 'rend': if (this.state !== 'roundEnd') this.endRound(msg.w); break;
      case 'placed':
        this.placements[msg.team] = msg.place;
        if (msg.team === this.player.team) this.finishRoyale(msg.place === 1, msg.place);
        break;
      case 'over': this.state = 'over'; break;
      case 'left': {
        const e = this.ents[msg.id];
        if (e) e.name = msg.name;
        this.hud.toast(msg.text);
        break;
      }
    }
  }

  applySnapshot(s) {
    if (s.st === 'live' && this.state === 'pre') { this.state = 'live'; this.frozen = false; }
    if (s.st === 'over' && this.state === 'live') this.state = 'over';
    if (this.state === 'pre' && s.st === 'pre') this.stateT = s.stT;
    this.tideNet = s.td;
    for (const a of s.e) {
      const e = this.ents[a[0]];
      if (!e) continue;
      e.health = a[9];
      e.armor = a[10];
      e.stats.kills = a[13];
      e.stats.deaths = a[14];
      const alive = !!(a[8] & 1);
      if (!alive && e.alive) {
        e.deadSince = e.deadSince || this.time;
        if (this.time - e.deadSince > 1.2) this.kill(e, null, false, 'tide', null, true);
      } else e.deadSince = 0;
      if (e.isPlayer || !e.alive) continue;
      this.setNetTarget(e, a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
      const gid = GUNS[a[11]];
      if (gid && gid !== e.model.gunId) e.model.setGun(gid);
      e.netReload = a[12] >= 0 ? a[12] / 100 : -1;
    }
  }

  placeFromNet(list) {
    for (const [id, x, y, z, yaw] of list) {
      const e = this.ents[id];
      if (!e) continue;
      this.resetEnt(e);
      e.pos.set(x, y, z);
      e.yaw = yaw;
      e.pitch = 0;
    }
  }

  applyRound(msg) {
    this.round = msg.round;
    this.score = msg.score.slice();
    this.resetTide();
    this.tideNet = null;
    this.fx.clear();
    for (const g of this.grenades) this.scene.remove(g.mesh);
    this.grenades = [];
    this.placeFromNet(msg.ents);
    const p = this.player;
    p.weapons = [makeWeapon(this.opts.loadout, 1), makeWeapon('pistol', 1), null];
    p.slot = 0;
    p.grenades = 1;
    p.medkits = 0;
    p.model.setGun(p.weapons[0].id);
    this.spectate = null;
    this.deathCam = null;
    this.state = 'pre';
    this.stateT = 3.5;
    this.frozen = true;
    this.lastCount = null;
    this.hud.roundIntro(this.round, this.score, this.mode);
    this.emit('roundStart');
  }

  applySetup(msg) {
    this.resetTide();
    this.tideNet = null;
    for (const rec of msg.loot) this.addLootRec(rec);
    for (const c of this.world.crateSpots) this.addCrate(c);
    this.placeFromNet(msg.ents);
    for (const e of this.ents) {
      e.gliding = true;
      e.weapons = [makeWeapon('pistol', 0), null, null];
      e.weapons[0].reserve = 36;
      e.slot = 0;
      e.grenades = 0;
      e.medkits = 0;
      e.model.setGun('pistol');
    }
    this.state = 'live';
    this.frozen = false;
    this.placements = {};
    this.hud.banner(this.dropHint(), 'info', 5);
    this.emit('roundStart');
  }

  tideClient(dt) {
    const n = this.tideNet, td = this.tide;
    if (n) {
      const [level, next, sub, ttn, phase] = n;
      const name = sub === 1 ? 'rise' : sub === 2 ? 'done' : 'wait';
      if (name === 'rise' && td.sub !== 'rise') {
        this.audio.horn();
        this.hud.banner('The tide is rising', 'alert', 3);
        this.emit('surge');
      }
      if (name === 'wait' && td.sub === 'wait' && ttn <= 10 && td.timeToNext > 10) {
        this.hud.banner(`Tide surge in 10 seconds — get above ${next.toFixed(1)} m`, 'warn', 3);
        this.audio.beep(false);
        this.audio.beep(true);
      }
      td.sub = name;
      td.next = next;
      td.phase = phase;
      td.timeToNext = ttn;
      td.level = Math.abs(level - td.level) > 2 ? level : td.level + (level - td.level) * Math.min(1, dt * 8);
    }
    const target = td.sub === 'rise' ? 1 : td.sub === 'done' ? 0 : td.timeToNext < 25 ? 0.55 + 0.45 * (1 - td.timeToNext / 25) : 0.3;
    td.alert = damp(td.alert, target, 3, dt);
    U.level.value = td.level;
    U.next.value = td.next;
    U.alert.value = td.alert;
    U.wet.value = td.level + 0.35;
    this.R.setSurge(td.sub === 'rise' ? 1 : 0);
  }

  humanLeft(hid, name) {
    const e = this.ents.find((o) => o.hid === hid);
    if (!e) return;
    e.hid = -1;
    e.puppet = false;
    e.net = null;
    e.ai = new BotBrain(this, e, this.opts.difficulty);
    if (this.mode.kind === 'royale') e.ai.range = 170;
    if (!e.weapons.some(Boolean)) e.weapons = [makeWeapon('ar', 1), makeWeapon('pistol', 1), null];
    for (const w of e.weapons) if (w) w.reserve = 999;
    e.slot = Math.max(0, e.weapons.findIndex(Boolean));
    e.name = name + ' (bot)';
    const text = `${name} left. A bot took their place.`;
    this.hud.toast(text);
    this.netOut({ t: 'left', id: e.id, name: e.name, text });
  }
}
