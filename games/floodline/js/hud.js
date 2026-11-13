// HUD: vitals, weapon panel, compass, minimap with the live flood overlay, the depth staff,
// kill feed, hit markers, damage numbers, banners, scoreboard and the full island map.
import * as THREE from 'three';
import { RARITY } from './weapons.js';
import { clamp, fmtTime, DEG, wrapAngle } from './util.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {};
    for (const id of ['vit-health', 'vit-armor', 'vit-hnum', 'vit-anum', 'wp-name', 'wp-class', 'wp-mag', 'wp-res', 'wp-slots', 'wp-items',
      'tide-level', 'tide-sub', 'tide-pill', 'score', 'counts', 'killfeed', 'team-list', 'prompt', 'banner', 'countdown', 'kill-notice',
      'toast', 'scope', 'progress', 'progress-label', 'progress-fill', 'spectate', 'scoreboard', 'bigmap', 'fps', 'alt', 'hitmarker',
      'xh', 'dmg-ind', 'dmg-nums', 'reload-tag']) this.el[id] = $(id);
    this.mini = $('minimap-c');
    this.miniCtx = this.mini.getContext('2d');
    this.compass = $('compass-c');
    this.compassCtx = this.compass.getContext('2d');
    this.staff = $('staff-c');
    this.staffCtx = this.staff.getContext('2d');
    this.big = $('bigmap-c');
    this.bigCtx = this.big.getContext('2d');
    this.slow = 0;
    this.feed = [];
    this.bannerT = 0;
    this.toastT = 0;
    this.noticeT = 0;
    this.hmT = 0;
    this.indicators = [];
    this.safe = null;
    this.safeT = 0;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.lastWater = null;
    this.proj = new THREE.Vector3();
  }

  show(on) { this.root.hidden = !on; }

  /* ---------- maps ---------- */

  setupMap(world) {
    const B = Math.max(world.bx, world.bz) + 6;
    this.mapB = B;
    const res = world.id === 'saltreach' ? 384 : 256;
    this.mapRes = res;
    const H = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      H[j * res + i] = world.heightAt(-B + ((i + 0.5) / res) * 2 * B, -B + ((j + 0.5) / res) * 2 * B);
    }
    this.mapH = H;
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(res, res);
    const pal = [[-50, [34, 46, 50]], [0, [150, 140, 108]], [1.5, [92, 104, 66]], [10, [104, 110, 70]], [24, [136, 128, 98]], [38, [172, 166, 150]]];
    const col = (h) => {
      let a = pal[0], b = pal[pal.length - 1];
      for (let k = 0; k < pal.length - 1; k++) if (h >= pal[k][0] && h < pal[k + 1][0]) { a = pal[k]; b = pal[k + 1]; break; }
      if (h >= pal[pal.length - 1][0]) return pal[pal.length - 1][1];
      const t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
      return [a[1][0] + (b[1][0] - a[1][0]) * t, a[1][1] + (b[1][1] - a[1][1]) * t, a[1][2] + (b[1][2] - a[1][2]) * t];
    };
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const h = H[k];
      const hx = H[j * res + Math.min(res - 1, i + 1)] - H[j * res + Math.max(0, i - 1)];
      const hz = H[Math.min(res - 1, j + 1) * res + i] - H[Math.max(0, j - 1) * res + i];
      const shade = clamp(0.82 - (hx + hz) * 0.06 * (res / 256), 0.45, 1.2);
      let [r, g, b] = col(h);
      const band = Math.floor(h / 5), bandR = Math.floor(H[j * res + Math.min(res - 1, i + 1)] / 5), bandD = Math.floor(H[Math.min(res - 1, j + 1) * res + i] / 5);
      const contour = h > 0 && (band !== bandR || band !== bandD) ? 0.72 : 1;
      img.data[k * 4] = r * shade * contour;
      img.data[k * 4 + 1] = g * shade * contour;
      img.data[k * 4 + 2] = b * shade * contour;
      img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const s = res / (2 * B);
    ctx.fillStyle = 'rgba(28,30,31,0.85)';
    for (const b of world.boxes) {
      if (!b.collide || b.y1 - b.y0 < 0.9 || b.mat === 'rock' || b.mat === 'bark') continue;
      ctx.fillRect((b.x0 + B) * s, (b.z0 + B) * s, Math.max(1, (b.x1 - b.x0) * s), Math.max(1, (b.z1 - b.z0) * s));
    }
    this.mapBase = c;
    this.water = document.createElement('canvas');
    this.water.width = this.water.height = res;
    this.waterCtx = this.water.getContext('2d');
    this.waterImg = this.waterCtx.createImageData(res, res);
    this.lastWater = null;
    this.world = world;
  }

  updateWater(level, next, alert) {
    const key = level.toFixed(1) + '|' + next.toFixed(1) + '|' + (alert > 0.5 ? 1 : 0);
    if (key === this.lastWater) return;
    this.lastWater = key;
    const res = this.mapRes, H = this.mapH, d = this.waterImg.data;
    const showNext = alert > 0.5;
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i, h = H[k];
      if (h < level) {
        const depth = clamp((level - h) / 6, 0, 1);
        d[k * 4] = 30 - depth * 18; d[k * 4 + 1] = 112 - depth * 60; d[k * 4 + 2] = 118 - depth * 50; d[k * 4 + 3] = 235;
      } else if (showNext && h < next && ((i + j) % 6 < 2)) {
        d[k * 4] = 255; d[k * 4 + 1] = 106; d[k * 4 + 2] = 43; d[k * 4 + 3] = 150;
      } else d[k * 4 + 3] = 0;
    }
    this.waterCtx.putImageData(this.waterImg, 0, 0);
  }

  drawMinimap(game) {
    const ctx = this.miniCtx, W = this.mini.width, Hh = this.mini.height;
    const e = game.player;
    const center = this.viewEnt(game);
    const radius = game.mode.kind === 'royale' ? 115 : 62;
    const scale = (W / 2) / radius;
    const B = this.mapB, s = this.mapRes / (2 * B);
    ctx.save();
    ctx.clearRect(0, 0, W, Hh);
    ctx.beginPath();
    ctx.arc(W / 2, Hh / 2, W / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#15262a';
    ctx.fillRect(0, 0, W, Hh);
    ctx.translate(W / 2, Hh / 2);
    ctx.rotate(-(center.yaw - Math.PI));
    ctx.scale(scale / s, scale / s);
    ctx.translate(-(center.pos.x + B) * s, -(center.pos.z + B) * s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapBase, 0, 0);
    ctx.drawImage(this.water, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(W / 2, Hh / 2);
    ctx.rotate(-(center.yaw - Math.PI));
    const toMap = (x, z) => [(x - center.pos.x) * scale, (z - center.pos.z) * scale];
    for (const o of game.ents) {
      if (o === center || !o.alive) continue;
      const mate = o.team === e.team;
      const loud = !mate && game.time - o.firedT < 2.2 && o.pos.distanceTo(center.pos) < 70;
      if (!mate && !loud) continue;
      const [x, y] = toMap(o.pos.x, o.pos.z);
      if (x * x + y * y > (W / 2 - 6) ** 2) continue;
      ctx.fillStyle = mate ? '#39e0cf' : '#ff4b3a';
      ctx.beginPath();
      ctx.arc(x, y, mate ? 4 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (game.mode.kind === 'royale') {
      for (const c of game.crates) {
        if (c.opened) continue;
        const [x, y] = toMap(c.pos.x, c.pos.z);
        if (x * x + y * y > (W / 2 - 6) ** 2) continue;
        ctx.fillStyle = '#5ff2ff';
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
    }
    ctx.restore();
    // player arrow
    ctx.save();
    ctx.translate(W / 2, Hh / 2);
    ctx.fillStyle = '#f4f7f5';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    // north marker on the ring
    ctx.save();
    ctx.translate(W / 2, Hh / 2);
    ctx.rotate(-(center.yaw - Math.PI));
    ctx.fillStyle = '#f4f7f5';
    ctx.font = '700 13px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(0, -(W / 2 - 12));
    ctx.rotate(center.yaw - Math.PI);
    ctx.fillText('N', 0, 0);
    ctx.restore();
  }

  viewEnt(game) {
    if (game.player.alive || !game.spectate) return game.player;
    return game.spectate;
  }

  drawCompass(game) {
    const ctx = this.compassCtx, W = this.compass.width, H = this.compass.height;
    const e = this.viewEnt(game);
    const bearing = (Math.atan2(Math.sin(e.yaw), -Math.cos(e.yaw)) / DEG + 360) % 360;
    ctx.clearRect(0, 0, W, H);
    const span = 110;
    const px = W / span;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let a = Math.floor((bearing - span / 2) / 5) * 5; a <= bearing + span / 2; a += 5) {
      const x = W / 2 + (a - bearing) * px;
      const an = ((a % 360) + 360) % 360;
      const major = an % 15 === 0;
      ctx.fillStyle = 'rgba(233,241,238,' + (labels[an] ? 0.95 : major ? 0.6 : 0.3) + ')';
      ctx.fillRect(x - 0.5, H - (major ? 11 : 6), 1, major ? 11 : 6);
      if (labels[an]) {
        ctx.font = '700 15px "Barlow Condensed", sans-serif';
        ctx.fillText(labels[an], x, H - 14);
      } else if (an % 15 === 0) {
        ctx.font = '500 11px "Barlow Condensed", sans-serif';
        ctx.fillStyle = 'rgba(233,241,238,0.55)';
        ctx.fillText(String(an), x, H - 14);
      }
    }
    const mark = (wx, wz, color, shape) => {
      const b = (Math.atan2(wx - e.pos.x, -(wz - e.pos.z)) / DEG + 360) % 360;
      let d = b - bearing;
      d = ((d + 540) % 360) - 180;
      if (Math.abs(d) > span / 2) return;
      const x = W / 2 + d * px;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (shape === 'diamond') { ctx.moveTo(x, 2); ctx.lineTo(x + 5, 7); ctx.lineTo(x, 12); ctx.lineTo(x - 5, 7); }
      else { ctx.moveTo(x - 5, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x, 9); }
      ctx.closePath();
      ctx.fill();
    };
    for (const o of game.ents) if (o !== e && o.alive && o.team === game.player.team) mark(o.pos.x, o.pos.z, '#39e0cf');
    if (this.safe) mark(this.safe.x, this.safe.z, '#f2b54a', 'diamond');
  }

  drawStaff(game) {
    const ctx = this.staffCtx, W = this.staff.width, H = this.staff.height;
    const e = this.viewEnt(game);
    const td = game.tide;
    const royale = game.mode.kind === 'royale';
    const lo = royale ? Math.max(-4, Math.min(td.level, e.pos.y) - 6) : -2;
    const span = royale ? 34 : 16;
    const hi = lo + span;
    const y = (h) => H - 6 - ((h - lo) / span) * (H - 12);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,16,20,0.55)';
    ctx.fillRect(0, 0, W, H);
    const wy = y(td.level);
    const grad = ctx.createLinearGradient(0, wy, 0, H);
    grad.addColorStop(0, 'rgba(57,224,207,0.7)');
    grad.addColorStop(1, 'rgba(16,60,66,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, Math.max(0, wy), W, H - wy);
    ctx.fillStyle = 'rgba(233,241,238,0.8)';
    ctx.font = '600 10px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'left';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const yy = y(m);
      const major = m % 5 === 0;
      ctx.fillRect(0, yy - 0.5, major ? 12 : 6, 1);
      if (major) ctx.fillText(String(m), 15, yy + 3.5);
    }
    if (td.next > td.level + 0.05) {
      const ny = y(td.next);
      ctx.strokeStyle = '#ff6a2b';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, ny);
      ctx.lineTo(W, ny);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const py = y(e.pos.y);
    const safe = e.pos.y > td.next + 0.3;
    ctx.fillStyle = safe ? '#f4f7f5' : '#ff6a2b';
    ctx.beginPath();
    ctx.moveTo(W, py);
    ctx.lineTo(W - 9, py - 5);
    ctx.lineTo(W - 9, py + 5);
    ctx.closePath();
    ctx.fill();
  }

  drawBigMap(game) {
    const ctx = this.bigCtx, S = this.big.width;
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapBase, 0, 0, S, S);
    ctx.drawImage(this.water, 0, 0, S, S);
    const B = this.mapB;
    const m = (x, z) => [((x + B) / (2 * B)) * S, ((z + B) / (2 * B)) * S];
    ctx.textAlign = 'center';
    for (const p of game.world.pois || []) {
      const [x, y] = m(p.x, p.z);
      ctx.font = '700 15px "Barlow Condensed", sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(p.name.toUpperCase(), x + 1, y + 1);
      ctx.fillStyle = '#f4f7f5';
      ctx.fillText(p.name.toUpperCase(), x, y);
      ctx.font = '500 12px "Barlow Condensed", sans-serif';
      ctx.fillStyle = p.h > game.tide.next ? 'rgba(233,241,238,0.75)' : '#ff8a55';
      ctx.fillText(p.h.toFixed(0) + ' m', x, y + 14);
    }
    for (const o of game.ents) {
      if (!o.alive || o.team !== game.player.team) continue;
      const [x, y] = m(o.pos.x, o.pos.z);
      ctx.fillStyle = o.isPlayer ? '#f4f7f5' : '#39e0cf';
      ctx.beginPath();
      ctx.arc(x, y, o.isPlayer ? 6 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (o.isPlayer) {
        ctx.strokeStyle = '#f4f7f5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.sin(o.yaw) * 16, y + Math.cos(o.yaw) * 16);
        ctx.stroke();
      }
    }
    if (this.safe) {
      const [x, y] = m(this.safe.x, this.safe.z);
      ctx.strokeStyle = '#f2b54a';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 6, y - 6, 12, 12);
    }
  }

  /* ---------- per-frame ---------- */

  update(dt, game, pc) {
    const e = game.player;
    if (!e) return;
    const td = game.tide;
    this.slow -= dt;
    const doSlow = this.slow <= 0;
    if (doSlow) this.slow = 0.1;
    const view = this.viewEnt(game);
    // vitals
    if (doSlow) {
      this.el['vit-health'].style.transform = `scaleX(${clamp(view.health / 100, 0, 1)})`;
      this.el['vit-armor'].style.transform = `scaleX(${clamp(view.armor / 100, 0, 1)})`;
      this.el['vit-hnum'].textContent = Math.ceil(Math.max(0, view.health));
      this.el['vit-anum'].textContent = Math.ceil(view.armor);
      this.el['vit-health'].classList.toggle('low', view.health < 35);
      const w = game.cur(view);
      if (w) {
        this.el['wp-name'].textContent = w.def.name;
        this.el['wp-name'].style.color = RARITY[w.rarity].color;
        this.el['wp-class'].textContent = RARITY[w.rarity].name + ' ' + w.def.cls;
        this.el['wp-mag'].textContent = w.mag;
        this.el['wp-mag'].classList.toggle('empty', w.mag === 0);
        this.el['wp-res'].textContent = w.reserve > 900 ? '∞' : w.reserve;
        this.el['reload-tag'].hidden = !(w.reloadT > 0);
      }
      const slots = view.weapons.map((x, i) => x ? `<span class="slot${i === view.slot ? ' on' : ''}" style="--rc:${RARITY[x.rarity].color}"><b>${i + 1}</b>${x.def.name}</span>` : `<span class="slot empty"><b>${i + 1}</b>Empty</span>`).join('');
      if (slots !== this.lastSlots) { this.el['wp-slots'].innerHTML = slots; this.lastSlots = slots; }
      const items = `<span title="Patch kits"><b>H</b>Patch ×${view.medkits}</span><span title="Frag grenades"><b>G</b>Frag ×${view.grenades}</span>`;
      if (items !== this.lastItems) { this.el['wp-items'].innerHTML = items; this.lastItems = items; }
      // tide
      this.el['tide-level'].textContent = td.level.toFixed(1) + ' m';
      let sub;
      if (td.sub === 'rise') sub = `Rising to ${td.next.toFixed(1)} m`;
      else if (td.sub === 'done') sub = 'Final tide';
      else sub = `Surge to ${td.next.toFixed(1)} m in ${fmtTime(td.timeToNext)}`;
      this.el['tide-sub'].textContent = sub;
      this.el['tide-pill'].dataset.state = td.sub === 'rise' ? 'rise' : td.timeToNext < 15 ? 'warn' : 'calm';
      // counts
      if (game.mode.kind === 'royale') {
        const alive = game.ents.filter((o) => o.alive).length;
        const teams = game.aliveTeams().length;
        this.el['counts'].innerHTML = `<span><b>${alive}</b> alive</span>${game.mode.teamSize > 1 ? `<span><b>${teams}</b> teams</span>` : ''}<span><b>${e.stats.kills}</b> kills</span>`;
      } else {
        this.el['counts'].innerHTML = `<span><b>${e.stats.kills}</b> kills</span><span>Round <b>${game.round}</b></span>`;
        this.renderScore(game);
      }
      // team list
      if (game.mode.teamSize > 1) {
        const html = game.ents.filter((o) => o.team === e.team && !o.isPlayer).map((o) =>
          `<div class="mate${o.alive ? '' : ' down'}"><span>${o.name}</span><i style="transform:scaleX(${clamp(o.health / 100, 0, 1)})"></i><em style="transform:scaleX(${clamp(o.armor / 100, 0, 1)})"></em></div>`).join('');
        if (html !== this.lastTeam) { this.el['team-list'].innerHTML = html; this.lastTeam = html; }
      }
      // safe ground hint
      this.safeT -= 0.1;
      const needSafe = e.alive && view.pos.y < td.next + 0.4 && td.sub !== 'done';
      if (needSafe && (this.safeT <= 0 || !this.safe)) {
        this.safeT = 3;
        this.safe = game.world.findHighGround(view.pos.x, view.pos.z, td.next + 1.5, Math.random, 120, 0.2);
      } else if (!needSafe) this.safe = null;
      // altitude during drop
      if (e.gliding) {
        const alt = e.pos.y - game.world.heightAt(e.pos.x, e.pos.z);
        this.el.alt.hidden = false;
        this.el.alt.innerHTML = `<b>${Math.max(0, alt).toFixed(0)} m</b> above ground · W to glide · Shift to dive`;
      } else this.el.alt.hidden = true;
      this.updateWater(td.level, td.next, td.alert);
    }
    this.drawMinimap(game);
    this.drawCompass(game);
    this.drawStaff(game);
    if (!this.el.bigmap.hidden) this.drawBigMap(game);

    // crosshair
    const w = game.cur(e);
    const cam = pc.R.camera;
    const px = (Math.tan(pc.spreadDeg * DEG) / Math.tan((cam.fov * DEG) / 2)) * (window.innerHeight / 2);
    const gap = clamp(px, 3, 140);
    this.el.xh.style.setProperty('--gap', gap.toFixed(1) + 'px');
    const scoped = w && w.def.scope && pc.ads > 0.92 && e.alive;
    this.el.xh.hidden = !e.alive || pc.ads > 0.85 || e.gliding || e.sprinting;
    this.el.scope.hidden = !scoped;
    // interaction prompt
    if (pc.interact && e.alive) {
      const it = pc.interact.obj;
      const col = it.type === 'weapon' ? RARITY[it.rarity].color : '#e9f1ee';
      this.el.prompt.hidden = false;
      this.el.prompt.innerHTML = `<kbd>E</kbd> ${it.type ? 'Pick up' : 'Open'} <b style="color:${col}">${pc.interact.label}</b>`;
    } else this.el.prompt.hidden = true;
    // progress (heal / reload)
    if (e.alive && e.healT >= 0) {
      this.el.progress.hidden = false;
      this.el['progress-label'].textContent = 'Applying patch kit';
      this.el['progress-fill'].style.transform = `scaleX(${clamp(e.healT / 2.6, 0, 1)})`;
    } else this.el.progress.hidden = true;
    // timers
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.el.banner.classList.remove('on'); }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el.toast.classList.remove('on'); }
    if (this.noticeT > 0) { this.noticeT -= dt; if (this.noticeT <= 0) this.el['kill-notice'].classList.remove('on'); }
    if (this.hmT > 0) { this.hmT -= dt; if (this.hmT <= 0) this.el.hitmarker.className = ''; }
    // damage direction indicators
    for (const ind of this.indicators) {
      ind.t -= dt;
      if (ind.t <= 0) { ind.el.remove(); continue; }
      let ang = 0;
      if (ind.pos) {
        const a = Math.atan2(ind.pos.x - e.pos.x, ind.pos.z - e.pos.z);
        ang = -wrapAngle(a - e.yaw) / DEG;
      }
      ind.el.style.transform = `translate(-50%,-50%) rotate(${ang}deg)`;
      ind.el.style.opacity = clamp(ind.t / 0.6, 0, 1);
    }
    this.indicators = this.indicators.filter((i) => i.t > 0);
    // killfeed expiry
    const now = performance.now();
    let changed = false;
    while (this.feed.length && now - this.feed[0].t > 6500) { this.feed.shift(); changed = true; }
    if (changed) this.renderFeed();
    // fps
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.el.fps.textContent = Math.round(this.fpsN / this.fpsAcc) + ' fps';
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
  }

  renderScore(game) {
    const s = game.score;
    const pips = (team) => game.ents.filter((o) => o.team === team).map((o) => `<i class="${o.alive ? '' : 'out'}"></i>`).join('');
    const target = game.mode.rounds;
    const html = `<div class="sc us"><div class="pips">${pips(0)}</div><b>${s[0]}</b></div><div class="sc-mid">First to ${target}</div><div class="sc them"><b>${s[1]}</b><div class="pips">${pips(1)}</div></div>`;
    if (html !== this.lastScore) { this.el.score.innerHTML = html; this.lastScore = html; }
  }

  /* ---------- events ---------- */

  setupMatch(game) {
    this.setupMap(game.world);
    this.feed = [];
    this.renderFeed();
    this.el.score.hidden = game.mode.kind !== 'arena';
    this.el['team-list'].hidden = game.mode.teamSize <= 1;
    this.el['team-list'].innerHTML = '';
    this.lastTeam = this.lastSlots = this.lastItems = this.lastScore = null;
    this.safe = null;
    this.el.bigmap.hidden = true;
    this.el.scoreboard.hidden = true;
    this.root.dataset.mode = game.mode.kind;
  }

  banner(text, kind = 'info', dur = 2.5) {
    const b = this.el.banner;
    b.textContent = text;
    b.dataset.kind = kind;
    b.classList.remove('on');
    void b.offsetWidth;
    b.classList.add('on');
    this.bannerT = dur;
  }

  countdown(n) {
    const c = this.el.countdown;
    c.textContent = n;
    c.classList.remove('on');
    void c.offsetWidth;
    c.classList.add('on');
  }

  roundIntro(round, score, mode) {
    this.banner(`Round ${round} · ${mode.label} · Tide resets`, 'info', 3);
  }

  score() {}

  toast(text) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('on');
    this.toastT = 1.8;
  }

  hitmarker(head, kill) {
    const h = this.el.hitmarker;
    h.className = '';
    void h.offsetWidth;
    h.className = 'on' + (head ? ' head' : '') + (kill ? ' kill' : '');
    this.hmT = kill ? 0.45 : 0.22;
  }

  damageNumber(pos, amount, head, shield) {
    this.proj.copy(pos).project(this.camera);
    if (this.proj.z > 1) return;
    const x = (this.proj.x * 0.5 + 0.5) * window.innerWidth, y = (-this.proj.y * 0.5 + 0.5) * window.innerHeight;
    const d = document.createElement('div');
    d.className = 'dnum' + (head ? ' head' : '') + (shield ? ' shield' : '');
    d.textContent = amount;
    d.style.left = x + (Math.random() - 0.5) * 30 + 'px';
    d.style.top = y - 20 + 'px';
    this.el['dmg-nums'].appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  hurt(fromPos, tide) {
    if (tide) return;
    const el = document.createElement('div');
    el.className = 'dind';
    this.el['dmg-ind'].appendChild(el);
    this.indicators.push({ el, pos: fromPos ? fromPos.clone() : null, t: 1.4 });
    if (this.indicators.length > 6) { const x = this.indicators.shift(); x.el.remove(); }
  }

  killfeed(by, victim, cause, head, player) {
    const cls = (o) => (o.team === player.team ? 'ally' : 'enemy') + (o.isPlayer ? ' you' : '');
    let html;
    if (cause === 'tide' && !by) html = `<b class="${cls(victim)}">${victim.name}</b> <span class="cause tide">was taken by the tide</span>`;
    else if (by) html = `<b class="${cls(by)}">${by.name}</b> <span class="cause">${cause === 'tide' ? 'drowned' : cause}${head ? ' · head' : ''}</span> <b class="${cls(victim)}">${victim.name}</b>`;
    else html = `<b class="${cls(victim)}">${victim.name}</b> <span class="cause">${cause}</span>`;
    this.feed.push({ html, t: performance.now() });
    if (this.feed.length > 6) this.feed.shift();
    this.renderFeed();
  }

  renderFeed() { this.el.killfeed.innerHTML = this.feed.map((f) => `<div>${f.html}</div>`).join(''); }

  killNotice(name, head) {
    const k = this.el['kill-notice'];
    k.innerHTML = `<span>Eliminated</span> <b>${name}</b>${head ? ' <em>Headshot</em>' : ''}`;
    k.classList.remove('on');
    void k.offsetWidth;
    k.classList.add('on');
    this.noticeT = 2.2;
  }

  spectating(name) {
    const s = this.el.spectate;
    if (name) { s.hidden = false; s.innerHTML = `Spectating <b>${name}</b> · Click to switch`; }
    else s.hidden = true;
  }

  toggleScoreboard(on, game) {
    const sb = this.el.scoreboard;
    sb.hidden = !on;
    if (!on) return;
    const teams = {};
    for (const o of game.ents) (teams[o.team] = teams[o.team] || []).push(o);
    const rows = Object.keys(teams).sort((a, b) => a - b).map((t) => teams[t].map((o) =>
      `<tr class="${o.team === game.player.team ? 'ally' : ''}${o.alive ? '' : ' down'}"><td>${o.team === game.player.team ? '◆ ' : ''}${o.name}</td><td>${o.stats.kills}</td><td>${o.stats.deaths}</td><td>${Math.round(o.stats.dmg)}</td></tr>`).join('')).join('');
    sb.innerHTML = `<table><thead><tr><th>${game.mode.label}</th><th>K</th><th>D</th><th>Dmg</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  toggleBigMap(on) {
    this.el.bigmap.hidden = !on;
  }
}
