// Procedural texture generation. Every surface in the game is painted here in code:
// tileable albedo + normal maps for structures, terrain and fabric, and sprites for effects.
import * as THREE from 'three';
import { tfbm, vnoise, hash2, clamp, smoothstep } from './util.js';

export const TEX = {};

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTex(c, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// fn(u, v, out) writes out.r/g/b (0..1, sRGB) and out.h (height). Produces albedo + normal textures.
function surface(size, fn, normalStrength = 2.5) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const H = new Float32Array(size * size);
  const o = { r: 0, g: 0, b: 0, h: 0 };
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      fn(u, v, o);
      const i = (y * size + x) * 4;
      img.data[i] = clamp(o.r, 0, 1) * 255;
      img.data[i + 1] = clamp(o.g, 0, 1) * 255;
      img.data[i + 2] = clamp(o.b, 0, 1) * 255;
      img.data[i + 3] = 255;
      H[y * size + x] = o.h;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: toTex(c, true), normalMap: normalFromHeight(H, size, normalStrength) };
}

function normalFromHeight(H, size, strength) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yr = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const nx = (H[yr + xm] - H[yr + xp]) * strength;
      const ny = (H[yp + x] - H[ym + x]) * strength;
      const l = Math.hypot(nx, ny, 1);
      const i = (yr + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, false);
}

function grey(size, fn, srgb = false) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const r = fn(x / size, y / size);
      img.data[i] = clamp(r[0], 0, 1) * 255;
      img.data[i + 1] = clamp(r[1], 0, 1) * 255;
      img.data[i + 2] = clamp(r[2], 0, 1) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, srgb);
}

/* ---------- surface painters ---------- */

function concrete(u, v, o) {
  const n1 = tfbm(u, v, 4, 5, 11);
  const n2 = tfbm(u, v, 24, 3, 12);
  const stain = tfbm(u, v, 2, 4, 13);
  const streak = tfbm(u, v, 48, 2, 14, 0.5, 1 / 12);
  const pit = vnoise(u * 64, v * 64, 64, 64, 15);
  let base = 0.62 + (n1 - 0.5) * 0.24 + (n2 - 0.5) * 0.1;
  base *= 1 - smoothstep(0.5, 0.9, stain) * 0.26;
  base *= 1 - smoothstep(0.5, 0.85, streak) * 0.2;
  let h = n1 * 0.5 + n2 * 0.5;
  if (pit > 0.88) { base *= 0.9; h -= (pit - 0.88) * 3; }
  const sv = (v * 2) % 1;
  if (sv < 0.006 || sv > 0.994) { base *= 0.7; h -= 0.5; }
  const su = (u * 2) % 1;
  if (su < 0.004 || su > 0.996) { base *= 0.82; h -= 0.3; }
  o.r = base * 1.02; o.g = base; o.b = base * 0.96; o.h = h;
}

function corrugated(col) {
  return (u, v, o) => {
    const rib = (u * 10) % 1;
    const prof = smoothstep(0.08, 0.22, rib) - smoothstep(0.58, 0.72, rib);
    const dent = tfbm(u, v, 6, 3, 21);
    const rust = tfbm(u, v, 5, 5, 22);
    const drip = tfbm(u, v, 40, 2, 24, 0.5, 1 / 10);
    const shade = 0.88 + (dent - 0.5) * 0.18 + prof * 0.07;
    let r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
    const rm = smoothstep(0.66, 0.8, rust + (1 - prof) * 0.03) * 0.8 + smoothstep(0.66, 0.85, drip) * 0.3;
    const rk = clamp(rm, 0, 1);
    const rc = 0.6 + dent * 0.6;
    r = r + (0.36 * rc - r) * rk; g = g + (0.19 * rc - g) * rk; b = b + (0.1 * rc - b) * rk;
    o.r = r; o.g = g; o.b = b; o.h = prof * 1.4 + dent * 0.3 - rk * 0.15;
  };
}

function paint(col, rustAmt) {
  return (u, v, o) => {
    const n = tfbm(u, v, 4, 4, 31);
    const chip = tfbm(u, v, 12, 4, 32);
    const streak = tfbm(u, v, 32, 2, 33, 0.5, 1 / 8);
    let shade = 0.85 + (n - 0.5) * 0.2;
    let r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
    const rk = clamp(smoothstep(0.74 - rustAmt * 0.12, 0.84, chip) * 0.85 + smoothstep(0.7, 0.88, streak) * rustAmt * 0.5, 0, 1);
    r += (0.3 - r) * rk; g += (0.15 - g) * rk; b += (0.08 - b) * rk;
    o.r = r; o.g = g; o.b = b; o.h = n * 0.4 - rk * 0.4;
  };
}

function wood(u, v, o) {
  const plank = Math.floor(v * 6);
  const tone = hash2(plank, 3, 41);
  const grain = tfbm(u, v, 2, 4, 42, 0.55, 24);
  const knot = vnoise(u * 8 + plank * 1.7, v * 8, 8, 8, 43);
  let base = 0.38 + tone * 0.12 + (grain - 0.5) * 0.18;
  if (knot > 0.85) base *= 0.75;
  const fv = (v * 6) % 1;
  let h = grain * 0.4;
  if (fv < 0.04 || fv > 0.96) { base *= 0.45; h -= 0.8; }
  o.r = base * 1.05; o.g = base * 0.93; o.b = base * 0.8; o.h = h;
}

function terrainDetail(u, v, o) {
  const n = tfbm(u, v, 8, 5, 51);
  const peb = vnoise(u * 96, v * 96, 96, 96, 52);
  const fine = vnoise(u * 256, v * 256, 256, 256, 53);
  let base = 0.82 + (n - 0.5) * 0.32 + (fine - 0.5) * 0.1;
  let h = n * 0.6 + fine * 0.15;
  if (peb > 0.78) { base *= 0.85 + peb * 0.15; h += (peb - 0.78) * 4; }
  o.r = base; o.g = base; o.b = base; o.h = h;
}

function rock(u, v, o) {
  const n = tfbm(u, v, 4, 6, 61);
  const crack = Math.abs(tfbm(u, v, 6, 3, 62) - 0.5);
  const lichen = tfbm(u, v, 10, 3, 63);
  let base = 0.5 + (n - 0.5) * 0.35;
  let r = base * 1.0, g = base * 0.97, b = base * 0.92;
  if (crack < 0.03) { r *= 0.55; g *= 0.55; b *= 0.55; }
  const lk = smoothstep(0.62, 0.72, lichen) * 0.6;
  r += (0.55 - r) * lk; g += (0.58 - g) * lk; b += (0.36 - b) * lk;
  o.r = r; o.g = g; o.b = b; o.h = n - (crack < 0.03 ? 0.3 : 0);
}

function bark(u, v, o) {
  const n = tfbm(u, v, 12, 3, 71, 0.5, 1 / 4);
  const base = 0.3 + n * 0.2;
  o.r = base * 1.05; o.g = base * 0.88; o.b = base * 0.72; o.h = n;
}

function foliage(u, v, o) {
  const n = tfbm(u, v, 16, 3, 81);
  const base = 0.65 + n * 0.45;
  o.r = base; o.g = base; o.b = base; o.h = n;
}

function camo(cols, seed) {
  return (u, v, o) => {
    const a = tfbm(u, v, 3, 4, seed);
    const b = tfbm(u, v, 4, 4, seed + 7);
    let c = cols[0];
    if (a > 0.56) c = cols[1];
    if (b > 0.6) c = cols[2];
    const weave = (Math.sin(u * Math.PI * 256) * Math.sin(v * Math.PI * 256)) * 0.5 + 0.5;
    const s = 0.9 + weave * 0.12;
    o.r = c[0] * s; o.g = c[1] * s; o.b = c[2] * s; o.h = weave * 0.3 + a * 0.2;
  };
}

function cordura(u, v, o) {
  const weave = (Math.sin(u * Math.PI * 200) * Math.sin(v * Math.PI * 200)) * 0.5 + 0.5;
  const n = tfbm(u, v, 6, 3, 91);
  const molle = (v * 10) % 1;
  let s = 0.82 + weave * 0.1 + (n - 0.5) * 0.15;
  let h = weave * 0.3;
  if (molle < 0.28) { s *= 0.8; h += 0.6; }
  o.r = s; o.g = s; o.b = s; o.h = h;
}

/* ---------- sprites ---------- */

function sprite(size, draw) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  draw(ctx, size);
  return toTex(c, true, false);
}

function radial(ctx, s, stops) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

export async function generateTextures(onProgress) {
  const jobs = [
    ['concrete', () => surface(512, concrete, 3)],
    ['contRed', () => surface(256, corrugated([0.52, 0.13, 0.09]), 4)],
    ['contBlue', () => surface(256, corrugated([0.11, 0.24, 0.38]), 4)],
    ['contGreen', () => surface(256, corrugated([0.2, 0.33, 0.22]), 4)],
    ['contOrange', () => surface(256, corrugated([0.78, 0.4, 0.12]), 4)],
    ['contWhite', () => surface(256, corrugated([0.72, 0.72, 0.69]), 4)],
    ['paintYellow', () => surface(256, paint([0.85, 0.62, 0.1], 0.7), 2)],
    ['paintSteel', () => surface(256, paint([0.36, 0.38, 0.4], 0.5), 2)],
    ['paintWhite', () => surface(256, paint([0.86, 0.85, 0.82], 0.3), 2)],
    ['paintRed', () => surface(256, paint([0.62, 0.1, 0.08], 0.4), 2)],
    ['wood', () => surface(256, wood, 3)],
    ['terrain', () => surface(512, terrainDetail, 2.2)],
    ['rock', () => surface(256, rock, 4)],
    ['bark', () => surface(128, bark, 3)],
    ['foliage', () => surface(128, foliage, 2)],
    ['camoUrban', () => surface(256, camo([[0.27, 0.29, 0.31], [0.16, 0.17, 0.18], [0.38, 0.39, 0.39]], 101), 1.5)],
    ['camoWood', () => surface(256, camo([[0.25, 0.27, 0.16], [0.15, 0.14, 0.09], [0.34, 0.32, 0.21]], 111), 1.5)],
    ['camoDesert', () => surface(256, camo([[0.48, 0.42, 0.31], [0.35, 0.29, 0.21], [0.56, 0.5, 0.38]], 121), 1.5)],
    ['cordura', () => surface(256, cordura, 2)],
    ['waterNormal', () => {
      const size = 512;
      const H = new Float32Array(size * size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        H[y * size + x] = tfbm(u, v, 6, 5, 141, 0.55) * 0.7 + tfbm(u, v, 20, 2, 142) * 0.3;
      }
      return { normalMap: normalFromHeight(H, size, 9) };
    }],
    ['foam', () => ({ map: grey(256, (u, v) => {
      const f = tfbm(u, v, 8, 4, 151);
      const g = tfbm(u, v, 24, 2, 152);
      const x = smoothstep(0.42, 0.7, f * 0.75 + g * 0.35);
      return [x, f, g];
    }) })],
    ['clouds', () => ({ map: grey(256, (u, v) => [tfbm(u, v, 4, 6, 161, 0.55), tfbm(u, v, 8, 4, 162), 0]) })],
  ];

  for (let i = 0; i < jobs.length; i++) {
    const [name, fn] = jobs[i];
    TEX[name] = fn();
    onProgress && onProgress((i + 1) / (jobs.length + 1), name);
    await new Promise((r) => setTimeout(r, 0));
  }

  TEX.glow = sprite(64, (ctx, s) => radial(ctx, s, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.65)'], [1, 'rgba(255,255,255,0)']]));
  TEX.flash = sprite(128, (ctx, s) => {
    ctx.translate(s / 2, s / 2);
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      ctx.save();
      ctx.rotate((k / 6) * Math.PI * 2 + (k % 2) * 0.2);
      const len = k % 2 ? s * 0.32 : s * 0.48;
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,240,200,1)');
      g.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.05);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, s * 0.05);
      ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.22);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-s / 2, -s / 2, s, s);
  });
  TEX.smoke = sprite(128, (ctx, s) => {
    for (let k = 0; k < 14; k++) {
      const a = hash2(k, 1, 7) * Math.PI * 2, r = hash2(k, 2, 7) * s * 0.18;
      const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
      const rad = s * (0.16 + hash2(k, 3, 7) * 0.16);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  });
  TEX.hole = sprite(64, (ctx, s) => {
    radial(ctx, s, [[0, 'rgba(10,9,8,1)'], [0.18, 'rgba(20,18,16,0.95)'], [0.32, 'rgba(40,36,32,0.6)'], [0.6, 'rgba(60,55,50,0.15)'], [1, 'rgba(0,0,0,0)']]);
    ctx.strokeStyle = 'rgba(25,22,20,0.55)';
    ctx.lineWidth = 1;
    for (let k = 0; k < 6; k++) {
      const a = hash2(k, 9, 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(s / 2 + Math.cos(a) * 5, s / 2 + Math.sin(a) * 5);
      ctx.lineTo(s / 2 + Math.cos(a) * (12 + hash2(k, 4, 3) * 14), s / 2 + Math.sin(a + 0.1) * (12 + hash2(k, 4, 3) * 14));
      ctx.stroke();
    }
  });
  TEX.ring = sprite(128, (ctx, s) => radial(ctx, s, [[0, 'rgba(255,255,255,0)'], [0.72, 'rgba(255,255,255,0)'], [0.86, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]));
  TEX.grass = sprite(128, (ctx, s) => {
    for (let k = 0; k < 22; k++) {
      const x0 = s * (0.15 + hash2(k, 1, 5) * 0.7);
      const h = s * (0.45 + hash2(k, 2, 5) * 0.55);
      const lean = (hash2(k, 3, 5) - 0.5) * s * 0.35;
      const w = 2 + hash2(k, 4, 5) * 3;
      const g = ctx.createLinearGradient(0, s, 0, s - h);
      const t = hash2(k, 5, 5);
      g.addColorStop(0, 'rgba(48,58,26,1)');
      g.addColorStop(1, t > 0.5 ? 'rgba(170,165,92,1)' : 'rgba(120,140,60,1)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0 - w, s);
      ctx.quadraticCurveTo(x0 + lean * 0.3, s - h * 0.6, x0 + lean, s - h);
      ctx.quadraticCurveTo(x0 + lean * 0.3 + w * 0.3, s - h * 0.6, x0 + w, s);
      ctx.fill();
    }
  });
  onProgress && onProgress(1, 'done');
  return TEX;
}
