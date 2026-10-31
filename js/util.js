'use strict';
(function file() {
  const TR = (window.TR = window.TR || {});
  // Every script hands in its own function, so the online referee can tell a host running other code by
  // the whole text of it, closures and constants included.
  TR.files = [file];
  const U = (TR.U = {});

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));
  U.wrap = (a) => {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
  };
  U.damp = (dt, rate) => 1 - Math.exp(-dt * rate);
  U.smooth = (t) => {
    t = U.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };
  U.hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  U.fmtTime = (t) => {
    if (t == null) return '—';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };

  // mulberry32
  U.rng = function (seed) {
    let a = seed >>> 0;
    const f = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    f.shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(f() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    };
    return f;
  };

  // Oriented box: centre, half length along the heading, half width across it.
  U.obb = (cx, cy, hl, hw, a) => ({ cx, cy, hl, hw, ux: Math.cos(a), uy: Math.sin(a) });
  U.aabb = (x0, y0, x1, y1) => U.obb((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0);
  U.corners = (b) => {
    const lx = b.ux * b.hl, ly = b.uy * b.hl;
    const wx = -b.uy * b.hw, wy = b.ux * b.hw;
    return [
      { x: b.cx + lx + wx, y: b.cy + ly + wy },
      { x: b.cx + lx - wx, y: b.cy + ly - wy },
      { x: b.cx - lx - wx, y: b.cy - ly - wy },
      { x: b.cx - lx + wx, y: b.cy - ly + wy },
    ];
  };
  const radius = (b, ax, ay) =>
    b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);

  // Separating axis test. The normal points from a towards b.
  U.sat = (a, b) => {
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const reach = a.hl + a.hw + b.hl + b.hw;
    if (dx * dx + dy * dy > reach * reach) return null;
    const axes = [a.ux, a.uy, -a.uy, a.ux, b.ux, b.uy, -b.uy, b.ux];
    let best = Infinity, nx = 0, ny = 0;
    for (let i = 0; i < 8; i += 2) {
      const ax = axes[i], ay = axes[i + 1];
      const dist = dx * ax + dy * ay;
      const o = radius(a, ax, ay) + radius(b, ax, ay) - Math.abs(dist);
      if (o <= 0) return null;
      if (o < best) {
        best = o;
        const s = dist < 0 ? -1 : 1;
        nx = ax * s;
        ny = ay * s;
      }
    }
    return { nx, ny, depth: best };
  };

  U.roundRect = (ctx, x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  U.shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) {
      r *= 1 + f; g *= 1 + f; b *= 1 + f;
    } else {
      r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f;
    }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  };

  // ---------- input ----------
  // brake and horn share keys with action: action only matters while loading or unloading, brake and horn only while driving.
  TR.KEYS = [
    { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], action: ['Space', 'KeyE'], reset: ['KeyQ'], brake: ['Space'], horn: ['KeyE'] },
    {
      up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      action: ['Enter', 'NumpadEnter', 'Numpad0'], reset: ['ShiftRight', 'Backspace'], brake: ['AltRight', 'Numpad0'],
      horn: ['Enter', 'NumpadEnter'],
    },
  ];
  const GAME_KEYS = new Set(['Escape', 'KeyP', 'KeyF']);
  TR.KEYS.forEach((k) => Object.values(k).forEach((list) => list.forEach((c) => GAME_KEYS.add(c))));

  const down = new Set();
  const hit = new Set();
  const typing = (e) => e.target instanceof HTMLInputElement && e.target.type === 'text';
  window.addEventListener('keydown', (e) => {
    if (typing(e) && e.code !== 'Enter' && e.code !== 'Escape') return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!down.has(e.code)) hit.add(e.code);
    down.add(e.code);
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());

  const endFrameHooks = [];
  TR.Input = {
    isDown: (codes) => codes.some((c) => down.has(c)),
    wasHit: (codes) => codes.some((c) => hit.has(c)),
    endFrame: () => {
      hit.clear();
      for (const f of endFrameHooks) f();
    },
    onEndFrame: (f) => endFrameHooks.push(f),
    // A function per player that replaces the keyboard for them; online.js sets these.
    sources: [null, null],
    player(i) {
      return this.sources[i] ? this.sources[i]() : this.keys([TR.KEYS[i]]);
    },
    // The input of one player who drives with any of several key maps at once.
    keys(maps) {
      const any = (f, name) => maps.some((k) => f(k[name]));
      const held = (name) => any(this.isDown, name), tap = (name) => any(this.wasHit, name);
      const up = held('up'), dn = held('down'), lf = held('left'), rt = held('right');
      return {
        thr: (up ? 1 : 0) - (dn ? 1 : 0),
        steer: (rt ? 1 : 0) - (lf ? 1 : 0),
        mx: (rt ? 1 : 0) - (lf ? 1 : 0),
        my: (dn ? 1 : 0) - (up ? 1 : 0),
        action: tap('action'),
        reset: tap('reset'),
        brake: held('brake'),
        horn: tap('horn'),
        left: tap('left'),
        right: tap('right'),
      };
    },
  };
})();
