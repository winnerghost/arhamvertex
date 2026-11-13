// Boot, menus, settings, the cinematic menu scene, input mode (mouse or touch), the online
// lobby, and the main loop.
import * as THREE from 'three';
import { generateTextures } from './textures.js';
import { Renderer } from './render.js';
import { FX } from './fx.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { Game, MODES, buildRoster } from './game.js';
import { PlayerController } from './player.js';
import { Soldier, TEAM_LOOKS } from './characters.js';
import { makeWeapon } from './weapons.js';
import { TouchControls } from './touch.js';
import { NetSession } from './net.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  sens: 3.5, touchSens: 5, fov: 90, quality: 'medium', master: 0.8, music: 0.5, invert: false, showFps: false,
  difficulty: 'regular', loadout: 'ar', mode: 'a4', touch: 'auto', name: '', lobbyMode: 'a1', pref: 'versus',
};
const KEY = 'floodline-settings-v1';
const coarse = matchMedia('(pointer: coarse)').matches;

function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    const s = { ...DEFAULTS, ...JSON.parse(raw || '{}') };
    if (!raw && coarse) s.quality = 'low';
    return s;
  } catch (e) {
    return { ...DEFAULTS, quality: coarse ? 'low' : 'medium' };
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
}

let R, fx, audio, hud, game, pc, touch;
const net = new NetSession();
let appState = 'boot';
let paused = false;
let last = performance.now();
let menuSoldiers = [];
let menuCam = null;
let menuT = 0;
let settingsFrom = null;
let timeScale = 1;
let netT = 0;
let touchMode = false;
const dbg = { noRender: false };
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
  game.netSend = (msg, o) => {
    if (net.role === 'host') {
      if (o && o.to !== undefined) net.sendTo(o.to, msg);
      else net.broadcast(msg, o ? o.except : undefined);
    } else if (net.role === 'client') net.send(msg);
  };
  pc = new PlayerController(game, R, audio, hud, settings);
  pc.bind($('view'));
  touch = new TouchControls(pc, hud, game, { pause: () => showPause() });
  applyInputMode();
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
  bindNet();
  if (window.claude || typeof RTCPeerConnection === 'undefined') $('online-note').hidden = false;
  if (location.protocol === 'https:' && location.hostname !== 'app.floodline.game' && !window.claude) $('apk-link').hidden = false;
  showMenu('home');
  appState = 'menu';
  window.addEventListener('resize', () => { R.resize(); fitLogo(); checkRotate(); });
  fitLogo();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLogo);
  requestAnimationFrame(loop);
  window.__floodline = {
    game, pc, R, net, settings, touch, dbg, start: (mode, o) => startMatch(mode, o), setTimeScale: (v) => { timeScale = v; },
    forceWeapon: (id) => { const p = game.player; p.weapons[0] = makeWeapon(id, 1); game.switchWeapon(p, 0, true); p.weapons[0].cooldown = 0; },
  };
  // Android back button and app switching (used by the APK)
  window.__floodlineBack = () => {
    if (appState === 'game') {
      if ($('pause').hidden && $('results').hidden) { showPause(); return true; }
      return false;
    }
    if (!$('menu').hidden && $('scr-home').hidden) { showMenu('home'); return true; }
    return false;
  };
  window.__floodlinePause = () => { if (appState === 'game' && $('pause').hidden && $('results').hidden) showPause(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) window.__floodlinePause(); });
}

function applyInputMode() {
  touchMode = settings.touch === 'on' || (settings.touch === 'auto' && coarse);
  document.body.classList.toggle('touch', touchMode);
  pc.touchMode = touchMode;
  hud.touch = touchMode;
  game.touchMode = touchMode;
  $('input-hint').textContent = touchMode ? 'Touch controls on · bots fill every slot' : 'Keyboard and mouse · bots fill every slot';
}

function enterFullscreen() {
  if (!touchMode) return;
  const el = document.documentElement;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null;
    const lock = () => { try { const o = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (o && o.catch) o.catch(() => {}); } catch (e) { /* not supported */ } };
    if (p && p.then) p.then(lock).catch(() => {}); else lock();
  } catch (e) { /* fullscreen is optional */ }
}

function checkRotate() {
  $('rotate').hidden = !(touchMode && appState === 'game' && window.innerHeight > window.innerWidth);
}

// Keep the logo inside its column whatever font actually loaded.
function fitLogo() {
  const el = document.querySelector('#menu .logo');
  if (!el || el.offsetParent === null) return;
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  const max = el.parentElement.clientWidth;
  const range = document.createRange();
  range.selectNodeContents(el);
  while (range.getBoundingClientRect().width > max && size > 28) {
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
  cam.fov = Math.max(42, 2 * Math.atan(Math.tan((62 * Math.PI) / 360) / cam.aspect) * (180 / Math.PI));
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

const SCREENS = ['home', 'play', 'howto', 'settings', 'join', 'lobby'];

function showMenu(screen) {
  $('menu').hidden = false;
  for (const id of SCREENS) $('scr-' + id).hidden = id !== screen;
  syncUI();
  requestAnimationFrame(fitLogo);
}

function syncUI() {
  const pressed = (sel, attr, val) => document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === val)));
  pressed('[data-mode]', 'mode', settings.mode);
  pressed('[data-diff]', 'diff', settings.difficulty);
  pressed('[data-load]', 'load', settings.loadout);
  pressed('[data-q]', 'q', settings.quality);
  pressed('[data-touch]', 'touch', settings.touch);
  pressed('[data-lmode]', 'lmode', net.lobby.mode);
  pressed('[data-pref]', 'pref', net.lobby.pref);
  $('loadout-wrap').hidden = MODES[settings.mode].kind !== 'arena';
  $('set-sens').value = settings.sens;
  $('out-sens').textContent = Number(settings.sens).toFixed(1);
  $('set-tsens').value = settings.touchSens;
  $('out-tsens').textContent = Number(settings.touchSens).toFixed(1);
  $('set-fov').value = settings.fov;
  $('out-fov').textContent = settings.fov + '°';
  $('set-vol').value = settings.master;
  $('out-vol').textContent = Math.round(settings.master * 100) + '%';
  $('set-music').value = settings.music;
  $('out-music').textContent = Math.round(settings.music * 100) + '%';
  $('set-invert').checked = settings.invert;
  $('set-fps').checked = settings.showFps;
  $('fps').hidden = !settings.showFps;
  $('deploy').textContent = `Deploy · ${MODES[settings.mode].label}`;
}

function gesture() {
  audio.init();
  audio.applyVolume();
  if (appState === 'menu') audio.startMusic();
}

function playerName() {
  const n = (settings.name || '').trim();
  return n || 'Player ' + Math.floor(100 + Math.random() * 900);
}

function bindUI() {
  const click = (el, fn) => el.addEventListener('click', (ev) => { gesture(); audio.uiTick(); fn(ev); });
  click($('go-play'), () => showMenu('play'));
  click($('go-howto'), () => showMenu('howto'));
  click($('go-settings'), () => { settingsFrom = null; showMenu('settings'); });
  document.querySelectorAll('[data-back]').forEach((b) => click(b, () => {
    if (settingsFrom === 'pause') { settingsFrom = null; $('menu').hidden = true; $('pause').hidden = false; return; }
    if (settingsFrom === 'lobby') { settingsFrom = null; showMenu('lobby'); return; }
    const scr = SCREENS.find((s) => !$('scr-' + s).hidden);
    showMenu(scr === 'join' ? 'play' : 'home');
  }));
  document.querySelectorAll('[data-mode]').forEach((b) => click(b, () => { settings.mode = b.dataset.mode; saveSettings(); syncUI(); }));
  document.querySelectorAll('[data-diff]').forEach((b) => click(b, () => { settings.difficulty = b.dataset.diff; saveSettings(); syncUI(); }));
  document.querySelectorAll('[data-load]').forEach((b) => click(b, () => {
    settings.loadout = b.dataset.load;
    saveSettings();
    syncUI();
    if (net.role === 'client') net.send({ t: 'load', l: settings.loadout });
    if (net.role === 'host') { const me = net.lobby.players.find((p) => p.hid === 0); if (me) { me.loadout = settings.loadout; net.emitLobby(); } }
  }));
  document.querySelectorAll('[data-q]').forEach((b) => click(b, () => { settings.quality = b.dataset.q; saveSettings(); R.setQuality(settings.quality); syncUI(); }));
  document.querySelectorAll('[data-touch]').forEach((b) => click(b, () => { settings.touch = b.dataset.touch; saveSettings(); applyInputMode(); syncUI(); }));
  const range = (id, key, fn) => $(id).addEventListener('input', (e) => { settings[key] = Number(e.target.value); saveSettings(); fn && fn(); syncUI(); });
  range('set-sens', 'sens');
  range('set-tsens', 'touchSens');
  range('set-fov', 'fov');
  range('set-vol', 'master', () => { audio.vol.master = settings.master; audio.applyVolume(); });
  range('set-music', 'music', () => { audio.vol.music = settings.music; audio.applyVolume(); });
  $('set-invert').addEventListener('change', (e) => { settings.invert = e.target.checked; saveSettings(); });
  $('set-fps').addEventListener('change', (e) => { settings.showFps = e.target.checked; saveSettings(); syncUI(); });
  $('deploy').addEventListener('click', () => { gesture(); audio.uiSelect(); enterFullscreen(); lockPointer(); startMatch(settings.mode); });
  $('resume').addEventListener('click', () => { gesture(); resume(); });
  $('pause-settings').addEventListener('click', () => { settingsFrom = 'pause'; $('pause').hidden = true; showMenu('settings'); });
  $('leave').addEventListener('click', () => toMenu());
  $('again').addEventListener('click', () => { gesture(); enterFullscreen(); lockPointer(); startMatch(game.mode.id); });
  $('to-menu').addEventListener('click', () => toMenu());
  $('to-lobby').addEventListener('click', () => backToLobby(true));
  $('view').addEventListener('click', () => { if (appState === 'game' && !pc.locked && $('results').hidden && !touchMode) lockPointer(); });
  $('minimap-c').addEventListener('click', () => { if (touchMode && appState === 'game' && game.mode.kind === 'royale') hud.toggleBigMap(true); });
  $('bigmap').addEventListener('click', () => { if (touchMode) hud.toggleBigMap(false); });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === $('view');
    pc.locked = locked || pc.noLock || touchMode;
    if (locked) {
      $('pause').hidden = true;
      paused = false;
    } else if (appState === 'game' && $('results').hidden && !pc.noLock && !touchMode) {
      pc.releaseAll();
      showPause();
    }
  });
  document.addEventListener('pointerlockerror', () => {
    if (appState === 'game' && !touchMode) {
      pc.noLock = true;
      pc.locked = true;
      $('pause').hidden = true;
      paused = false;
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

  // online
  for (const id of ['join-name']) $(id).value = settings.name;
  $('join-name').addEventListener('input', (e) => { settings.name = e.target.value.slice(0, 16); saveSettings(); });
  $('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
  click($('go-join'), () => { enterFullscreen(); showMenu('join'); setStatus('join-status', ''); $('join-code').focus(); });
  click($('go-host'), () => { enterFullscreen(); hostRoom(); });
  click($('join-go'), () => joinRoom());
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  click($('lobby-copy'), () => {
    const code = net.code;
    const done = () => setStatus('lobby-status', 'Code copied. Send it to your friends.', 'ok');
    try { navigator.clipboard.writeText(code).then(done, () => selectCode()); } catch (e) { selectCode(); }
  });
  click($('lobby-leave'), () => { net.close(); showMenu('play'); });
  click($('lobby-start'), () => hostStart());
  document.querySelectorAll('[data-lmode]').forEach((b) => click(b, () => { settings.lobbyMode = b.dataset.lmode; saveSettings(); net.setLobby({ mode: b.dataset.lmode }); }));
  document.querySelectorAll('[data-pref]').forEach((b) => click(b, () => { settings.pref = b.dataset.pref; saveSettings(); net.setLobby({ pref: b.dataset.pref }); }));
}

function selectCode() {
  const r = document.createRange();
  r.selectNodeContents($('lobby-code'));
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  setStatus('lobby-status', 'Copy the highlighted code and send it to your friends.');
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.dataset.kind = kind || '';
}

/* ---------- online lobby ---------- */

function bindNet() {
  net.onLobby = () => renderLobby();
  net.onMessage = (msg, hid) => {
    if (net.role === 'host') {
      if (msg.t === 'load') {
        const p = net.lobby.players.find((x) => x.hid === hid);
        if (p && MODES.a1 && ['ar', 'smg', 'shotgun', 'dmr'].includes(msg.l)) { p.loadout = msg.l; net.emitLobby(); }
        return;
      }
      if (appState === 'game') game.onClientMsg(msg, hid);
      return;
    }
    if (msg.t === 'start') { startMatch(msg.mode, { role: 'client', roster: msg.roster, myHid: net.myHid, difficulty: msg.difficulty }); return; }
    if (msg.t === 'tolobby') { backToLobby(false); return; }
    if (appState === 'game') game.onHostMsg(msg);
  };
  net.onPeerLeft = (hid, name) => {
    if (appState === 'game') game.humanLeft(hid, name);
    else setStatus('lobby-status', `${name} left the room.`);
  };
  net.onClosed = (reason) => {
    if (appState === 'game') toMenu(reason);
    else { showMenu('play'); hud.toast(reason); }
  };
}

async function hostRoom() {
  settings.name = settings.name || playerName();
  saveSettings();
  showMenu('lobby');
  $('scr-lobby').classList.add('is-host');
  $('lobby-code').textContent = '·····';
  setStatus('lobby-status', 'Creating your room…');
  try {
    const code = await net.host(settings.name, { mode: settings.lobbyMode || 'a1', pref: settings.pref || 'versus', difficulty: settings.difficulty });
    const me = net.lobby.players[0];
    me.loadout = settings.loadout;
    $('lobby-code').textContent = code;
    setStatus('lobby-status', 'Share this code. Friends tap Play, then Join a room.', 'ok');
    renderLobby();
  } catch (err) {
    setStatus('lobby-status', 'Could not create a room. Check your internet connection and try again.', 'error');
  }
}

async function joinRoom() {
  const code = $('join-code').value;
  settings.name = ($('join-name').value || '').trim() || playerName();
  $('join-name').value = settings.name;
  saveSettings();
  setStatus('join-status', 'Connecting…');
  $('join-go').disabled = true;
  try {
    await net.join(code, settings.name);
    net.send({ t: 'load', l: settings.loadout });
    $('scr-lobby').classList.remove('is-host');
    $('lobby-code').textContent = net.code;
    showMenu('lobby');
    setStatus('lobby-status', 'Connected. Waiting for the host to start.', 'ok');
    renderLobby();
  } catch (err) {
    setStatus('join-status', err && err.message ? err.message : 'Could not join that room.', 'error');
  }
  $('join-go').disabled = false;
}

function lobbyCheck() {
  const L = net.lobby, m = MODES[L.mode];
  const n = L.players.length;
  if (m.kind === 'arena') {
    const cap = L.pref === 'together' ? m.teamSize : m.teamSize * 2;
    if (n > cap) return { ok: false, text: `${m.label} fits ${cap} ${L.pref === 'together' ? 'friends on one team' : 'players'}. Pick a bigger mode or switch teams.` };
    const vsBots = L.pref === 'together';
    return { ok: true, text: vsBots ? `You and your friends against bots in ${m.label}, first to ${m.rounds} rounds.` : `Friends are split across both teams in ${m.label}. Bots fill the rest.` };
  }
  return { ok: true, text: L.pref === 'together' ? `Royale ${m.label.toLowerCase()}: friends drop as one team of up to ${m.teamSize}, 24 players in total.` : `Royale ${m.label.toLowerCase()}: every friend is on a different team, 24 players in total.` };
}

function renderLobby() {
  if ($('scr-lobby').hidden) return;
  const L = net.lobby;
  const roster = buildRoster(MODES[L.mode], L.players, L.pref);
  const teamOf = (hid) => { const r = roster.find((x) => x.hid === hid); return r ? r.team : -1; };
  const arena = MODES[L.mode].kind === 'arena';
  $('lobby-players').innerHTML = L.players.map((p) => {
    const t = teamOf(p.hid);
    const team = t < 0 ? 'No slot' : arena ? (t === 0 ? 'Teal team' : 'Orange team') : `Team ${t + 1}`;
    const extra = arena && p.loadout ? ` · ${({ ar: 'Rifle', smg: 'SMG', shotgun: 'Shotgun', dmr: 'Marksman' })[p.loadout]}` : '';
    return `<li class="${p.hid === net.myHid ? 'me' : ''}"><span>${escapeHtml(p.name)}${p.hid === 0 ? ' (host)' : ''}</span><em>${team}${extra}</em></li>`;
  }).join('');
  const chk = lobbyCheck();
  $('lobby-summary').textContent = chk.text;
  $('lobby-start').disabled = !chk.ok;
  $('lobby-loadout').hidden = !arena;
  syncUI();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function hostStart() {
  const chk = lobbyCheck();
  if (!chk.ok) return;
  const L = net.lobby;
  const roster = buildRoster(MODES[L.mode], L.players, L.pref);
  net.inMatch = true;
  net.broadcast({ t: 'start', mode: L.mode, roster, difficulty: settings.difficulty });
  enterFullscreen();
  lockPointer();
  startMatch(L.mode, { role: 'host', roster, myHid: 0 });
}

function backToLobby(announce) {
  if (announce && net.role === 'host') { net.inMatch = false; net.broadcast({ t: 'tolobby' }); }
  leaveGame();
  showMenu('lobby');
  $('scr-lobby').classList.toggle('is-host', net.role === 'host');
  setStatus('lobby-status', net.role === 'host' ? 'Back in the room. Start another match when everyone is ready.' : 'Back in the room. Waiting for the host to start.', 'ok');
  renderLobby();
}

/* ---------- match flow ---------- */

function lockPointer() {
  if (touchMode) return;
  const c = $('view');
  try {
    const p = c.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { const q = c.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch (e) { /* ignored */ } });
  } catch (e) {
    try { c.requestPointerLock(); } catch (e2) { /* ignored */ }
  }
}

function online() { return net.role === 'host' || net.role === 'client'; }

function showPause() {
  if (appState !== 'game') return;
  if (!online()) paused = true;
  pc.releaseAll();
  touch.reset();
  $('pause').hidden = false;
  $('pause-sub').textContent = `${game.mode.label} · ${game.world.name}${online() ? ' · online, the match keeps running' : ''}`;
}

function resume() {
  if (touchMode) {
    $('pause').hidden = true;
    paused = false;
    return;
  }
  lockPointer();
}

async function startMatch(modeId, netOpts) {
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
  game.start(modeId, { difficulty: (netOpts && netOpts.difficulty) || settings.difficulty, loadout: settings.loadout, ...(netOpts || {}) });
  hud.setupMatch(game);
  hud.show(true);
  pc.resetCamera();
  $('loading').hidden = true;
  appState = 'game';
  if (touchMode) {
    pc.locked = true;
    touch.enable(true);
    paused = false;
  } else {
    paused = !pc.locked && !online();
    if (!pc.locked) showPause();
  }
  checkRotate();
  audio.stopMusic();
  audio.startAmbience(!!R.skyPreset.rain);
}

function leaveGame() {
  $('results').hidden = true;
  $('pause').hidden = true;
  hud.show(false);
  touch.enable(false);
  game.clear();
  game.state = 'idle';
  game.role = 'solo';
  appState = 'menu';
  paused = false;
  pc.vm.setWeapon(null);
  if (document.pointerLockElement) document.exitPointerLock();
  audio.stopAmbience();
  audio.setUnder(false);
  R.post.under = 0;
  R.post.damage = 0;
  R.post.chill = 0;
  checkRotate();
  if (game.world.id === 'spillway') { game.resetTide(); setupMenuScene(); }
  else {
    game.loadMap('spillway');
    game.resetTide();
    setupMenuScene();
  }
  audio.startMusic();
}

async function toMenu(message) {
  if (online()) net.close();
  if (game.world.id !== 'spillway') {
    $('loading').hidden = false;
    $('loading-text').textContent = 'Flooding Spillway';
    await frame();
    await frame();
  }
  leaveGame();
  $('loading').hidden = true;
  showMenu('home');
  if (message) hud.toast(message);
}

function showResults(r) {
  if (!online()) paused = true;
  if (document.pointerLockElement) document.exitPointerLock();
  pc.releaseAll();
  touch.reset();
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
  $('res-sub').textContent = sub + (net.role === 'client' ? ' · the host can take everyone back to the room' : '');
  const cells = [['Kills', s.kills], ['Damage', s.dmg], ['Accuracy', s.acc + '%'], ['Headshots', s.heads]];
  if (r.kind === 'arena') cells.push(['Deaths', s.deaths]);
  else cells.push(['Survived', Math.floor(game.player.alive ? game.time : game.player.deathTime || game.time) + ' s']);
  $('res-stats').innerHTML = cells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  $('results').dataset.win = String(!!r.win);
  $('again').hidden = online();
  $('to-lobby').hidden = net.role !== 'host';
  $('to-menu').textContent = online() ? 'Leave the room' : 'Main menu';
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

function netTick(dt) {
  if (!online() || game.state === 'idle') return;
  netT -= dt;
  if (netT > 0) return;
  netT = 1 / 15;
  if (net.role === 'host') net.broadcast(game.makeSnapshot());
  else if (game.player) net.send(game.makeClientState());
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
        netTick(dt);
      }
      touch.update();
      updateFlash(dt);
      R.update(paused ? 0 : dt, R.camera.position);
      fx.update(paused ? 0 : dt * timeScale, R.camera, particleScale());
      hud.update(dt, game, pc);
    }
    if (!dbg.noRender) R.render();
  } catch (err) {
    console.error(err);
  }
}

const hot = window.claude && window.claude.hot;
if (hot && hot.snapshot) hot.snapshot(() => ({ settings }));
if (hot && hot.ready) hot.ready(boot);
else boot(hot ? hot.data : {});
