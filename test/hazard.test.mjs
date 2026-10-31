// Run: node --test test/hazard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;

// start (0,0) → fork (0,-8000) → { shortcut straight, busy 2000 east } → merge (0,-18000) → lot (0,-24000).
// features and events go on the shortcut.
function fixtureSpec(features = [], events = {}) {
  const seg = (id, a, b, role, flow, detour, f = [], ev = {}) => ({
    id, a, b, role, flow, detour, curvy: 0, tight: 1, wseed: 11 + id, features: f, events: Object.assign({ flock: false, work: false }, ev),
  });
  return {
    ri: 0, seed: 1, attempt: 0, jams: [],
    nodes: [
      { id: 0, x: 0, y: 0, kind: 'start' },
      { id: 1, x: 0, y: -8000, kind: 'fork' },
      { id: 2, x: 0, y: -18000, kind: 'merge' },
      { id: 3, x: 0, y: -24000, kind: 'lot' },
    ],
    segs: [seg(0, 0, 1, 'trunk', 1, 0), seg(1, 1, 2, 'shortcut', 0.6, 0, features, events), seg(2, 1, 2, 'busy', 1.5, 2000), seg(3, 2, 3, 'trunk', 1, 0)],
  };
}
const SHORTCUT = 1, BUSY = 2, LOT = 3;

// A round in play with no car moving, so every car is where the test puts it. Junctions keep their own
// update (lights, radars) unless still is set, which freezes them too; events keep theirs only with events.
function world(features, still = false, events = null) {
  const clock = { t: 1000 };
  const w = makeWorld('hazard', { clock });
  const TR = w.TR, G = TR.Game;
  TR.Settings.set({ traffic: 'normal', weather: 'gunduz', shake: false });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(0, { seed: 1, mapSpec: fixtureSpec(features, events || {}) });
  for (const sg of G.map.segs) {
    sg.traffic.cars.length = 0;
    sg.traffic.update = () => {};
    sg.junctions.cars.length = 0;
    if (still) sg.junctions.update = () => [];
    if (!events) sg.events.update = () => [];
  }
  // put() jumps a truck past its turbo point, and a truck in turbo drives through cars.
  for (const p of G.players) p.turboS = Infinity;
  G.map.draw = () => {};
  TR.Light.draw = () => {};
  TR.HUD.draw = () => {};
  w.step = () => {
    clock.t += FRAME_MS;
    w.frame();
  };
  while (G.state === 'countdown') w.step();
  return w;
}

const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

function put(w, p, seg, s, d, v = 0) {
  const q = w.TR.Game.map.segs[seg].road.lanePos(s, d);
  p.truck.place(q.x, q.y, q.h);
  p.truck.v = v;
  p.seg = seg;
  p.s = s;
  p.d = d;
  p.hint = -1;
}

function park(w, p) {
  p.truck.place(p.idx * 900 - 6000, 2000, -Math.PI / 2);
  p.truck.v = 0;
  p.seg = w.TR.Game.map.start;
  p.hint = -1;
}

function hold(w, p, inp) {
  w.TR.Input.sources[p.idx] = () => Object.assign({}, NONE, inp);
}

// Drives p along lane of seg at full throttle.
function drive(w, p, seg, lane) {
  const TR = w.TR, U = TR.U, road = TR.Game.map.segs[seg].road;
  TR.Input.sources[p.idx] = () => {
    const t = p.truck, q = road.lanePos(road.locate(t.x, t.y, -1).s + 300, lane);
    return Object.assign({}, NONE, { thr: 1, steer: U.clamp(U.wrap(Math.atan2(q.y - t.y, q.x - t.x) - t.th) * 4, -1, 1) });
  };
}

// A car of seg's traffic standing at (s, d), moving in dir.
function carOn(w, seg, dir, s, d) {
  const tr = w.TR.Game.map.segs[seg].traffic, c = tr.makeCar(dir);
  Object.assign(c, { kind: 'car', len: 40, wid: 20 });
  tr.setS(c, s);
  c.d = c.dTarget = d;
  tr.place(c);
  tr.cars.push(c);
  return c;
}

function runUntil(w, max, done) {
  for (let f = 0; f < max && !done(); f++) w.step();
}

test('a truck that runs into a car is a crash on every segment', () => {
  const count = world().TR.Game.map.segs.length;
  for (let k = 0; k < count; k++) {
    const w = world([], true), G = w.TR.Game, R = w.TR.ROAD, [p, o] = G.players, mid = G.map.segs[k].road.length / 2;
    park(w, o);
    put(w, p, k, mid, R.LANE / 2, 150);
    hold(w, p, { thr: 1 });
    const c = carOn(w, k, 1, mid + 200, R.LANE / 2);
    runUntil(w, 120, () => p.crashes > 0);
    assert.equal(p.crashes, 1, 'segment ' + k + ': no crash');
    assert.ok(c.wreck, 'segment ' + k + ': the car is no wreck');
  }
});

test('a truck that runs into a side road car is a crash on every segment', () => {
  const count = world().TR.Game.map.segs.length;
  for (let k = 0; k < count; k++) {
    const w = world([], true), TR = w.TR, G = TR.Game, R = TR.ROAD, [p, o] = G.players, road = G.map.segs[k].road, mid = road.length / 2;
    park(w, o);
    put(w, p, k, mid, R.LANE / 2, 150);
    hold(w, p, { thr: 1 });
    const q = road.lanePos(mid + 200, R.LANE / 2);
    const c = { id: 1, path: null, pos: 0, kind: 'car', len: 40, wid: 20, color: '#fff', vBase: 0, v: 0, x: q.x, y: q.y, h: q.h + Math.PI / 2, wreck: null, brake: false, flash: 0 };
    G.map.segs[k].junctions.cars.push(c);
    runUntil(w, 120, () => p.crashes > 0);
    assert.equal(p.crashes, 1, 'segment ' + k + ': no crash');
    assert.ok(c.wreck, 'segment ' + k + ': the side car is no wreck');
  }
});

// Past a fork the branches still overlap, so a truck on one runs into the other's cars.
test('a sibling branch car is a crash where the branches overlap', () => {
  const w = world([], true), TR = w.TR, G = TR.Game, R = TR.ROAD, [p, o] = G.players, busy = G.map.segs[BUSY].road;
  park(w, o);
  const q = busy.lanePos(60, R.LANE / 2), own = G.map.segs[SHORTCUT].road.locate(q.x, q.y, -1);
  put(w, p, SHORTCUT, own.s, own.d, 150);
  hold(w, p, { thr: 1 });
  const c = carOn(w, BUSY, 1, 260, R.LANE / 2);
  let seg = null;
  runUntil(w, 120, () => (p.crashes > 0 ? ((seg = p.seg), true) : false));
  assert.equal(p.crashes, 1, 'no crash');
  assert.equal(seg, SHORTCUT, 'the truck was not on the shortcut when it crashed');
  assert.ok(c.wreck);
});

// Two oncoming cars stand the same s and d apart from the truck's lane, one on its segment and one on the
// sibling branch; only the one on its own segment is a near miss.
test('a near miss counts on the truck\'s own segment only', () => {
  const w = world([], true), TR = w.TR, G = TR.Game, R = TR.ROAD, T = TR.TRUCK, [p, o] = G.players;
  park(w, o);
  put(w, p, SHORTCUT, 4000, R.LANE / 2, 200);
  hold(w, p, { thr: 1 });
  // 6 between the car's side and the truck's: closer than a near miss needs, clear of a crash.
  const d = R.LANE / 2 - (10 + Math.max(T.CAB_HW, T.TR_HW) + 6);
  const mine = carOn(w, SHORTCUT, -1, 4500, d), other = carOn(w, BUSY, -1, 4500, d);
  runUntil(w, 600, () => p.s > 4900);
  assert.ok(p.s > 4900, 'the truck stopped at s ' + p.s.toFixed(0));
  assert.equal(p.crashes, 0);
  assert.ok(!mine.wreck && !other.wreck);
  assert.ok(mine.nearDone[p.idx], 'the truck never cleared the car');
  assert.equal(p.nearMisses, 1);
});

test('a radar fines only the trucks on its segment', () => {
  const w = world([{ type: 'radar', rise: 4000, kmh: 40 }]), TR = w.TR, G = TR.Game, R = TR.ROAD, [a, b] = G.players;
  put(w, a, SHORTCUT, 3500, R.LANE / 2, 200);
  put(w, b, BUSY, 3500, R.LANE / 2, 200);
  drive(w, a, SHORTCUT, R.LANE / 2);
  drive(w, b, BUSY, R.LANE / 2);
  runUntil(w, 600, () => a.s > 4300 && b.s > 4300);
  assert.equal(a.seg, SHORTCUT);
  assert.equal(b.seg, BUSY);
  assert.ok(a.s > 4300 && b.s > 4300, 'a truck stopped short: ' + a.s.toFixed(0) + ', ' + b.s.toFixed(0));
  assert.equal(a.speeding, 1, 'the speeding truck on the radar segment');
  assert.equal(b.speeding, 0, 'the truck on the sibling branch');
});

// The car ahead moves over for the horn unless a truck holds the lane it would move into; a truck on the
// sibling branch at the same s does not.
test('a car yields to the horn past a truck on the sibling branch', () => {
  const w = world([], true), TR = w.TR, G = TR.Game, R = TR.ROAD, T = TR.TRUCK, [a, b] = G.players;
  put(w, a, SHORTCUT, 5000, R.LANE / 2);
  put(w, b, BUSY, 5000, R.LANE * 1.5);
  hold(w, a, { horn: true });
  hold(w, b, {});
  const c = carOn(w, SHORTCUT, 1, 5000 + T.CAB_FRONT + 150, R.LANE / 2);
  w.step();
  assert.equal(b.seg, BUSY);
  assert.equal(c.dTarget, R.LANE * 1.5, 'the car did not move over');
});

// A car honked at with a car beside it, and the truck stopped behind it at s0. Only the shortcut's traffic
// moves. The other truck is parked unless sib puts it on the busy branch beside the first, in its outer lane.
function hornBlocked(w, s0 = 5000, sib = false) {
  const TR = w.TR, G = TR.Game, R = TR.ROAD, T = TR.TRUCK, [a, b] = G.players;
  delete G.map.segs[SHORTCUT].traffic.update;
  if (sib) put(w, b, BUSY, s0, R.LANE * 1.5);
  else park(w, b);
  put(w, a, SHORTCUT, s0, R.LANE / 2);
  hold(w, b, {});
  const s = s0 + T.CAB_FRONT + 150;
  const c = carOn(w, SHORTCUT, 1, s, R.LANE / 2), side = carOn(w, SHORTCUT, 1, s, R.LANE * 1.5);
  for (const o of [c, side]) Object.assign(o, { v: 100, vBase: 100, laneT: Infinity });
  hold(w, a, { horn: true });
  w.step();
  hold(w, a, {});
  for (let f = 0; f < 30; f++) {
    w.step();
    assert.equal(c.dTarget, R.LANE / 2, 'frame ' + f + ': the car moved into a taken lane');
  }
  return { a, c, side };
}

test('a car honked at moves over once the lane beside it clears', () => {
  const w = world([], true), R = w.TR.ROAD, { c, side } = hornBlocked(w);
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  w.step();
  assert.equal(c.dTarget, R.LANE * 1.5, 'the car did not move over');
});

test('a car honked at forgets the horn once the truck is out of range', () => {
  const w = world([], true), R = w.TR.ROAD, T = w.TR.TRUCK, { a, c, side } = hornBlocked(w);
  runUntil(w, 600, () => c.s - a.s - T.CAB_FRONT > 420);
  assert.ok(c.s - a.s - T.CAB_FRONT > 420, 'the car stayed in range');
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  for (let f = 0; f < 30; f++) w.step();
  assert.equal(c.dTarget, R.LANE / 2, 'the car moved over for a stale horn');
});

test('a car honked at near the fork moves over past a truck on the sibling branch', () => {
  const w = world([], true), R = w.TR.ROAD, { c, side } = hornBlocked(w, 1500, true);
  assert.ok(1500 < w.TR.MAP.LINK_R, 'the trucks are not near the fork');
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  w.step();
  assert.equal(c.dTarget, R.LANE * 1.5, 'the car did not move over');
});

test('a car honked at forgets the horn once the truck leaves its segment', () => {
  const w = world([], true), R = w.TR.ROAD, { a, c, side } = hornBlocked(w);
  put(w, a, BUSY, 5000, R.LANE / 2);
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  for (let f = 0; f < 30; f++) w.step();
  assert.equal(c.dTarget, R.LANE / 2, 'the car moved over for a truck on another segment');
  assert.equal(c.hornBy, null);
});

test('a car that moved over for the horn does not move back when the truck follows it', () => {
  const w = world([], true), R = w.TR.ROAD, T = w.TR.TRUCK, { a, c, side } = hornBlocked(w);
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  w.step();
  assert.equal(c.dTarget, R.LANE * 1.5, 'the car did not move over');
  put(w, a, SHORTCUT, c.s - T.CAB_FRONT - 150, R.LANE * 1.5);
  for (let f = 0; f < 120; f++) {
    w.step();
    assert.equal(c.dTarget, R.LANE * 1.5, 'frame ' + f + ': the car moved back');
  }
  assert.equal(c.d, c.dTarget, 'the car never settled in its new lane');
});

test('a car honked at in the middle of a lane change keeps on with it', () => {
  const w = world([], true), R = w.TR.ROAD, { c, side } = hornBlocked(w);
  w.TR.Game.map.segs[SHORTCUT].traffic.retire(side);
  // As the car's own lane change (laneT) starts one.
  c.lane = 1;
  c.dTarget = R.LANE * 1.5;
  for (let f = 0; f < 30; f++) {
    w.step();
    assert.equal(c.dTarget, R.LANE * 1.5, 'frame ' + f + ': the car turned back');
  }
});

const BEAM = '255,244,200';

test('the headlights blink with the horn, and only then', () => {
  const w = world([], true), R = w.TR.ROAD, [a, b] = w.TR.Game.players;
  put(w, a, SHORTCUT, 5000, R.LANE / 2);
  put(w, b, BUSY, 5000, R.LANE / 2);
  hold(w, b, {});
  const lit = () => {
    w.log.length = 0;
    w.step();
    return w.log.some((l) => l.includes(BEAM));
  };
  hold(w, a, {});
  for (let f = 0; f < 60; f++) assert.equal(lit(), false, 'frame ' + f + ': lit before the horn');
  // Only frames drawn while the flash still runs: the one where it runs out is dark anyway.
  const seen = [];
  hold(w, a, { horn: true });
  for (let f = 0; f < 600; f++) {
    const on = lit();
    hold(w, a, {});
    if (a.truck.flash <= 0) break;
    seen.push(on);
  }
  assert.ok(seen.length < 600, 'the flash never ended');
  assert.ok(seen.length > 60, 'the flash lasted ' + seen.length + ' frames');
  assert.ok(seen.filter(Boolean).length > 10, 'the headlights were on for ' + seen.filter(Boolean).length + ' frames');
  assert.ok(seen.some((x) => !x), 'the headlights did not blink');
  for (let f = 0; f < 60; f++) assert.equal(lit(), false, 'frame ' + f + ': lit after the flash');
});

test('a horn just before the park ends leaves no headlights on through the unload', () => {
  const w = world([], true), TR = w.TR, G = TR.Game, T = TR.TRUCK, [a, b] = G.players;
  park(w, b);
  hold(w, b, {});
  hold(w, a, {});
  const bay = G.lot.bays[0];
  a.cargo = TR.BOXES.map((_, i) => i);
  a.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  runUntil(w, 600, () => a.phase === 'park');
  assert.equal(a.phase, 'park');
  // Late enough in the park hold that the flash is still lit when the unload starts.
  for (let f = 0; f < 8; f++) w.step();
  hold(w, a, { horn: true });
  w.step();
  hold(w, a, {});
  runUntil(w, 600, () => a.phase === 'unload');
  assert.equal(a.phase, 'unload');
  for (let f = 0; f < 120; f++) {
    w.log.length = 0;
    w.step();
    assert.ok(!w.log.some((l) => l.includes(BEAM)), 'frame ' + f + ' of the unload: the headlights are on');
  }
});

test('the red light ahead comes from the truck\'s own segment', () => {
  const w = world([{ type: 'cross', rise: 5000 }]), TR = w.TR, G = TR.Game, R = TR.ROAD, T = TR.TRUCK, [a, b] = G.players;
  const cross = G.map.segs[SHORTCUT].road.points[0];
  put(w, a, SHORTCUT, cross.s - 400, R.LANE / 2);
  put(w, b, BUSY, cross.s - 400, R.LANE / 2);
  hold(w, a, {});
  hold(w, b, {});
  const seen = [];
  // A whole light cycle, a little over 20 s.
  for (let f = 0; f < 60 * 24; f++) {
    w.step();
    assert.equal(b.redAhead, Infinity, 'frame ' + f + ': the truck on the sibling branch sees a red light');
    if (a.redAhead !== Infinity) seen.push(a.redAhead);
  }
  assert.equal(a.seg, SHORTCUT);
  assert.ok(seen.length > 0, 'the light ahead was never red');
  assert.ok(seen.length < 60 * 24, 'the light ahead was never green');
  // The stop line is 82 (SIDE_HW + STOP_GAP) south of the crossing; the truck's nose CAB_FRONT ahead of s.
  for (const v of seen) assert.ok(Math.abs(v - (cross.s - 82 - (a.s + T.CAB_FRONT))) < 1, 'red ahead ' + v.toFixed(1));
});

// Q11: driving back south past a crossing and a radar, and north past them again, is no second fine. The
// light is held red and the truck runs over the radar's limit on every pass, so only the first counts.
test('a truck fined at a red light and a radar is not fined again after turning back', () => {
  const w = world([{ type: 'cross', rise: 4000 }, { type: 'radar', rise: 5000, kmh: 40 }]);
  const TR = w.TR, G = TR.Game, R = TR.ROAD, U = TR.U, [a, b] = G.players, J = G.map.segs[SHORTCUT].junctions;
  const [cross, radar] = J.states.map((st) => st.j);
  assert.deepEqual([cross.type, radar.type], ['cross', 'radar']);
  let red = 0;
  for (; red < 30; red += 0.25) {
    const ev = [];
    J.time = red;
    J.judge({ j: cross, passed: [false, false], flash: 0, front: [-Infinity, -Infinity], gates: null }, 0, [{ phase: 'race', idx: 0, s: cross.s, d: 0, truck: { v: 0 } }], ev);
    if (ev.length) break;
  }
  assert.ok(red < 30, 'the crossing never shows red');
  for (const P of J.paths) P.spawn = false;
  const update = J.update.bind(J);
  J.update = (dt, on) => update(dt, on, red);
  park(w, b);
  const lane = R.LANE / 2, fast = 40 / 0.36 + 20;
  // Drives a on the shortcut's lane north (way 1) or south (way -1) from s0 until done().
  const pass = (s0, way, done) => {
    put(w, a, SHORTCUT, s0, lane, 200);
    if (way < 0) a.truck.place(a.truck.x, a.truck.y, a.truck.th + Math.PI);
    a.truck.v = 200;
    const road = G.map.segs[SHORTCUT].road;
    TR.Input.sources[a.idx] = () => {
      const t = a.truck, q = road.lanePos(road.locate(t.x, t.y, -1).s + 300 * way, lane);
      return Object.assign({}, NONE, { thr: t.v < 220 ? 1 : 0, steer: U.clamp(U.wrap(Math.atan2(q.y - t.y, q.x - t.x) - t.th) * 4, -1, 1) });
    };
    runUntil(w, 600, done);
    assert.ok(done(), 'the truck stopped at s ' + a.s.toFixed(0));
    assert.ok(a.truck.v > fast, 'the truck was under the radar\'s limit: ' + a.truck.v.toFixed(0));
    assert.equal(a.seg, SHORTCUT);
  };
  pass(cross.s - 600, 1, () => a.s > radar.s + 300);
  assert.deepEqual([a.redLights, a.speeding], [1, 1], 'the first pass north');
  pass(radar.s + 300, -1, () => a.s < cross.s - 600);
  assert.deepEqual([a.redLights, a.speeding], [1, 1], 'the pass back south');
  pass(cross.s - 600, 1, () => a.s > radar.s + 300);
  assert.deepEqual([a.redLights, a.speeding], [1, 1], 'the second pass north');
  assert.equal(a.crashes, 0);
});

const FLOCK_AT = { flock: { rise: 5000 } };

test('a truck that runs into the sheep on its segment is slowed and stunned', () => {
  const w = world([], true, FLOCK_AT), TR = w.TR, G = TR.Game, R = TR.ROAD, [p, o] = G.players, ev = G.map.segs[SHORTCUT].events;
  park(w, o);
  const f = ev.flocks[0];
  assert.ok(f, 'no flock on the shortcut');
  // The flock stands across the truck's lane already, so it is not waiting to cross.
  for (const q of f.sheep) {
    q.d = q.goal = R.LANE / 2 + (q.d % 20);
    ev.placeSheep(q, f, 0);
  }
  f.met = [true, true];
  put(w, p, SHORTCUT, f.s - 300, R.LANE / 2, 200);
  hold(w, p, { thr: 1 });
  let hit = null;
  runUntil(w, 120, () => (p.truck.stun > 0 ? ((hit = { v: p.truck.v, toast: p.toast }), true) : false));
  assert.ok(hit, 'the truck never met the sheep');
  assert.ok(hit.v <= 60 + 1, 'not slowed: ' + hit.v.toFixed(0));
  assert.equal(hit.toast, 'KOYUNLAR KAÇIŞTI!');
});

test('a truck on the sibling branch does not start the flock crossing', () => {
  const run = (seg) => {
    const w = world([], true, FLOCK_AT), TR = w.TR, G = TR.Game, R = TR.ROAD, [p, o] = G.players, f = G.map.segs[SHORTCUT].events.flocks[0];
    park(w, o);
    put(w, p, seg, f.s - 1500, R.LANE / 2, 150);
    drive(w, p, seg, R.LANE / 2);
    let crossing = false;
    runUntil(w, 600, () => (crossing = crossing || f.crossing, p.s > f.s - 500));
    assert.equal(p.seg, seg);
    return crossing;
  };
  assert.equal(run(SHORTCUT), true, 'a truck on the flock\'s segment never set it crossing');
  assert.equal(run(BUSY), false, 'a truck on the sibling branch set it crossing');
});

test('recover past the lot road end puts the truck back at its end', () => {
  const w = world([], true), TR = w.TR, G = TR.Game, R = TR.ROAD, [p, o] = G.players, lot = G.map.segs[LOT].road;
  park(w, o);
  // The lot takes the truck 40 past the road end.
  put(w, p, LOT, lot.length + 30, R.LANE / 2);
  hold(w, p, {});
  w.step();
  assert.equal(p.phase, 'race', 'already in the lot');
  assert.ok(p.s > lot.length + 20, 'not past the road end: s ' + p.s.toFixed(0));
  hold(w, p, { reset: true });
  w.step();
  hold(w, p, {});
  w.step();
  assert.equal(p.resets, 1);
  const c = lot.locate(p.truck.x, p.truck.y, -1);
  assert.ok(Math.abs(c.s - lot.length) < 1, 'placed at s ' + c.s.toFixed(1) + ' of ' + lot.length.toFixed(1));
});
