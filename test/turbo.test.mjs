// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;

// start (0,0) → fork (0,-8000) → { shortcut straight, busy 2000 east } → merge (0,-18000) → lot (0,-24000),
// every segment straight and with no features.
function straightSpec() {
  const seg = (id, a, b, role, flow, detour) => ({
    id, a, b, role, flow, detour, curvy: 0, tight: 1, wseed: 11 + id, features: [], events: { flock: false, work: false },
  });
  return {
    ri: 0, seed: 1, attempt: 0, jams: [],
    nodes: [
      { id: 0, x: 0, y: 0, kind: 'start' },
      { id: 1, x: 0, y: -8000, kind: 'fork' },
      { id: 2, x: 0, y: -18000, kind: 'merge' },
      { id: 3, x: 0, y: -24000, kind: 'lot' },
    ],
    segs: [seg(0, 0, 1, 'trunk', 1, 0), seg(1, 1, 2, 'shortcut', 0.6, 0), seg(2, 1, 2, 'busy', 1.5, 2000), seg(3, 2, 3, 'trunk', 1, 0)],
  };
}

function round(ri = 0, mapSpec = undefined) {
  const clock = { t: 1000 };
  const w = makeWorld('solo', { clock });
  w.TR.Settings.set({ shake: false, weather: 'gunduz', traffic: 'normal' });
  w.TR.FX.draw = () => {};
  const G = w.TR.Game;
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(ri, { seed: 99, mapSpec });
  w.step = () => {
    clock.t += FRAME_MS;
    w.frame();
    w.log.length = 0;
  };
  while (G.state === 'countdown') w.step();
  return w;
}

const trafficOf = (w, p) => w.TR.Game.map.segs[p.seg].traffic;

// Puts an awake car of direction dir on top of player p's cab, in the traffic of p's segment.
function carOn(w, p, dir, skip = null) {
  const tr = trafficOf(w, p), c = tr.cars.find((o) => o.dir === dir && o.dormant > 0 && o !== skip);
  c.dormant = 0;
  tr.setS(c, p.s + w.TR.TRUCK.CAB_FRONT / 2);
  c.d = c.dTarget = p.d;
  tr.place(c);
  return c;
}

function sleepAll(w) {
  for (const sg of w.TR.Game.map.segs) for (const c of sg.traffic.cars) { c.dormant = 99; c.x = c.y = 1e9; }
}

test('a truck in turbo drives through a car of its own direction, not through an oncoming one', () => {
  const w = round(), G = w.TR.Game, p = G.players[0];
  const hits = (dir, turbo) => {
    sleepAll(w);
    const c = carOn(w, p, dir);
    p.turbo = turbo;
    p.ghost = turbo > 0;
    return trafficOf(w, p).collide([p]).filter((h) => h.car === c).length;
  };
  assert.equal(hits(1, 0), 1, 'the overlap set up here is not a hit without turbo');
  assert.equal(hits(1, 5), 0);
  assert.equal(hits(-1, 5), 1);
});

// The truck stands still on the lot segment, the last one the game walks after every other segment's
// traffic, with no car moving; each frame is a full game frame.
test('a turbo that ends inside a car of its own direction is not a crash, and the next car after it is', () => {
  const w = round(), G = w.TR.Game, R = w.TR.ROAD, p = G.players[0], o = G.players[1];
  assert.ok(G.map.lotSeg > G.map.start, 'the lot segment is not walked after the start segment');
  for (const sg of G.map.segs) sg.traffic.update = () => {};
  sleepAll(w);
  const road = G.map.segs[G.map.lotSeg].road, s = road.length / 2, q = road.lanePos(s, R.LANE / 2);
  Object.assign(p, { seg: G.map.lotSeg, s, d: R.LANE / 2, hint: -1, turbo: 0, turboS: Infinity, ghost: true });
  p.truck.place(q.x, q.y, q.h);
  p.truck.v = 0;
  o.turboS = Infinity;
  const crashes = () => {
    const n = p.crashes;
    p.truck.stun = 0;
    p.crashCd = 0;
    w.step();
    return p.crashes - n;
  };
  const c = carOn(w, p, 1);
  assert.equal(crashes(), 0, 'hit by the car the turbo ended inside');
  assert.equal(p.ghost, true, 'stopped passing through while still inside the car');
  // Neither a sleeping car nor a wreck of its own direction keeps the truck passing through.
  c.dormant = 99;
  const wreck = carOn(w, p, 1, c);
  wreck.wreck = { vx: 0, vy: 0, spin: 0, t: 99 };
  assert.equal(crashes(), 0);
  assert.equal(p.ghost, false, 'still passing through once clear of every awake car of its own direction');
  sleepAll(w);
  p.ghost = true;
  carOn(w, p, -1);
  assert.equal(crashes(), 1, 'kept passing through for an oncoming car');
  sleepAll(w);
  p.ghost = false;
  carOn(w, p, 1);
  assert.equal(crashes(), 1, 'passed through a car of its own direction with no turbo');
});

test('the turbo banner shows on the HUD, and the turbo goes to an online guest in the snapshot', () => {
  const w = round(), G = w.TR.Game, p = G.players[0];
  p.turboS = Infinity;
  // frame() runs without moving the clock, so the turbo does not tick down between setting and drawing it.
  p.turbo = 5.5;
  w.frame();
  assert.ok(w.log.some((l) => l.includes('"TURBO · 6 sn"')), 'no turbo banner in the draw log');
  p.turbo = 0;
  w.frame();
  assert.ok(!w.log.some((l) => l.includes('TURBO')), 'turbo banner drawn with no turbo');
  p.turbo = 4;
  const snap = w.TR.Online.dec(w.TR.Online.enc(w.TR.Online.snapshot()));
  assert.equal(snap.p[0].turbo, 4);
});

test('the turbo point lies within its share of the shortest path', () => {
  const G = round().TR.Game, p = G.players[0];
  assert.ok(p.turboS >= G.map.shortest * 0.15 && p.turboS <= G.map.shortest * 0.7, 'turbo point ' + p.turboS + ' of ' + G.map.shortest);
  assert.ok(p.turboLen >= 5 && p.turboLen <= 10, 'turbo length ' + p.turboLen);
});

// The truck sits just short of its turbo point on the straight shortcut, past the start segment (where s and
// the distance gone are the same number), at top speed, holding the throttle without steering.
test('turbo starts once at its point, lasts its length and lifts the top speed', () => {
  const w = round(0, straightSpec()), G = w.TR.Game, T = w.TR.TRUCK, R = w.TR.ROAD;
  const p = G.players[0], o = G.players[1];
  const at = { seg: 1, s: 1000 };
  const road = G.map.segs[at.seg].road, q = road.lanePos(at.s, R.LANE / 2);
  p.turboS = G.map.shortest - G.map.distToLot(at.seg, at.s + 40);
  Object.assign(p, { seg: at.seg, s: at.s, d: R.LANE / 2, hint: -1 });
  p.truck.place(q.x, q.y, q.h);
  p.truck.v = T.MAX_FWD;
  o.turboS = Infinity;
  sleepAll(w);
  for (const sg of G.map.segs) sg.junctions.cars.length = 0;
  w.down('KeyW');
  let starts = 0, on = 0, top = 0, startS = null;
  for (let f = 0; f < 60 * 12; f++) {
    const was = p.turbo;
    w.step();
    if (p.turbo > 0 && was === 0) { starts++; startS = p.seg === at.seg ? p.s : null; }
    if (p.turbo > 0) { on++; top = Math.max(top, p.truck.v); }
    if (p.turbo > 0 && !p.ghost) assert.fail('in turbo but not passing through cars');
  }
  assert.equal(starts, 1);
  assert.ok(startS !== null && startS >= at.s + 40 && startS < at.s + 40 + T.MAX_FWD / 30, 'turbo started at ' + startS + ', its point is ' + (at.s + 40));
  assert.ok(Math.abs(on / 60 - p.turboLen) < 0.1, 'on for ' + on / 60 + ' s of ' + p.turboLen);
  assert.ok(top > T.MAX_FWD * 1.4, 'top speed in turbo ' + top);
  assert.equal(p.turbo, 0);
  assert.ok(p.truck.v <= T.MAX_FWD + 1, 'still above the normal top speed after turbo: ' + p.truck.v);
  assert.equal(o.turbo, 0);
});
