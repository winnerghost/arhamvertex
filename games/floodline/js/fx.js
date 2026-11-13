// Visual effects: GPU point particles (additive and alpha), bullet tracers, impact decals,
// water ripples, explosions and rain.
import * as THREE from 'three';
import { TEX } from './textures.js';
import { U } from './render.js';

class Particles {
  constructor(scene, max, tex, additive) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.rgb = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aCol', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: 600 }, uFog: { value: 0.005 } },
      vertexShader: `attribute vec4 aCol; attribute float aSize; uniform float uScale; uniform float uFog; varying vec4 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          gl_PointSize = aSize * uScale / max(d, 0.1);
          float f = exp(-uFog * uFog * d * d);
          vCol = vec4(aCol.rgb, aCol.a * f);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D uTex; varying vec4 vCol;
        void main() { vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vCol.rgb * t.rgb, t.a * vCol.a); }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = g; this.rgb[i * 3 + 2] = b;
    this.a0[i] = a;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const j = --this.n;
        if (i !== j) this.copy(j, i);
        continue;
      }
      const k = 1 - this.life[i] / this.maxLife[i];
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= dr; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt; this.vel[i * 3 + 2] *= dr;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      const fade = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      this.col[i * 4] = this.rgb[i * 3];
      this.col[i * 4 + 1] = this.rgb[i * 3 + 1];
      this.col[i * 4 + 2] = this.rgb[i * 3 + 2];
      this.col[i * 4 + 3] = this.a0[i] * Math.max(0, fade);
      i++;
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }

  copy(j, i) {
    for (let c = 0; c < 3; c++) {
      this.pos[i * 3 + c] = this.pos[j * 3 + c];
      this.vel[i * 3 + c] = this.vel[j * 3 + c];
      this.rgb[i * 3 + c] = this.rgb[j * 3 + c];
    }
    for (let c = 0; c < 4; c++) this.col[i * 4 + c] = this.col[j * 4 + c];
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
    this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j]; this.size[i] = this.size[j];
    this.a0[i] = this.a0[j]; this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
  }

  clear() { this.n = 0; this.points.geometry.setDrawRange(0, 0); }
}

class Tracers {
  constructor(scene, max) {
    this.max = max;
    this.list = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 4 * 3);
    this.col = new Float32Array(max * 4 * 3);
    const idx = [];
    for (let i = 0; i < max; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    g.setIndex(idx);
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  add(a, b, width = 0.028, bright = 1) {
    if (this.list.length >= this.max) this.list.shift();
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 0.5) return;
    this.list.push({ a: a.clone(), dir: d.divideScalar(len), len, t: 0, width, bright });
  }

  update(dt, cam) {
    const speed = 520;
    const camPos = cam.position;
    let n = 0;
    const tmp = new THREE.Vector3(), side = new THREE.Vector3(), head = new THREE.Vector3(), tail = new THREE.Vector3();
    this.list = this.list.filter((t) => (t.t += dt) * speed - 7 < t.len);
    for (const t of this.list) {
      const hd = Math.min(t.len, t.t * speed);
      const tl = Math.max(0, hd - 7);
      head.copy(t.a).addScaledVector(t.dir, hd);
      tail.copy(t.a).addScaledVector(t.dir, tl);
      tmp.subVectors(head, camPos);
      side.crossVectors(t.dir, tmp).normalize().multiplyScalar(t.width * (1 + tmp.length() * 0.004));
      const o = n * 12;
      this.pos.set([tail.x - side.x, tail.y - side.y, tail.z - side.z, tail.x + side.x, tail.y + side.y, tail.z + side.z,
        head.x + side.x, head.y + side.y, head.z + side.z, head.x - side.x, head.y - side.y, head.z - side.z], o);
      const b = t.bright;
      this.col.set([0, 0, 0, 0, 0, 0, 1.6 * b, 1.2 * b, 0.7 * b, 1.6 * b, 1.2 * b, 0.7 * b], o);
      n++;
    }
    this.mesh.geometry.setDrawRange(0, n * 6);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
  }

  clear() { this.list.length = 0; }
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.glow = new Particles(scene, 2500, TEX.glow, true);
    this.smoke = new Particles(scene, 1800, TEX.smoke, false);
    this.tracers = new Tracers(scene, 90);
    const dm = new THREE.MeshStandardMaterial({ map: TEX.hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.9 });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dm, 240);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decalI = 0;
    scene.add(this.decals);
    this.ripples = [];
    const rm = new THREE.MeshBasicMaterial({ map: TEX.ring, transparent: true, depthWrite: false, opacity: 0.6, fog: true });
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), rm.clone());
      m.visible = false;
      m.renderOrder = 3;
      scene.add(m);
      this.ripples.push({ m, t: 0, life: 1, size: 1 });
    }
    this.ri = 0;
    this._o = new THREE.Object3D();
    this.rainOn = false;
    const rg = new THREE.BufferGeometry();
    this.rainN = 2400;
    this.rainPos = new Float32Array(this.rainN * 6);
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab4bc, transparent: true, opacity: 0.32, fog: true }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rainSeeded = false;
    scene.add(this.rain);
  }

  setFog(d) { this.glow.mat.uniforms.uFog.value = d; this.smoke.mat.uniforms.uFog.value = d; }

  muzzle(p, dir, big = 1) {
    this.glow.emit(p.x, p.y, p.z, dir.x * 2, dir.y * 2, dir.z * 2, 0.06, 0.55 * big, 0.7 * big, 1.0, 0.75, 0.4, 1);
    for (let i = 0; i < 2; i++) {
      this.glow.emit(p.x, p.y, p.z, dir.x * 8 + (Math.random() - 0.5) * 3, dir.y * 8 + Math.random() * 2, dir.z * 8 + (Math.random() - 0.5) * 3, 0.1, 0.06, 0.02, 1, 0.7, 0.3, 1, 9);
    }
    this.smoke.emit(p.x, p.y, p.z, dir.x * 1.5, 0.4, dir.z * 1.5, 0.6, 0.2, 0.7, 0.75, 0.74, 0.72, 0.25, -0.3, 1.5);
  }

  impact(p, n, kind) {
    const r = Math.random;
    if (kind === 'water') { this.splash(p, 0.6); return; }
    if (kind === 'shield' || kind === 'flesh') {
      const c = kind === 'shield' ? [0.35, 0.75, 1.4] : [1.4, 0.45, 0.25];
      for (let i = 0; i < 8; i++) this.glow.emit(p.x, p.y, p.z, n.x * 2 + (r() - 0.5) * 5, n.y * 2 + (r() - 0.3) * 4, n.z * 2 + (r() - 0.5) * 5, 0.22, 0.07, 0.01, c[0], c[1], c[2], 1, 6, 2);
      this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.08, 0.35, 0.45, c[0], c[1], c[2], 0.8);
      return;
    }
    const metal = kind === 'metal';
    const dust = kind === 'terrain' ? [0.45, 0.4, 0.32] : kind === 'wood' ? [0.5, 0.42, 0.32] : [0.62, 0.6, 0.56];
    for (let i = 0; i < (metal ? 9 : 4); i++) {
      this.glow.emit(p.x, p.y, p.z, n.x * 3 + (r() - 0.5) * 6, n.y * 3 + r() * 3, n.z * 3 + (r() - 0.5) * 6, 0.18 + r() * 0.2, 0.05, 0.01, 1.4, 0.9, 0.5, 1, 9.8, 1);
    }
    for (let i = 0; i < 3; i++) {
      this.smoke.emit(p.x, p.y, p.z, n.x * (0.8 + r()) + (r() - 0.5) * 0.6, n.y * (0.8 + r()) + 0.3, n.z * (0.8 + r()) + (r() - 0.5) * 0.6, 0.6 + r() * 0.5, 0.12, 0.65, dust[0], dust[1], dust[2], 0.5, 0.4, 2.5);
    }
    if (kind === 'terrain') {
      for (let i = 0; i < 5; i++) this.smoke.emit(p.x, p.y, p.z, (r() - 0.5) * 3, 2 + r() * 3, (r() - 0.5) * 3, 0.5, 0.06, 0.04, 0.25, 0.22, 0.18, 1, 12, 0);
    }
    this.decal(p, n, 0.09 + r() * 0.05);
  }

  decal(p, n, size) {
    const o = this._o;
    o.position.set(p.x + n.x * 0.012, p.y + n.y * 0.012, p.z + n.z * 0.012);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n.x, n.y, n.z));
    o.rotateZ(Math.random() * Math.PI * 2);
    o.scale.set(size, size, size);
    o.updateMatrix();
    this.decals.setMatrixAt(this.decalI, o.matrix);
    this.decalI = (this.decalI + 1) % 240;
    this.decals.count = Math.min(240, this.decals.count + 1);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  splash(p, s = 1) {
    const r = Math.random;
    for (let i = 0; i < 10 * s + 3; i++) {
      this.smoke.emit(p.x, p.y, p.z, (r() - 0.5) * 2 * s, 2 + r() * 4 * s, (r() - 0.5) * 2 * s, 0.6 + r() * 0.4, 0.15 * s, 0.5 * s, 0.85, 0.92, 0.95, 0.75, 9, 0.5);
    }
    this.ripple(p.x, p.z, 0.6 * s + 0.4, 1.2 * s, U.level.value + 0.03);
  }

  ripple(x, z, size, life, y) {
    const rp = this.ripples[this.ri];
    this.ri = (this.ri + 1) % this.ripples.length;
    rp.t = 0;
    rp.life = life;
    rp.size = size;
    rp.m.position.set(x, y, z);
    rp.m.visible = true;
  }

  explosion(p) {
    const r = Math.random;
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, e = r() * 1.4 - 0.2;
      const sp = 3 + r() * 6;
      this.glow.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp, 0.35 + r() * 0.25, 1.4, 2.6, 1.6, 0.7, 0.25, 1, -1, 4);
    }
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2, sp = 8 + r() * 18;
      this.glow.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * sp, 4 + r() * 12, Math.sin(a) * sp, 0.6 + r() * 0.6, 0.09, 0.02, 1.5, 0.9, 0.4, 1, 14, 0.6);
    }
    for (let i = 0; i < 22; i++) {
      const a = r() * Math.PI * 2, sp = 1 + r() * 3;
      this.smoke.emit(p.x + Math.cos(a), p.y + 0.5 + r(), p.z + Math.sin(a), Math.cos(a) * sp, 1.5 + r() * 2.5, Math.sin(a) * sp, 2.5 + r() * 2.5, 1.2, 4.5, 0.22, 0.21, 0.2, 0.75, -0.25, 0.8);
    }
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2, sp = 5 + r() * 9;
      this.smoke.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * sp, 5 + r() * 8, Math.sin(a) * sp, 1.2, 0.12, 0.08, 0.15, 0.13, 0.11, 1, 18, 0.2);
    }
  }

  steam(p) {
    const r = Math.random;
    this.smoke.emit(p.x + (r() - 0.5) * 1.6, p.y + 0.2, p.z + (r() - 0.5) * 1.6, (r() - 0.5) * 0.4, 2.5 + r() * 2, (r() - 0.5) * 0.4, 1.6, 0.6, 2.4, 0.9, 0.95, 0.97, 0.22, -0.4, 0.5);
  }

  footSplash(p) {
    const r = Math.random;
    for (let i = 0; i < 4; i++) this.smoke.emit(p.x, U.level.value + 0.05, p.z, (r() - 0.5) * 1.5, 1 + r() * 1.6, (r() - 0.5) * 1.5, 0.45, 0.1, 0.3, 0.85, 0.92, 0.95, 0.6, 9, 0.5);
    this.ripple(p.x, p.z, 0.6, 0.9, U.level.value + 0.03);
  }

  tracer(a, b, w, bright) { this.tracers.add(a, b, w, bright); }

  setRain(on) { this.rainOn = on; this.rain.visible = on; }

  update(dt, cam, uScale) {
    this.glow.mat.uniforms.uScale.value = uScale;
    this.smoke.mat.uniforms.uScale.value = uScale;
    this.glow.update(dt);
    this.smoke.update(dt);
    this.tracers.update(dt, cam);
    for (const rp of this.ripples) {
      if (!rp.m.visible) continue;
      rp.t += dt;
      const k = rp.t / rp.life;
      if (k >= 1) { rp.m.visible = false; continue; }
      const s = rp.size * (0.3 + k * 1.7);
      rp.m.scale.set(s, 1, s);
      rp.m.material.opacity = 0.6 * (1 - k);
    }
    if (this.rainOn) {
      const P = this.rainPos, c = cam.position;
      for (let i = 0; i < this.rainN; i++) {
        let x = P[i * 6], y = P[i * 6 + 1], z = P[i * 6 + 2];
        if (!this.rainSeeded || y < c.y - 12 || Math.abs(x - c.x) > 30 || Math.abs(z - c.z) > 30) {
          x = c.x + (Math.random() - 0.5) * 60;
          z = c.z + (Math.random() - 0.5) * 60;
          y = c.y + (this.rainSeeded ? 18 : (Math.random() - 0.3) * 30);
        }
        y -= 22 * dt;
        x += 2.2 * dt;
        P[i * 6] = x; P[i * 6 + 1] = y; P[i * 6 + 2] = z;
        P[i * 6 + 3] = x - 0.1; P[i * 6 + 4] = y + 0.75; P[i * 6 + 5] = z;
      }
      this.rainSeeded = true;
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
  }

  clear() {
    this.glow.clear();
    this.smoke.clear();
    this.tracers.clear();
    this.decals.count = 0;
    this.decalI = 0;
    for (const rp of this.ripples) rp.m.visible = false;
  }
}
