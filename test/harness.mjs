// Loads the game into a node vm context with a stub DOM, so two such worlds can play an online match
// against each other in one process. Every canvas call goes to the world's draw log.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The game's own scripts, in index.html's order; the CDN script (PeerJS) is left out.
export function scriptList() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => m[1]);
}

const fmt = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? JSON.stringify(v) : v && v.__id ? v.__id : typeof v);

function recordingContext(log, id) {
  const special = {
    measureText: (s) => ({ width: String(s).length * 7 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, __id: 'm' }),
    createRadialGradient: (...a) => (log.push(id + '.radial(' + a.map(fmt) + ')'), { addColorStop: (...c) => log.push('stop(' + c.map(fmt) + ')'), __id: 'grad' }),
    createLinearGradient: (...a) => (log.push(id + '.linear(' + a.map(fmt) + ')'), { addColorStop: (...c) => log.push('stop(' + c.map(fmt) + ')'), __id: 'grad' }),
  };
  return new Proxy({}, {
    get: (t, k) => special[k] || ((...a) => log.push(id + '.' + String(k) + '(' + a.map(fmt).join(',') + ')')),
    set: (t, k, v) => (log.push(id + '.' + String(k) + '=' + fmt(v)), true),
  });
}

function element(log, id) {
  const listeners = {};
  let ctx = null;
  const el = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: { setProperty() {} }, width: 0, height: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => true },
    addEventListener: (type, f) => (listeners[type] = f),
    appendChild() {}, blur() {}, querySelectorAll: () => [],
    getContext: () => ctx || (ctx = recordingContext(log, id)),
  };
  return el;
}

export function makeWorld(name, { width = 1280, height = 760, clock }) {
  const log = [];
  const listeners = {};
  const els = {};
  let canvases = 0, rafCb = null;
  class HTMLElement {}
  class HTMLInputElement extends HTMLElement {}
  class HTMLButtonElement extends HTMLElement {}
  const document = {
    getElementById: (id) => els[id] || (els[id] = element(log, id)),
    createElement: (tag) => element(log, tag === 'canvas' ? 'layer' + canvases++ : tag),
    querySelectorAll: () => [],
    addEventListener: (type, f) => (listeners['doc:' + type] = f),
    body: { classList: { toggle() {} } },
    activeElement: null,
    hidden: false,
  };
  const ctx = {
    console, document, HTMLElement, HTMLInputElement, HTMLButtonElement,
    innerWidth: width, innerHeight: height, devicePixelRatio: 1,
    location: { search: '' },
    matchMedia: () => ({ matches: false }),
    localStorage: (() => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    })(),
    performance: { now: () => clock.t },
    requestAnimationFrame: (f) => (rafCb = f),
    setTimeout: () => 0,
    addEventListener: (type, f) => ((listeners[type] = listeners[type] || []).push(f)),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const src of scriptList()) vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), ctx, { filename: src });
  const key = (type, code) => {
    for (const f of listeners[type] || []) f({ code, target: {}, preventDefault() {} });
  };
  return {
    name, ctx, log, TR: ctx.TR,
    frame() {
      log.length = 0;
      rafCb(clock.t);
    },
    down: (code) => key('keydown', code),
    up: (code) => key('keyup', code),
  };
}

// A link pair whose messages wait in a queue until flush(), so each world runs a whole frame undisturbed.
export function linkPair() {
  const queue = [];
  const sides = {};
  const link = (from, to) => ({
    send: (s) => queue.push([to, s]),
    drop() {}, close() {},
  });
  // sides holds each end's handlers, for a test to play a link that closes or a broker that errors.
  return {
    sides,
    net(world) {
      const Net = world.TR.Net;
      Net.host = (code, h) => ((sides.host = h), queue.push(['host-ready']), link('host', 'guest'));
      Net.join = (code, h) => ((sides.guest = h), queue.push(['open']), link('guest', 'host'));
      Net.available = () => true;
    },
    flush() {
      while (queue.length) {
        const [to, s] = queue.shift();
        if (to === 'host-ready') sides.host.onReady();
        else if (to === 'open') { sides.host.onOpen(); sides.guest.onOpen(); }
        else sides[to].onData(s);
      }
    },
  };
}
