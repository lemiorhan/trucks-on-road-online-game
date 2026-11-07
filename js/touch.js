'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;
  const $ = (id) => document.getElementById(id);

  // A finger (or a held mouse button) dragged on the road drives: up is throttle, down brakes and then
  // reverses, sideways steers; at a depot ramp and while unloading it walks the worker. R is the drag in CSS px for full lock,
  // DEAD the share of R that counts as no drag. A finger dragged past R pulls the stick's centre after it, so
  // swinging the other way never takes more than R.
  const STICK = { R: 60, DEAD: 0.25 };
  const LIVE = ['countdown', 'play', 'finishing'];
  const PHASES = {
    race: { pads: ['brake', 'horn', 'reset'], reset: 'Yola dön', hint: 'Sürükle: yukarı gaz · aşağı fren · sağa sola direksiyon' },
    park: { pads: ['brake', 'reset'], reset: 'Girişe dön', hint: 'Sürükle: yukarı ileri · aşağı geri · sağa sola direksiyon' },
    load: { pads: ['action', 'reset'], reset: 'Rampadan çık', hint: 'Sürükle: yürü' },
    unload: { pads: ['action'], hint: 'Sürükle: yürü' },
  };

  const pad = { thr: 0, steer: 0, mx: 0, my: 0, brake: false, action: false, reset: false, horn: false };
  TR.Input.pad = pad;

  const dead = (v) => (Math.abs(v) < STICK.DEAD ? 0 : (v - Math.sign(v) * STICK.DEAD) / (1 - STICK.DEAD));
  // A drag of (dx, dy) CSS px from the stick's centre; screen y grows downwards. The truck has no half
  // throttle, so thr is only ever -1, 0 or 1.
  function read(dx, dy) {
    const x = U.clamp(dx / STICK.R, -1, 1), y = U.clamp(dy / STICK.R, -1, 1);
    const walk = Math.hypot(x, y) >= STICK.DEAD;
    const fwd = dead(y);
    return { thr: fwd < 0 ? 1 : fwd > 0 ? -1 : 0, steer: dead(x), mx: walk ? x : 0, my: walk ? y : 0 };
  }

  const Touch = (TR.Touch = { STICK, read, on: false });
  const canvas = $('game'), layer = $('touch'), hint = $('touchHint'), base = $('stick'), knob = $('stickKnob');
  const buttons = Array.from(document.querySelectorAll('[data-pad]'));
  base.style.width = base.style.height = 2 * STICK.R + 'px';
  base.style.left = base.style.top = -STICK.R + 'px';

  // A coarse pointer (a phone, a tablet) shows the buttons from the start, any other screen from its first
  // touch; a held mouse button drives without them.
  const useTouch = () => (Touch.on = true);
  if (window.matchMedia('(pointer: coarse)').matches) useTouch();

  const me = () => TR.Game.players && TR.Game.players[TR.Online.meIdx()];
  const playing = () => TR.UI.current === null && LIVE.includes(TR.Game.state) && !!me();

  const stick = { id: null, ox: 0, oy: 0 };
  function drag(e) {
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK.R) {
      stick.ox += dx * (1 - STICK.R / d);
      stick.oy += dy * (1 - STICK.R / d);
      dx = e.clientX - stick.ox;
      dy = e.clientY - stick.oy;
    }
    Object.assign(pad, read(dx, dy));
    base.style.transform = 'translate(' + stick.ox + 'px,' + stick.oy + 'px)';
    knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }
  function letGo() {
    stick.id = null;
    pad.thr = pad.steer = pad.mx = pad.my = 0;
    base.classList.add('hidden');
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') useTouch();
    // Before the stick check: a second finger folds the map while the first one drives.
    if (e.button !== 0 || !playing() || TR.HUD.tapNav(e.clientX, e.clientY) || stick.id !== null) return;
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    base.classList.remove('hidden');
    hint.classList.add('hidden');
    drag(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === stick.id) drag(e);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, (e) => {
      if (e.pointerId === stick.id) letGo();
    });
  }

  for (const b of buttons) {
    const name = b.dataset.pad;
    if (name === 'pause') {
      b.addEventListener('click', () => TR.Game.pause());
      continue;
    }
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('on');
      pad[name] = true;
    });
    const up = () => {
      b.classList.remove('on');
      if (name === 'brake') pad.brake = false;
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  // A press is seen for one frame, like a key press. The layer is redrawn only when what it shows changes.
  let shown = null;
  TR.Input.onEndFrame(() => {
    pad.action = pad.reset = pad.horn = false;
    const live = playing();
    if (!live) {
      if (stick.id !== null) letGo();
      pad.brake = false;
    }
    const phase = live ? me().phase : null;
    // On a split screen the layer sits in the bottom-right corner of its own player's half.
    const vp = live && Touch.on ? TR.Game.viewport(TR.Online.meIdx()) : null;
    const right = vp ? window.innerWidth - (vp.x + vp.w) : 0;
    const now = vp ? phase + ' ' + right : null;
    if (now === shown) return;
    shown = now;
    layer.classList.toggle('hidden', now === null);
    layer.style.setProperty('--view-right', right + 'px');
    const set = PHASES[phase];
    for (const b of buttons) {
      b.classList.remove('on');
      b.classList.toggle('hidden', b.dataset.pad !== 'pause' && !(set && set.pads.includes(b.dataset.pad)));
      if (b.dataset.pad === 'reset' && set && set.reset) b.textContent = set.reset;
    }
    // Shown again at each phase until the first drag in it: on a phone it covers part of the HUD.
    hint.textContent = set ? set.hint : '';
    hint.classList.toggle('hidden', !set);
  });
})();
