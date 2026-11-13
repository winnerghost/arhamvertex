// Map layouts. Spillway is a compact, point-symmetric arena for team elimination rounds.
// Saltreach is an island for the battle royale, with named places at different heights so the
// rising tide pushes everyone toward The Summit.
import { smoothstep, lerp, fbm, ridged } from './util.js';

const SPILL_BASE = [
  { x: -30, z: 21, r: 10, h: 5.5 },
  { x: -21, z: -27, r: 8, h: 4.4 },
  { x: -8, z: 35, r: 5, h: 3.2 },
  { x: -44, z: -20, r: 5, h: 3.0 },
];
const SPILL_FEATURES = [{ x: 0, z: 0, r: 14, h: 10 }, ...SPILL_BASE, ...SPILL_BASE.map((f) => ({ ...f, x: -f.x, z: -f.z }))];

const SALT_HILLS = [
  { x: -124, z: 70, h: 24, r: 15, R: 78 },
  { x: 152, z: 108, h: 17, r: 14, R: 52 },
  { x: -62, z: -112, h: 11, r: 26, R: 66 },
  { x: -30, z: 122, h: 7, r: 20, R: 50 },
  { x: 120, z: 22, h: 14, r: 8, R: 46 },
  { x: -150, z: -122, h: 9, r: 6, R: 36 },
];

const COLORS = ['Red', 'Blue', 'Green', 'Orange', 'White'];

function warehouse(w, cx, cz, rot, W, D, H, y) {
  const f = w.frame(cx, y, cz, rot);
  f.box(-W / 2 - 0.3, -2, -D / 2 - 0.3, W / 2 + 0.3, 0.15, D / 2 + 0.3, 'concreteDark');
  const T = 0.35;
  const door = (c, wd = 6, hgt = 5) => ({ u0: c - wd / 2, u1: c + wd / 2, v0: 0, v1: hgt });
  const withWindows = (len, doors) => {
    const ops = [...doors];
    for (let u = 2; u < len - 3; u += 4.5) {
      const o = { u0: u, u1: u + 2.4, v0: H - 2.4, v1: H - 1.2 };
      if (!doors.some((d) => o.u1 > d.u0 - 0.5 && o.u0 < d.u1 + 0.5)) ops.push(o);
    }
    return ops;
  };
  w.wall(f, 'x', -W / 2, W / 2, D / 2 - T / 2, T, 0.15, H, withWindows(W, [door(W * 0.3)]), 'siding');
  w.wall(f, 'x', -W / 2, W / 2, -D / 2 + T / 2, T, 0.15, H, withWindows(W, [door(W * 0.7)]), 'siding');
  w.wall(f, 'z', -D / 2 + T, D / 2 - T, -W / 2 + T / 2, T, 0.15, H, [door((D - 2 * T) / 2, 1.8, 2.4)], 'siding');
  w.wall(f, 'z', -D / 2 + T, D / 2 - T, W / 2 - T / 2, T, 0.15, H, [door((D - 2 * T) / 2, 1.8, 2.4)], 'siding');
  f.box(-W / 2 - 0.3, H + 0.15, -D / 2 - 0.3, W / 2 + 0.3, H + 0.45, D / 2 + 0.3, 'paintSteel');
  // interior cover
  const p1 = f.pt(-W * 0.25, 0, -D * 0.12);
  w.container(p1.x, p1.z, rot, 'Blue', { y: y + 0.15 });
  const p2 = f.pt(W * 0.22, 0, D * 0.1);
  w.container(p2.x, p2.z, rot + 1, 'Orange', { y: y + 0.15, open: true });
  for (const [lx, lz] of [[W * 0.05, -D * 0.25], [W * 0.38, -D * 0.3], [-W * 0.38, D * 0.25]]) {
    f.box(lx - 0.6, 0.15, lz - 0.6, lx + 0.6, 1.35, lz + 0.6, 'wood');
  }
  for (const [lx, lz] of [[-W * 0.4, -D * 0.3], [0, D * 0.3], [W * 0.4, 0], [-W * 0.05, 0]]) w.lootSpots.push(f.pt(lx, 0.17, lz));
  w.crateSpots.push(f.pt(-W * 0.1, 0.17, D * 0.32));
}

function crane(w, x, z, y) {
  for (const [lx, lz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
    w.addBox(x + lx - 0.45, y, z + lz - 0.45, x + lx + 0.45, y + 22, z + lz + 0.45, 'paintYellow');
  }
  w.addBox(x - 4.5, y + 9, z - 4.4, x + 4.5, y + 10, z - 3.6, 'paintYellow');
  w.addBox(x - 4.5, y + 9, z + 3.6, x + 4.5, y + 10, z + 4.4, 'paintYellow');
  w.addBox(x - 4.6, y + 21, z - 4.6, x + 4.6, y + 23, z + 4.6, 'paintYellow');
  w.addBox(x - 36, y + 23, z - 1.3, x + 12, y + 25.2, z + 1.3, 'paintYellow');
  w.addBox(x - 2.5, y + 25.2, z - 3, x + 5.5, y + 29, z + 3, 'contWhite');
  w.props.push({ kind: 'cable', x: x - 30, y: y + 23, z, len: 14 });
}

function mast(w, x, z, h) {
  const y = w.heightAt(x, z) - 0.2;
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) {
    w.addBox(x + lx - 0.15, y, z + lz - 0.15, x + lx + 0.15, y + h, z + lz + 0.15, 'paintRed');
  }
  w.props.push({ kind: 'mast', x, y, z, h });
}

export const MAP_DEFS = {
  spillway: {
    name: 'Spillway',
    size: 180,
    N: 181,
    bx: 64,
    bz: 52,
    seed: 1907,
    navRes: 1,
    sky: 'dusk',
    pads: [
      { id: 'spawnA', x: -54, z: 0, rx: 7, rz: 10, h: 2.2, fall: 3, mat: 'concrete' },
      { id: 'spawnB', x: 54, z: 0, rx: 7, rz: 10, h: 2.2, fall: 3, mat: 'concrete' },
      { id: 'gate', x: 0, z: 0, rx: 8, rz: 8, h: 10, fall: 2, mat: 'concrete' },
    ],
    tide: {
      start: 0,
      baseDps: 4,
      phases: [
        { wait: 22, rise: 12, to: 2.9, dps: 5 },
        { wait: 16, rise: 14, to: 6.1, dps: 8 },
        { wait: 16, rise: 18, to: 10.8, dps: 12 },
        { wait: 8, rise: 12, to: 16, dps: 30 },
      ],
    },
    height(w, x, z) {
      const n = w.noise;
      const sn = (f, o) => 0.5 * (n(x * f + o, z * f + o) + n(-x * f + o, -z * f + o));
      const ex = Math.abs(x) / 66, ez = Math.abs(z) / 53;
      const sq = Math.pow(ex ** 4 + ez ** 4, 0.25) + sn(0.035, 3) * 0.07;
      const land = 1 - smoothstep(0.9, 1.06, sq);
      let h = 1.6 + sn(0.06, 7) * 0.4 + sn(0.2, 11) * 0.1;
      const wob = sn(0.12, 13) * 1.4;
      for (const f of SPILL_FEATURES) {
        const d = Math.hypot(x - f.x, z - f.z) + wob;
        const m = f.h * (1 - smoothstep(f.r, f.r + f.h * 0.85 + 1.2, d));
        if (m > h) h = m;
      }
      h += sn(0.3, 17) * 0.08;
      let out = lerp(-7 + sn(0.02, 19) * 1.5, h, land);
      for (const p of w.pads) out = lerp(out, p.h, w.padWeight(p, x, z));
      return out;
    },
    build(w) {
      w.house(0, 0, 0, 9, 7, 1, { y: 10, sideDoors: true, roofBroken: true, loot: 0, mat: 'concrete' });
      for (const s of [1, -1]) {
        const P = (x, z) => [x * s, z * s];
        const R = (r) => (s === 1 ? r : r + 2);
        w.container(...P(-47, 9), R(1), 'Blue');
        w.container(...P(-47, -9), R(1), 'Red');
        w.barrier(...P(-45, 0), R(1));
        w.house(...P(-36, 3), R(1), 6, 5, 1, { mat: 'concrete', loot: 0 });
        w.car(...P(-30, -9), R(0), 'paintRed');
        w.stack(...P(-40, 18), R(0), ['Green', 'Orange']);
        w.container(...P(-49, -30), R(0), 'White', { open: true });
        w.house(...P(-31, 23), R(0), 7, 6, 2, { loot: 0 });
        w.barrier(...P(-23, 17), R(1));
        w.lowWall(...P(-21, -23), R(0), 5, 2.2);
        w.lowWall(...P(-25, -28), R(1), 4, 1.4);
        w.container(...P(-15, -31), R(0), 'Orange');
        w.barrier(...P(-8, 33), R(0));
        w.container(...P(-44, -20), R(0), 'Green');
        w.pipe(...P(-40, -38), ...P(-28, -38), 0.8);
        w.vent(...P(-23, 7), 20);
        w.lowWall(...P(-7, 6.5), R(1), 3, 1.15, 'concrete', 10);
        w.lowWall(...P(6, 8.5), R(0), 3.2, 1.15, 'concrete', 10);
        w.barrier(...P(0, -9.5), R(0), 10);
        w.container(...P(9.5, -5), R(1), 'White', { y: 9.95 });
        w.car(...P(-12, -40), R(1), 'paintSteel');
        w.barrels(...P(-44, 13.5), 3);
        w.barrels(...P(-33, -3), 2);
        w.barrels(...P(-18, -34), 2);
        for (let k = 0; k < 4; k++) {
          const [x, z] = P(-54, -4.5 + k * 3);
          w.teamSpawns[s === 1 ? 0 : 1].push({ x, z, yaw: s === 1 ? Math.PI / 2 : -Math.PI / 2 });
        }
      }
      // rocks along the shore and slopes, mirrored for fairness
      const rng = w.rng;
      for (let k = 0; k < 46; k++) {
        const a = rng() * Math.PI * 2;
        const ex = 66 * (0.93 + rng() * 0.08), ez = 53 * (0.93 + rng() * 0.08);
        const c = Math.cos(a), sa = Math.sin(a);
        const r = 1 / Math.pow(Math.abs(c / ex) ** 4 + Math.abs(sa / ez) ** 4, 0.25);
        const x = c * r, z = sa * r;
        const s = 1.4 + rng() * 2.4;
        if (w.footprintFree(x, z, s) && w.footprintFree(-x, -z, s)) { w.rock(x, z, s); w.rock(-x, -z, s); }
      }
      for (let k = 0; k < 10; k++) {
        const a = rng() * Math.PI * 2, d = 17.5 + rng() * 4;
        const x = Math.cos(a) * d, z = Math.sin(a) * d, s = 0.9 + rng() * 0.8;
        if (w.footprintFree(x, z, s + 1) && w.footprintFree(-x, -z, s + 1)) { w.rock(x, z, s); w.rock(-x, -z, s); }
      }
      for (let k = 0; k < 7; k++) {
        const x = -60 + rng() * 52, z = -45 + rng() * 90;
        if (w.heightAt(x, z) < 2.4 && w.footprintFree(x, z, 1.5) && w.footprintFree(-x, -z, 1.5)) { w.deadTree(x, z, 0.9 + rng() * 0.5); w.deadTree(-x, -z, 0.9 + rng() * 0.5); }
      }
    },
  },

  saltreach: {
    name: 'Saltreach',
    size: 540,
    N: 217,
    bx: 236,
    bz: 236,
    seed: 4242,
    navRes: 1,
    sky: 'storm',
    pads: [
      { id: 'harbor', name: 'Old Harbor', x: -176, z: -40, rx: 34, rz: 26, h: 1.8, fall: 12, mat: 'asphalt' },
      { id: 'town', name: 'Drowned Town', x: 92, z: -92, rx: 38, rz: 32, h: 5.0, fall: 14, mat: 'asphalt' },
      { id: 'pump', name: 'Pump Station', x: -62, z: -112, rx: 28, rz: 22, h: 11, fall: 14, mat: 'concrete' },
      { id: 'radio', name: 'Radio Ridge', x: -124, z: 70, rx: 17, rz: 17, h: 24, fall: 10, mat: 'dirt' },
      { id: 'light', name: 'Lighthouse Point', x: 152, z: 108, rx: 15, rz: 15, h: 17, fall: 10, mat: 'dirt' },
      { id: 'summit', name: 'The Summit', x: 18, z: -8, rx: 21, rz: 21, h: 42, fall: 6, mat: 'dirt' },
      { id: 'farm', name: 'Saltgrass Farm', x: -30, z: 122, rx: 24, rz: 18, h: 7, fall: 10, mat: 'dirt' },
    ],
    tide: {
      start: 0,
      baseDps: 1,
      phases: [
        { wait: 50, rise: 20, to: 3.0, dps: 2 },
        { wait: 36, rise: 22, to: 8.0, dps: 3 },
        { wait: 32, rise: 22, to: 13.5, dps: 4 },
        { wait: 30, rise: 22, to: 19.5, dps: 5 },
        { wait: 28, rise: 22, to: 25.5, dps: 7 },
        { wait: 25, rise: 22, to: 32, dps: 9 },
        { wait: 22, rise: 22, to: 38, dps: 12 },
        { wait: 20, rise: 20, to: 41.3, dps: 16 },
        { wait: 25, rise: 30, to: 50, dps: 25 },
      ],
    },
    height(w, x, z) {
      const n = w.noise, n2 = w.noise2;
      const r = Math.hypot(x, z), a = Math.atan2(z, x);
      const coastR = 200 + n(Math.cos(a) * 1.4 + 3, Math.sin(a) * 1.4 + 3) * 22 + n(x * 0.012, z * 0.012) * 10;
      const land = 1 - smoothstep(coastR - 24, coastR + 6, r);
      let h = 2.8 + fbm(n, x * 0.007, z * 0.007, 4) * 4.2 + n2(x * 0.03, z * 0.03) * 0.7;
      const dm = Math.hypot(x - 18, z + 8);
      const R = 120 + n(x * 0.01 + 5, z * 0.01 - 3) * 14;
      let m = 42 * Math.pow(1 - smoothstep(22, R, dm), 1.35);
      m += (ridged(n2, x * 0.018, z * 0.018, 3) - 0.45) * 8 * smoothstep(30, 55, dm) * (1 - smoothstep(R - 30, R, dm));
      if (m > h) h = m;
      for (const hl of SALT_HILLS) {
        const d = Math.hypot(x - hl.x, z - hl.z) + n(x * 0.03, z * 0.03) * 4;
        const v = hl.h * Math.pow(1 - smoothstep(hl.r, hl.R, d), 1.3);
        if (v > h) h = v;
      }
      let out = lerp(-14 + n(x * 0.01 + 9, z * 0.01) * 3, h, land);
      for (const p of w.pads) out = lerp(out, p.h, w.padWeight(p, x, z));
      return out;
    },
    build(w) {
      const rng = w.rng;
      const C = () => COLORS[Math.floor(rng() * COLORS.length)];

      // Old Harbor
      {
        const h = 1.8;
        warehouse(w, -166, -54, 0, 28, 16, 8, h);
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 3; j++) {
            if (rng() < 0.18) continue;
            const x = -198 + i * 7.6, z = -32 + j * 5.2;
            const hgt = 1 + Math.floor(rng() * 3);
            w.stack(x, z, 0, Array.from({ length: hgt }, C), { y: h - 0.05, open: rng() < 0.3 });
          }
          w.lootSpots.push({ x: -198 + i * 7.6, y: h, z: -29.4 });
        }
        w.addBox(-236, 1.45, -62, -205, 1.8, -53, 'wood');
        for (let x = -234; x <= -206; x += 4) for (const z of [-61.5, -53.5]) w.props.push({ kind: 'post', x, z, y0: -8, y1: 1.5 });
        crane(w, -201, -42, h);
        w.lootSpots.push({ x: -224, y: 1.82, z: -57.5 });
        w.crateSpots.push({ x: -186, y: h, z: -22 });
        w.barrier(-180, -36, 1, h);
        w.barrier(-150, -30, 0, h);
        w.car(-158, -32, 0, 'paintWhite');
        w.barrels(-176, -46, 3, h);
        w.barrels(-150, -40, 4, h);
        w.barrels(-200, -38, 2, h);
      }

      // Drowned Town
      {
        const cx = 92, cz = -92, y = 5.0;
        const rowA = [-28, -10, 8, 26], rowB = [-28, -8, 12, 30];
        for (const dx of rowA) {
          const W = 8 + Math.floor(rng() * 3), D = 7 + Math.floor(rng() * 2);
          w.house(cx + dx, cz - 17, 0, W, D, rng() < 0.6 ? 2 : 1, { y, mat: rng() < 0.5 ? 'plaster' : 'plasterBlue' });
        }
        for (const dx of rowB) {
          if (rng() < 0.15) continue;
          const W = 8 + Math.floor(rng() * 3), D = 7 + Math.floor(rng() * 2);
          w.house(cx + dx, cz + 9, 2, W, D, rng() < 0.6 ? 2 : 1, { y, mat: rng() < 0.5 ? 'plaster' : 'plasterBlue' });
        }
        w.house(cx, cz + 25, 2, 14, 10, 1, { y, fh: 5, sideDoors: true, roofBroken: true, loot: 2, mat: 'concrete' });
        w.crateSpots.push({ x: cx, y: y + 0.22, z: cz + 25 });
        w.car(cx - 18, cz - 5, 0, 'paintRed');
        w.car(cx + 2, cz - 3, 1, 'paintSteel');
        w.car(cx + 21, cz - 6, 0, 'paintWhite');
        w.barrier(cx - 34, cz - 4, 1, y);
        w.barrier(cx + 36, cz - 4, 1, y);
        w.crateSpots.push({ x: cx - 6, y, z: cz - 4 });
        w.lootSpots.push({ x: cx + 14, y, z: cz - 2 }, { x: cx - 26, y, z: cz - 6 });
        w.barrels(cx - 12, cz - 9, 3, y);
        w.barrels(cx + 31, cz + 1, 2, y);
      }

      // Pump Station
      {
        const y = 11;
        w.house(-62, -114, 0, 20, 12, 2, { y, fh: 4.4, mat: 'concrete', ruin: false, loot: 2, backDoor: true });
        w.crateSpots.push({ x: -56, y: y + 0.22, z: -114 });
        w.tank(-82, -100, 4.5, 7);
        w.tank(-82, -123, 4.5, 7);
        w.tank(-42, -126, 4.2, 6.5);
        w.pipe(-80, -97, -40, -97, 0.6, y + 2.9);
        for (const x of [-76, -64, -52, -44]) w.props.push({ kind: 'post', x, z: -97, y0: y - 0.2, y1: y + 2.3 });
        w.container(-44, -104, 1, 'Blue');
        w.container(-82, -111.5, 0, 'White', { open: true });
        w.barrier(-60, -100, 0, y);
        w.lootSpots.push({ x: -70, y, z: -103 }, { x: -48, y, z: -112 });
        w.barrels(-74, -104, 3, y);
        w.barrels(-48, -120, 4, y);
        w.crateSpots.push({ x: -76, y, z: -128 });
      }

      // Radio Ridge
      {
        const y = 24;
        mast(w, -124, 70, 38);
        w.house(-134, 61, 1, 7, 5, 1, { y, fh: 2.8, mat: 'concrete', backDoor: false, loot: 2 });
        w.house(-113, 80, 3, 7, 5, 1, { y, fh: 2.8, mat: 'concrete', backDoor: false, loot: 2 });
        w.lowWall(-124, 76, 0, 4, 1.15, 'concrete', y);
        w.lowWall(-118, 66, 1, 4, 1.15, 'concrete', y);
        w.lowWall(-130, 72, 1, 3, 1.15, 'concrete', y);
        w.container(-114, 60, 0, 'Green', { y: y - 0.05 });
        w.crateSpots.push({ x: -127, y, z: 67 });
      }

      // Lighthouse Point
      {
        const y = 17;
        const lx = 157, lz = 113;
        w.addBox(lx - 2.3, y - 0.5, lz - 2.3, lx + 2.3, y + 24, lz + 2.3, 'paintWhite', { visible: false });
        w.props.push({ kind: 'lighthouse', x: lx, y: y - 0.3, z: lz });
        w.house(144, 101, 0, 8, 6, 1, { y, loot: 2, mat: 'plasterBlue' });
        w.lowWall(150, 116, 0, 5, 1.0, 'concrete', y);
        w.crateSpots.push({ x: 150, y, z: 108 });
      }

      // The Summit
      {
        const y = 42;
        w.house(18, -8, 0, 11, 11, 2, { y, mat: 'concrete', loot: 2 });
        w.container(32, -14, 1, 'Orange', { y: y - 0.05 });
        w.container(5, 3, 0, 'Blue', { y: y - 0.05, open: true });
        w.container(8, -22, 0, 'White', { y: y - 0.05 });
        w.lowWall(30, 2, 1, 4, 1.15, 'concrete', y);
        w.lowWall(4, -12, 1, 3.5, 1.15, 'concrete', y);
        w.lowWall(20, 6, 0, 4, 1.15, 'concrete', y);
        w.barrier(22, -22, 0, y);
        w.barrier(34, -3, 1, y);
        w.barrier(0, -4, 1, y);
        w.props.push({ kind: 'dish', x: 27, y, z: 9, yaw: 2.4 });
        w.addBox(26, y, 8, 28, y + 2.2, 10, 'paintSteel', { visible: false });
        w.crateSpots.push({ x: 12, y, z: 4 }, { x: 28, y, z: -20 });
        w.lootSpots.push({ x: 26, y, z: -6 }, { x: 10, y, z: -16 });
      }

      // Saltgrass Farm
      {
        const y = 7;
        w.house(-38, 126, 0, 14, 10, 1, { y, mat: 'wood', fh: 5, sideDoors: true, roofBroken: true, loot: 2 });
        w.house(-16, 116, 2, 9, 7, 2, { y, mat: 'plaster' });
        w.tank(-20, 132, 3.2, 12, 'silo');
        w.car(-28, 110, 1, 'paintRed');
        w.lowWall(-48, 112, 0, 6, 1.0, 'wood', y);
        w.lowWall(-6, 130, 1, 6, 1.0, 'wood', y);
        w.crateSpots.push({ x: -40, y: y + 0.22, z: 126 });
      }

      // scattered world
      const land = (x, z, minH) => w.heightAt(x, z) > minH && w.inBounds(x, z, 4);
      for (let k = 0; k < 14; k++) {
        const x = (rng() - 0.5) * 400, z = (rng() - 0.5) * 400;
        if (land(x, z, 1.2) && w.footprintFree(x, z, 5)) w.container(x, z, Math.floor(rng() * 4), C(), { open: rng() < 0.4 });
      }
      for (let k = 0; k < 12; k++) {
        const x = (rng() - 0.5) * 400, z = (rng() - 0.5) * 400;
        if (land(x, z, 1.2) && w.footprintFree(x, z, 4)) w.car(x, z, Math.floor(rng() * 4), ['paintRed', 'paintSteel', 'paintWhite'][k % 3]);
      }
      for (let k = 0; k < 260; k++) {
        const x = (rng() - 0.5) * 470, z = (rng() - 0.5) * 470;
        if (!land(x, z, -3)) continue;
        const s = 1 + rng() * rng() * 4.5;
        if (w.footprintFree(x, z, s + 0.5)) w.rock(x, z, s);
      }
      let pines = 0;
      for (let k = 0; k < 2600 && pines < 460; k++) {
        const x = (rng() - 0.5) * 440, z = (rng() - 0.5) * 440;
        const h = w.heightAt(x, z);
        if (h < 6 || h > 39 || !w.inBounds(x, z, 6)) continue;
        if (w.noise(x * 0.018 + 40, z * 0.018) < 0.05) continue;
        if (!w.footprintFree(x, z, 1.4)) continue;
        w.pine(x, z, 0.8 + rng() * 0.6);
        pines++;
      }
      let dead = 0;
      for (let k = 0; k < 1200 && dead < 70; k++) {
        const x = (rng() - 0.5) * 440, z = (rng() - 0.5) * 440;
        const h = w.heightAt(x, z);
        if (h < 0.4 || h > 6 || !w.inBounds(x, z, 6) || !w.footprintFree(x, z, 1.2)) continue;
        w.deadTree(x, z, 0.8 + rng() * 0.6);
        dead++;
      }
      for (const [x, z] of [[60, -58], [-92, -70], [-62, 38], [42, 62], [96, 38], [-150, 4], [-10, 70], [70, -20]]) {
        if (land(x, z, 0.5)) w.vent(x, z, 21);
      }
      let loot = 0;
      for (let k = 0; k < 900 && loot < 56; k++) {
        const x = (rng() - 0.5) * 420, z = (rng() - 0.5) * 420;
        if (!land(x, z, 1.5)) continue;
        const y = w.heightAt(x, z);
        const out = [];
        w.queryBoxes(x - 0.6, y - 1, z - 0.6, x + 0.6, y + 2, z + 0.6, out);
        if (out.length) continue;
        w.lootSpots.push({ x, y, z });
        loot++;
      }
      let crates = 0;
      for (let k = 0; k < 300 && crates < 5; k++) {
        const x = (rng() - 0.5) * 380, z = (rng() - 0.5) * 380;
        if (land(x, z, 3) && w.footprintFree(x, z, 2)) { w.crateSpots.push({ x, y: w.heightAt(x, z), z }); crates++; }
      }
      w.pois = w.pads.filter((p) => p.name);
      w.dropZones = w.pois.map((p) => ({ x: p.x, z: p.z, r: Math.min(p.rx, p.rz) * 0.9 }));
    },
  },
};
