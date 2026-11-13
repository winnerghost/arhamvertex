// Procedural audio. Every sound is synthesized with Web Audio: layered gunshots with distance
// delay and filtering, positional bot sounds, ocean/wind/rain ambience, the tide horn and music.

const SHOTS = {
  ar: { crackF: 2600, crackQ: 0.9, crackD: 0.07, bodyF: 1400, bodyD: 0.16, thumpF: 120, thumpD: 0.12, gain: 0.9, tail: 0.5 },
  smg: { crackF: 3200, crackQ: 1.0, crackD: 0.05, bodyF: 1700, bodyD: 0.11, thumpF: 150, thumpD: 0.08, gain: 0.72, tail: 0.35 },
  shotgun: { crackF: 1500, crackQ: 0.7, crackD: 0.09, bodyF: 900, bodyD: 0.32, thumpF: 80, thumpD: 0.22, gain: 1.15, tail: 0.8 },
  dmr: { crackF: 2200, crackQ: 0.8, crackD: 0.1, bodyF: 1100, bodyD: 0.36, thumpF: 70, thumpD: 0.25, gain: 1.25, tail: 1.0 },
  pistol: { crackF: 3000, crackQ: 1.1, crackD: 0.05, bodyF: 1600, bodyD: 0.1, thumpF: 160, thumpD: 0.08, gain: 0.7, tail: 0.35 },
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.vol = { master: 0.8, music: 0.5 };
    this.under = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(this.muffle);
    this.muffle.connect(comp);
    comp.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.connect(comp);
    this.music = ctx.createGain();
    this.music.connect(comp);
    this.amb = ctx.createGain();
    this.amb.connect(this.master);
    // buffers
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len * 2, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < b.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    // reverb impulse
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.2, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const x = ir.getChannelData(c);
      for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / x.length, 3.2) * (i < 800 ? i / 800 : 1);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.5;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.sfx);
    this.applyVolume();
  }

  applyVolume() {
    if (!this.ctx) return;
    this.master.gain.value = this.vol.master;
    this.ui.gain.value = this.vol.master * 0.6;
    this.music.gain.value = this.vol.master * this.vol.music * 0.55;
  }

  get t() { return this.ctx.currentTime; }

  src(buf, offset = Math.random()) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf || this.noise;
    s.loop = true;
    s.loopStart = 0;
    s._off = offset * (s.buffer.duration - 0.5);
    return s;
  }

  env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  output(pos, dist, extraLow = 0) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    if (!pos) { g.connect(this.sfx); return g; }
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 6;
    p.rolloffFactor = 0.85;
    p.maxDistance = 600;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(500, 18000 * Math.exp(-(dist || 0) / 110) - extraLow);
    g.connect(lp);
    lp.connect(p);
    p.connect(this.sfx);
    return g;
  }

  listener(pos, fwd) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  shot(kind, pos, dist = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const P = SHOTS[kind] || SHOTS.ar;
    const delay = pos && dist > 25 ? dist / 343 : 0;
    const t = ctx.currentTime + delay + 0.005;
    const out = this.output(pos, dist);
    const far = pos ? Math.min(1, dist / 160) : 0;
    out.gain.value = P.gain * (pos ? 1.0 : 0.85);
    const n1 = this.src();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = P.crackF * (0.9 + Math.random() * 0.2);
    bp.Q.value = P.crackQ;
    const g1 = ctx.createGain();
    this.env(g1, t, 1.2 * (1 - far * 0.6), 0.001, P.crackD);
    n1.connect(bp); bp.connect(g1); g1.connect(out);
    const n2 = this.src();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(P.bodyF, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + P.bodyD);
    const g2 = ctx.createGain();
    this.env(g2, t, 1.4, 0.002, P.bodyD);
    n2.connect(lp); lp.connect(g2); g2.connect(out);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(P.thumpF, t);
    o.frequency.exponentialRampToValueAtTime(38, t + P.thumpD);
    const g3 = ctx.createGain();
    this.env(g3, t, pos ? 0.6 : 1.1, 0.002, P.thumpD);
    o.connect(g3); g3.connect(out);
    const send = ctx.createGain();
    send.gain.value = P.tail * (0.5 + far);
    out.connect(send);
    send.connect(this.verbIn);
    const end = t + Math.max(P.bodyD, P.thumpD) + 0.1;
    n1.start(t, n1._off); n2.start(t, n2._off); o.start(t);
    n1.stop(end); n2.stop(end); o.stop(end);
  }

  click(freq = 3000, gain = 0.25, decay = 0.02, at = 0, pos = null) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + at;
    const out = this.output(pos, 0);
    const n = this.src();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 3;
    const g = ctx.createGain();
    this.env(g, t, gain, 0.001, decay);
    n.connect(bp); bp.connect(g); g.connect(out);
    n.start(t, n._off);
    n.stop(t + decay + 0.05);
  }

  tone(freq, dur, type = 'sine', gain = 0.2, at = 0, bus = null, slide = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    const g = ctx.createGain();
    this.env(g, t, gain, 0.005, dur);
    o.connect(g);
    g.connect(bus || this.ui);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  reload(kind, dur) {
    const steps = kind === 'shotgun' ? [[0.05, 2400]] : [[0.12, 2200], [dur * 0.45, 1600], [dur * 0.62, 2800], [dur * 0.85, 3400]];
    for (const [at, f] of steps) this.click(f, 0.3, 0.03, at);
  }

  action(kind) {
    if (kind === 'pump') { this.click(1400, 0.35, 0.05, 0.12); this.click(2000, 0.35, 0.04, 0.3); }
    else { this.click(2600, 0.3, 0.03, 0.18); this.click(1800, 0.3, 0.04, 0.42); }
  }

  empty() { this.click(4200, 0.25, 0.015); }

  hit(head, kill) {
    if (!this.ctx) return;
    if (head) { this.tone(2600, 0.08, 'sine', 0.22); this.tone(3900, 0.06, 'sine', 0.12); }
    else this.click(2400, 0.4, 0.035);
    if (kill) { this.tone(180, 0.18, 'sine', 0.35, 0.02); this.tone(1200, 0.08, 'triangle', 0.15, 0.05); }
  }

  hurt() {
    if (!this.ctx) return;
    this.tone(90, 0.2, 'sine', 0.5, 0, this.sfx, -40);
    this.click(400, 0.5, 0.12);
  }

  step(pos, water, gain = 0.18, dist = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.output(pos, dist);
    const n = this.src();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = water ? 1100 + Math.random() * 400 : 380 + Math.random() * 200;
    f.Q.value = water ? 0.8 : 1.4;
    const g = ctx.createGain();
    this.env(g, t, water ? gain * 1.4 : gain, 0.004, water ? 0.22 : 0.07);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t, n._off);
    n.stop(t + 0.3);
  }

  thud(gain = 0.4) {
    this.tone(70, 0.16, 'sine', gain, 0, this.sfx, -30);
    this.click(300, gain * 0.8, 0.08);
  }

  explosion(pos, dist) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const delay = dist > 25 ? dist / 343 : 0;
    const t = ctx.currentTime + delay;
    const out = this.output(pos, dist * 0.6);
    out.gain.value = 1.6;
    const n = this.src();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 1.4);
    const g = ctx.createGain();
    this.env(g, t, 2.2, 0.004, 1.6);
    n.connect(lp); lp.connect(g); g.connect(out);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(25, t + 0.8);
    const g2 = ctx.createGain();
    this.env(g2, t, 1.5, 0.005, 0.9);
    o.connect(g2); g2.connect(out);
    const send = ctx.createGain();
    send.gain.value = 1.2;
    out.connect(send); send.connect(this.verbIn);
    n.start(t, n._off); o.start(t);
    n.stop(t + 2); o.stop(t + 1);
  }

  splash(pos, dist, big = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.output(pos, dist);
    const n = this.src();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.3 * big);
    const g = ctx.createGain();
    this.env(g, t, 0.35 * big, 0.005, 0.3 * big);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t, n._off); n.stop(t + 0.5 * big);
  }

  whoosh() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.src();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2500, t + 0.5);
    const g = ctx.createGain();
    this.env(g, t, 0.5, 0.05, 0.7);
    n.connect(f); f.connect(g); g.connect(this.sfx);
    n.start(t, n._off); n.stop(t + 0.9);
  }

  pickup() { this.tone(660, 0.08, 'triangle', 0.18); this.tone(990, 0.12, 'triangle', 0.15, 0.06); }
  uiTick() { this.tone(1500, 0.03, 'triangle', 0.08); }
  uiSelect() { this.tone(520, 0.08, 'triangle', 0.14); this.tone(780, 0.12, 'triangle', 0.12, 0.05); }
  beep(hi) { this.tone(hi ? 1320 : 880, 0.12, 'sine', 0.2); }

  horn() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.linearRampToValueAtTime(700, t + 0.6);
    lp.frequency.linearRampToValueAtTime(350, t + 3.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.5);
    g.gain.setValueAtTime(0.5, t + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    lp.connect(g);
    g.connect(this.ui);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    g.connect(send);
    send.connect(this.verbIn);
    for (const [f, type, a] of [[55, 'sawtooth', 0.5], [82.4, 'sawtooth', 0.35], [110, 'square', 0.12], [55.4, 'sawtooth', 0.4]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f * 0.97, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.4);
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + 4.3);
    }
  }

  sting(win) {
    const notes = win ? [261.6, 329.6, 392, 523.2] : [220, 261.6, 311.1, 207.6];
    notes.forEach((f, i) => this.tone(f, 1.6 - i * 0.2, 'triangle', 0.13, i * 0.12, this.music));
  }

  startAmbience(rain) {
    if (!this.ctx) return;
    this.stopAmbience();
    const ctx = this.ctx;
    const nodes = [];
    const ocean = ctx.createBufferSource();
    ocean.buffer = this.brown;
    ocean.loop = true;
    const oLp = ctx.createBiquadFilter();
    oLp.type = 'lowpass';
    oLp.frequency.value = 520;
    const oG = ctx.createGain();
    oG.gain.value = 0.22;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.12;
    lfo.connect(lfoG);
    lfoG.connect(oG.gain);
    ocean.connect(oLp); oLp.connect(oG); oG.connect(this.amb);
    ocean.start(); lfo.start();
    nodes.push(ocean, lfo);
    this.oceanGain = oG;
    const wind = this.src();
    const wF = ctx.createBiquadFilter();
    wF.type = 'bandpass';
    wF.frequency.value = 600;
    wF.Q.value = 0.6;
    const wl = ctx.createOscillator();
    wl.frequency.value = 0.06;
    const wlG = ctx.createGain();
    wlG.gain.value = 300;
    wl.connect(wlG); wlG.connect(wF.frequency);
    const wG = ctx.createGain();
    wG.gain.value = 0.04;
    wind.connect(wF); wF.connect(wG); wG.connect(this.amb);
    wind.start(0, wind._off); wl.start();
    nodes.push(wind, wl);
    if (rain) {
      const r = this.src();
      const rF = ctx.createBiquadFilter();
      rF.type = 'highpass';
      rF.frequency.value = 2500;
      const rG = ctx.createGain();
      rG.gain.value = 0.05;
      r.connect(rF); rF.connect(rG); rG.connect(this.amb);
      r.start(0, r._off);
      nodes.push(r);
    }
    this.ambNodes = nodes;
    this.amb.gain.value = 1;
  }

  stopAmbience() {
    if (this.ambNodes) for (const n of this.ambNodes) { try { n.stop(); } catch (e) { /* already stopped */ } }
    this.ambNodes = null;
  }

  setOcean(k) { if (this.oceanGain) this.oceanGain.gain.value = 0.08 + k * 0.3; }

  setUnder(on) {
    if (!this.ctx || on === this.under) return;
    this.under = on;
    this.muffle.frequency.setTargetAtTime(on ? 500 : 20000, this.ctx.currentTime, 0.08);
  }

  startMusic() {
    if (!this.ctx || this.musicNodes) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 400;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);
    lfo.start();
    lp.connect(out);
    out.connect(this.music);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    out.connect(send);
    send.connect(this.verbIn);
    const chords = [[110, 164.8, 220, 261.6], [87.3, 130.8, 174.6, 261.6], [130.8, 196, 261.6, 329.6], [98, 146.8, 196, 293.7]];
    const voices = [];
    for (let v = 0; v < 4; v++) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.045;
        o.connect(g);
        g.connect(lp);
        o.start();
        voices.push({ o, v });
      }
    }
    let ci = 0;
    const step = () => {
      const c = chords[ci % chords.length];
      const t = ctx.currentTime;
      for (const { o, v } of voices) o.frequency.setTargetAtTime(c[v], t, 1.2);
      ci++;
    };
    step();
    this.musicTimer = setInterval(step, 7000);
    this.musicNodes = { out, voices, lfo };
  }

  stopMusic() {
    if (!this.musicNodes) return;
    const { out, voices, lfo } = this.musicNodes;
    const t = this.ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + 1.5);
    setTimeout(() => { for (const { o } of voices) o.stop(); lfo.stop(); }, 1700);
    clearInterval(this.musicTimer);
    this.musicNodes = null;
  }
}
