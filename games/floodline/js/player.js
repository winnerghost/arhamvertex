// Player input, first-person movement (sprint, crouch, slide, glide, swim), aiming, firing with
// recoil and spread, interaction, and the camera (including death cam and spectating).
import * as THREE from 'three';
import { Viewmodel, RARITY } from './weapons.js';
import { clamp, lerp, damp, DEG, wrapAngle } from './util.js';

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _m = new THREE.Vector3();

export class PlayerController {
  constructor(game, renderer, audio, hud, settings) {
    this.game = game;
    this.R = renderer;
    this.audio = audio;
    this.hud = hud;
    this.settings = settings;
    this.keys = {};
    this.pressed = {};
    this.mouseL = false;
    this.mouseR = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.vm = new Viewmodel(renderer.vmScene);
    this.ads = 0;
    this.punch = 0;
    this.shake = 0;
    this.shakeT = 0;
    this.stepOffset = 0;
    this.triggerHeld = false;
    this.jumpBuf = 0;
    this.locked = false;
    this.fovKick = 0;
    this.roll = 0;
    this.camBob = 0;
    this.spreadDeg = 0;
    this.specIdx = 0;
    this.interact = null;
    this.wheelAcc = 0;
    this.touchDX = 0;
    this.touchDY = 0;
    this.analog = null;
    this.touchSprint = false;
    this.touchMode = false;
    this.assistT = 0;
  }

  bind(canvas) {
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (['Tab', 'Space', 'KeyM'].includes(e.code)) e.preventDefault();
      if (!this.keys[e.code]) this.pressed[e.code] = true;
      this.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouseL = true; this.pressed.Mouse0 = true; }
      if (e.button === 2) this.mouseR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookDX += clamp(e.movementX, -300, 300);
      this.lookDY += clamp(e.movementY, -300, 300);
    });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheelAcc += Math.sign(e.deltaY); }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll() {
    this.keys = {};
    this.pressed = {};
    this.mouseL = false;
    this.mouseR = false;
  }

  fovFor(hfovDeg, aspect) {
    return 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect) / DEG;
  }

  update(dt) {
    const g = this.game, e = g.player, R = this.R, cam = R.camera, s = this.settings;
    if (!e) return;
    const k = this.keys, p = this.pressed;
    const w = g.cur(e);
    const def = w ? w.def : null;
    const lookDX = this.lookDX, lookDY = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    const zoom = def ? lerp(1, def.zoom, this.ads) : 1;
    const sens = (s.sens * 0.00055) / Math.pow(zoom, 0.85);
    const alive = e.alive;

    const tdx = this.touchDX, tdy = this.touchDY;
    this.touchDX = 0;
    this.touchDY = 0;
    if (alive) {
      e.yaw -= lookDX * sens;
      e.pitch -= lookDY * sens * (s.invert ? -1 : 1);
      const ts = ((s.touchSens || 5) * 0.0011) / Math.pow(zoom, 0.75);
      e.yaw -= tdx * ts;
      e.pitch -= tdy * ts * (s.invert ? -1 : 1);
      e.pitch = clamp(e.pitch, -1.5, 1.5);
      if (this.touchMode && !e.gliding && (this.mouseL || this.ads > 0.5)) this.aimAssist(e, dt);
    }

    // movement intent
    let fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
    let str = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    let mag = 1;
    if (this.analog) { fwd = this.analog.y; str = this.analog.x; mag = Math.min(1, Math.hypot(fwd, str)); }
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    const rx = -Math.cos(e.yaw), rz = Math.sin(e.yaw);
    let mx = fx * fwd + rx * str, mz = fz * fwd + rz * str;
    const ml = Math.hypot(mx, mz);
    if (ml > 0) { mx = (mx / ml) * mag; mz = (mz / ml) * mag; }
    const reloading = w && w.reloadT > 0;
    const healing = e.healT >= 0;
    const wantSprint = (k.ShiftLeft || k.ShiftRight || this.touchSprint) && fwd > 0 && !this.mouseR && !e.crouch && !healing;
    e.sprinting = alive && wantSprint && e.onGround && !e.swimming;
    let speed = 5.2;
    if (e.sprinting) speed = 7.5;
    else if (e.crouch) speed = 2.8;
    if (this.ads > 0.4) speed = Math.min(speed, 3.1 * (def ? def.moveMul : 1));
    if (healing) speed = Math.min(speed, 2.6);
    if (def) speed *= def.moveMul;
    if (e.gliding) {
      e.diving = !!(k.ShiftLeft || k.ShiftRight || this.touchSprint);
      const gs = e.diving ? 20 : 15;
      const gf = Math.max(0, fwd) * 1 + 0.25;
      e.wish.set((fx * gf + rx * str * 0.8) * gs, (fz * gf + rz * str * 0.8) * gs);
    } else if (alive && !g.frozen) {
      e.wish.set(mx * speed, mz * speed);
    } else e.wish.set(0, 0);

    // jump with a short input buffer
    if (p.Space) this.jumpBuf = 0.15;
    this.jumpBuf -= dt;
    e.wantJump = alive && !g.frozen && (this.jumpBuf > 0 || (e.swimming && k.Space));
    if (e.wantJump && e.onGround) this.jumpBuf = 0;
    // crouch / slide
    const crouchKey = !!k.KeyC;
    if (p.KeyC) {
      const hs = Math.hypot(e.vel.x, e.vel.z);
      if (e.sprinting && e.onGround && hs > 6) {
        e.sliding = 0.8;
        const d = hs > 0.1 ? 1 / hs : 0;
        e.vel.x = e.vel.x * d * 10.5;
        e.vel.z = e.vel.z * d * 10.5;
        this.audio.click(220, 0.35, 0.35);
      }
    }
    e.wantCrouch = alive && crouchKey;

    // weapons
    if (alive && !e.gliding) {
      if (p.Digit1) g.switchWeapon(e, 0);
      if (p.Digit2) g.switchWeapon(e, 1);
      if (p.Digit3) g.switchWeapon(e, 2);
      if (this.wheelAcc) {
        const dir = this.wheelAcc > 0 ? 1 : -1;
        for (let i = 1; i <= 3; i++) {
          const slot = (e.slot + dir * i + 3) % 3;
          if (e.weapons[slot]) { g.switchWeapon(e, slot); break; }
        }
      }
      if (p.KeyR) g.startReload(e);
      if (p.KeyH || p.Digit4) {
        if (e.medkits <= 0) this.hud.toast('No patch kits');
        else if (e.health >= 100) this.hud.toast('Health is full');
        else g.startHeal(e);
      }
      if (p.KeyG) {
        if (e.grenades > 0) { _f.set(fx * Math.cos(e.pitch), Math.sin(e.pitch), fz * Math.cos(e.pitch)); g.throwGrenade(e, _f); }
        else this.hud.toast('No grenades');
      }
    }
    this.wheelAcc = 0;

    const wantAds = alive && this.mouseR && !e.sprinting && !healing && !e.gliding && e.sliding <= 0;
    const adsRate = def ? 1 / def.adsTime : 5;
    this.ads = clamp(this.ads + (wantAds ? 1 : -1) * adsRate * dt, 0, 1);

    // fire
    const sp = Math.hypot(e.vel.x, e.vel.z);
    if (def) {
      let spread = lerp(def.hip, def.ads, this.ads) + w.bloom;
      spread += def.move * clamp(sp / 5, 0, 1.4) * (1 - this.ads * 0.6);
      if (!e.onGround && !e.swimming) spread += 3.5;
      if (e.swimming) spread += 2;
      if (e.sliding > 0) spread += 1.2;
      if (e.crouch && e.onGround) spread *= 0.8;
      if (def.scope && this.ads > 0.95) spread = sp > 1 ? 0.6 : 0;
      this.spreadDeg = spread;
    }
    if (p.Mouse0) this.fireBuf = 0.16;
    this.fireBuf = (this.fireBuf || 0) - dt;
    if (alive && w && !g.frozen && !e.gliding && (this.mouseL || this.fireBuf > 0)) {
      if (w.reloadT > 0 && def.shellReload && w.mag > 0 && p.Mouse0) w.reloadT = 0;
      if (w.mag <= 0) {
        if (p.Mouse0) { this.audio.empty(); g.startReload(e); }
      } else {
        const canFire = w.cooldown <= 0 && w.reloadT <= 0 && !healing && !(w.actionT > 0);
        if (canFire && ((def.auto && this.mouseL) || this.fireBuf > 0)) {
          this.fireBuf = 0;
          this.shoot(e, w);
        }
      }
    }
    this.triggerHeld = this.mouseL;
    if (alive && w && w.mag === 0 && w.reserve > 0 && w.reloadT <= 0 && w.cooldown <= -0.15 && !this.mouseL) g.startReload(e);

    // interaction
    this.interact = null;
    if (alive && !e.gliding) {
      let best = null, bd = 2.4;
      const vx = fx * Math.cos(e.pitch), vy = Math.sin(e.pitch), vz = fz * Math.cos(e.pitch);
      const ey = e.pos.y + e.eyeH;
      const consider = (obj, label) => {
        const dx = obj.pos.x - e.pos.x, dy = obj.pos.y + 0.4 - ey, dz = obj.pos.z - e.pos.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > 2.6) return;
        const dot = (dx * vx + dy * vy + dz * vz) / Math.max(d, 0.01);
        const score = d - dot * 1.2;
        if (dot > 0.35 && score < bd) { bd = score; best = { obj, label }; }
      };
      for (const it of g.loot) if (!it.taken && Math.abs(it.pos.y - e.pos.y) < 2) consider(it, g.lootLabel(it));
      for (const c of g.crates) if (!c.opened) consider(c, 'Supply case');
      if (best) {
        this.interact = best;
        if (p.KeyE) {
          if (best.obj.type) {
            if (!g.pickup(e, best.obj)) this.hud.toast(best.obj.type === 'medkit' ? 'Carrying the maximum of 3 patch kits' : best.obj.type === 'armor' ? 'Armor is full' : 'Can’t carry more');
          } else g.openCrate(e, best.obj);
        }
      }
    }

    this._lk = { lookDX: lookDX + tdx * 1.5, lookDY: lookDY + tdy * 1.5, str };
    this._specClick = !!p.Mouse0 && !alive;
    this.pressed = {};
  }

  lateUpdate(dt) {
    const g = this.game, e = g.player, R = this.R, cam = R.camera, s = this.settings;
    if (!e) return;
    const w = g.cur(e);
    const def = w ? w.def : null;
    const zoom = def ? lerp(1, def.zoom, this.ads) : 1;
    const alive = e.alive;
    const { lookDX, lookDY, str } = this._lk || { lookDX: 0, lookDY: 0, str: 0 };
    const healing = e.healT >= 0;
    const sp = Math.hypot(e.vel.x, e.vel.z);
    // camera
    if (e.stepUp) { this.stepOffset -= e.stepUp; e.stepUp = 0; }
    this.stepOffset = damp(this.stepOffset, 0, 14, dt);
    const eyeT = e.swimming ? 1.62 : e.sliding > 0 ? 0.9 : e.crouch ? 1.05 : 1.62;
    e.eyeH = damp(e.eyeH, eyeT, 12, dt);
    this.punch = damp(this.punch, 0, 9, dt);
    this.shakeT = Math.max(0, this.shakeT - dt);
    const shakeA = this.shake * (this.shakeT / 0.5);
    if (this.shakeT <= 0) this.shake = 0;
    const moving = e.onGround && sp > 0.5 && !e.sliding;
    this.camBob += dt * (moving ? 4.5 + sp : 0);
    const bob = moving ? Math.sin(this.camBob * 2) * 0.018 * (1 - this.ads) * clamp(sp / 5, 0, 1.5) : 0;
    const rollT = (e.sliding > 0 ? 0.08 : 0) - str * 0.012 * (1 - this.ads);
    this.roll = damp(this.roll, rollT, 8, dt);
    this.fovKick = damp(this.fovKick, e.sprinting ? 6 : e.sliding > 0 ? 9 : e.gliding && e.diving ? 14 : 0, 6, dt);

    let vfov = this.fovFor(s.fov + this.fovKick, cam.aspect);
    vfov = 2 * Math.atan(Math.tan((vfov * DEG) / 2) / zoom) / DEG;

    if (alive) {
      cam.position.set(e.pos.x, e.pos.y + e.eyeH + this.stepOffset + bob, e.pos.z);
      cam.rotation.set(e.pitch + this.punch + (Math.random() - 0.5) * shakeA * 0.03, e.yaw + Math.PI + (Math.random() - 0.5) * shakeA * 0.03, this.roll, 'YXZ');
    } else {
      this.deadCamera(dt);
    }
    cam.fov = vfov;
    cam.updateProjectionMatrix();

    // viewmodel
    if (w) {
      if (this.vm.currentId !== w.id) this.vm.setWeapon(w.id);
      this.vm.update(dt, {
        def, ads: this.ads, speed: sp, sprint: e.sprinting, onGround: e.onGround, lookDX, lookDY,
        reload: w.reloadT > 0 && !def.shellReload ? 1 - w.reloadT / w.reloadTotal : w.reloadT > 0 ? 0.5 : -1,
        crouch: e.crouch, slide: e.sliding > 0, heal: healing, hidden: !alive || e.gliding, action: w.actionT > 0 ? 1 - w.actionT / (60 / def.rpm) : 0,
      });
    }

    // listener + underwater
    _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.listener(cam.position, _f);
    const under = cam.position.y < g.tide.level;
    this.audio.setUnder(under);
    R.post.under = damp(R.post.under, under ? 1 : 0, 10, dt);
    R.post.chill = damp(R.post.chill, alive && e.wading ? 0.7 : 0, 4, dt);
    R.post.damagePulse = Math.max(0, (R.post.damagePulse || 0) - dt * 1.6);
    const low = alive ? clamp((45 - e.health) / 45, 0, 1) * 0.55 : 0;
    R.post.damage = Math.max(low, R.post.damagePulse);
  }

  // Gentle aim help for touch screens: pulls the crosshair toward a visible enemy near it.
  aimAssist(e, dt) {
    const g = this.game;
    const eye = g.eyePos(e, new THREE.Vector3());
    this.assistT -= dt;
    let best = null, bestA = 0.1, by = 0, bp = 0;
    for (const o of g.ents) {
      if (!o.alive || o.team === e.team || o.gliding) continue;
      const dx = o.pos.x - eye.x, dy = g.chestY(o) - eye.y, dz = o.pos.z - eye.z;
      const hd = Math.hypot(dx, dz);
      if (hd > 80 || hd < 0.5) continue;
      const ay = wrapAngle(Math.atan2(dx, dz) - e.yaw), ap = Math.atan2(dy, hd) - e.pitch;
      const a = Math.hypot(ay, ap);
      if (a < bestA) { bestA = a; best = o; by = ay; bp = ap; }
    }
    if (!best) { this.assistTarget = null; return; }
    if (best !== this.assistTarget || this.assistT <= 0) {
      this.assistT = 0.12;
      this.assistTarget = best;
      this.assistVisible = g.canSee(eye, best);
    }
    if (!this.assistVisible) return;
    const rate = 2.6 * dt, cap = 0.5 * dt;
    e.yaw += clamp(by * rate, -cap, cap);
    e.pitch += clamp(bp * rate, -cap, cap);
  }

  shoot(e, w) {
    const g = this.game, cam = this.R.camera, def = w.def;
    _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const origin = cam.position.clone();
    const dir = new THREE.Vector3(Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), Math.cos(e.yaw) * Math.cos(e.pitch));
    const a = 1 - this.ads;
    _m.copy(origin).addScaledVector(_f, 0.6).addScaledVector(_r, 0.13 * a).addScaledVector(_u, -0.1 * a - 0.035);
    if (e.sprinting) e.sprinting = false;
    g.fireShot(e, w, origin, dir, this.spreadDeg * DEG, _m.clone());
    const rk = def.recoil * RARITY[w.rarity].recoil * (this.ads > 0.5 ? 0.72 : 1) * (e.crouch ? 0.85 : 1);
    e.pitch = clamp(e.pitch + rk * DEG * 0.55, -1.5, 1.5);
    e.yaw += (Math.random() - 0.45) * def.recoilYaw * DEG * 2;
    this.punch += rk * DEG * 0.5;
    this.vm.fire(def, this.ads);
    this.R.vmFlashT = 0.05;
    this.R.flashAt = { pos: _m.clone(), t: 0.04, player: true };
    if (def.action) setTimeout(() => this.audio.action(def.action), 120);
  }

  addShake(a) {
    this.shake = Math.max(this.shake, a);
    this.shakeT = 0.5;
  }

  deadCamera(dt) {
    const g = this.game, e = g.player, cam = this.R.camera;
    const dc = g.deathCam;
    const t = dc ? (dc.t += dt) : 99;
    let target = null;
    if (t > 2.6 && g.spectate) {
      if (!g.spectate.alive) {
        g.spectate = g.ents.find((o) => o.alive && o.team === e.team && !o.isPlayer) || null;
      }
      if (this._specClick) {
        this._specClick = false;
        const mates = g.ents.filter((o) => o.alive && o.team === e.team && !o.isPlayer);
        if (mates.length) { this.specIdx = (this.specIdx + 1) % mates.length; g.spectate = mates[this.specIdx]; }
      }
      target = g.spectate;
    }
    if (target) {
      const yaw = target.yaw, pitch = clamp(target.pitch, -0.6, 0.6);
      const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.cos(yaw) * Math.cos(pitch);
      const head = new THREE.Vector3(target.pos.x, target.pos.y + 1.65, target.pos.z);
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      const back = new THREE.Vector3(-fx * 3.2 + rx * 0.7, 0.45 - fy * 1.5, -fz * 3.2 + rz * 0.7);
      const len = back.length();
      back.normalize();
      const hit = g.world.raycast(head.x, head.y, head.z, back.x, back.y, back.z, len, null);
      const d = Math.min(len, hit - 0.25);
      cam.position.copy(head).addScaledVector(back, Math.max(0.4, d));
      cam.rotation.set(pitch, yaw + Math.PI, 0, 'YXZ');
      this.hud.spectating(target.name);
    } else {
      // death cam: rise above the body and look toward the killer
      const k = Math.min(1, t / 1.5);
      const by = dc && dc.by && dc.by !== e ? dc.by : null;
      const cx = e.pos.x, cy = e.pos.y + 1.2 + k * 2.5, cz = e.pos.z;
      cam.position.set(cx, cy, cz);
      let yaw = e.yaw, pitch = -0.5 * k;
      if (by) {
        yaw = Math.atan2(by.pos.x - cx, by.pos.z - cz);
        pitch = Math.atan2(by.pos.y + 1.2 - cy, Math.hypot(by.pos.x - cx, by.pos.z - cz));
      }
      this.deadYaw = this.deadYaw === undefined ? yaw : this.deadYaw + wrapAngle(yaw - this.deadYaw) * Math.min(1, dt * 3);
      cam.rotation.set(pitch, this.deadYaw + Math.PI, 0, 'YXZ');
      this.hud.spectating(null);
    }
  }

  resetCamera() {
    this.deadYaw = undefined;
    this.ads = 0;
    this.stepOffset = 0;
    this.punch = 0;
    this.vm.setWeapon(null);
    this.hud.spectating(null);
  }
}
