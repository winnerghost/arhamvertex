// World: heightfield terrain, axis-aligned structure boxes, collision queries, raycasts and the
// navigation grid the bots path on. Map layouts live in maps.js and are built through this API.
import { mulberry32, makeSimplex, clamp, smoothstep } from './util.js';
import { MAP_DEFS } from './maps.js';

export class World {
  constructor(mapId) {
    const def = MAP_DEFS[mapId];
    this.id = mapId;
    this.def = def;
    this.name = def.name;
    this.size = def.size;
    this.half = def.size / 2;
    this.N = def.N;
    this.cell = def.size / (def.N - 1);
    this.bx = def.bx;
    this.bz = def.bz;
    this.rng = mulberry32(def.seed);
    this.noise = makeSimplex(def.seed);
    this.noise2 = makeSimplex(def.seed + 99);
    this.pads = def.pads || [];
    this.boxes = [];
    this.props = [];
    this.inst = { rock: [], pine: [], dead: [], bush: [], rubble: [], barrel: [] };
    this.lootSpots = [];
    this.crateSpots = [];
    this.vents = [];
    this.teamSpawns = [[], []];
    this.dropZones = [];
    this.pois = [];
    this.tide = def.tide;
    this.sky = def.sky;

    const N = this.N;
    this.heights = new Float32Array(N * N);
    let mn = 1e9, mx = -1e9;
    for (let iz = 0; iz < N; iz++) {
      const z = -this.half + iz * this.cell;
      for (let ix = 0; ix < N; ix++) {
        const x = -this.half + ix * this.cell;
        const h = def.height(this, x, z);
        this.heights[iz * N + ix] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    this.minH = mn;
    this.maxH = mx;

    def.build(this);
    this.finalizeBoxes();
    this.buildNav(def.navRes);
  }

  /* ---------- terrain ---------- */

  heightAt(x, z) {
    const N = this.N;
    let gx = (x + this.half) / this.cell, gz = (z + this.half) / this.cell;
    if (gx < 0) gx = 0; else if (gx > N - 1.0001) gx = N - 1.0001;
    if (gz < 0) gz = 0; else if (gz > N - 1.0001) gz = N - 1.0001;
    const ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz;
    const i = iz * N + ix, H = this.heights;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + N], h11 = H[i + N + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  normalAt(x, z, out) {
    const e = this.cell * 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  padWeight(p, x, z) {
    const dx = Math.abs(x - p.x) / p.rx, dz = Math.abs(z - p.z) / p.rz;
    const d = Math.pow(dx ** 4 + dz ** 4, 0.25);
    return 1 - smoothstep(1, 1 + p.fall / Math.min(p.rx, p.rz), d);
  }

  padAt(x, z) {
    let best = null, bw = 0;
    for (const p of this.pads) {
      const w = this.padWeight(p, x, z);
      if (w > bw) { bw = w; best = p; }
    }
    return { pad: best, w: bw };
  }

  groundUnder(cx, cz, w, d) {
    let m = this.heightAt(cx, cz);
    const hw = w / 2, hd = d / 2;
    m = Math.min(m, this.heightAt(cx - hw, cz - hd), this.heightAt(cx + hw, cz - hd), this.heightAt(cx - hw, cz + hd), this.heightAt(cx + hw, cz + hd));
    return m;
  }

  inBounds(x, z, margin = 0) {
    return Math.abs(x) < this.bx - margin && Math.abs(z) < this.bz - margin;
  }

  /* ---------- building API ---------- */

  addBox(x0, y0, z0, x1, y1, z1, mat, opt) {
    const b = {
      x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1),
      mat,
      collide: !opt || opt.collide !== false,
      visible: !opt || opt.visible !== false,
      id: this.boxes.length,
    };
    this.boxes.push(b);
    return b;
  }

  frame(ox, oy, oz, rot) {
    const w = this;
    rot = ((rot % 4) + 4) % 4;
    const tx = (lx, lz) => (rot === 0 ? [lx, lz] : rot === 1 ? [lz, -lx] : rot === 2 ? [-lx, -lz] : [-lz, lx]);
    return {
      rot, yaw: (rot * Math.PI) / 2, ox, oy, oz,
      pt(lx, ly, lz) {
        const [a, b] = tx(lx, lz);
        return { x: ox + a, y: oy + ly, z: oz + b };
      },
      box(lx0, ly0, lz0, lx1, ly1, lz1, mat, opt) {
        const [a0, b0] = tx(lx0, lz0);
        const [a1, b1] = tx(lx1, lz1);
        return w.addBox(ox + a0, oy + ly0, oz + b0, ox + a1, oy + ly1, oz + b1, mat, opt);
      },
    };
  }

  // Wall along local axis from a to b at offset c, thickness t, base y, height h, with openings.
  wall(f, axis, a, b, c, t, y, h, openings, mat, jag = 0) {
    const L = b - a;
    const solids = [];
    let u = 0;
    const ops = (openings || []).slice().sort((p, q) => p.u0 - q.u0);
    for (const op of ops) {
      if (op.u0 > u) solids.push([u, op.u0, 0, h]);
      if (op.v0 > 0) solids.push([op.u0, op.u1, 0, op.v0]);
      if (op.v1 < h) solids.push([op.u0, op.u1, op.v1, h]);
      u = Math.max(u, op.u1);
    }
    if (u < L) solids.push([u, L, 0, h]);
    const place = (u0, u1, v0, v1) => {
      if (u1 - u0 < 0.02 || v1 - v0 < 0.02) return;
      if (axis === 'x') f.box(a + u0, y + v0, c - t / 2, a + u1, y + v1, c + t / 2, mat);
      else f.box(c - t / 2, y + v0, a + u0, c + t / 2, y + v1, a + u1, mat);
    };
    // trims: sills under windows and lintels over openings (visual only)
    if (mat !== 'siding' && mat !== 'wood') {
      for (const op of ops) {
        const trim = (a0, a1, b0, b1, out) => {
          if (axis === 'x') f.box(a + a0, y + b0, c - t / 2 - out, a + a1, y + b1, c + t / 2 + out, 'concreteDark', { collide: false });
          else f.box(c - t / 2 - out, y + b0, a + a0, c + t / 2 + out, y + b1, a + a1, 'concreteDark', { collide: false });
        };
        if (op.v0 > 0.3) trim(op.u0 - 0.08, op.u1 + 0.08, op.v0 - 0.07, op.v0, 0.06);
        if (op.v1 < h - 0.15 && !jag) trim(op.u0 - 0.1, op.u1 + 0.1, op.v1, op.v1 + 0.14, 0.025);
      }
    }
    for (const [u0, u1, v0, v1] of solids) {
      if (jag && v1 >= h - 0.01) {
        // crumbled top edge: a random walk so the profile slopes instead of forming battlements
        let s = u0;
        let top = h - this.rng() * jag;
        while (s < u1 - 0.01) {
          const e = Math.min(u1, s + 0.45 + this.rng() * 0.5);
          top = Math.min(h, Math.max(h - jag, top + (this.rng() - 0.5) * 0.7));
          place(s, e, v0, Math.max(v0 + 0.35, top));
          s = e;
        }
      } else place(u0, u1, v0, v1);
    }
  }

  // Concrete house with doors, windows, interior stairs and optionally a roofless ruined top floor.
  house(cx, cz, rot, W, D, floors, o = {}) {
    const gy = o.y ?? this.groundUnder(cx, cz, W, D);
    const f = this.frame(cx, gy, cz, rot);
    const T = 0.3, FH = o.fh || 3.2, base = 0.2;
    const mat = o.mat || 'plaster';
    const rng = this.rng;
    f.box(-W / 2 - 0.25, -2.5, -D / 2 - 0.25, W / 2 + 0.25, base, D / 2 + 0.25, 'concreteDark');
    const stairW = 1.15, run = 3.6;
    const sx0 = -W / 2 + T, sx1 = sx0 + stairW;
    const sz0 = -D / 2 + T + 0.2;
    const DW = 1.7;
    const win = (len, centers) => centers.map((c) => ({ u0: c - 0.6, u1: c + 0.6, v0: 1.0, v1: 2.2 }));
    const winsAlong = (len) => {
      const out = [];
      if (len >= 7) out.push(len * 0.2, len * 0.8);
      else out.push(len * 0.5);
      return out;
    };
    for (let fl = 0; fl < floors; fl++) {
      const y = base + fl * FH;
      const top = fl === floors - 1;
      const ruin = top && (o.ruin ?? floors > 1);
      const jag = ruin ? 1.7 : 0;
      let front, back, left, right;
      const innerD = D - 2 * T;
      if (fl === 0) {
        const off = o.doorOff || 0;
        const door = { u0: W / 2 - DW / 2 + off, u1: W / 2 + DW / 2 + off, v0: 0, v1: 2.35 };
        const sideWins = W >= 7 ? win(W, [W * 0.17, W * 0.83]) : [];
        front = [door, ...sideWins];
        back = o.backDoor === false ? win(W, winsAlong(W)) : [{ ...door }, ...sideWins];
        left = hasStairsSide(floors) ? win(innerD, [innerD * 0.8]) : win(innerD, winsAlong(innerD));
        right = o.sideDoors ? [{ u0: innerD / 2 - DW / 2, u1: innerD / 2 + DW / 2, v0: 0, v1: 2.35 }] : win(innerD, winsAlong(innerD));
        if (o.sideDoors && !hasStairsSide(floors)) left = [{ u0: innerD / 2 - DW / 2, u1: innerD / 2 + DW / 2, v0: 0, v1: 2.35 }];
      } else {
        front = win(W, winsAlong(W));
        back = win(W, winsAlong(W));
        left = win(innerD, winsAlong(innerD));
        right = win(innerD, winsAlong(innerD));
      }
      this.wall(f, 'x', -W / 2, W / 2, D / 2 - T / 2, T, y, FH, front, mat, jag);
      this.wall(f, 'x', -W / 2, W / 2, -D / 2 + T / 2, T, y, FH, back, mat, jag);
      this.wall(f, 'z', -D / 2 + T, D / 2 - T, -W / 2 + T / 2, T, y, FH, left, mat, jag);
      this.wall(f, 'z', -D / 2 + T, D / 2 - T, W / 2 - T / 2, T, y, FH, right, mat, jag);

      // loot inside this floor
      const lx0 = (floors > 1 ? sx1 + 0.6 : -W / 2 + T + 0.6), lx1 = W / 2 - T - 0.6;
      const nLoot = o.loot ?? 1;
      for (let k = 0; k < nLoot; k++) {
        const p = f.pt(lx0 + rng() * (lx1 - lx0), y + 0.02, -D / 2 + T + 0.7 + rng() * (D - 2 * T - 1.4));
        this.lootSpots.push(p);
      }
      if (!top) {
        const sy = y + FH;
        const ix0 = -W / 2 + T, ix1 = W / 2 - T, iz0 = -D / 2 + T, iz1 = D / 2 - T;
        f.box(sx1 + 0.1, sy - 0.25, iz0, ix1, sy, iz1, 'concreteDark');
        f.box(ix0, sy - 0.25, sz0 + run, sx1 + 0.1, sy, iz1, 'concreteDark');
        if (sz0 - 0.1 > iz0 + 0.05) f.box(ix0, sy - 0.25, iz0, sx1 + 0.1, sy, sz0 - 0.1, 'concreteDark');
        if (fl === 0) {
          for (let i = 0; i < 12; i++) {
            f.box(sx0, y, sz0 + i * 0.3, sx1, y + ((i + 1) * FH) / 12, sz0 + (i + 1) * 0.3, 'concreteDark');
          }
        }
      } else if (!ruin && o.roof !== false) {
        const ry = y + FH;
        // parapet band around the roof edge
        for (const [x0, z0, x1, z1] of [[-W / 2 - 0.12, D / 2 - 0.05, W / 2 + 0.12, D / 2 + 0.12], [-W / 2 - 0.12, -D / 2 - 0.12, W / 2 + 0.12, -D / 2 + 0.05],
          [-W / 2 - 0.12, -D / 2, -W / 2 + 0.05, D / 2], [W / 2 - 0.05, -D / 2, W / 2 + 0.12, D / 2]]) {
          f.box(x0, ry + 0.25, z0, x1, ry + 0.55, z1, mat === 'wood' ? 'wood' : 'concreteDark', { collide: false });
        }
        if (o.roofBroken) {
          f.box(-W / 2 - 0.1, ry, -D / 2 - 0.1, W * 0.1, ry + 0.25, D / 2 + 0.1, 'concreteDark');
          f.box(W * 0.1, ry, -D / 2 - 0.1, W / 2 + 0.1, ry + 0.25, -D * 0.1, 'concreteDark');
        } else {
          f.box(-W / 2 - 0.15, ry, -D / 2 - 0.15, W / 2 + 0.15, ry + 0.25, D / 2 + 0.15, 'concreteDark');
        }
      }
    }
    function hasStairsSide(fl) { return fl > 1; }
    // plinth along the base and rubble around ruins
    if (mat !== 'wood') {
      for (const [x0, z0, x1, z1] of [[-W / 2 - 0.04, D / 2 - 0.1, W / 2 + 0.04, D / 2 + 0.04], [-W / 2 - 0.04, -D / 2 - 0.04, W / 2 + 0.04, -D / 2 + 0.1],
        [-W / 2 - 0.04, -D / 2, -W / 2 + 0.1, D / 2], [W / 2 - 0.1, -D / 2, W / 2 + 0.04, D / 2]]) {
        f.box(x0, base, z0, x1, base + 0.4, z1, 'concreteDark', { collide: false });
      }
    }
    if (floors > 1 || o.roofBroken) {
      const n = 4 + Math.floor(rng() * 5);
      for (let k = 0; k < n; k++) {
        const side = Math.floor(rng() * 4);
        const along = (rng() - 0.5);
        const lx = side < 2 ? along * W : (side === 2 ? -1 : 1) * (W / 2 + 0.4 + rng() * 0.8);
        const lz = side >= 2 ? along * D : (side === 0 ? -1 : 1) * (D / 2 + 0.4 + rng() * 0.8);
        const p = f.pt(lx, 0, lz);
        this.inst.rubble.push({ x: p.x, y: this.heightAt(p.x, p.z) - 0.05, z: p.z, s: 0.18 + rng() * 0.35, ry: rng() * 6.28, v: Math.floor(rng() * 3) });
      }
    }
    return f;
  }

  container(x, z, rot, color, o = {}) {
    const L = 6.06, Wd = 2.44, H = 2.59;
    const y = o.y ?? this.groundUnder(x, z, rot % 2 ? Wd : L, rot % 2 ? L : Wd) - 0.05;
    const f = this.frame(x, y, z, rot);
    const mat = 'cont' + color;
    if (o.open) {
      f.box(-L / 2, 0, -Wd / 2, L / 2, 0.12, Wd / 2, mat);
      f.box(-L / 2, H - 0.12, -Wd / 2, L / 2, H, Wd / 2, mat);
      f.box(-L / 2, 0, -Wd / 2, L / 2, H, -Wd / 2 + 0.07, mat);
      f.box(-L / 2, 0, Wd / 2 - 0.07, L / 2, H, Wd / 2, mat);
      f.box(-L / 2, 0, -Wd / 2, -L / 2 + 0.07, H, Wd / 2, mat);
      this.lootSpots.push(f.pt(-1, 0.14, 0));
    } else {
      f.box(-L / 2, 0, -Wd / 2, L / 2, H, Wd / 2, mat);
    }
    return y + H;
  }

  stack(x, z, rot, colors, o = {}) {
    let y = undefined;
    for (let i = 0; i < colors.length; i++) {
      y = this.container(x, z, rot, colors[i], { ...o, y, open: i === 0 && o.open });
    }
    return y;
  }

  barrier(x, z, rot, y) {
    const f = this.frame(x, y ?? this.groundUnder(x, z, 3, 0.6) - 0.05, z, rot);
    f.box(-1.5, 0, -0.3, 1.5, 1.05, 0.3, 'concrete');
  }

  lowWall(x, z, rot, len, h, mat = 'concrete', y) {
    const f = this.frame(x, y ?? this.groundUnder(x, z, len, 0.4) - 0.1, z, rot);
    f.box(-len / 2, 0, -0.2, len / 2, h + 0.1, 0.2, mat);
  }

  car(x, z, rot, paint) {
    const y = this.groundUnder(x, z, 4.2, 1.8);
    const f = this.frame(x, y, z, rot);
    const mat = paint || 'paintSteel';
    f.box(-2.1, 0.32, -0.88, 2.1, 1.1, 0.88, mat);
    f.box(-1.05, 1.1, -0.8, 1.15, 1.7, 0.8, mat);
    this.props.push({ kind: 'carGlass', x, y, z, yaw: f.yaw });
    for (const [lx, lz] of [[-1.35, -0.85], [1.35, -0.85], [-1.35, 0.85], [1.35, 0.85]]) {
      const p = f.pt(lx, 0.36, lz);
      this.props.push({ kind: 'wheel', x: p.x, y: p.y, z: p.z, yaw: f.yaw });
    }
  }

  pipe(x0, z0, x1, z1, r, y) {
    y = y ?? Math.min(this.heightAt(x0, z0), this.heightAt(x1, z1)) + r - 0.15;
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    if (alongX) this.addBox(Math.min(x0, x1), y - r, z0 - r, Math.max(x0, x1), y + r * 0.9, z0 + r, 'paintSteel', { visible: false });
    else this.addBox(x0 - r, y - r, Math.min(z0, z1), x0 + r, y + r * 0.9, Math.max(z0, z1), 'paintSteel', { visible: false });
    this.props.push({ kind: 'pipe', x0, z0, x1: alongX ? x1 : x0, z1: alongX ? z0 : z1, r, y });
  }

  tank(x, z, r, h, style = 'tank') {
    const y = this.groundUnder(x, z, r * 2, r * 2) - 0.1;
    const s = r * 0.78;
    this.addBox(x - s, y, z - s, x + s, y + h, z + s, 'paintWhite', { visible: false });
    this.props.push({ kind: style, x, y, z, r, h });
  }

  barrel(x, z, y) {
    y = y ?? this.heightAt(x, z) - 0.02;
    this.inst.barrel.push({ x, y, z, ry: this.rng() * 6.28, c: Math.floor(this.rng() * 3) });
    this.addBox(x - 0.3, y, z - 0.3, x + 0.3, y + 0.92, z + 0.3, 'paintRed', { visible: false });
  }

  barrels(x, z, n, y) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + this.rng(), r = i === 0 ? 0 : 0.68;
      this.barrel(x + Math.cos(a) * r, z + Math.sin(a) * r, y);
    }
  }

  vent(x, z, power) {
    const y = this.heightAt(x, z);
    this.vents.push({ x, y, z, power });
    this.props.push({ kind: 'vent', x, y, z });
  }

  rock(x, z, s) {
    const y = this.heightAt(x, z) - s * 0.3;
    this.inst.rock.push({ x, y, z, s, ry: this.rng() * Math.PI * 2, v: Math.floor(this.rng() * 3) });
    const e = s * 0.6;
    this.addBox(x - e, y - 0.5, z - e, x + e, y + s * 0.62, z + e, 'rock', { visible: false });
  }

  pine(x, z, s) {
    const y = this.heightAt(x, z) - 0.2;
    this.inst.pine.push({ x, y, z, s, ry: this.rng() * Math.PI * 2 });
    this.addBox(x - 0.25 * s, y, z - 0.25 * s, x + 0.25 * s, y + 5 * s, z + 0.25 * s, 'bark', { visible: false });
  }

  deadTree(x, z, s) {
    const y = this.heightAt(x, z) - 0.2;
    this.inst.dead.push({ x, y, z, s, ry: this.rng() * Math.PI * 2 });
    this.addBox(x - 0.2 * s, y, z - 0.2 * s, x + 0.2 * s, y + 4 * s, z + 0.2 * s, 'bark', { visible: false });
  }

  footprintFree(x, z, r) {
    for (const b of this.boxes) {
      if (b.x1 > x - r && b.x0 < x + r && b.z1 > z - r && b.z0 < z + r) return false;
    }
    for (const p of this.pads) if (this.padWeight(p, x, z) > 0.15) return false;
    return true;
  }

  /* ---------- collision ---------- */

  finalizeBoxes() {
    this.gcell = 8;
    this.gn = Math.ceil(this.size / this.gcell) + 1;
    const gn = this.gn;
    this.grid = new Array(gn * gn);
    for (let i = 0; i < gn * gn; i++) this.grid[i] = [];
    for (const b of this.boxes) {
      if (!b.collide) continue;
      const i0 = clamp(Math.floor((b.x0 + this.half) / this.gcell), 0, gn - 1);
      const i1 = clamp(Math.floor((b.x1 + this.half) / this.gcell), 0, gn - 1);
      const j0 = clamp(Math.floor((b.z0 + this.half) / this.gcell), 0, gn - 1);
      const j1 = clamp(Math.floor((b.z1 + this.half) / this.gcell), 0, gn - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * gn + i].push(b.id);
    }
    this.stamp = new Uint32Array(this.boxes.length);
    this.stampId = 0;
  }

  queryBoxes(x0, y0, z0, x1, y1, z1, out) {
    out.length = 0;
    const gn = this.gn, g = this.gcell, h = this.half;
    const i0 = clamp(Math.floor((x0 + h) / g), 0, gn - 1), i1 = clamp(Math.floor((x1 + h) / g), 0, gn - 1);
    const j0 = clamp(Math.floor((z0 + h) / g), 0, gn - 1), j1 = clamp(Math.floor((z1 + h) / g), 0, gn - 1);
    const s = ++this.stampId;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.grid[j * gn + i];
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          if (this.stamp[id] === s) continue;
          this.stamp[id] = s;
          const b = this.boxes[id];
          if (b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1 && b.z1 > z0 && b.z0 < z1) out.push(b);
        }
      }
    }
    return out;
  }

  // Highest walkable surface (terrain or box top) under a footprint, at or below maxY.
  groundBelow(x, z, r, maxY) {
    let g = this.heightAt(x, z);
    const out = this._gb || (this._gb = []);
    this.queryBoxes(x - r, g - 0.1, z - r, x + r, maxY, z + r, out);
    for (const b of out) if (b.y1 <= maxY + 0.001 && b.y1 > g) g = b.y1;
    return g;
  }

  // Raycast against structures and terrain. Returns distance or Infinity; fills hit.
  raycast(ox, oy, oz, dx, dy, dz, maxDist, hit) {
    let best = maxDist, bBox = null, bnx = 0, bny = 0, bnz = 0;
    const g = this.gcell, half = this.half, gn = this.gn;
    let cx = Math.floor((ox + half) / g), cz = Math.floor((oz + half) / g);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDX = dx !== 0 ? Math.abs(g / dx) : Infinity, tDZ = dz !== 0 ? Math.abs(g / dz) : Infinity;
    let tMX = dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * g - half - ox) / dx : Infinity;
    let tMZ = dz !== 0 ? ((cz + (stepZ > 0 ? 1 : 0)) * g - half - oz) / dz : Infinity;
    const s = ++this.stampId;
    let t = 0;
    for (let guard = 0; guard < 400; guard++) {
      if (cx >= 0 && cz >= 0 && cx < gn && cz < gn) {
        const list = this.grid[cz * gn + cx];
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          if (this.stamp[id] === s) continue;
          this.stamp[id] = s;
          const b = this.boxes[id];
          let tmin = 0, tmax = best, ax = -1, sg = 0;
          if (Math.abs(dx) < 1e-9) { if (ox < b.x0 || ox > b.x1) continue; } else {
            let t1 = (b.x0 - ox) / dx, t2 = (b.x1 - ox) / dx, sn = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sn = 1; }
            if (t1 > tmin) { tmin = t1; ax = 0; sg = sn; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) continue;
          }
          if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.y1) continue; } else {
            let t1 = (b.y0 - oy) / dy, t2 = (b.y1 - oy) / dy, sn = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sn = 1; }
            if (t1 > tmin) { tmin = t1; ax = 1; sg = sn; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) continue;
          }
          if (Math.abs(dz) < 1e-9) { if (oz < b.z0 || oz > b.z1) continue; } else {
            let t1 = (b.z0 - oz) / dz, t2 = (b.z1 - oz) / dz, sn = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sn = 1; }
            if (t1 > tmin) { tmin = t1; ax = 2; sg = sn; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) continue;
          }
          if (ax >= 0 && tmin < best) {
            best = tmin; bBox = b;
            bnx = ax === 0 ? sg : 0; bny = ax === 1 ? sg : 0; bnz = ax === 2 ? sg : 0;
          }
        }
      }
      let tn;
      if (tMX < tMZ) { tn = tMX; tMX += tDX; cx += stepX; } else { tn = tMZ; tMZ += tDZ; cz += stepZ; }
      t = tn;
      if (t > best || t > maxDist) break;
      if ((cx < 0 && stepX < 0) || (cz < 0 && stepZ < 0) || (cx >= gn && stepX > 0) || (cz >= gn && stepZ > 0)) break;
    }
    const tt = this.rayTerrain(ox, oy, oz, dx, dy, dz, best);
    if (tt < best) {
      if (hit) {
        hit.t = tt; hit.x = ox + dx * tt; hit.y = oy + dy * tt; hit.z = oz + dz * tt;
        this.normalAt(hit.x, hit.z, hit.n || (hit.n = { x: 0, y: 1, z: 0 }));
        hit.type = 'terrain'; hit.box = null;
      }
      return tt;
    }
    if (bBox) {
      if (hit) {
        hit.t = best; hit.x = ox + dx * best; hit.y = oy + dy * best; hit.z = oz + dz * best;
        const n = hit.n || (hit.n = { x: 0, y: 1, z: 0 });
        n.x = bnx; n.y = bny; n.z = bnz;
        hit.type = 'box'; hit.box = bBox;
      }
      return best;
    }
    return Infinity;
  }

  rayTerrain(ox, oy, oz, dx, dy, dz, maxDist) {
    let h = this.heightAt(ox, oz);
    let above = oy - h;
    if (above < 0) return 0;
    let t = 0, prev = 0;
    while (t < maxDist) {
      const step = clamp(above * 0.45, 0.2, 3.0);
      prev = t;
      t = Math.min(t + step, maxDist);
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (dy > 0 && y > this.maxH + 1) return Infinity;
      if (Math.abs(x) > this.half || Math.abs(z) > this.half) return Infinity;
      h = this.heightAt(x, z);
      above = y - h;
      if (above < 0) {
        let a = prev, b = t;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - this.heightAt(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
        }
        return b;
      }
      if (t >= maxDist) break;
    }
    return Infinity;
  }

  /* ---------- navigation ---------- */

  buildNav(res) {
    const B = Math.max(this.bx, this.bz);
    const n = Math.ceil((2 * B) / res);
    const nav = { res, n, B, h: new Float32Array(n * n), blocked: new Uint8Array(n * n) };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -B + (i + 0.5) * res, z = -B + (j + 0.5) * res;
        const k = j * n + i;
        nav.h[k] = this.heightAt(x, z);
        if (Math.abs(x) > this.bx - 0.8 || Math.abs(z) > this.bz - 0.8) nav.blocked[k] = 1;
      }
    }
    const r = 0.25;
    for (const b of this.boxes) {
      if (!b.collide) continue;
      const i0 = Math.max(0, Math.ceil((b.x0 - r + B) / res - 0.5));
      const i1 = Math.min(n - 1, Math.floor((b.x1 + r + B) / res - 0.5));
      const j0 = Math.max(0, Math.ceil((b.z0 - r + B) / res - 0.5));
      const j1 = Math.min(n - 1, Math.floor((b.z1 + r + B) / res - 0.5));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          const g = nav.h[k];
          if (b.y0 < g + 1.75 && b.y1 > g + 0.45) nav.blocked[k] = 1;
        }
      }
    }
    this.nav = nav;
    this.navG = new Float32Array(n * n);
    this.navP = new Int32Array(n * n);
    this.navSeen = new Uint32Array(n * n);
    this.navClosed = new Uint32Array(n * n);
    this.navStamp = 0;
    // high ground list
    const cells = [];
    for (let k = 0; k < n * n; k++) if (!nav.blocked[k]) cells.push(k);
    cells.sort((a, b) => nav.h[b] - nav.h[a]);
    this.highCells = cells.slice(0, 400);
    this.freeCells = cells;
  }

  navCell(x, z) {
    const nav = this.nav;
    const i = Math.floor((x + nav.B) / nav.res), j = Math.floor((z + nav.B) / nav.res);
    if (i < 0 || j < 0 || i >= nav.n || j >= nav.n) return -1;
    return j * nav.n + i;
  }

  cellPos(k, out = {}) {
    const nav = this.nav;
    const i = k % nav.n, j = (k / nav.n) | 0;
    out.x = -nav.B + (i + 0.5) * nav.res;
    out.z = -nav.B + (j + 0.5) * nav.res;
    out.y = nav.h[k];
    return out;
  }

  nearestFree(k, radius) {
    const nav = this.nav, n = nav.n;
    if (k >= 0 && !nav.blocked[k]) return k;
    const ci = k % n, cj = (k / n) | 0;
    for (let r = 1; r <= radius; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const kk = j * n + i;
          if (!nav.blocked[kk]) return kk;
        }
      }
    }
    return -1;
  }

  findPath(sx, sz, tx, tz, water, avoid, maxIter = 6000) {
    const nav = this.nav, n = nav.n, res = nav.res;
    let s = this.nearestFree(this.navCell(clamp(sx, -nav.B + 0.1, nav.B - 0.1), clamp(sz, -nav.B + 0.1, nav.B - 0.1)), 4);
    let t = this.nearestFree(this.navCell(clamp(tx, -nav.B + 0.1, nav.B - 0.1), clamp(tz, -nav.B + 0.1, nav.B - 0.1)), 8);
    if (s < 0 || t < 0) return null;
    const stamp = ++this.navStamp;
    const G = this.navG, P = this.navP, seen = this.navSeen, closed = this.navClosed, H = nav.h, blk = nav.blocked;
    const ti = t % n, tj = (t / n) | 0;
    const heur = (k) => {
      const di = Math.abs((k % n) - ti), dj = Math.abs(((k / n) | 0) - tj);
      return (di + dj + (1.4142 - 2) * Math.min(di, dj)) * res;
    };
    const heap = [];
    const push = (k, f) => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp; i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp; i = m;
        }
      }
      return top;
    };
    G[s] = 0; P[s] = -1; seen[s] = stamp;
    push(s, heur(s));
    let bestK = s, bestH = heur(s), iter = 0, found = false;
    const maxStep = res * 1.4 + 0.3;
    const costMul = (k) => {
      const h = H[k];
      if (h < water + 0.4) return 8;
      if (h < avoid) return 2.2;
      return 1;
    };
    while (heap.length && iter < maxIter) {
      const [, k] = pop();
      if (closed[k] === stamp) continue;
      closed[k] = stamp;
      iter++;
      if (k === t) { found = true; break; }
      const hk = heur(k);
      if (hk < bestH) { bestH = hk; bestK = k; }
      const ci = k % n, cj = (k / n) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const kk = j * n + i;
          if (blk[kk] || closed[kk] === stamp) continue;
          if (di && dj && (blk[cj * n + i] || blk[j * n + ci])) continue;
          if (Math.abs(H[kk] - H[k]) > maxStep) continue;
          const g = G[k] + (di && dj ? 1.4142 : 1) * res * costMul(kk);
          if (seen[kk] !== stamp || g < G[kk]) {
            seen[kk] = stamp;
            G[kk] = g;
            P[kk] = k;
            push(kk, g + heur(kk));
          }
        }
      }
    }
    let end = found ? t : bestK;
    const cells = [];
    for (let k = end, guard = 0; k !== -1 && guard < 20000; k = P[k], guard++) {
      cells.push(k);
      if (k === s) break;
    }
    cells.reverse();
    // string pulling
    const pts = cells.map((k) => this.cellPos(k));
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 14);
      while (j > i + 1 && !this.navLine(pts[i], pts[j], water)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  navLine(a, b, water) {
    const nav = this.nav;
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    const steps = Math.ceil(L / (nav.res * 0.5));
    let ph = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const k = this.navCell(a.x + dx * t, a.z + dz * t);
      if (k < 0 || nav.blocked[k]) return false;
      const h = nav.h[k];
      if (Math.abs(h - ph) > nav.res + 0.3) return false;
      if (h < water + 0.4 && a.y >= water + 0.4) return false;
      ph = h;
    }
    return true;
  }

  // Random free cell with height >= minH, preferring ones near (x,z).
  findHighGround(x, z, minH, rng, samples = 80, spread = 1) {
    const cells = this.freeCells;
    let best = -1, bestScore = Infinity;
    for (let s = 0; s < samples; s++) {
      const k = cells[Math.floor(rng() * cells.length)];
      const h = this.nav.h[k];
      if (h < minH) continue;
      const p = this.cellPos(k, this._cp || (this._cp = {}));
      const d = Math.hypot(p.x - x, p.z - z) * (0.7 + rng() * 0.6 * spread);
      if (d < bestScore) { bestScore = d; best = k; }
    }
    if (best < 0) {
      best = this.highCells[Math.floor(rng() * Math.min(this.highCells.length, 120))];
    }
    return this.cellPos(best);
  }
}
