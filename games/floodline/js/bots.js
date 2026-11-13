// Bot AI. Bots see with field-of-view + line-of-sight checks, react after a delay, aim with an
// error that settles over time (worse against moving targets), fire in bursts, strafe, loot,
// heal, follow their squad and climb away from the rising tide.
import * as THREE from 'three';
import { WEAPONS } from './weapons.js';
import { clamp, DEG, wrapAngle, approachAngle } from './util.js';

export const SKILLS = {
  recruit: { react: 0.75, err: 9, minErr: 1.7, settle: 2.2, turn: 190, burst: [3, 5], pause: [0.4, 0.8], head: 0.06, track: 1.3, dmg: 0.75 },
  regular: { react: 0.45, err: 7, minErr: 1.0, settle: 3.2, turn: 300, burst: [4, 7], pause: [0.28, 0.55], head: 0.12, track: 0.9, dmg: 0.9 },
  veteran: { react: 0.27, err: 5, minErr: 0.55, settle: 4.8, turn: 460, burst: [5, 9], pause: [0.16, 0.36], head: 0.22, track: 0.55, dmg: 1.0 },
};

const WEAPON_VALUE = { ar: 5, smg: 4.2, shotgun: 4, dmr: 4.4, pistol: 1 };
export function weaponScore(w) { return w ? WEAPON_VALUE[w.id] + w.rarity * 1.4 : 0; }

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), dirV = new THREE.Vector3();

export class BotBrain {
  constructor(game, e, skillName) {
    this.game = game;
    this.e = e;
    this.skill = SKILLS[skillName] || SKILLS.regular;
    this.thinkT = Math.random() * 0.3;
    this.target = null;
    this.visible = false;
    this.lastSeen = new THREE.Vector3();
    this.lastSeenT = -99;
    this.reaction = 0;
    this.aimErrYaw = 0;
    this.aimErrPitch = 0;
    this.wob = Math.random() * 10;
    this.burstLeft = 0;
    this.pauseT = 0;
    this.semiT = 0;
    this.aimHead = false;
    this.strafeDir = 1;
    this.strafeT = 0;
    this.mode = 'idle';
    this.path = null;
    this.pathI = 0;
    this.goal = null;
    this.goalT = 0;
    this.repathT = 0;
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3();
    this.stuckCheckT = 0;
    this.attacker = null;
    this.attackedT = -99;
    this.heard = new THREE.Vector3();
    this.heardT = -99;
    this.lane = null;
    this.lootTarget = null;
    this.crouchT = 0;
    this.roamT = 0;
    this.range = 140;
    this.formation = new THREE.Vector2((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
  }

  reset() {
    this.target = null;
    this.visible = false;
    this.path = null;
    this.goal = null;
    this.mode = 'idle';
    this.lootTarget = null;
    this.attacker = null;
    this.burstLeft = 0;
  }

  onDamaged(by) {
    if (!by || by === this.e) return;
    this.attacker = by;
    this.attackedT = this.game.time;
    if (!this.visible) {
      this.heard.copy(by.pos);
      this.heardT = this.game.time;
    }
  }

  onNoise(pos) {
    if (this.visible) return;
    this.heard.set(pos.x + (Math.random() - 0.5) * 10, pos.y, pos.z + (Math.random() - 0.5) * 10);
    this.heardT = this.game.time;
  }

  update(dt) {
    const e = this.e;
    if (!e.alive) return;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.16 + Math.random() * 0.12;
      this.think();
    }
    this.act(dt);
  }

  think() {
    const g = this.game, e = this.e;
    if (e.gliding) return;
    const eye = g.eyePos(e, tmp);
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    let best = null, bestScore = Infinity;
    // how far this bot is willing to start a fight depends on its best weapon
    let reach = 0;
    for (const w of e.weapons) if (w) reach = Math.max(reach, w.def.prefRange);
    let engage = Math.min(this.range, Math.max(32, reach * 3));
    const landedFor = g.time - (e.landedT ?? -99);
    if (g.mode.kind === 'royale' && landedFor < 14) engage = Math.min(engage, 18);
    for (const o of g.ents) {
      if (!o.alive || o.team === e.team || o.gliding) continue;
      const dx = o.pos.x - e.pos.x, dz = o.pos.z - e.pos.z, dy = o.pos.y - e.pos.y;
      const d = Math.hypot(dx, dy, dz);
      const known = o === this.target && g.time - this.lastSeenT < 1.5;
      const aware = o === this.attacker && g.time - this.attackedT < 3;
      if (d > (aware || known ? Math.min(this.range, engage * 1.7) : engage)) continue;
      const hd = Math.max(0.01, Math.hypot(dx, dz));
      const inFov = (dx * fx + dz * fz) / hd > 0.3 || d < 9;
      if (!inFov && !known && !aware) continue;
      if (!g.canSee(eye, o)) continue;
      const score = d - (o === this.target ? 20 : 0) - (aware ? 15 : 0) - (o.isPlayer ? 3 : 0);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) {
      if (best !== this.target || !this.visible) {
        const quick = best === this.target && g.time - this.lastSeenT < 1.2;
        this.reaction = this.skill.react * (0.7 + Math.random() * 0.6) * (quick ? 0.4 : 1);
        const err = this.skill.err * DEG * (quick ? 0.5 : 1);
        this.aimErrYaw = (Math.random() - 0.5) * 2 * err;
        this.aimErrPitch = (Math.random() - 0.5) * err * 0.7;
      }
      this.target = best;
      this.visible = true;
      this.lastSeen.copy(best.pos);
      this.lastSeenT = g.time;
    } else {
      this.visible = false;
      if (this.target && (!this.target.alive || g.time - this.lastSeenT > 7)) this.target = null;
    }
    this.decide();
  }

  decide() {
    const g = this.game, e = this.e, w = g.world;
    const tide = g.tide;
    const inWater = e.pos.y < tide.level + 0.25;
    const soon = e.pos.y < tide.next + 0.6 && tide.timeToNext < 32;
    this.wantSafe = inWater || soon;
    if (this.visible) {
      this.mode = 'fight';
      if (this.wantSafe) this.setGoalSafe();
      return;
    }
    if (!inWater && e.health < 60 && e.medkits > 0 && g.time - e.lastHitT > 2.5 && e.healT < 0) {
      g.startHeal(e);
      this.mode = 'heal';
      return;
    }
    if (e.healT >= 0) { this.mode = 'heal'; return; }
    if (this.wantSafe) { this.mode = 'rotate'; this.setGoalSafe(); return; }
    const cw = e.weapons[e.slot];
    if (cw && cw.mag < cw.def.mag * 0.5 && cw.reloadT <= 0) g.startReload(e);
    if (this.target && g.time - this.lastSeenT < 7) {
      this.mode = 'hunt';
      this.setGoal(this.lastSeen.x, this.lastSeen.z);
      return;
    }
    if (g.time - this.heardT < 6) {
      this.mode = 'investigate';
      this.setGoal(this.heard.x, this.heard.z);
      return;
    }
    const leader = g.teamLeader(e.team);
    if (leader && leader !== e && leader.alive && !leader.gliding) {
      const d = Math.hypot(leader.pos.x - e.pos.x, leader.pos.z - e.pos.z);
      if (d > 10 || (this.mode === 'follow' && d > 5)) {
        this.mode = 'follow';
        let gx = leader.pos.x + this.formation.x, gz = leader.pos.z + this.formation.y;
        if (w.heightAt(gx, gz) < tide.level + 0.4) { gx = leader.pos.x; gz = leader.pos.z; }
        this.setGoal(gx, gz);
        return;
      }
      if (g.mode.kind === 'royale' && d < 10) {
        if (this.tryLoot(25)) return;
        this.mode = 'idle';
        this.path = null;
        return;
      }
    }
    if (g.mode.kind === 'royale') {
      if (this.tryLoot(weaponScore(e.weapons[0]) + weaponScore(e.weapons[1]) < 6 ? 75 : 40)) return;
      this.mode = 'roam';
      this.roamT -= 0.2;
      if (!this.goal || this.roamT <= 0 || this.reached()) {
        this.roamT = 12 + Math.random() * 10;
        const minH = tide.next + 1.5;
        const p = w.findHighGround(e.pos.x + (Math.random() - 0.5) * 120, e.pos.z + (Math.random() - 0.5) * 120, minH, Math.random, 40);
        this.setGoal(p.x, p.z, true);
      }
    } else {
      this.mode = 'push';
      if (this.lane) {
        this.setGoal(this.lane.x, this.lane.z);
        if (Math.hypot(this.lane.x - e.pos.x, this.lane.z - e.pos.z) < 4) this.lane = null;
        return;
      }
      let near = null, nd = Infinity;
      for (const o of g.ents) {
        if (!o.alive || o.team === e.team) continue;
        const d = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z);
        if (d < nd) { nd = d; near = o; }
      }
      this.goalT -= 0.2;
      if (near && (this.goalT <= 0 || !this.goal)) {
        this.goalT = 3 + Math.random() * 2;
        let gx = near.pos.x + (Math.random() - 0.5) * 14, gz = near.pos.z + (Math.random() - 0.5) * 14;
        if (w.heightAt(gx, gz) < tide.next + 0.3 && tide.timeToNext < 25) { const p = w.findHighGround(gx, gz, tide.next + 1, Math.random, 50); gx = p.x; gz = p.z; }
        this.setGoal(gx, gz, true);
      }
    }
  }

  tryLoot(radius) {
    const g = this.game, e = this.e;
    const lt = this.lootTarget;
    if (lt && !lt.taken && !lt.opened) {
      if (g.time - this.lootSince > 14) {
        lt.botSkip = true;
        this.lootTarget = null;
      } else {
        this.mode = 'loot';
        this.setGoal(lt.pos.x, lt.pos.z);
        return true;
      }
    }
    this.lootTarget = null;
    let best = null, bd = radius;
    const W = g.world;
    const reachable = (p) => p.y < W.heightAt(p.x, p.z) + 0.9;
    for (const it of g.loot) {
      if (it.taken || it.botSkip || (it.claim && it.claim !== e)) continue;
      if (it.pos.y < g.tide.level + 0.2 || !reachable(it.pos)) continue;
      if (!this.wants(it)) continue;
      const d = Math.hypot(it.pos.x - e.pos.x, it.pos.z - e.pos.z) + (Math.abs(it.pos.y - e.pos.y) > 2.5 ? 30 : 0);
      if (d < bd) { bd = d; best = it; }
    }
    for (const c of g.crates) {
      if (c.opened || c.botSkip || c.pos.y < g.tide.level + 0.2 || !reachable(c.pos)) continue;
      const d = Math.hypot(c.pos.x - e.pos.x, c.pos.z - e.pos.z) * 0.8 + (Math.abs(c.pos.y - e.pos.y) > 2.5 ? 30 : 0);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return false;
    this.lootTarget = best;
    this.lootSince = g.time;
    if (best.type) best.claim = e;
    this.mode = 'loot';
    this.setGoal(best.pos.x, best.pos.z);
    return true;
  }

  wants(it) {
    const e = this.e;
    if (it.type === 'weapon') {
      const worst = Math.min(...e.weapons.map(weaponScore));
      if (e.weapons.some((w) => w && w.id === it.id && w.rarity >= it.rarity)) return false;
      return weaponScore({ id: it.id, rarity: it.rarity }) > worst + 0.5;
    }
    if (it.type === 'armor') return e.armor < 100;
    if (it.type === 'medkit') return e.medkits < 3;
    if (it.type === 'grenade') return e.grenades < 2;
    if (it.type === 'ammo') return false;
    return false;
  }

  reached() {
    if (!this.goal) return true;
    return Math.hypot(this.goal.x - this.e.pos.x, this.goal.z - this.e.pos.z) < 2.5;
  }

  setGoalSafe() {
    const g = this.game, e = this.e;
    if (this.safeGoal && g.world.heightAt(this.safeGoal.x, this.safeGoal.z) > g.tide.next + 1 && g.time - this.safeT < 10) {
      this.setGoal(this.safeGoal.x, this.safeGoal.z);
      return;
    }
    const p = g.world.findHighGround(e.pos.x, e.pos.z, g.tide.next + 1.2, Math.random, 90, 0.4);
    this.safeGoal = p;
    this.safeT = g.time;
    this.setGoal(p.x, p.z, true);
  }

  setGoal(x, z, force) {
    const g = this.game;
    const moved = !this.goal || Math.hypot(this.goal.x - x, this.goal.z - z) > 3;
    if (!moved && !force && this.path && g.time - this.repathT < 4) return;
    if (g.pathBudget <= 0) return;
    g.pathBudget--;
    this.goal = { x, z };
    this.repathT = g.time;
    const e = this.e;
    this.path = g.world.findPath(e.pos.x, e.pos.z, x, z, g.tide.level, g.tide.next, 5000);
    this.pathI = 1;
  }

  act(dt) {
    const g = this.game, e = this.e, sk = this.skill;
    const w = e.weapons[e.slot];
    e.wish.set(0, 0);
    e.wantJump = false;
    e.wantCrouch = false;
    e.sprinting = false;
    if (e.gliding || g.frozen) return;
    this.reaction -= dt;
    this.pauseT -= dt;
    this.semiT -= dt;
    this.wob += dt;

    let mvx = 0, mvz = 0, speed = 4.4;
    // movement goal
    if (this.mode === 'heal') {
      // stand still while healing
    } else if (this.mode === 'fight' && this.target) {
      const t = this.target;
      const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const pref = w ? w.def.prefRange : 15;
      let fwd = 0;
      if (d > pref * 1.35) fwd = 1;
      else if (d < pref * 0.55) fwd = -0.8;
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 0.45 + Math.random() * 1.1;
        const r = Math.random();
        this.strafeDir = r < 0.42 ? -1 : r < 0.84 ? 1 : 0;
        if (Math.random() < 0.08 && e.onGround) e.wantJump = true;
      }
      const nx = dx / d, nz = dz / d;
      mvx = nx * fwd + -nz * this.strafeDir;
      mvz = nz * fwd + nx * this.strafeDir;
      speed = 4.0;
      if (this.wantSafe && this.path) {
        const wp = this.waypoint();
        if (wp) { mvx = wp.x; mvz = wp.z; speed = 5.2; }
      }
      this.crouchT -= dt;
      if (this.crouchT <= 0) this.crouchT = 1.5 + Math.random() * 2;
      if (d > 30 && fwd === 0 && this.crouchT < 0.9 && !this.wantSafe) { e.wantCrouch = true; mvx *= 0.3; mvz *= 0.3; }
    } else {
      const wp = this.waypoint();
      if (wp) {
        mvx = wp.x; mvz = wp.z;
        const far = this.goal ? Math.hypot(this.goal.x - e.pos.x, this.goal.z - e.pos.z) : 0;
        if (far > 12 && !this.target) { speed = 6.6; e.sprinting = true; } else speed = 4.6;
      }
    }
    // separation from teammates
    for (const o of g.ents) {
      if (o === e || !o.alive || o.team !== e.team) continue;
      const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 2.2 && d2 > 0.0001) { const d = Math.sqrt(d2); mvx += (dx / d) * 0.8; mvz += (dz / d) * 0.8; }
    }
    const ml = Math.hypot(mvx, mvz);
    if (ml > 0.01) e.wish.set((mvx / ml) * speed, (mvz / ml) * speed);

    // stuck detection
    this.stuckCheckT -= dt;
    if (this.stuckCheckT <= 0) {
      this.stuckCheckT = 0.8;
      const moved = Math.hypot(e.pos.x - this.lastPos.x, e.pos.z - this.lastPos.z);
      if (ml > 0.01 && moved < 0.35 && e.onGround) {
        this.stuckT++;
        e.wantJump = true;
        if (this.stuckT > 2 && this.goal) {
          this.path = null;
          this.setGoal(this.goal.x + (Math.random() - 0.5) * 6, this.goal.z + (Math.random() - 0.5) * 6, true);
        }
        if (this.stuckT > 5) { this.goal = null; this.lane = null; this.stuckT = 0; }
      } else this.stuckT = 0;
      this.lastPos.copy(e.pos);
    }

    // aiming
    if (this.target && this.visible && this.target.alive) {
      const t = this.target;
      const aimY = this.aimHead ? g.headY(t) : g.chestY(t);
      const eye = g.eyePos(e, tmp);
      const dx = t.pos.x - eye.x, dy = aimY - eye.y, dz = t.pos.z - eye.z;
      const hd = Math.hypot(dx, dz) || 0.01;
      const dist = Math.hypot(hd, dy);
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, hd);
      this.aimErrYaw *= Math.exp(-sk.settle * dt);
      this.aimErrPitch *= Math.exp(-sk.settle * dt);
      const lat = Math.abs(-t.vel.x * (dz / hd) + t.vel.z * (dx / hd)) / Math.max(dist, 1);
      const floor = sk.minErr * DEG * (1 + lat * sk.track * 6 + (t.sliding > 0 ? 1.2 : 0) + (!t.onGround ? 0.6 : 0));
      const jy = Math.sin(this.wob * 1.9 + e.id) * floor + Math.sin(this.wob * 4.3) * floor * 0.4;
      const jp = Math.sin(this.wob * 2.3 + e.id * 2) * floor * 0.6;
      e.yaw = approachAngle(e.yaw, wantYaw + this.aimErrYaw + jy, sk.turn * DEG * dt);
      e.pitch = clamp(e.pitch + clamp(wantPitch + this.aimErrPitch + jp - e.pitch, -sk.turn * DEG * dt, sk.turn * DEG * dt), -1.2, 1.2);
      // weapon choice for range
      this.chooseWeapon(dist);
      // fire
      if (w && this.reaction <= 0 && e.healT < 0 && w.reloadT <= 0 && w.cooldown <= 0 && dist < w.def.range) {
        if (w.mag <= 0) { g.startReload(e); return; }
        const err = Math.abs(wrapAngle(e.yaw - wantYaw));
        const tol = Math.max(2.5 * DEG, Math.atan2(0.9, dist));
        if (err < tol * 2.2) {
          if (this.burstLeft <= 0 && this.pauseT <= 0) {
            this.burstLeft = w.def.auto ? sk.burst[0] + Math.floor(Math.random() * (sk.burst[1] - sk.burst[0] + 1)) : 1;
            this.aimHead = Math.random() < sk.head;
          }
          const semiOk = w.def.auto || this.semiT <= 0;
          const dmrOk = w.id !== 'dmr' || Math.abs(this.aimErrYaw) < 0.8 * DEG;
          if (this.burstLeft > 0 && semiOk && dmrOk) {
            const spread = (w.def.hip * 0.55 + (e.wish.lengthSq() > 1 ? w.def.move * 0.5 : 0) + w.bloom * 0.5) * DEG;
            g.botFire(e, w, spread);
            this.burstLeft--;
            if (!w.def.auto) this.semiT = 60 / w.def.rpm + 0.12 + Math.random() * 0.25;
            if (this.burstLeft <= 0) this.pauseT = sk.pause[0] + Math.random() * (sk.pause[1] - sk.pause[0]);
          }
        }
      }
    } else {
      // look where we're going, or toward the last known threat
      let look = null;
      if (this.target && g.time - this.lastSeenT < 4) look = this.lastSeen;
      else if (g.time - this.heardT < 4) look = this.heard;
      let yawT = e.yaw;
      if (look) yawT = Math.atan2(look.x - e.pos.x, look.z - e.pos.z);
      else if (ml > 0.1) yawT = Math.atan2(mvx, mvz);
      e.yaw = approachAngle(e.yaw, yawT, 4 * dt);
      e.pitch *= Math.exp(-3 * dt);
      if (w && w.mag === 0) g.startReload(e);
      this.chooseWeapon(30);
    }
  }

  chooseWeapon(dist) {
    const e = this.e;
    const cur = e.weapons[e.slot];
    if (cur && cur.reloadT > 0) return;
    let best = e.slot, bs = -Infinity;
    for (let i = 0; i < e.weapons.length; i++) {
      const w = e.weapons[i];
      if (!w || (w.mag <= 0 && w.reserve <= 0)) continue;
      const fit = -Math.abs(Math.log((dist + 2) / (w.def.prefRange + 2))) * 2 + weaponScore(w) * 0.4;
      if (fit > bs + (i === e.slot ? -0.6 : 0)) { bs = fit; best = i; }
    }
    if (best !== e.slot) this.game.switchWeapon(e, best);
  }

  waypoint() {
    const e = this.e;
    if (!this.path || this.pathI >= this.path.length) return null;
    let p = this.path[this.pathI];
    let dx = p.x - e.pos.x, dz = p.z - e.pos.z;
    let d = Math.hypot(dx, dz);
    while (d < 0.9 && this.pathI < this.path.length - 1) {
      this.pathI++;
      p = this.path[this.pathI];
      dx = p.x - e.pos.x; dz = p.z - e.pos.z;
      d = Math.hypot(dx, dz);
    }
    if (d < 0.9) { this.path = null; return null; }
    dirV.set(dx / d, 0, dz / d);
    return dirV;
  }
}
