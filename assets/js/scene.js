/* ==========================================================================
   WebGL renderer for the vertex sculpture.
   One draw call: every point carries two positions (the form it is leaving
   and the form it is becoming) and the vertex shader blends between them.
   ========================================================================== */
(function () {
  'use strict';
  var AV = (window.AV = window.AV || {});

  var VERT = [
    'precision highp float;',
    'attribute vec3 aA;',
    'attribute vec3 aB;',
    'attribute vec4 aSeed;',
    'uniform mat4 uMV;',
    'uniform mat4 uP;',
    'uniform float uMix;',
    'uniform float uTime;',
    'uniform float uAssemble;',
    'uniform float uScatter;',
    'uniform float uWave;',
    'uniform float uPx;',
    'uniform float uAspect;',
    'uniform float uBright;',
    'uniform float uDark;',
    'uniform float uDepth;',
    'uniform vec2 uOffset;',
    'uniform vec3 uPointer;',
    'uniform vec3 uPulse[3];',
    'varying float vAlpha;',
    'varying float vTone;',
    'varying float vGlow;',
    'void main() {',
    // Each point leaves on its own schedule, so a morph sweeps through the form.
    '  float t = clamp(uMix * 1.6 - aSeed.x * 0.6, 0.0, 1.0);',
    '  t = t * t * t * (t * (6.0 * t - 15.0) + 10.0);',
    '  vec3 p = mix(aA, aB, t);',
    '  float arc = sin(3.14159265 * t);',
    '  vec3 drift = vec3(sin(aSeed.y * 40.0 + uTime * 0.6), cos(aSeed.z * 37.0 + uTime * 0.5), sin(aSeed.w * 51.0 - uTime * 0.7));',
    '  p += drift * arc * uScatter * (0.2 + aSeed.y * 0.45);',
    '  float sw = arc * 1.25 * (aSeed.z - 0.35) * uScatter * 2.4;',
    '  float cs = cos(sw); float sn = sin(sw);',
    '  p.xz = mat2(cs, -sn, sn, cs) * p.xz;',
    // Idle shimmer.
    '  p += 0.0055 * vec3(sin(uTime * 0.9 + aSeed.x * 60.0), cos(uTime * 0.8 + aSeed.y * 60.0), sin(uTime * 0.7 + aSeed.z * 60.0));',
    // Travelling ripple (used by the sound rings).
    '  float rr = length(p.xz);',
    '  p.y += uWave * 0.05 * sin(rr * 14.0 - uTime * 2.6) * smoothstep(0.0, 0.25, rr);',
    // Intro: points fly in from a wide shell.
    '  vec3 shell = normalize(aSeed.xyz - 0.5 + 0.001) * (2.4 + aSeed.w * 3.4);',
    '  float gather = clamp(uAssemble * 1.7 - aSeed.w * 0.7, 0.0, 1.0);',
    '  gather = 1.0 - pow(1.0 - gather, 4.0);',
    '  p = mix(shell, p, gather);',
    '  vec4 mv = uMV * vec4(p, 1.0);',
    '  vec4 clip = uP * mv;',
    '  vec2 ndc = clip.xy / clip.w + uOffset;',
    // The pointer parts the cloud.
    '  vec2 d = ndc - uPointer.xy;',
    '  d.x *= uAspect;',
    '  float dl = length(d);',
    '  float push = exp(-dl * dl * 16.0) * uPointer.z;',
    '  ndc += (d / max(dl, 0.0001)) * push * 0.075 * vec2(1.0 / uAspect, 1.0);',
    // Shockwaves from clicks: a moving front that shoves and lights the points.
    '  float glow = 0.0;',
    '  for (int i = 0; i < 3; i++) {',
    '    float age = uPulse[i].z;',
    '    if (age >= 0.0) {',
    '      vec2 q = ndc - uPulse[i].xy;',
    '      q.x *= uAspect;',
    '      float ql = length(q);',
    '      float front = age * 1.35;',
    '      float fade = exp(-age * 0.9);',
    '      float band = exp(-pow((ql - front) * 5.5, 2.0));',
    '      ndc += (q / max(ql, 0.0001)) * band * fade * 0.05 * vec2(1.0 / uAspect, 1.0);',
    '      float wake = step(ql, front) * exp(-(front - ql) * 1.6);',
    '      glow += (band * 1.5 + wake * 0.85) * fade;',
    '    }',
    '  }',
    '  gl_Position = vec4(ndc * clip.w, clip.z, clip.w);',
    '  float depth = smoothstep(uDepth - 1.3, uDepth + 1.3, -mv.z);',
    '  float big = step(0.985, aSeed.x);',
    '  float size = (0.75 + aSeed.w * 1.7) * (1.0 + big * 2.6);',
    '  gl_PointSize = size * uPx / -mv.z * (1.0 + glow * 0.32) * mix(1.25, 0.8, depth);',
    '  float twinkle = 0.78 + 0.22 * sin(uTime * (1.2 + aSeed.z * 2.0) + aSeed.y * 100.0);',
    '  float base = mix(1.0, 0.22, depth) * uBright * (1.0 - uDark) * twinkle * (1.0 + big * 0.8);',
    '  vAlpha = (base + glow * (0.3 + uDark * 0.55) * uBright) * gather;',
    '  vTone = aSeed.z;',
    '  vGlow = glow;',
    '}'
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec3 uColA;',
    'uniform vec3 uColB;',
    'varying float vAlpha;',
    'varying float vTone;',
    'varying float vGlow;',
    'void main() {',
    '  float d = length(gl_PointCoord - 0.5);',
    '  float a = smoothstep(0.5, 0.08, d);',
    '  vec3 col = mix(uColA, uColB, smoothstep(0.62, 0.86, vTone));',
    '  col = mix(col, vec3(1.0), clamp(vGlow * 0.45, 0.0, 0.7));',
    '  float o = a * vAlpha;',
    '  gl_FragColor = vec4(col * o, o);',
    '}'
  ].join('\n');

  var FOV = 35 * Math.PI / 180;
  var DIST = 5;

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  }

  function Scene(canvas, shapeNames, count) {
    this.canvas = canvas;
    this.names = shapeNames;
    this.count = count;
    this.ok = false;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.mv = new Float32Array(16);
    this.proj = new Float32Array(16);
    this.pulseData = new Float32Array(9);
    this.pulses = [];
    this.pulseSlot = 0;
    var self = this;
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); self.ok = false; });
    canvas.addEventListener('webglcontextrestored', function () { self.init(); });
    this.init();
  }

  Scene.prototype.init = function () {
    var gl;
    try {
      gl = this.canvas.getContext('webgl', {
        alpha: true, antialias: false, premultipliedAlpha: true,
        depth: false, stencil: false, powerPreference: 'high-performance'
      });
    } catch (e) { gl = null; }
    if (!gl) { this.ok = false; return; }
    this.gl = gl;
    try {
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.prog = prog;
    } catch (err) {
      if (window.console) console.warn('Scene disabled:', err.message);
      this.ok = false;
      return;
    }
    gl.useProgram(this.prog);

    var n = this.count, i;
    this.buffers = {};
    for (i = 0; i < this.names.length; i++) {
      var name = this.names[i];
      if (this.buffers[name] || !AV.shapes[name]) continue;
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, AV.shapes[name](n), gl.STATIC_DRAW);
      this.buffers[name] = buf;
    }
    var seeds = new Float32Array(n * 4);
    var s = 1234567;
    for (i = 0; i < n * 4; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      seeds[i] = (s >>> 0) / 4294967296;
    }
    this.seedBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

    this.loc = {
      aA: gl.getAttribLocation(this.prog, 'aA'),
      aB: gl.getAttribLocation(this.prog, 'aB'),
      aSeed: gl.getAttribLocation(this.prog, 'aSeed')
    };
    var self = this;
    this.u = {};
    ['uMV', 'uP', 'uMix', 'uTime', 'uAssemble', 'uScatter', 'uWave', 'uPx', 'uAspect', 'uBright',
      'uDark', 'uDepth', 'uOffset', 'uPointer', 'uPulse', 'uColA', 'uColB'].forEach(function (k) {
      self.u[k] = gl.getUniformLocation(self.prog, k);
    });
    gl.enableVertexAttribArray(this.loc.aA);
    gl.enableVertexAttribArray(this.loc.aB);
    gl.enableVertexAttribArray(this.loc.aSeed);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.vertexAttribPointer(this.loc.aSeed, 4, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    this.ok = true;
    this.resize(true);
  };

  Scene.prototype.resize = function (force) {
    if (!this.gl) return;
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    // Mobile browsers resize the viewport as their toolbars slide. Ignore
    // those small changes so the canvas is not reallocated mid-scroll.
    if (!force && w === this.w && Math.abs(h - this.h) < 130) return;
    this.w = w; this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    var f = 1 / Math.tan(FOV / 2), near = 0.1, far = 30, p = this.proj;
    for (var i = 0; i < 16; i++) p[i] = 0;
    p[0] = f / (w / h); p[5] = f; p[10] = (far + near) / (near - far); p[11] = -1;
    p[14] = (2 * far * near) / (near - far);
  };

  // World radius 1 at the origin covers this many CSS pixels of radius.
  Scene.prototype.unitPx = function () {
    return (this.h / 2) / (DIST * Math.tan(FOV / 2));
  };

  // Start a shockwave at a viewport position (CSS pixels).
  Scene.prototype.pulse = function (x, y, now) {
    this.pulses[this.pulseSlot] = { x: (x / this.w) * 2 - 1, y: 1 - (y / this.h) * 2, t: now };
    this.pulseSlot = (this.pulseSlot + 1) % 3;
  };

  /* state: { a, b, mix, time, tilt, yaw, scale, lift, cx, cy, sizePx, bright, dark,
              wave, scatter, assemble, colA, colB, px, py, pforce } */
  Scene.prototype.render = function (st) {
    if (!this.ok) return;
    var gl = this.gl, u = this.u, m = this.mv;
    var bufA = this.buffers[st.a], bufB = this.buffers[st.b];
    if (!bufA || !bufB) return;

    var c = Math.cos(st.yaw), s = Math.sin(st.yaw);
    var cp = Math.cos(st.tilt), sp = Math.sin(st.tilt), S = st.scale;
    m[0] = c * S;  m[1] = sp * s * S;  m[2] = -cp * s * S; m[3] = 0;
    m[4] = 0;      m[5] = cp * S;      m[6] = sp * S;      m[7] = 0;
    m[8] = s * S;  m[9] = -sp * c * S; m[10] = cp * c * S; m[11] = 0;
    m[12] = 0;     m[13] = st.lift;    m[14] = -DIST;      m[15] = 1;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufA);
    gl.vertexAttribPointer(this.loc.aA, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
    gl.vertexAttribPointer(this.loc.aB, 3, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix4fv(u.uMV, false, m);
    gl.uniformMatrix4fv(u.uP, false, this.proj);
    gl.uniform1f(u.uMix, st.mix);
    gl.uniform1f(u.uTime, st.time);
    gl.uniform1f(u.uAssemble, st.assemble);
    gl.uniform1f(u.uScatter, st.scatter);
    gl.uniform1f(u.uWave, st.wave);
    gl.uniform1f(u.uAspect, this.w / this.h);
    gl.uniform1f(u.uBright, st.bright);
    gl.uniform1f(u.uDark, st.dark);
    gl.uniform1f(u.uDepth, DIST);
    gl.uniform1f(u.uPx, this.dpr * 5.4 * Math.max(0.62, Math.min(1.35, st.sizePx / 620)));
    gl.uniform2f(u.uOffset, (st.cx / this.w) * 2 - 1, 1 - (st.cy / this.h) * 2);
    gl.uniform3f(u.uPointer, (st.px / this.w) * 2 - 1, 1 - (st.py / this.h) * 2, st.pforce);
    gl.uniform3f(u.uColA, st.colA[0], st.colA[1], st.colA[2]);
    gl.uniform3f(u.uColB, st.colB[0], st.colB[1], st.colB[2]);

    var pd = this.pulseData;
    for (var i = 0; i < 3; i++) {
      var p = this.pulses[i];
      var age = p ? st.time - p.t : -1;
      if (age > 4.5) age = -1;
      pd[i * 3] = p ? p.x : 0; pd[i * 3 + 1] = p ? p.y : 0; pd[i * 3 + 2] = age;
    }
    gl.uniform3fv(u.uPulse, pd);
    gl.drawArrays(gl.POINTS, 0, this.count);
  };

  AV.Scene = Scene;
})();
