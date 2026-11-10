/* ==========================================================================
   Page choreography: smooth scroll, the sculpture's journey between sections,
   text reveals, pinned chapters, cursor, and the small interactions.
   Everything animated is driven from one requestAnimationFrame loop.
   ========================================================================== */
(function () {
  'use strict';

  var AV = window.AV || {};
  var doc = document.documentElement;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var pinMQ = window.matchMedia('(min-width: 861px) and (min-height: 640px)');

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b, t) { return a + (b - a) * t; }
  function damp(a, b, lambda, dt) { return mix(a, b, 1 - Math.exp(-lambda * dt)); }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function num(v, fallback) { var n = parseFloat(v); return isNaN(n) ? fallback : n; }
  function pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }
  function hex(h) {
    h = h.replace('#', '');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  /* ------------------------------------------------------------------------
     Text splitting
     ------------------------------------------------------------------------ */
  function eachTextNode(root, fn) {
    $$('*', root).concat([root]).forEach(function (el) {
      Array.prototype.slice.call(el.childNodes).forEach(function (node) {
        if (node.nodeType === 3 && node.textContent.trim()) fn(node);
      });
    });
  }
  function wrapPieces(node, pieces, outerClass, innerClass, counter) {
    var frag = document.createDocumentFragment();
    pieces.forEach(function (piece) {
      if (piece === '') return;
      if (/^\s+$/.test(piece)) { frag.appendChild(document.createTextNode(' ')); return; }
      var outer = document.createElement('span');
      outer.className = outerClass;
      if (innerClass) {
        var inner = document.createElement('span');
        inner.className = innerClass;
        inner.textContent = piece;
        inner.style.setProperty('--i', counter.i++);
        outer.appendChild(inner);
      } else {
        outer.textContent = piece;
        outer.style.setProperty('--i', counter.i++);
      }
      frag.appendChild(outer);
    });
    node.parentNode.replaceChild(frag, node);
  }
  $$('[data-words]').forEach(function (el) {
    var counter = { i: 0 };
    eachTextNode(el, function (node) { wrapPieces(node, node.textContent.split(/(\s+)/), 'w', 'w__i', counter); });
  });
  $$('[data-chars]').forEach(function (el) {
    var counter = { i: 0 };
    eachTextNode(el, function (node) { wrapPieces(node, node.textContent.split(''), 'c', 'c__i', counter); });
    el.setAttribute('aria-hidden', 'true');
  });
  $$('[data-fill]').forEach(function (el) {
    var counter = { i: 0 };
    eachTextNode(el, function (node) { wrapPieces(node, node.textContent.split(/(\s+)/), 'f', null, counter); });
    el.style.setProperty('--n', counter.i);
  });

  /* ------------------------------------------------------------------------
     Smooth scroll
     ------------------------------------------------------------------------ */
  var lenis = null;
  if (window.Lenis && !reduce) {
    lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 0.95, smoothWheel: true });
    lenis.stop();
  }
  // History calls can be refused inside sandboxed frames; never let that stop the page.
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
  window.scrollTo(0, 0);

  function getScroll() { return lenis ? lenis.animatedScroll : window.pageYOffset; }
  function scrollToTarget(target, immediate) {
    if (lenis) {
      lenis.scrollTo(target, {
        immediate: !!immediate, duration: 2, force: true,
        easing: function (t) { return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2; }
      });
    } else if (target === 0) {
      window.scrollTo(0, 0);
    } else {
      target.scrollIntoView();
    }
  }

  /* ------------------------------------------------------------------------
     Sections that carry a sculpture
     ------------------------------------------------------------------------ */
  var sections = $$('[data-scene]').map(function (el, i) {
    var shape = el.getAttribute('data-scene');
    var d = (AV.shapeDefaults && AV.shapeDefaults[shape]) || {};
    var anchor = $('[data-anchor]', el);
    if (!anchor) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      slot.setAttribute('aria-hidden', 'true');
      slot.innerHTML = '<div class="slot__pin"><i class="slot__anchor"></i></div>';
      el.insertBefore(slot, el.firstChild);
      anchor = $('.slot__anchor', slot);
    }
    return {
      el: el, shape: shape, anchor: anchor, index: i,
      label: el.getAttribute('data-label') || shape,
      tilt: num(el.getAttribute('data-tilt'), d.tilt || 0),
      spin: num(el.getAttribute('data-spin'), d.spin == null ? 1 : d.spin),
      sway: d.sway || 0,
      wave: d.wave || 0,
      bright: num(el.getAttribute('data-bright'), 1),
      dark: num(el.getAttribute('data-dark'), 0),
      climb: el.hasAttribute('data-climb'),
      colA: hex(el.getAttribute('data-col-a') || '#d8ba7e'),
      colB: hex(el.getAttribute('data-col-b') || '#f6efe0'),
      glow: hex(el.getAttribute('data-glow') || el.getAttribute('data-col-a') || '#d8ba7e'),
      top: 0, h: 1, sb: 1, p: 0
    };
  });

  var canvas = $('#scene');
  var scene = null;
  if (canvas && AV.Scene && sections.length) {
    var small = Math.min(window.innerWidth, window.innerHeight) < 700;
    scene = new AV.Scene(canvas, sections.map(function (s) { return s.shape; }), small ? 8000 : 16000);
    if (!scene.ok) { canvas.style.display = 'none'; }
  }

  /* ------------------------------------------------------------------------
     Chapters
     ------------------------------------------------------------------------ */
  var chapters = $$('[data-chapter]').map(function (el) {
    return {
      el: el, pin: $('.chapter__pin', el),
      mech: $$('[data-mech] li', el),
      floorEl: $('[data-floor]', el), gauge: $$('[data-gauge] li', el),
      isClap: el.hasAttribute('data-clap'),
      section: sections.filter(function (s) { return s.el === el; })[0],
      top: 0, h: 1, p: 0, active: -1, floor: 0, engaged: false, litTimer: 0
    };
  });

  /* ------------------------------------------------------------------------
     Measuring
     ------------------------------------------------------------------------ */
  var vw = window.innerWidth, vh = window.innerHeight, docH = 1, pinned = pinMQ.matches;
  var marquee = $('[data-marquee]'), marqueeTrack = marquee && $('.marquee__track', marquee);
  var marqueeHalf = 0, marqueeX = 0;
  if (marqueeTrack) {
    // Duplicate the items once so the loop is seamless.
    $$(':scope > *', marqueeTrack).forEach(function (n) { marqueeTrack.appendChild(n.cloneNode(true)); });
  }
  var fillEls = $$('[data-fill]').map(function (el) { return { el: el, top: 0, h: 1, p: -1 }; });

  function measure() {
    vw = doc.clientWidth; vh = window.innerHeight;
    pinned = pinMQ.matches;
    var sy = window.pageYOffset;
    sections.forEach(function (s) {
      var r = s.el.getBoundingClientRect();
      s.top = r.top + sy; s.h = Math.max(1, r.height);
      s.sb = num(getComputedStyle(s.el).getPropertyValue('--sb'), 1);
    });
    chapters.forEach(function (c) {
      var r = c.el.getBoundingClientRect();
      c.top = r.top + sy; c.h = Math.max(1, r.height);
      if (!pinned && c.active !== -1) {
        c.active = -1;
        c.mech.forEach(function (li) { li.classList.remove('is-active'); });
      }
    });
    fillEls.forEach(function (f) {
      var r = f.el.getBoundingClientRect();
      f.top = r.top + sy; f.h = Math.max(1, r.height);
    });
    docH = Math.max(1, doc.scrollHeight - vh);
    if (marqueeTrack) {
      var gap = parseFloat(getComputedStyle(marqueeTrack).columnGap) || 0;
      marqueeHalf = (marqueeTrack.scrollWidth + gap) / 2;
    }
    if (scene) scene.resize();
    if (lenis) lenis.resize();
  }
  var measureQueued = false;
  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(function () { measureQueued = false; measure(); });
  }
  window.addEventListener('resize', queueMeasure);
  window.addEventListener('load', queueMeasure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueMeasure);
  if (window.ResizeObserver) new ResizeObserver(queueMeasure).observe(document.body);

  /* Where are we between sculptures? Returns a float: 2.4 means 40% of the
     way from section 2's form to section 3's. Each section holds its form
     while it fills the viewport and morphs in the gap to the next one. */
  function sceneIndex(yv) {
    var n = sections.length;
    for (var k = 0; k < n; k++) {
      var s = sections[k], half = Math.min(s.h, vh) / 2;
      var holdEnd = s.top + s.h - half;
      if (yv <= holdEnd) return k;
      var nx = sections[k + 1];
      if (!nx) return n - 1;
      var nextStart = nx.top + Math.min(nx.h, vh) / 2;
      if (yv < nextStart) return k + smooth((yv - holdEnd) / Math.max(1, nextStart - holdEnd));
    }
    return n - 1;
  }

  /* ------------------------------------------------------------------------
     Pointer, cursor, magnets, tilt
     ------------------------------------------------------------------------ */
  var pointer = { x: vw / 2, y: vh / 2, sx: vw / 2, sy: vh / 2, rx: vw / 2, ry: vh / 2, seen: false, force: 0 };
  var cursorEl = $('[data-cursor-el]');
  var cursorDot = cursorEl && $('.cursor__dot', cursorEl);
  var cursorRing = cursorEl && $('.cursor__ring', cursorEl);
  var cursorLabel = cursorEl && $('[data-cursor-label]', cursorEl);
  var useCursor = finePointer && !reduce && !!cursorEl;

  window.addEventListener('pointermove', function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (!pointer.seen && e.pointerType === 'mouse') {
      pointer.seen = true;
      pointer.sx = pointer.rx = e.clientX; pointer.sy = pointer.ry = e.clientY;
      if (useCursor) { doc.classList.add('has-cursor'); cursorEl.classList.add('is-on'); }
    }
  }, { passive: true });

  if (useCursor) {
    document.addEventListener('mouseover', function (e) {
      var t = e.target.closest ? e.target.closest('[data-cursor], a, button') : null;
      var label = t && t.getAttribute('data-cursor');
      cursorEl.classList.toggle('is-label', !!label);
      cursorEl.classList.toggle('is-solid', !!label && t.matches('a, button'));
      var plain = !!t && !label;
      var isButton = plain && t.matches('.btn, .orb, .hero__handle, .burger');
      cursorEl.classList.toggle('is-link', plain && !isButton);
      cursorEl.classList.toggle('is-hide', isButton);
      if (label) cursorLabel.textContent = label;
    });
    document.addEventListener('mousedown', function () { cursorEl.classList.add('is-down'); });
    document.addEventListener('mouseup', function () { cursorEl.classList.remove('is-down'); });
    doc.addEventListener('mouseleave', function () { cursorEl.classList.remove('is-on'); });
    doc.addEventListener('mouseenter', function () { if (pointer.seen) cursorEl.classList.add('is-on'); });
  }

  var magnets = [];
  if (finePointer && !reduce) {
    $$('[data-magnetic]').forEach(function (el) {
      var m = { el: el, x: 0, y: 0, tx: 0, ty: 0, live: false };
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        m.tx = (e.clientX - (r.left + r.width / 2)) * 0.34;
        m.ty = (e.clientY - (r.top + r.height / 2)) * 0.34;
        m.live = true;
      });
      el.addEventListener('pointerleave', function () { m.tx = 0; m.ty = 0; });
      magnets.push(m);
    });
  }

  var tilts = $$('[data-tilt]').map(function (el) { return { el: el, rx: 0, ry: 0 }; });

  /* ------------------------------------------------------------------------
     Clicks send a shockwave through the sculpture. In CLAP TO SEE that
     shockwave is also the only light.
     ------------------------------------------------------------------------ */
  var time = 0;
  function spawn(className, x, y, life) {
    var el = document.createElement('i');
    el.className = className;
    el.style.setProperty('--x', x + 'px');
    el.style.setProperty('--y', y + 'px');
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, life);
  }
  function clap(c, x, y) {
    if (scene) scene.pulse(x, y, time);
    c.el.classList.add('is-lit');
    clearTimeout(c.litTimer);
    c.litTimer = setTimeout(function () { c.el.classList.remove('is-lit'); }, 1300);
    if (!reduce) {
      spawn('clap-flash', x, y, 2100);
      spawn('clap-ring', x, y, 2000);
      spawn('clap-ring clap-ring--b', x, y, 2600);
    }
  }
  function anchorCenter(s) {
    var r = s.anchor.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button) return;
    var interactive = e.target.closest && e.target.closest('a, button');
    var clapChapter = null;
    chapters.forEach(function (c) { if (c.isClap && c.el.contains(e.target)) clapChapter = c; });
    if (clapChapter && !interactive) { clap(clapChapter, e.clientX, e.clientY); return; }
    if (scene && !interactive) scene.pulse(e.clientX, e.clientY, time);
  });
  chapters.forEach(function (c) {
    var btn = $('[data-clap-btn]', c.el);
    if (btn) btn.addEventListener('click', function () {
      var p = anchorCenter(c.section);
      // On small screens the sculpture may be off screen; clap from the button.
      if (p.y < 0 || p.y > vh) { var r = btn.getBoundingClientRect(); p = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
      clap(c, p.x, p.y);
    });
  });

  function updateChapters(scroll) {
    for (var i = 0; i < chapters.length; i++) {
      var c = chapters[i];
      var p = clamp((scroll - c.top) / Math.max(1, c.h - vh), 0, 1);
      c.p = p;
      if (pinned) {
        var n = c.mech.length;
        var idx = Math.min(n - 1, Math.floor(p * n));
        if (idx !== c.active) {
          c.active = idx;
          for (var k = 0; k < n; k++) c.mech[k].classList.toggle('is-active', k === idx);
        }
        if (c.floorEl) {
          var fl = Math.min(10, 1 + Math.floor(p * 10));
          if (fl !== c.floor) {
            c.floor = fl;
            c.floorEl.textContent = pad(fl, 2);
            c.floorEl.classList.remove('is-tick');
            void c.floorEl.offsetWidth;
            c.floorEl.classList.add('is-tick');
            for (var g = 0; g < c.gauge.length; g++) {
              c.gauge[g].classList.toggle('is-passed', g < fl - 1);
              c.gauge[g].classList.toggle('is-current', g === fl - 1);
            }
          }
        }
      }
      // The first time the dark room fills the screen, clap once to show how.
      var engaged = scroll > c.top - vh * 0.3 && scroll < c.top + c.h - vh * 0.7;
      if (c.isClap && engaged && !c.engaged && started) {
        var pt = anchorCenter(c.section);
        clap(c, clamp(pt.x, 0, vw), clamp(pt.y, 0, vh));
      }
      c.engaged = engaged;
    }
  }

  /* ------------------------------------------------------------------------
     Reveals
     ------------------------------------------------------------------------ */
  var revealTargets = $$('[data-words], [data-chars], [data-reveal]');
  function startReveals() {
    if (!('IntersectionObserver' in window)) {
      revealTargets.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
    // Pinned chapters keep some of their content right at the viewport's
    // edge, so they get an observer without the bottom inset.
    var edge = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); edge.unobserve(entry.target); }
      });
    }, { threshold: 0.01 });
    revealTargets.forEach(function (el) {
      // The opening screen is revealed as a set, whatever the viewport height.
      if (el.closest('.hero')) el.classList.add('is-in');
      else if (el.closest('.chapter__pin')) edge.observe(el);
      else io.observe(el);
    });
  }

  /* ------------------------------------------------------------------------
     Header, menu, anchors
     ------------------------------------------------------------------------ */
  var hdr = $('[data-hdr]'), burger = $('[data-burger]'), menu = $('[data-menu]');
  var burgerLabel = $('[data-burger-label]');
  function setMenu(open) {
    doc.classList.toggle('menu-open', open);
    if (burger) burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (burgerLabel) burgerLabel.textContent = open ? 'Close' : 'Menu';
    if (menu) {
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) menu.removeAttribute('inert'); else menu.setAttribute('inert', '');
    }
    if (lenis && started) { if (open) lenis.stop(); else lenis.start(); }
  }
  if (menu) menu.setAttribute('inert', '');
  if (burger) burger.addEventListener('click', function () { setMenu(!doc.classList.contains('menu-open')); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  pinMQ.addEventListener && pinMQ.addEventListener('change', function () { setMenu(false); queueMeasure(); });

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute('href');
    var target = id === '#top' ? 0 : $(id);
    if (target == null) return;
    e.preventDefault();
    setMenu(false);
    scrollToTarget(target);
    try {
      if (history.replaceState) history.replaceState(null, '', id === '#top' ? location.pathname + location.search : id);
    } catch (err) { /* ignore */ }
  });

  /* ------------------------------------------------------------------------
     Read-outs
     ------------------------------------------------------------------------ */
  var hudX = $('[data-hud-x]'), hudY = $('[data-hud-y]'), hudZ = $('[data-hud-z]');
  var hudIndex = $('[data-hud-index]'), hudLabel = $('[data-hud-label]'), hudTotal = $('[data-hud-total]');
  var progressEl = $('[data-progress]'), glowEl = $('[data-glow]');
  if (hudTotal) hudTotal.textContent = pad(sections.length, 2);
  var hudClock = 0, hudShown = -1;
  function signed(v) { return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(3); }

  /* ------------------------------------------------------------------------
     The loop
     ------------------------------------------------------------------------ */
  var started = false, assembleAt = -1, last = 0;
  var sCur = 0, lastScroll = 0, vel = 0, dir = 1;
  var spinAngle = 0.7, latch = null;
  var cx = vw / 2, cy = vh / 2, size = Math.min(vw, vh) * 0.7, placed = false;
  var glowKey = '';
  var st = {
    a: 'cube', b: 'cube', mix: 0, time: 0, tilt: 0, yaw: 0, scale: 1, lift: 0,
    cx: 0, cy: 0, sizePx: 600, bright: 1, dark: 0, wave: 0, scatter: 0.3, assemble: 0,
    colA: [1, 1, 1], colB: [1, 1, 1], px: 0, py: 0, pforce: 0
  };

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    time += dt;
    if (lenis) lenis.raf(now);

    var scroll = getScroll();
    var rawVel = (scroll - lastScroll) / dt;
    lastScroll = scroll;
    vel = damp(vel, rawVel, 8, dt);
    if (Math.abs(rawVel) > 4) dir = rawVel > 0 ? 1 : -1;

    // ---- Which forms, and how far between them
    var n = sections.length;
    if (n) {
      var target = sceneIndex(scroll + vh / 2);
      sCur = reduce ? target : damp(sCur, target, 7, dt);
      var i = Math.min(n - 1, Math.floor(sCur + 1e-6));
      var j = Math.min(n - 1, i + 1);
      var f = clamp(sCur - i, 0, 1);
      var A = sections[i], B = sections[j];

      // ---- Where on screen: dock onto each section's anchor
      var ra = A.anchor.getBoundingClientRect();
      var rb = i === j ? ra : B.anchor.getBoundingClientRect();
      var tx = mix(ra.left + ra.width / 2, rb.left + rb.width / 2, f);
      var ty = mix(ra.top + ra.height / 2, rb.top + rb.height / 2, f);
      var ts = mix(ra.width, rb.width, f);
      if (!placed || reduce) { cx = tx; cy = ty; size = ts; placed = true; }
      else { cx = damp(cx, tx, 16, dt); cy = damp(cy, ty, 16, dt); size = damp(size, ts, 10, dt); }

      // ---- Pointer
      pointer.sx = damp(pointer.sx, pointer.x, 6, dt);
      pointer.sy = damp(pointer.sy, pointer.y, 6, dt);
      pointer.force = damp(pointer.force, pointer.seen && !reduce ? 1 : 0, 3, dt);
      var nx = pointer.seen ? (pointer.sx / vw) * 2 - 1 : 0;
      var ny = pointer.seen ? (pointer.sy / vh) * 2 - 1 : 0;

      // ---- Orientation. Forms that must face the camera (spin 0) ease the
      // shared rotation to the nearest half turn and release it afterwards.
      var spin = mix(A.spin, B.spin, f);
      spinAngle += (dt * 0.2 + vel * 0.00045 * dt) * spin * (reduce ? 0.25 : 1);
      var still = (A.spin === 0 ? 1 - f : 0) + (B.spin === 0 && i !== j ? f : 0);
      if (still > 0.0005) { if (latch === null) latch = Math.round(spinAngle / Math.PI) * Math.PI; }
      else latch = null;
      var yaw = latch === null ? spinAngle : mix(spinAngle, latch, smooth(still));
      yaw += mix(A.sway, B.sway, f) * Math.sin(time * 0.4) + nx * 0.3;
      var tilt = mix(A.tilt, B.tilt, f) + ny * 0.16;

      // ---- Scale, and the climb up the tower
      var unit = scene ? scene.unitPx() : 300;
      var scale = size / 2 / unit;
      var climbW = pinned ? (A.climb ? 1 - f : 0) + (B.climb && i !== j ? f : 0) : 0;
      var lift = 0;
      if (climbW > 0) {
        var cs = A.climb ? A : B, cp = 0;
        for (var q = 0; q < chapters.length; q++) if (chapters[q].section === cs) cp = chapters[q].p;
        var zoom = mix(1, 1.62, smooth(climbW));
        scale *= zoom;
        lift = (0.5 - cp) * 1.5 * scale * smooth(climbW);
      }

      st.a = A.shape; st.b = B.shape; st.mix = f; st.time = time;
      st.tilt = tilt; st.yaw = yaw; st.scale = scale; st.lift = lift;
      st.cx = cx; st.cy = cy; st.sizePx = size;
      st.bright = mix(A.bright * A.sb, B.bright * B.sb, f);
      st.dark = mix(A.dark, B.dark, f);
      st.wave = mix(A.wave, B.wave, f);
      st.scatter = reduce ? 0 : 0.34;
      st.assemble = assembleAt < 0 ? 0 : reduce ? 1 : clamp((time - assembleAt) / 3, 0, 1);
      for (var k = 0; k < 3; k++) {
        st.colA[k] = mix(A.colA[k], B.colA[k], f);
        st.colB[k] = mix(A.colB[k], B.colB[k], f);
      }
      st.px = pointer.sx; st.py = pointer.sy; st.pforce = pointer.force;
      if (scene) scene.render(st);

      // ---- Soft bloom behind the sculpture
      if (glowEl) {
        var vmax = Math.max(vw, vh) * 0.7;
        glowEl.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) scale(' + clamp((size * 1.9) / vmax, 0.3, 2.4).toFixed(3) + ')';
        glowEl.style.opacity = (st.bright * (1 - st.dark) * st.assemble).toFixed(3);
        var key = Math.round(mix(A.glow[0], B.glow[0], f) * 255) + ' ' + Math.round(mix(A.glow[1], B.glow[1], f) * 255) + ' ' + Math.round(mix(A.glow[2], B.glow[2], f) * 255);
        if (key !== glowKey) { glowKey = key; glowEl.style.setProperty('--glow-rgb', key); }
      }

      // ---- Read-outs
      hudClock += dt;
      if (hudClock > 0.09 && hudX) {
        hudClock = 0;
        hudX.textContent = signed(nx);
        hudY.textContent = signed(-ny);
        hudZ.textContent = clamp(scroll / docH, 0, 1).toFixed(3);
        var near = Math.round(sCur);
        if (near !== hudShown) {
          hudShown = near;
          hudIndex.textContent = pad(near + 1, 2);
          hudLabel.textContent = sections[near].label;
        }
      }
    }

    updateChapters(scroll);

    // ---- Scroll-filled text
    for (var m = 0; m < fillEls.length; m++) {
      var fe = fillEls[m];
      var fp = clamp((scroll + vh * 0.82 - fe.top) / (fe.h + vh * 0.42), 0, 1.05);
      fp = Math.round(fp * 400) / 400;
      if (fp !== fe.p) { fe.p = fp; fe.el.style.setProperty('--p', fp); }
    }

    // ---- Progress and header
    if (progressEl) progressEl.style.transform = 'scaleX(' + clamp(scroll / docH, 0, 1).toFixed(4) + ')';
    if (hdr && started) {
      if (scroll < 120 || rawVel < -60) hdr.classList.remove('is-hidden');
      else if (rawVel > 60 && !doc.classList.contains('menu-open')) hdr.classList.add('is-hidden');
    }

    // ---- Marquee: drifts on its own, hurries when you scroll
    if (marqueeTrack && marqueeHalf > 0 && !reduce) {
      marqueeX += (46 + Math.abs(vel) * 0.32) * dt * dir;
      marqueeX = ((marqueeX % marqueeHalf) + marqueeHalf) % marqueeHalf;
      marqueeTrack.style.transform = 'translate3d(' + (-marqueeX).toFixed(2) + 'px,0,0) skewX(' + clamp(vel * -0.0035, -7, 7).toFixed(2) + 'deg)';
    }

    // ---- Cursor
    if (useCursor && pointer.seen) {
      pointer.rx = damp(pointer.rx, pointer.x, 13, dt);
      pointer.ry = damp(pointer.ry, pointer.y, 13, dt);
      cursorDot.style.transform = 'translate3d(' + pointer.x + 'px,' + pointer.y + 'px,0)';
      cursorRing.style.transform = 'translate3d(' + pointer.rx.toFixed(2) + 'px,' + pointer.ry.toFixed(2) + 'px,0)';
    }
    for (var g = 0; g < magnets.length; g++) {
      var mg = magnets[g];
      if (!mg.live) continue;
      mg.x = damp(mg.x, mg.tx, 9, dt); mg.y = damp(mg.y, mg.ty, 9, dt);
      if (Math.abs(mg.x) < 0.02 && Math.abs(mg.y) < 0.02 && mg.tx === 0 && mg.ty === 0) {
        mg.x = mg.y = 0; mg.live = false; mg.el.style.translate = '';
      } else {
        mg.el.style.translate = mg.x.toFixed(2) + 'px ' + mg.y.toFixed(2) + 'px';
      }
    }
    if (pointer.seen && !reduce) {
      for (var t = 0; t < tilts.length; t++) {
        var tl = tilts[t];
        var tr = tl.el.getBoundingClientRect();
        if (tr.bottom < 0 || tr.top > vh) continue;
        var dx = clamp((pointer.sx - (tr.left + tr.width / 2)) / vw, -0.5, 0.5);
        var dy = clamp((pointer.sy - (tr.top + tr.height / 2)) / vh, -0.5, 0.5);
        tl.el.style.setProperty('--ry', (dx * 26).toFixed(2) + 'deg');
        tl.el.style.setProperty('--rx', (dy * -22).toFixed(2) + 'deg');
      }
    }
  }

  /* ------------------------------------------------------------------------
     Boot: count up while fonts and art load, then lift the curtain.
     ------------------------------------------------------------------------ */
  function start() {
    if (started) return;
    started = true;
    measure();
    doc.classList.remove('is-loading');
    doc.classList.add('is-loaded');
    if (lenis) lenis.start();
    setTimeout(function () {
      doc.classList.add('is-ready');
      assembleAt = time;
      startReveals();
      if (location.hash && location.hash.length > 1) {
        var t = null;
        try { t = $(location.hash); } catch (e) { t = null; }
        if (t) setTimeout(function () { scrollToTarget(t); }, 900);
      }
    }, reduce ? 0 : 520);
  }

  function boot() {
    var countEl = $('[data-loader-count]');
    var began = performance.now(), ready = false, shown = 0;
    var minTime = reduce ? 200 : 1900;
    var loaded = new Promise(function (res) {
      if (document.readyState === 'complete') res(); else window.addEventListener('load', res);
    });
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    var cap = new Promise(function (res) { setTimeout(res, 5000); });
    Promise.race([Promise.all([loaded, fonts]), cap]).then(function () { ready = true; });

    (function tick(now) {
      var t = clamp((now - began) / minTime, 0, 1);
      var goal = (ready ? t : Math.min(t, 0.88)) * 100;
      shown += (goal - shown) * 0.14;
      if (countEl) countEl.textContent = pad(Math.round(shown), 3);
      if (ready && t >= 1 && shown > 99.4) { if (countEl) countEl.textContent = '100'; start(); return; }
      requestAnimationFrame(tick);
    })(began);
  }

  measure();
  requestAnimationFrame(function (now) { last = now; frame(now); });
  boot();
})();
