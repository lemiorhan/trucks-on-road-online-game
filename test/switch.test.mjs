// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;

// start (0,0) → fork (0,-8000) → { shortcut straight, busy 2000 east, quiet 2000 west } → merge (0,-18000)
// → lot (0,-24000).
function fixtureSpec() {
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
    segs: [
      seg(0, 0, 1, 'trunk', 1, 0), seg(1, 1, 2, 'shortcut', 0.6, 0), seg(2, 1, 2, 'busy', 1.5, 2000),
      seg(3, 1, 2, 'quiet', 0.4, -2000), seg(4, 2, 3, 'trunk', 1, 0),
    ],
  };
}
const SHORTCUT = 1, EAST = 2, WEST = 3, OUT = 4;

// A round in play with no traffic, junction cars or events, and nothing drawn but the frame itself, so a
// truck's run depends only on its own input.
function world(ri, opts) {
  const clock = { t: 1000 };
  const w = makeWorld('switch', { clock });
  const TR = w.TR, G = TR.Game;
  TR.Settings.set({ traffic: 'normal', weather: 'gunduz' });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(ri, opts);
  for (const sg of G.map.segs) {
    sg.traffic.cars.length = 0;
    sg.traffic.update = () => {};
    sg.junctions.cars.length = 0;
    sg.junctions.update = () => [];
    sg.events.update = () => [];
  }
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
const fixture = () => world(0, { seed: 1, mapSpec: fixtureSpec() });

// Puts player p on segment seg at (s, d), heading along the road at speed v; the other player waits far
// off to the side.
function put(w, p, seg, s, d, v = 0) {
  const G = w.TR.Game, q = G.map.segs[seg].road.lanePos(s, d);
  p.truck.place(q.x, q.y, q.h);
  p.truck.v = v;
  p.seg = seg;
  p.s = s;
  p.hint = -1;
}
function park(w, p) {
  p.truck.place(p.idx * 900 - 6000, 2000, -Math.PI / 2);
  p.truck.v = 0;
  p.seg = w.TR.Game.map.start;
  p.hint = -1;
}

const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

// Drives p along lane of each segment of path in turn, aiming look ahead, at up to vmax.
function drive(w, p, path, lane, vmax = 200, look = 300) {
  const TR = w.TR, U = TR.U, segs = TR.Game.map.segs;
  TR.Input.sources[p.idx] = () => {
    const t = p.truck;
    let road;
    for (const k of path) {
      road = segs[k].road;
      if (road.locate(t.x, t.y, -1).s < road.length) break;
    }
    const q = road.lanePos(road.locate(t.x, t.y, -1).s + look, lane);
    const err = U.wrap(Math.atan2(q.y - t.y, q.x - t.x) - t.th);    return Object.assign({}, NONE, { thr: t.v < vmax ? 1 : 0, steer: U.clamp(err * 4, -1, 1) });
  };
}
function hold(w, p, inp) {
  w.TR.Input.sources[p.idx] = () => Object.assign({}, NONE, inp);
}

// Every segment whose corridor, HALF either side of its centre line between its ends, holds (x, y).
function corridors(TR, x, y) {
  return TR.Game.map.segs.filter((sg) => {
    const c = sg.road.locate(x, y, -1);
    return c.s >= 0 && c.s <= sg.road.length && Math.abs(c.d) <= TR.ROAD.HALF;
  }).map((sg) => sg.id);
}

// Steps until done() or max frames, and returns one row per frame.
function run(w, p, max, done) {
  const rows = [];
  for (let f = 0; f < max; f++) {
    w.step();
    rows.push({ seg: p.seg, s: p.s, d: p.d, offroad: p.offroad, phase: p.phase, x: p.truck.x, y: p.truck.y, inside: corridors(w.TR, p.truck.x, p.truck.y) });
    if (done(rows[rows.length - 1])) break;
  }
  return rows;
}

// How far into seg a run goes: out of its first node's reach, or halfway on a segment too short for that.
const past = (TR, seg) => Math.min(TR.MAP.NODE_R, TR.Game.map.segs[seg].road.length / 2) + 100;

// From the frame p first lands on seg it stays there on every later frame, and the run ends past the
// node it entered by.
function assertTakes(TR, rows, seg, what) {
  const first = rows.findIndex((r) => r.seg === seg);
  assert.ok(first >= 0, what + ': never on segment ' + seg + ', last on ' + rows[rows.length - 1].seg);
  rows.slice(first).forEach((r, f) => assert.equal(r.seg, seg, what + ': left segment ' + seg + ' on frame ' + (first + f)));
  const last = rows[rows.length - 1];
  assert.ok(last.s >= past(TR, seg), what + ': the run ended inside a node, at s ' + last.s.toFixed(0));}

function assertOnRoad(rows, what) {
  rows.forEach((r, f) => assert.ok(!(r.offroad && r.inside.length), what + ': offroad on frame ' + f + ' inside segment ' + r.inside));
}

function throughFork(seg) {
  const w = fixture(), TR = w.TR, G = TR.Game, p = G.players[0];
  park(w, G.players[1]);
  put(w, p, 0, G.map.segs[0].road.length - 1500, TR.ROAD.LANE / 2, 200);
  drive(w, p, [0, seg], TR.ROAD.LANE / 2);
  const rows = run(w, p, 2400, (r) => r.seg === seg && r.s >= past(TR, seg));
  return { w, rows };
}

test('steer west, take west', () => {
  const { w, rows } = throughFork(WEST);
  assertTakes(w.TR, rows, WEST, 'west');
  assertOnRoad(rows, 'west');
});

test('steer east, take east', () => {
  const { w, rows } = throughFork(EAST);
  assertTakes(w.TR, rows, EAST, 'east');
  assertOnRoad(rows, 'east');
});

test('merge', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, [a, b] = G.players, R = TR.ROAD;
  put(w, a, WEST, G.map.segs[WEST].road.length - 2000, R.LANE / 2, 200);
  put(w, b, EAST, G.map.segs[EAST].road.length - 2600, R.LANE * 1.5, 200);
  drive(w, a, [WEST, OUT], R.LANE / 2);
  drive(w, b, [EAST, OUT], R.LANE * 1.5);
  const rows = { a: [], b: [] };
  for (let f = 0; f < 2400; f++) {
    w.step();
    for (const [k, p] of [['a', a], ['b', b]]) rows[k].push({ seg: p.seg, s: p.s, offroad: p.offroad, inside: corridors(TR, p.truck.x, p.truck.y) });
    if ([a, b].every((p) => p.seg === OUT && p.s >= past(TR, OUT))) break;
  }
  assertTakes(TR, rows.a, OUT, 'from the west');
  assertTakes(TR, rows.b, OUT, 'from the east');
  assertOnRoad(rows.a, 'from the west');
  assertOnRoad(rows.b, 'from the east');
});

// The s on the shortcut, north of the fork, where the east branch first runs sep east of it.
function sepAt(TR, sep) {
  const segs = TR.Game.map.segs, B = segs[EAST].road, A = segs[SHORTCUT].road;
  for (let s = 0; s < TR.MAP.NODE_R; s += 4) {
    const q = B.posAt(s, 0), c = A.locate(q.x, q.y, -1);
    if (c.d >= sep) return c.s;
  }
  throw new Error('the branches never part by ' + sep);
}

test('rails at a fork', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, R = TR.ROAD, p = G.players[0];
  park(w, G.players[1]);
  // Where the branches run 260 apart a truck 140 east of the shortcut overhangs its rail and sits inside
  // the east branch's: it must not be pushed, and it keeps to one segment.
  const s = sepAt(TR, 260);
  put(w, p, SHORTCUT, s, 140);
  hold(w, p, {});
  const at = [p.truck.x, p.truck.y];
  w.step();
  const seg = p.seg;
  for (let f = 0; f < 30; f++) {
    if (f) w.step();
    assert.equal(p.seg, seg, 'frame ' + f + ': the truck changed segment standing still');
    assert.deepEqual([p.truck.x, p.truck.y], at, 'frame ' + f + ': pushed inside the east branch');
  }
  const over = Math.max(...p.truck.boxes().flatMap((b) => TR.U.corners(b)).map((c) => Math.abs(G.map.segs[SHORTCUT].road.locate(c.x, c.y, -1).d)));
  assert.ok(over > R.RAIL, 'no corner overhangs the shortcut rail: ' + over.toFixed(1));
  assert.equal(p.bumps, 0);

  // Straight north on the shortcut's rail line, the truck rides between both rails until the branches
  // part, then meets the gore tip.
  const g = fixture(), q = g.TR.Game.players[0];
  park(g, g.TR.Game.players[1]);
  put(g, q, SHORTCUT, sepAt(g.TR, 100), R.RAIL, 150);
  hold(g, q, { thr: 1 });
  const tip = g.TR.Game.map.segs[SHORTCUT].road.posAt(sepAt(g.TR, 2 * R.RAIL - 50), 0).y;
  const rows = run(g, q, 300, () => q.bumps > 0);
  assert.ok(q.bumps > 0, 'never pushed at the gore');
  const y = rows[rows.length - 1].y;
  assert.ok(y < tip, 'pushed at y ' + y.toFixed(0) + ', south of the gore tip at ' + tip.toFixed(0));
});

test('offroad at a merge', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, R = TR.ROAD, MAP = TR.MAP, p = G.players[0];
  park(w, G.players[1]);
  const east = G.map.segs[EAST].road, short = G.map.segs[SHORTCUT].road;
  let s = east.length - MAP.NODE_R;
  while (short.locate(east.posAt(s, 0).x, east.posAt(s, 0).y, -1).d > 340) s += 4;
  put(w, p, EAST, s, R.LANE / 2, 80);
  drive(w, p, [SHORTCUT, OUT], R.LANE / 2, 80, 60);
  const rows = run(w, p, 600, (r) => r.seg === OUT);
  assert.ok(rows.some((r) => r.seg === SHORTCUT), 'the lane change never reached the shortcut');
  assertOnRoad(rows, 'lane change');
  // The truck leaves the branch at its asphalt's edge, onto the one whose asphalt holds it; d is taken
  // before the frame's move and inside after it, hence the 4.
  rows.forEach((r, f) => assert.ok(!r.inside.length || Math.abs(r.d) <= R.HALF + 4, 'frame ' + f + ': d ' + r.d.toFixed(1) + ' on segment ' + r.seg + ' inside ' + r.inside));
  assert.ok(rows.some((r) => r.inside.length > 1), 'no frame lay inside two segments');
});

test('offroad past the lot road end', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, R = TR.ROAD, p = G.players[0];
  park(w, G.players[1]);
  const lot = G.map.segs[OUT].road;
  put(w, p, OUT, lot.length + 1, R.HALF + 17, 100);
  hold(w, p, { thr: 1 });
  const rows = run(w, p, 600, (r) => r.phase === 'park');
  assert.equal(rows[rows.length - 1].phase, 'park', 'never reached the lot');
  assert.ok(rows.some((r) => Math.abs(r.d) > R.HALF + 4), 'never off centre');
  rows.forEach((r, f) => assert.equal(r.offroad, false, 'offroad on frame ' + f + ' at d ' + r.d.toFixed(1)));
});

test('rank by distance', () => {
  const w = fixture(), G = w.TR.Game, [a, b] = G.players;
  put(w, a, EAST, 4100, 27);
  put(w, b, SHORTCUT, 4000, 81);
  hold(w, a, {});
  hold(w, b, {});
  for (let f = 0; f < 30; f++) {
    w.step();
    assert.ok(b.s < a.s, 'frame ' + f + ': b is not behind on s');
    assert.ok(G.map.distToLot(b.seg, b.s) < G.map.distToLot(a.seg, a.s), 'frame ' + f + ': b is not nearer the lot');
    assert.deepEqual([G.rankOf(a), G.rankOf(b)], [2, 1], 'frame ' + f);
  }
});

test('draft same segment', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, T = TR.TRUCK, [a, b] = G.players;
  put(w, a, SHORTCUT, 1100, 27, 200);
  put(w, b, EAST, 1350, 27, 200);
  drive(w, a, [SHORTCUT], 27);
  drive(w, b, [EAST], 27);
  let zone = 0;
  for (let f = 0; f < 60; f++) {
    w.step();
    const gap = b.s - a.s - (T.LT + T.TR_REAR + T.CAB_FRONT);
    if (gap > 0 && gap < 380 && Math.abs(b.d - a.d) < 30 && a.truck.v > 120) zone++;
    assert.equal(a.draft, 0, 'frame ' + f + ': drafting a truck on a sibling branch');
  }
  assert.ok(zone > 0, 'the trucks were never in slipstream range');
});

test('draft facing south', () => {
  const w = fixture(), TR = w.TR, G = TR.Game, T = TR.TRUCK, [a, b] = G.players;
  const lead = T.LT + T.TR_REAR + T.CAB_FRONT;
  put(w, b, SHORTCUT, 1600, 27);
  put(w, a, SHORTCUT, 1600 - lead - 150, 27);
  a.truck.place(a.truck.x, a.truck.y, a.truck.th + Math.PI);
  a.truck.v = 200;
  hold(w, a, { thr: 1 });
  hold(w, b, {});
  let zone = 0;
  for (let f = 0; f < 60; f++) {
    w.step();
    const gap = b.s - a.s - lead;
    if (a.seg === b.seg && gap > 0 && gap < 380 && Math.abs(b.d - a.d) < 30 && a.truck.v > 120) zone++;
    assert.equal(a.draft, 0, 'frame ' + f + ': drafting while heading south');
  }
  assert.ok(zone > 0, 'the trucks were never in slipstream range');
  assert.ok(a.s < 1600 - lead - 150, 'the truck did not drive south');
});

test('recover on segment', () => {
  for (const s0 of [200, 5000]) {
    const w = fixture(), TR = w.TR, G = TR.Game, R = TR.ROAD, p = G.players[0];
    park(w, G.players[1]);
    put(w, p, EAST, s0, 600);
    w.step();
    w.down('KeyQ');
    w.step();
    w.up('KeyQ');
    for (let f = 0; f < 5; f++) w.step();
    const c = G.map.segs[EAST].road.locate(p.truck.x, p.truck.y, -1);
    assert.equal(p.seg, EAST, 's ' + s0 + ': segment');
    assert.equal(p.resets, 1, 's ' + s0 + ': resets');
    assert.ok(Math.abs(c.d) < R.HALF, 's ' + s0 + ': d ' + c.d.toFixed(1));
    assert.ok(p.s >= TR.MAP.NODE_CLEAR, 's ' + s0 + ': s ' + p.s.toFixed(0));
  }
});

// One generated map per route, every fork and every merge of it, each branch driven in both northbound
// lanes: from the frame the truck first lands on the segment it follows it stays there, before a merge it
// never leaves the branch it follows, and on every frame its own segment's asphalt holds it.
test('either lane keeps its branch through every fork and merge', () => {
  // A speed and a look ahead at which the driver holds its lane through the bends.
  const SEED = 4242, V = 160, LOOK = 200;
  let forks = 0, merges = 0, routes = 0;
  const count = world(0, { seed: SEED }).TR.ROUTES.length;
  for (let ri = 0; ri < count; ri++) {
    const w = world(ri, { seed: SEED }), TR = w.TR, G = TR.Game, map = G.map, p = G.players[0], R = TR.ROAD;
    const onAsphalt = (rows, at) => rows.forEach((r, f) => assert.ok(Math.abs(r.d) <= R.HALF, at + ': d ' + r.d.toFixed(1) + ' on segment ' + r.seg + ' at frame ' + f));
    routes++;
    park(w, G.players[1]);
    const name = TR.ROUTES[ri].id;
    for (const sg of map.segs) {
      const into = sg.out.length > 1 ? sg.out : [];
      if (into.length) forks++;
      for (const b of into) {
        for (const lane of [R.LANE / 2, R.LANE * 1.5]) {
          const at = name + ' fork ' + sg.id + ' into ' + b + ' lane ' + lane;
          put(w, p, sg.id, sg.road.length - 1500, lane, V);
          drive(w, p, [sg.id, b], lane, V, LOOK);
          const rows = run(w, p, 3000, (r) => r.seg === b && r.s >= past(TR, b));
          assertTakes(TR, rows, b, at);
          onAsphalt(rows, at);
        }
      }
      const o = sg.out[0];
      if (sg.out.length !== 1 || map.segs[o].in.length < 2) continue;
      merges++;
      for (const lane of [R.LANE / 2, R.LANE * 1.5]) {
        const at = name + ' merge from ' + sg.id + ' lane ' + lane;
        put(w, p, sg.id, sg.road.length - 2600, lane, V);
        drive(w, p, [sg.id, o], lane, V, LOOK);
        const rows = run(w, p, 3000, (r) => r.seg === o && r.s >= past(TR, o));
        const first = rows.findIndex((r) => r.seg === o);
        rows.slice(0, first).forEach((r, f) => assert.equal(r.seg, sg.id, at + ': on segment ' + r.seg + ' at frame ' + f));
        assertTakes(TR, rows, o, at);
        onAsphalt(rows, at);
      }
    }
  }
  assert.ok(routes > 0);
  assert.ok(forks >= 2 * routes && merges >= 4 * routes, forks + ' forks and ' + merges + ' merging branches driven');
});

// Every start-to-lot path of a generated map, as a list of segment ids.
function paths(map) {
  const out = [], walk = (k, acc) => {
    const seg = map.segs[k];
    if (!seg.out.length) out.push(acc);
    for (const o of seg.out) walk(o, acc.concat(o));
  };
  walk(map.start, [map.start]);
  return out;
}

test('every path reaches the lot', () => {
  // Ova on seed 1 is a two-braid map: four paths.
  const ri = 1, seed = 1, first = world(ri, { seed }), R = first.TR.ROAD;
  const all = paths(first.TR.Game.map);
  assert.ok(all.length > 2, 'only ' + all.length + ' paths');
  for (const path of all) {
    const w = world(ri, { seed }), TR = w.TR, G = TR.Game, p = G.players[0], at = 'path ' + path.join('-');
    park(w, G.players[1]);
    for (let i = 0; i + 1 < path.length; i++) {
      put(w, p, path[i], G.map.segs[path[i]].road.length - 400, R.LANE / 2, 200);
      drive(w, p, [path[i], path[i + 1]], R.LANE / 2);
      const rows = run(w, p, 2400, (r) => r.seg === path[i + 1] && r.s >= past(TR, path[i + 1]));
      assertTakes(TR, rows, path[i + 1], at + ' into ' + path[i + 1]);
    }
    const lot = G.map.segs[path[path.length - 1]].road;
    drive(w, p, [path[path.length - 1]], R.LANE / 2);
    const rows = run(w, p, 3000, (r) => r.phase === 'park');
    assert.equal(rows[rows.length - 1].phase, 'park', at + ': never reached the lot, last s ' + p.s.toFixed(0) + ' of ' + lot.length);
  }
});
