/* ==========================================================================
   Point-cloud sculptures.
   Every form on the site is the same set of points rearranged, so each
   generator returns exactly `n` xyz triples inside roughly a unit sphere.
   ========================================================================== */
(function () {
  'use strict';
  var AV = (window.AV = window.AV || {});
  var TAU = Math.PI * 2;

  // Small deterministic PRNG so the sculptures look identical on every visit.
  function rng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function len(a) { return Math.hypot(a[0], a[1], a[2]); }
  function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function basis(dir) {
    var d = norm(dir);
    var up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = norm(cross(up, d));
    var v = cross(d, u);
    return { d: d, u: u, v: v };
  }

  /* A Builder collects weighted samplers (edges, rings, clusters...) and then
     spends the point budget across them in proportion to their weight. */
  function Builder(seed) {
    this.items = [];
    this.total = 0;
    this.rand = rng(seed);
  }
  Builder.prototype.add = function (weight, fn) {
    if (weight > 0) { this.items.push({ w: weight, fn: fn }); this.total += weight; }
    return this;
  };
  Builder.prototype.seg = function (a, b, density, jitter) {
    var j = jitter == null ? 0.004 : jitter;
    var d = sub(b, a);
    return this.add(len(d) * (density || 1), function (u, r) {
      return [
        a[0] + d[0] * u + (r() - 0.5) * j,
        a[1] + d[1] * u + (r() - 0.5) * j,
        a[2] + d[2] * u + (r() - 0.5) * j
      ];
    });
  };
  Builder.prototype.loop = function (pts, density, jitter) {
    for (var i = 0; i < pts.length; i++) this.seg(pts[i], pts[(i + 1) % pts.length], density, jitter);
    return this;
  };
  Builder.prototype.ring = function (c, radius, normal, density, jitter) {
    var b = basis(normal);
    var j = jitter == null ? 0.004 : jitter;
    return this.add(TAU * radius * (density || 1), function (u, r) {
      var a = u * TAU;
      var x = Math.cos(a) * radius, y = Math.sin(a) * radius;
      return [
        c[0] + b.u[0] * x + b.v[0] * y + (r() - 0.5) * j,
        c[1] + b.u[1] * x + b.v[1] * y + (r() - 0.5) * j,
        c[2] + b.u[2] * x + b.v[2] * y + (r() - 0.5) * j
      ];
    });
  };
  Builder.prototype.ball = function (c, radius, weight) {
    return this.add(weight, function (u, r) {
      var a = r() * TAU, z = r() * 2 - 1, s = Math.sqrt(1 - z * z);
      var rad = radius * Math.cbrt(r());
      return [c[0] + Math.cos(a) * s * rad, c[1] + z * rad, c[2] + Math.sin(a) * s * rad];
    });
  };
  Builder.prototype.quad = function (a, b, d, weight) {
    var e1 = sub(b, a), e2 = sub(d, a);
    return this.add(weight, function (u, r) {
      var s = r(), t = r();
      return [a[0] + e1[0] * s + e2[0] * t, a[1] + e1[1] * s + e2[1] * t, a[2] + e1[2] * s + e2[2] * t];
    });
  };
  Builder.prototype.curve = function (fn, approxLen, density) {
    return this.add(approxLen * (density || 1), function (u, r) { return fn(u, r); });
  };
  Builder.prototype.build = function (n) {
    var out = new Float32Array(n * 3);
    var items = this.items, total = this.total, rand = this.rand;
    var keys = new Float32Array(n), order = new Array(n);
    var idx = 0, acc = items.length ? items[0].w : 0, i, p;
    for (i = 0; i < n; i++) {
      // Stratified pick: walk the cumulative weights once so every sampler
      // receives its fair share of points.
      var target = ((i + rand()) / n) * total;
      while (target > acc && idx < items.length - 1) { idx++; acc += items[idx].w; }
      p = items[idx].fn(rand(), rand);
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
    // Shuffle with a bias toward height. Points keep a loose vertical
    // correspondence between forms, which makes the morphs read as a flow
    // instead of a blender.
    for (i = 0; i < n; i++) { keys[i] = out[i * 3 + 1] + (rand() - 0.5) * 0.55; order[i] = i; }
    order.sort(function (a, b) { return keys[a] - keys[b]; });
    var sorted = new Float32Array(n * 3);
    for (i = 0; i < n; i++) {
      var o = order[i] * 3;
      sorted[i * 3] = out[o]; sorted[i * 3 + 1] = out[o + 1]; sorted[i * 3 + 2] = out[o + 2];
    }
    return sorted;
  };

  /* ----------------------------------------------------------------------
     Forms
     ---------------------------------------------------------------------- */

  // Hero: a cube inside a cube, every corner joined. The Roblox primitive,
  // drawn the way a modeller sees it: vertices first.
  function cube(n) {
    var b = new Builder(11);
    var h = 0.62, k = 0.27, i, s;
    function corners(e) {
      var c = [];
      for (var x = -1; x <= 1; x += 2) for (var y = -1; y <= 1; y += 2) for (var z = -1; z <= 1; z += 2) c.push([x * e, y * e, z * e]);
      return c;
    }
    function edges(c, density) {
      for (var a = 0; a < 8; a++) for (var q = a + 1; q < 8; q++) {
        var diff = 0;
        for (var m = 0; m < 3; m++) if (c[a][m] !== c[q][m]) diff++;
        if (diff === 1) b.seg(c[a], c[q], density);
      }
    }
    var outer = corners(h), inner = corners(k);
    edges(outer, 3.2);
    edges(inner, 1.7);
    for (i = 0; i < 8; i++) {
      b.seg(inner[i], outer[i], 0.9);
      b.ball(outer[i], 0.03, 0.34);
      b.ball(inner[i], 0.018, 0.12);
    }
    // Faint construction grid on each face.
    var t = h / 3;
    for (s = -1; s <= 1; s += 2) {
      [-t, t].forEach(function (g) {
        b.seg([-h, g, s * h], [h, g, s * h], 0.5); b.seg([g, -h, s * h], [g, h, s * h], 0.5);
        b.seg([s * h, g, -h], [s * h, g, h], 0.5); b.seg([s * h, -h, g], [s * h, h, g], 0.5);
        b.seg([-h, s * h, g], [h, s * h, g], 0.5); b.seg([g, s * h, -h], [g, s * h, h], 0.5);
      });
    }
    b.ball([0, 0, 0], 0.035, 0.25);
    return b.build(n);
  }

  // Premise: one vertex, a few orbits, the first edges leaving it.
  function vertex(n) {
    var b = new Builder(23);
    b.ball([0, 0, 0], 0.045, 2.2);
    b.ball([0, 0, 0], 0.17, 0.9);
    var orbits = [
      { r: 0.52, nrm: [0.25, 1, 0.1] },
      { r: 0.78, nrm: [-0.7, 1, 0.35] },
      { r: 1.04, nrm: [0.45, 1, -0.8] }
    ];
    orbits.forEach(function (o) { b.ring([0, 0, 0], o.r, o.nrm, 1.35, 0.005); });
    var rand = rng(5);
    for (var i = 0; i < 7; i++) {
      var o = orbits[i % 3], bs = basis(o.nrm), a = rand() * TAU;
      var end = add(mul(bs.u, Math.cos(a) * o.r), mul(bs.v, Math.sin(a) * o.r));
      b.seg([0, 0, 0], end, 0.55, 0.003);
      b.ball(end, 0.022, 0.16);
    }
    b.ball([0, 0, 0], 1.15, 0.5);
    return b.build(n);
  }

  // Crystal Depths: a cluster of hexagonal crystals growing out of rock.
  function crystal(n) {
    var b = new Builder(37);
    function shard(base, dir, radius, body, tip, density) {
      var bs = basis(dir), lo = [], hi = [], i;
      var apex = add(base, mul(bs.d, body + tip));
      for (i = 0; i < 6; i++) {
        var a = (i / 6) * TAU;
        var off = add(mul(bs.u, Math.cos(a) * radius), mul(bs.v, Math.sin(a) * radius));
        lo.push(add(base, off));
        hi.push(add(add(base, mul(off, 0.92)), mul(bs.d, body)));
      }
      for (i = 0; i < 6; i++) {
        var j = (i + 1) % 6;
        b.seg(lo[i], hi[i], density * 1.5);
        b.seg(hi[i], hi[j], density * 1.4);
        b.seg(hi[i], apex, density * 1.3);
        b.seg(lo[i], lo[j], density * 0.6);
        b.quad(lo[i], lo[j], hi[i], density * body * radius * 2.4);
      }
      b.ball(apex, 0.02, 0.1 * density);
    }
    var y = -0.82;
    shard([0, y, 0], [0.05, 1, 0.02], 0.2, 1.12, 0.42, 1.2);
    shard([-0.1, y, 0.05], [-0.58, 1, 0.16], 0.135, 0.66, 0.26, 1);
    shard([0.13, y, -0.04], [0.62, 1, -0.2], 0.155, 0.78, 0.3, 1);
    shard([0.02, y, 0.13], [0.16, 1, 0.74], 0.105, 0.48, 0.22, 0.9);
    shard([-0.04, y, -0.13], [-0.26, 1, -0.78], 0.115, 0.54, 0.22, 0.9);
    shard([0.2, y, 0.1], [1.05, 1, 0.5], 0.075, 0.34, 0.16, 0.8);
    shard([-0.2, y, -0.08], [-1.1, 1, -0.38], 0.07, 0.3, 0.15, 0.8);
    // Rock bed and a little dust in the air.
    b.add(1.5, function (u, r) {
      var a = r() * TAU, rad = Math.sqrt(r()) * 0.78;
      return [Math.cos(a) * rad, y - 0.02 + (r() - 0.5) * 0.05, Math.sin(a) * rad * 0.8];
    });
    b.ball([0, 0, 0], 1.05, 0.7);
    return b.build(n);
  }

  // Floor Ten: ten storeys, a helipad on the roof.
  function tower(n) {
    var b = new Builder(53);
    var w = 0.3, y0 = -1, floors = 10, fh = 0.186, top = y0 + floors * fh, i, f;
    var cs = [[-w, w], [w, w], [w, -w], [-w, -w]];
    for (i = 0; i < 4; i++) b.seg([cs[i][0], y0, cs[i][1]], [cs[i][0], top, cs[i][1]], 1.9);
    for (f = 0; f <= floors; f++) {
      var y = y0 + f * fh;
      b.loop(cs.map(function (c) { return [c[0], y, c[1]]; }), f === floors || f === 0 ? 2.2 : 1.25);
      if (f < floors) {
        for (i = 0; i < 4; i++) {
          var a = cs[i], c2 = cs[(i + 1) % 4];
          for (var t = 1; t <= 3; t++) {
            var px = a[0] + (c2[0] - a[0]) * (t / 4), pz = a[1] + (c2[1] - a[1]) * (t / 4);
            b.seg([px, y + fh * 0.28, pz], [px, y + fh * 0.72, pz], 0.5, 0.003);
          }
        }
      }
    }
    // Helipad: circle and an H.
    b.ring([0, top + 0.005, 0], 0.2, [0, 1, 0], 2);
    b.seg([-0.08, top + 0.005, -0.1], [-0.08, top + 0.005, 0.1], 1.6);
    b.seg([0.08, top + 0.005, -0.1], [0.08, top + 0.005, 0.1], 1.6);
    b.seg([-0.08, top + 0.005, 0], [0.08, top + 0.005, 0], 1.6);
    b.seg([w - 0.03, top, -w + 0.03], [w - 0.03, top + 0.24, -w + 0.03], 1.2);
    b.ball([w - 0.03, top + 0.25, -w + 0.03], 0.016, 0.08);
    // Street level.
    b.loop([[-0.62, y0, 0.62], [0.62, y0, 0.62], [0.62, y0, -0.62], [-0.62, y0, -0.62]], 0.5);
    b.add(0.9, function (u, r) { return [(r() - 0.5) * 1.5, y0 - 0.01, (r() - 0.5) * 1.5]; });
    b.ball([0, 0, 0], 1.1, 0.45);
    return b.build(n);
  }

  // CLAP TO SEE: sound spreading across a dark floor.
  function rings(n) {
    var b = new Builder(71);
    for (var k = 0; k < 10; k++) b.ring([0, 0, 0], 0.1 + k * 0.115, [0, 1, 0], 1, 0.005);
    b.ball([0, 0.02, 0], 0.04, 0.5);
    b.seg([0, 0, 0], [0, 0.34, 0], 0.35, 0.004);
    return b.build(n);
  }

  // Index: currents of wind.
  function wind(n) {
    var b = new Builder(89), rand = rng(17);
    for (var j = 0; j < 44; j++) {
      (function () {
        var y0 = (rand() - 0.5) * 1.5, z0 = (rand() - 0.5) * 1.2;
        var amp = 0.03 + rand() * 0.13, fr = 0.6 + rand() * 1.3, ph = rand();
        var start = rand() * 0.35, span = 0.55 + rand() * 0.45;
        b.curve(function (u) {
          var t = start + u * span * (1 - start);
          var e = Math.sin(Math.PI * u);
          return [
            -1.25 + 2.5 * t,
            y0 + amp * Math.sin(TAU * (fr * t + ph)) * (0.4 + e),
            z0 + amp * Math.cos(TAU * (fr * t + ph)) * (0.4 + e)
          ];
        }, 2.5 * span, 1);
      })();
    }
    // Two eddies where the current folds back on itself.
    [[-0.45, 0.28, 0.1, 0.3], [0.5, -0.3, -0.15, 0.24]].forEach(function (c) {
      b.curve(function (u) {
        var a = u * TAU * 2.6, rad = c[3] * (1 - u * 0.82);
        return [c[0] + Math.cos(a) * rad + u * 0.3, c[1] + Math.sin(a) * rad, c[2] + u * 0.1];
      }, 3, 1.1);
    });
    return b.build(n);
  }

  // Craft: an icosahedron with its geodesic struts.
  function icosa(n) {
    var b = new Builder(101);
    var g = (1 + Math.sqrt(5)) / 2, R = 0.96, i, j;
    var raw = [
      [-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0],
      [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g],
      [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]
    ].map(function (v) { return mul(norm(v), R); });
    var edgeLen = len(sub(raw[0], raw[1])) * 1.01;
    var faces = [];
    for (i = 0; i < 12; i++) for (j = i + 1; j < 12; j++) {
      if (len(sub(raw[i], raw[j])) <= edgeLen) {
        b.seg(raw[i], raw[j], 2.3);
        b.seg(mul(raw[i], 0.46), mul(raw[j], 0.46), 1.1);
        for (var k = j + 1; k < 12; k++) {
          if (len(sub(raw[i], raw[k])) <= edgeLen && len(sub(raw[j], raw[k])) <= edgeLen) faces.push([i, j, k]);
        }
      }
    }
    faces.forEach(function (f) {
      var m = [0, 1, 2].map(function (q) {
        return mul(norm(add(raw[f[q]], raw[f[(q + 1) % 3]])), R);
      });
      b.seg(m[0], m[1], 0.65); b.seg(m[1], m[2], 0.65); b.seg(m[2], m[0], 0.65);
    });
    for (i = 0; i < 12; i++) { b.ball(raw[i], 0.03, 0.3); b.seg(mul(raw[i], 0.46), raw[i], 0.45); }
    return b.build(n);
  }

  // About: a small world.
  function sphere(n) {
    var b = new Builder(131), R = 0.92, i;
    for (i = 1; i < 10; i++) {
      var lat = -Math.PI / 2 + (i / 10) * Math.PI;
      b.ring([0, Math.sin(lat) * R, 0], Math.cos(lat) * R, [0, 1, 0], 0.95);
    }
    for (i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI;
      b.ring([0, 0, 0], R, [Math.cos(a), 0, Math.sin(a)], 0.7);
    }
    b.add(5, function (u, r) {
      var a2 = r() * TAU, z = r() * 2 - 1, s = Math.sqrt(1 - z * z);
      return [Math.cos(a2) * s * R, z * R, Math.sin(a2) * s * R];
    });
    b.ring([0, 0, 0], 1.18, [0.35, 1, 0.2], 0.55, 0.01);
    return b.build(n);
  }

  // Contact: an eclipse. One thin bright ring and its corona, facing you.
  function halo(n) {
    var b = new Builder(151), R = 0.8;
    b.ring([0, 0, 0], R, [0, 0, 1], 3.2, 0.006);
    b.ring([0, 0, 0], R * 0.965, [0, 0, 1], 0.9, 0.01);
    b.add(13, function (u, r) {
      var a = r() * TAU;
      var fall = -Math.log(1 - r() * 0.985) * 0.11;
      var rad = R + fall * (0.6 + 0.4 * Math.sin(a * 3 + 1.3) * Math.sin(a * 5));
      return [Math.cos(a) * rad, Math.sin(a) * rad, (r() - 0.5) * 0.05];
    });
    b.add(1.6, function (u, r) {
      var a = r() * TAU, rad = R * Math.sqrt(r()) * 0.9;
      return [Math.cos(a) * rad, Math.sin(a) * rad, (r() - 0.5) * 0.6];
    });
    return b.build(n);
  }

  AV.shapes = {
    cube: cube, vertex: vertex, crystal: crystal, tower: tower, rings: rings,
    wind: wind, icosa: icosa, sphere: sphere, halo: halo
  };

  // How each form likes to be presented. Sections can override any of these.
  AV.shapeDefaults = {
    cube:    { tilt: 0.5,  spin: 1,    sway: 0 },
    vertex:  { tilt: 0.38, spin: 0.8,  sway: 0 },
    crystal: { tilt: 0.14, spin: 0.7,  sway: 0 },
    tower:   { tilt: 0.16, spin: 0.5,  sway: 0 },
    rings:   { tilt: 0.42, spin: 0.25, sway: 0, wave: 1 },
    wind:    { tilt: 0.12, spin: 0,    sway: 0.28 },
    icosa:   { tilt: 0.3,  spin: 0.9,  sway: 0 },
    sphere:  { tilt: 0.34, spin: 0.6,  sway: 0 },
    halo:    { tilt: 0,    spin: 0,    sway: 0.1 }
  };
})();
