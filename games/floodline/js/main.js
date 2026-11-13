// Boot, menus, settings, the cinematic menu scene, pointer lock and the main loop.
import * as THREE from 'three';
import { generateTextures } from './textures.js';
import { Renderer } from './render.js';
import { FX } from './fx.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { Game, MODES } from './game.js';
import { PlayerController } from './player.js';
import { Soldier, TEAM_LOOKS } from './characters.js';
import { makeWeapon } from './weapons.js';
import { damp } from './util.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { sens: 3.5, fov: 90, quality: 'medium', master: 0.8, music: 0.5, invert: false, showFps: false, difficulty: 'regular', loadout: 'ar', mode: 'a4' };
const KEY = 'floodline-settings-v1';

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
}

let R, fx, audio, hud, game, pc;
let appState = 'boot';
let paused = false;
let last = performance.now();
let menuSoldiers = [];
let menuCam = null;
let menuT = 0;
let settingsFromPause = false;
let timeScale = 1;
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function boot(data) {
  if (data && data.settings) Object.assign(settings, data.settings);
  const bar = $('load-bar'), txt = $('load-text');
  const steps = { concrete: 'Pouring concrete', contRed: 'Stacking containers', terrain: 'Shaping the island', camoUrban: 'Stitching uniforms', waterNormal: 'Raising the tide', clouds: 'Rolling in the clouds' };
  await generateTextures((p, name) => {
    bar.style.transform = `scaleX(${p * 0.7})`;
    if (steps[name]) txt.textContent = steps[name];
  });
  txt.textContent = 'Lighting the scene';
  await frame();
  R = new Renderer($('view'));
  R.setQuality(settings.quality);
  fx = new FX(R.scene);
  audio = new GameAudio();
  audio.vol.master = settings.master;
  audio.vol.music = settings.music;
  hud = new HUD();
  hud.camera = R.camera;
  game = new Game({ renderer: R, audio, hud, fx, settings });
  pc = new PlayerController(game, R, audio, hud, settings);
  pc.bind($('view'));
  bar.style.transform = 'scaleX(0.82)';
  txt.textContent = 'Flooding Spillway';
  await frame();
  game.loadMap('spillway');
  game.resetTide();
  setupMenuScene();
  bar.style.transform = 'scaleX(1)';
  updateMenuCamera(0);
  R.update(0.016, R.camera.position);
  R.render();
  await frame();
  $('loader').hidden = true;
  bindUI();
  showMenu('home');
  appState = 'menu';
  window.addEventListener('resize', () => { R.resize(); fitLogo(); });
  fitLogo();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLogo);
  requestAnimationFrame(loop);
  window.__floodline = {
    game, pc, R, settings, start: (mode, o) => startMatch(mode, o), setTimeScale: (v) => { timeScale = v; },
    forceWeapon: (id) => { const p = game.player; p.weapons[0] = makeWeapon(id, 1); game.switchWeapon(p, 0, true); p.weapons[0].cooldown = 0; },
  };
}

// Keep the logo inside its column whatever font actually loaded.
function fitLogo() {
  const el = document.querySelector('#menu .logo');
  if (!el || el.offsetParent === null) return;
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  const max = el.parentElement.clientWidth;
  while (el.scrollWidth > max && size > 28) {
    size -= 2;
    el.style.fontSize = size + 'px';
  }
}

/* ---------- menu scene ---------- */

function setupMenuScene() {
  clearMenuScene();
  const w = game.world;
  const P = new THREE.Vector3(-12.5, 0, -3);
  P.y = w.groundBelow(P.x, P.z, 0.3, 30);
  const view = new THREE.Vector3(0.94, 0, 0.34).normalize();
  const perp = new THREE.Vector3(-view.z, 0, view.x);
  const guns = ['smg', 'ar', 'dmr', 'shotgun'];
  [-1.9, -0.62, 0.62, 1.9].forEach((o, i) => {
    const s = new Soldier(TEAM_LOOKS[0], guns[i]);
    const pos = P.clone().addScaledVector(perp, o).addScaledVector(view, -Math.abs(o) * 0.4);
    pos.y = w.groundBelow(pos.x, pos.z, 0.3, P.y + 2);
    s.menu = { pos, yaw: Math.atan2(view.x, view.z) + (i - 1.5) * 0.16, t: i * 1.7 };
    R.scene.add(s.root);
    menuSoldiers.push(s);
  });
  const left = new THREE.Vector3(-0.34, 0, 0.94);
  menuCam = {
    target: P.clone().add(new THREE.Vector3(0, 1.05, 0)).addScaledVector(left, 2.3),
    base: P.clone().addScaledVector(view, 6.4).add(new THREE.Vector3(0, 1.45, 0)).addScaledVector(left, 1.0),
  };
}

function clearMenuScene() {
  for (const s of menuSoldiers) R.scene.remove(s.root);
  menuSoldiers = [];
}

function updateMenuCamera(dt) {
  menuT += dt;
  const cam = R.camera;
  if (!menuCam) return;
  cam.position.copy(menuCam.base).add(new THREE.Vector3(Math.sin(menuT * 0.11) * 0.5, Math.sin(menuT * 0.17) * 0.12, Math.cos(menuT * 0.09) * 0.4));
  cam.lookAt(menuCam.target);
  cam.fov = 2 * Math.atan(Math.tan((62 * Math.PI) / 360) / cam.aspect) * (180 / Math.PI) * 1.0;
  cam.fov = Math.max(cam.fov, 42);
  cam.updateProjectionMatrix();
  for (const s of menuSoldiers) {
    s.menu.t += dt;
    const t = s.menu.t;
    s.update(dt, {
      x: s.menu.pos.x, y: s.menu.pos.y, z: s.menu.pos.z, yaw: s.menu.yaw + Math.sin(t * 0.4) * 0.05,
      pitch: -0.08 + Math.sin(t * 1.1) * 0.025, vx: 0, vz: 0, onGround: true, crouch: false, alive: true, near: true, reload: -1,
    });
    s.spine.rotation.x += Math.sin(t * 1.6) * 0.012;
  }
}

/* ---------- UI ---------- */

function showMenu(screen) {
  $('menu').hidden = false;
  requestAnimationFrame(fitLogo);
  for (const id of ['home', 'play', 'howto', 'settings']) $('scr-' + id).hidden = id !== screen;
  syncUI();
}

function syncUI() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  document.querySelectorAll('[data-diff]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.diff === settings.difficulty)));
  document.querySelectorAll('[data-load]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.load === settings.loadout)));
  document.querySelectorAll('[data-q]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === settings.quality)));
  $('loadout-wrap').hidden = MODES[settings.mode].kind !== 'arena';
  $('set-sens').value = settings.sens;
  $('out-sens').textContent = Number(settings.sens).toFixed(1);
  $('set-fov').value = settings.fov;
  $('out-fov').textContent = settings.fov + '°';
  $('set-vol').value = settings.master;
  $('out-vol').textContent = Math.round(settings.master * 100) + '%';
  $('set-music').value = settings.music;
  $('out-music').textContent = Math.round(settings.music * 100) + '%';
  $('set-invert').checked = settings.invert;
  $('set-fps').checked = settings.showFps;
  $('fps').hidden = !settings.showFps;
  const deploy = $('deploy');
  const m = MODES[settings.mode];
  deploy.textContent = `Deploy · ${m.label}`;
}

function gesture() {
  audio.init();
  audio.applyVolume();
  if (appState === 'menu') audio.startMusic();
}

function bindUI() {
  const click = (el, fn) => el.addEventListener('click', (ev) => { gesture(); audio.uiTick(); fn(ev); });
  click($('go-play'), () => showMenu('play'));
  click($('go-howto'), () => showMenu('howto'));
  click($('go-settings'), () => { settingsFromPause = false; showMenu('settings'); });
  document.querySelectorAll('[data-back]').forEach((b) => click(b, () => {
    if (settingsFromPause) { settingsFromPause = false; $('menu').hidden = true; $('pause').hidden = false; return; }
    showMenu('home');
  }));
  document.querySelectorAll('[data-mode]').forEach((b) => click(b, () => { settings.mode = b.dataset.mode; saveSettings(); syncUI(); }));
  document.querySelectorAll('[data-diff]').forEach((b) => click(b, () => { settings.difficulty = b.dataset.diff; saveSettings(); syncUI(); }));
  document.querySelectorAll('[data-load]').forEach((b) => click(b, () => { settings.loadout = b.dataset.load; saveSettings(); syncUI(); }));
  document.querySelectorAll('[data-q]').forEach((b) => click(b, () => {
    settings.quality = b.dataset.q;
    saveSettings();
    R.setQuality(settings.quality);
    syncUI();
  }));
  const range = (id, key, fn) => $(id).addEventListener('input', (e) => { settings[key] = Number(e.target.value); saveSettings(); fn && fn(); syncUI(); });
  range('set-sens', 'sens');
  range('set-fov', 'fov');
  range('set-vol', 'master', () => { audio.vol.master = settings.master; audio.applyVolume(); });
  range('set-music', 'music', () => { audio.vol.music = settings.music; audio.applyVolume(); });
  $('set-invert').addEventListener('change', (e) => { settings.invert = e.target.checked; saveSettings(); });
  $('set-fps').addEventListener('change', (e) => { settings.showFps = e.target.checked; saveSettings(); syncUI(); });
  $('deploy').addEventListener('click', () => { gesture(); audio.uiSelect(); lockPointer(); startMatch(settings.mode); });
  $('resume').addEventListener('click', () => { gesture(); lockPointer(); });
  $('pause-settings').addEventListener('click', () => { settingsFromPause = true; $('pause').hidden = true; showMenu('settings'); });
  $('leave').addEventListener('click', () => toMenu());
  $('again').addEventListener('click', () => { gesture(); lockPointer(); startMatch(game.mode.id); });
  $('to-menu').addEventListener('click', () => toMenu());
  $('view').addEventListener('click', () => { if (appState === 'game' && !pc.locked && $('results').hidden) lockPointer(); });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === $('view');
    pc.locked = locked || pc.noLock;
    if (locked) {
      $('pause').hidden = true;
      paused = false;
    } else if (appState === 'game' && $('results').hidden && !pc.noLock) {
      pc.releaseAll();
      showPause();
    }
  });
  document.addEventListener('pointerlockerror', () => {
    if (appState === 'game' && !paused) {
      // Mouse capture is unavailable here: fall back to plain mouse movement.
      pc.noLock = true;
      pc.locked = true;
      hud.toast('Mouse capture is blocked here, so move the mouse to look');
    }
  });
  window.addEventListener('keydown', (e) => {
    if (appState !== 'game') return;
    if (e.code === 'Tab') { e.preventDefault(); hud.toggleScoreboard(true, game); }
    if (e.code === 'KeyM' && game.mode.kind === 'royale') hud.toggleBigMap(hud.el.bigmap.hidden);
    if (e.code === 'Escape' && pc.noLock) { pc.locked = false; showPause(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Tab' && appState === 'game') hud.toggleScoreboard(false, game); });
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) $('touch-warn').hidden = false;
}

function lockPointer() {
  const c = $('view');
  try {
    const p = c.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { const q = c.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch (e) { /* ignored */ } });
  } catch (e) {
    try { c.requestPointerLock(); } catch (e2) { /* ignored */ }
  }
}

function showPause() {
  if (appState !== 'game') return;
  paused = true;
  $('pause').hidden = false;
  $('pause-sub').textContent = `${game.mode.label} · ${game.world.name}`;
}

async function startMatch(modeId) {
  const mode = MODES[modeId];
  $('menu').hidden = true;
  $('results').hidden = true;
  $('pause').hidden = true;
  if (!game.world || game.world.id !== mode.map) {
    $('loading').hidden = false;
    $('loading-text').textContent = mode.map === 'saltreach' ? 'Charting Saltreach' : 'Flooding Spillway';
    await frame();
    await frame();
  }
  clearMenuScene();
  game.start(modeId, { difficulty: settings.difficulty, loadout: settings.loadout });
  hud.setupMatch(game);
  hud.show(true);
  pc.resetCamera();
  $('loading').hidden = true;
  appState = 'game';
  paused = !pc.locked;
  if (paused) showPause();
  audio.stopMusic();
  audio.startAmbience(!!R.skyPreset.rain);
}

async function toMenu() {
  $('results').hidden = true;
  $('pause').hidden = true;
  hud.show(false);
  game.clear();
  game.state = 'idle';
  appState = 'menu';
  paused = false;
  pc.vm.setWeapon(null);
  if (document.pointerLockElement) document.exitPointerLock();
  audio.stopAmbience();
  audio.setUnder(false);
  R.post.under = 0;
  R.post.damage = 0;
  R.post.chill = 0;
  if (game.world.id !== 'spillway') {
    $('loading').hidden = false;
    $('loading-text').textContent = 'Flooding Spillway';
    await frame();
    await frame();
    game.loadMap('spillway');
    $('loading').hidden = true;
  }
  game.resetTide();
  setupMenuScene();
  showMenu('home');
  audio.startMusic();
}

function showResults(r) {
  paused = true;
  if (document.pointerLockElement) document.exitPointerLock();
  const s = game.stats(game.player);
  const m = game.mode;
  let title, sub;
  if (r.kind === 'arena') {
    title = r.win ? 'Victory' : 'Defeat';
    sub = `${r.score[0]} – ${r.score[1]} · ${m.label} on Spillway`;
  } else {
    title = r.win ? 'Victory' : `#${r.place}`;
    sub = r.win ? `Last team above water · ${m.label}` : `Out of ${r.teams} ${m.teamSize > 1 ? 'teams' : 'players'} · ${m.label} on Saltreach`;
  }
  $('res-title').textContent = title;
  $('res-sub').textContent = sub;
  const cells = [['Kills', s.kills], ['Damage', s.dmg], ['Accuracy', s.acc + '%'], ['Headshots', s.heads]];
  if (r.kind === 'arena') cells.push(['Deaths', s.deaths]);
  else cells.push(['Survived', Math.floor(game.player.alive ? game.time : game.player.deathTime || game.time) + ' s']);
  $('res-stats').innerHTML = cells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  $('results').dataset.win = String(!!r.win);
  $('results').hidden = false;
  $('pause').hidden = true;
}

/* ---------- loop ---------- */

function handleEvents() {
  for (const ev of game.events) {
    if (ev.type === 'shake') pc.addShake(ev.data);
    else if (ev.type === 'land') { pc.addShake(Math.min(0.5, ev.data / 30)); pc.vm.landed(Math.min(1, ev.data / 15)); }
    else if (ev.type === 'landed') pc.addShake(0.3);
    else if (ev.type === 'roundStart') pc.resetCamera();
    else if (ev.type === 'matchDone') showResults(ev.data);
  }
  game.events.length = 0;
}

function updateFlash(dt) {
  const f = R.flashAt;
  if (f) {
    R.flashLight.position.copy(f.pos);
    R.flashLight.intensity = f.big ? 1400 : f.player ? 18 : 30;
    R.flashLight.distance = f.big ? 40 : 12;
    f.t -= dt;
    if (f.t <= 0) R.flashAt = null;
  } else R.flashLight.intensity = 0;
  R.vmFlashT = (R.vmFlashT || 0) - dt;
  R.vmFlash.intensity = R.vmFlashT > 0 ? 4 : 0;
}

function particleScale() {
  const h = R.r.domElement.height;
  return h / (2 * Math.tan((R.camera.fov * Math.PI) / 360));
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    if (appState === 'menu') {
      updateMenuCamera(dt);
      R.flashLight.intensity = 0;
      R.update(dt, menuCam ? menuCam.target : R.camera.position);
      fx.update(dt, R.camera, particleScale());
    } else if (appState === 'game') {
      if (!paused) {
        const sdt = dt * timeScale;
        pc.update(sdt);
        game.update(sdt);
        pc.lateUpdate(sdt);
        handleEvents();
      }
      updateFlash(dt);
      R.update(paused ? 0 : dt, R.camera.position);
      fx.update(paused ? 0 : dt * timeScale, R.camera, particleScale());
      hud.update(dt, game, pc);
    }
    R.render();
  } catch (err) {
    console.error(err);
  }
}

const hot = window.claude && window.claude.hot;
if (hot && hot.snapshot) hot.snapshot(() => ({ settings }));
if (hot && hot.ready) hot.ready(boot);
else boot(hot ? hot.data : {});
