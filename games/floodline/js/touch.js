// Touch controls for phones and tablets: a floating move stick on the left, swipe-to-look on the
// right, and buttons laid out around the thumb. The fire buttons also steer the aim while held.
const ICONS = {
  fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 1v6M12 17v6M1 12h6M17 12h6"/></svg>',
  ads: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M12 20V5M5 11l7-7 7 7"/></svg>',
  crouch: '<svg viewBox="0 0 24 24"><path d="M12 4v15M5 13l7 7 7-7"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-4-4M20 16H6l4 4"/></svg>',
  nade: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="6"/><path d="M10 8V5h4v3M14 5l3-2"/></svg>',
  heal: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  score: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
};

export class TouchControls {
  constructor(pc, hud, game, handlers) {
    this.pc = pc;
    this.hud = hud;
    this.game = game;
    this.handlers = handlers;
    this.root = document.getElementById('touch');
    this.stickEl = document.getElementById('tc-stick');
    this.knob = this.stickEl.querySelector('i');
    this.stick = null;
    this.looks = new Map();
    this.fires = new Set();
    this.R = 58;
    this.enabled = false;
    for (const b of this.root.querySelectorAll('[data-act]')) {
      const act = b.dataset.act;
      if (ICONS[act]) b.insertAdjacentHTML('afterbegin', ICONS[act]);
      b.addEventListener('pointerdown', (e) => this.down(e, act, b));
      b.addEventListener('pointermove', (e) => this.move(e));
      b.addEventListener('pointerup', (e) => this.up(e, act, b));
      b.addEventListener('pointercancel', (e) => this.up(e, act, b));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    const zone = document.getElementById('tc-zone');
    zone.addEventListener('pointerdown', (e) => this.zoneDown(e));
    zone.addEventListener('pointermove', (e) => this.move(e));
    zone.addEventListener('pointerup', (e) => this.zoneUp(e));
    zone.addEventListener('pointercancel', (e) => this.zoneUp(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  enable(on) {
    this.enabled = on;
    this.root.hidden = !on;
    if (!on) this.reset();
  }

  reset() {
    const pc = this.pc;
    this.stick = null;
    this.looks.clear();
    this.fires.clear();
    pc.analog = null;
    pc.touchSprint = false;
    pc.mouseL = false;
    pc.mouseR = false;
    pc.keys = {};
    this.crouchOn = false;
    this.stickEl.hidden = true;
  }

  zoneDown(e) {
    e.preventDefault();
    const left = e.clientX < window.innerWidth * 0.42;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
    if (left && !this.stick) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
      this.stickEl.hidden = false;
      this.stickEl.style.left = e.clientX + 'px';
      this.stickEl.style.top = e.clientY + 'px';
      this.knob.style.transform = 'translate(-50%,-50%)';
    } else {
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 });
    }
  }

  zoneUp(e) {
    if (this.stick && this.stick.id === e.pointerId) {
      this.stick = null;
      this.pc.analog = null;
      this.pc.touchSprint = false;
      this.stickEl.hidden = true;
      return;
    }
    const l = this.looks.get(e.pointerId);
    if (l) {
      // a quick tap with no drag switches spectator target when dead
      if (l.moved < 8 && performance.now() - l.t < 250 && !this.game.player.alive) this.pc.pressed.Mouse0 = true;
      this.looks.delete(e.pointerId);
    }
  }

  move(e) {
    if (this.stick && this.stick.id === e.pointerId) {
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const d = Math.hypot(dx, dy);
      const R = this.R;
      if (d > R) { dx *= R / d; dy *= R / d; }
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const x = dx / R, y = -dy / R;
      const mag = Math.hypot(x, y);
      this.pc.analog = mag < 0.12 ? null : { x, y };
      this.pc.touchSprint = mag > 0.92 && y > 0.7;
      this.stickEl.classList.toggle('sprint', this.pc.touchSprint);
      return;
    }
    const l = this.looks.get(e.pointerId);
    if (l) {
      const dx = e.clientX - l.x, dy = e.clientY - l.y;
      l.x = e.clientX;
      l.y = e.clientY;
      l.moved += Math.abs(dx) + Math.abs(dy);
      this.pc.touchDX += dx;
      this.pc.touchDY += dy;
    }
  }

  down(e, act, b) {
    e.preventDefault();
    e.stopPropagation();
    const pc = this.pc;
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
    b.classList.add('held');
    switch (act) {
      case 'fire':
        this.fires.add(e.pointerId);
        this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 });
        pc.mouseL = true;
        pc.pressed.Mouse0 = true;
        break;
      case 'ads': pc.mouseR = !pc.mouseR; break;
      case 'jump': pc.keys.Space = true; pc.pressed.Space = true; break;
      case 'crouch':
        // while sprinting a tap slides; otherwise it toggles crouch
        if (pc.game.player.sprinting) { pc.pressed.KeyC = true; break; }
        this.crouchOn = !this.crouchOn;
        pc.keys.KeyC = this.crouchOn;
        break;
      case 'reload': pc.pressed.KeyR = true; break;
      case 'swap': pc.wheelAcc = 1; break;
      case 'nade': pc.pressed.KeyG = true; break;
      case 'heal': pc.pressed.KeyH = true; break;
      case 'use': pc.pressed.KeyE = true; break;
      case 'pause': this.handlers.pause(); break;
      case 'score': this.hud.toggleScoreboard(this.hud.el.scoreboard.hidden, this.game); break;
    }
  }

  up(e, act, b) {
    b.classList.remove('held');
    const pc = this.pc;
    if (act === 'fire') {
      this.fires.delete(e.pointerId);
      this.looks.delete(e.pointerId);
      if (!this.fires.size) pc.mouseL = false;
    } else if (act === 'jump') pc.keys.Space = false;
  }

  update() {
    if (!this.enabled) return;
    const pc = this.pc, g = this.game, e = g.player;
    if (!e) return;
    const show = (sel, on) => { const el = this.root.querySelector(sel); if (el) el.hidden = !on; };
    const alive = e.alive;
    const it = pc.interact;
    const use = this.root.querySelector('[data-act="use"]');
    if (it && alive) {
      use.hidden = false;
      const label = it.obj.type ? 'Pick up' : 'Open';
      if (use.dataset.label !== label) { use.dataset.label = label; use.lastChild.textContent = label; }
    } else use.hidden = true;
    for (const a of ['fire', 'ads', 'jump', 'crouch', 'reload', 'swap']) show(`[data-act="${a}"]`, alive);
    show('[data-act="nade"]', alive && e.grenades > 0);
    show('[data-act="heal"]', alive && e.medkits > 0);
    this.root.querySelector('[data-act="ads"]').classList.toggle('on', pc.mouseR);
    if (this.crouchOn && !pc.keys.KeyC) this.crouchOn = false;
    this.root.querySelector('[data-act="crouch"]').classList.toggle('on', this.crouchOn);
    if (!alive && pc.mouseR) pc.mouseR = false;
  }
}
