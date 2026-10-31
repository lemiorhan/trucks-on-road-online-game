// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const w = makeWorld('a', { clock: { t: 1000 } });
const { TR } = w;
const { DS } = TR.ROAD, MAP = TR.MAP;
const SEEDS = Array.from({ length: 24 }, (_, k) => 1 + k * 97);

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' against ' + b);

// Straight segments throughout except the busy alternative, so every length but that one is its rise:
// start (0,0) → fork (0,-8000) → { shortcut straight, busy detoured } → merge (0,-18000) → lot (0,-24000).
// A cross sits on the first trunk and a toll on the lot segment, matching the route's pool; two jams keep
// clear of the nodes. The shortcut pays with a narrow section and a flock. A depot for each box: three on
// the first trunk and two on the lot segment, each CLEAR off its neighbours, and one on the busy branch,
// facing away from the shortcut.
function validSpec() {
  const seg = (id, a, b, role, flow, detour, features = [], flock = false) => ({
    id, a, b, role, flow, detour, curvy: 0, tight: 1, wseed: 11 + id, features, events: { flock, work: false },
  });
  const depot = (rise, dir, box) => ({ type: 'depot', rise, dir, box });
  return {
    ri: 0, seed: 1, attempt: 0, jams: [jam(1, 4000), jam(3, 1500, 60, 90)],
    nodes: [
      { id: 0, x: 0, y: 0, kind: 'start' },
      { id: 1, x: 0, y: -8000, kind: 'fork' },
      { id: 2, x: 0, y: -18000, kind: 'merge' },
      { id: 3, x: 0, y: -24000, kind: 'lot' },
    ],
    segs: [
      seg(0, 0, 1, 'trunk', 1, 0, [{ type: 'cross', rise: 1500 }, depot(3200, 1, 0), depot(4800, -1, 1), depot(6400, 1, 2)]),
      seg(1, 1, 2, 'shortcut', 0.6, 0, [{ type: 'narrow', rise0: 3000, rise1: 4500 }], true),
      seg(2, 1, 2, 'busy', 1.5, 2000, [depot(3300, 1, 5)]),
      seg(3, 2, 3, 'trunk', 1, 0, [depot(1300, -1, 3), { type: 'toll', rise: 3000 }, depot(4700, 1, 4)]),
    ],
  };
}
const jam = (seg, rise0, t0 = 10, t1 = 50) => ({ seg, rise0, rise1: rise0 + 1000, t0, t1 });
const fixtureRoute = Object.assign({}, TR.ROUTES[0], { length: 24000, features: [{ type: 'cross', s: 1500 }, { type: 'toll', s: 21000 }] });

// One segment with a detour, so s and rise differ along it; a cross at CROSS_RISE.
const CROSS_RISE = 6000;
const detourSeg = () => ({
  id: 0, a: { x: 0, y: 0 }, b: { x: 0, y: -12000 }, detour: 1500, curvy: 0.5, tight: 1, wseed: 7,
  features: [{ type: 'cross', rise: CROSS_RISE }], isStart: true, atLot: true,
});

const RECIPES = [
  { a: { x: 0, y: 0 }, b: { x: 0, y: -8000 }, opts: { endFlat: 1000 } },
  { a: { x: 120, y: -3000 }, b: { x: -900, y: -15000 }, opts: { detour: 2400, curvy: 0.9, tight: 0.5, wseed: 3, endFlat: 1000 } },
  { a: { x: 0, y: 0 }, b: { x: 300, y: -10000 }, opts: { detour: -6000, curvy: 1.2, tight: 0.35, wseed: 99, endFlat: 1000 } },
  {
    a: { x: -50, y: 500 }, b: { x: 700, y: -13500 },
    opts: { detour: 1800, curvy: 1, tight: 0.6, wseed: 42, endFlat: 1000, flats: [{ rise: 5000, half: 420 }, { rise: 9000, half: 520 }] },
  },
];

test('trace hits both nodes', () => {
  for (const { a, b, opts } of RECIPES) {
    const t = TR.Road.trace(a, b, opts);
    close(t.xs[0], a.x, 1e-6, 'first x');
    close(t.ys[0], a.y, 1e-6, 'first y');
    close(t.xs[t.n - 1], b.x, 1e-6, 'last x');
    close(t.ys[t.n - 1], b.y, 1e-6, 'last y');
    assert.equal(t.length, (t.n - 1) * DS);
  }
});

test('trace is northbound', () => {
  for (const { a, b, opts } of RECIPES) {
    const t = TR.Road.trace(a, b, opts);
    for (let i = 1; i < t.n; i++) assert.ok(t.ys[i] < t.ys[i - 1], 'sample ' + i + ' does not run north');
  }
});

test('trace is flat at both ends and over every flat window', () => {
  let checked = 0;
  for (const { a, b, opts } of RECIPES) {
    const t = TR.Road.trace(a, b, opts), R = a.y - b.y, ef = opts.endFlat;
    for (let i = 0; i < t.n; i++) {
      const r = a.y - t.ys[i];
      const flat = r <= ef || r >= R - ef || (opts.flats || []).some((f) => Math.abs(r - f.rise) <= f.half);
      if (!flat) continue;
      checked++;
      close(t.hs[i], -Math.PI / 2, 1e-9, 'heading at rise ' + r);
    }
  }
  assert.ok(checked > 0);
});

test('sAtRise lands on the rise on a detoured segment', () => {
  const road = new TR.Road(TR.ROUTES[0], detourSeg());
  assert.equal(road.sAtRise(0), 0);
  for (const r of [500, 2000, 4500, 6000, 8000, 11500]) close(road.posAt(road.sAtRise(r), 0).y, -r, 1, 'y at rise ' + r);
  close(road.sAtRise(12000), road.length, DS, 'end');
});

test('a depot leaves its segment and every generated segment where it was', () => {
  const plain = new TR.Road(TR.ROUTES[0], detourSeg());
  const held = new TR.Road(TR.ROUTES[0], Object.assign(detourSeg(), { features: detourSeg().features.concat([{ type: 'depot', rise: 3500, dir: 1, box: 0 }]) }));
  assert.deepEqual([...held.xs], [...plain.xs]);
  const spec = TR.MapGen.generate(TR.ROUTES[0], SEEDS[0]), held2 = new TR.RoadMap(spec, TR.ROUTES[0]);
  const bare = JSON.parse(JSON.stringify(spec));
  bare.segs.forEach((sg) => { sg.features = sg.features.filter((f) => f.type !== 'depot'); });
  const plain2 = new TR.RoadMap(bare, TR.ROUTES[0]);
  assert.ok(spec.segs.some((sg) => sg.features.some((f) => f.type === 'depot')));
  held2.segs.forEach((s, k) => assert.deepEqual([...s.road.xs], [...plain2.segs[k].road.xs], 'segment ' + k));
});

test('a junction on a detoured segment sits at its rise and works', () => {
  const route = TR.ROUTES[0];
  const road = new TR.Road(route, detourSeg());
  const j = road.points[0];
  assert.equal(typeof j.s, 'number');
  const c = road.posAt(j.s, 0);
  close(j.x, c.x, 1e-9, 'x');
  close(j.y, c.y, 1e-9, 'y');
  close(j.y, -CROSS_RISE, 1, 'y at its rise');
  const events = new TR.Events(road, 5);
  const traffic = new TR.Traffic(road, route, 6, 1, events);
  const junctions = new TR.Junctions(road, traffic, 7);
  assert.notEqual(junctions.limit(j.x, j.y), undefined);
  assert.equal(junctions.limit(j.x, j.y - 3000), undefined);
  assert.equal(junctions.limit(j.x + 5000, j.y), undefined);
});

test('generate is deterministic, within a world and across two', () => {
  const w2 = makeWorld('b', { clock: { t: 1000 } });
  for (let ri = 0; ri < TR.ROUTES.length; ri++) {
    for (const seed of SEEDS.slice(0, 4)) {
      const one = JSON.stringify(TR.MapGen.generate(TR.ROUTES[ri], seed));
      assert.equal(JSON.stringify(TR.MapGen.generate(TR.ROUTES[ri], seed)), one);
      assert.equal(JSON.stringify(w2.TR.MapGen.generate(w2.TR.ROUTES[ri], seed)), one);
    }
  }
});

test('the seed changes the map', () => {
  for (const route of TR.ROUTES) {
    const shapes = new Set(SEEDS.map((seed) => {
      const { nodes, segs } = TR.MapGen.generate(route, seed);
      return JSON.stringify({ nodes, segs });
    }));
    assert.ok(shapes.size >= 2, route.id + ' gives one map for every seed');
  }
});

// A round offers a choice at two forks at least on every map, and at three on most maps of each route.
test('every generated map validates', () => {
  const visited = new Set();
  let maps = 0;
  for (const route of TR.ROUTES) {
    let three = 0;
    for (const seed of SEEDS) {
      const spec = TR.MapGen.generate(route, seed);
      const v = TR.MapGen.validate(spec, route);
      assert.ok(v.ok, route.id + ' seed ' + seed + ': ' + v.why.join('; '));
      assert.ok(spec.attempt >= 0, route.id + ' seed ' + seed + ' fell back');
      const forks = spec.nodes.filter((n) => n.kind === 'fork' && spec.segs.filter((sg) => sg.a === n.id).length > 1).length;
      assert.ok(forks >= 2, route.id + ' seed ' + seed + ' has ' + forks + ' forks');
      if (forks >= 3) three++;
      visited.add(route.id);
      maps++;
    }
    assert.ok(three > SEEDS.length / 2, route.id + ': three forks on ' + three + ' of ' + SEEDS.length + ' maps');
  }
  assert.deepEqual([...visited], [...TR.ROUTES.map((r) => r.id)]);
  assert.equal(maps, TR.ROUTES.length * SEEDS.length);
  assert.ok(SEEDS.length > 0 && TR.ROUTES.length > 0);
});

// Every way from the start to the lot, as the set of segments it drives, walked over the spec's own graph.
const ways = (spec) => {
  const lot = spec.nodes.find((n) => n.kind === 'lot').id, out = [];
  const walk = (v, path) => {
    if (v === lot) return out.push(new Set(path));
    for (const sg of spec.segs) if (sg.a === v) walk(sg.b, path.concat(sg.id));
  };
  walk(spec.nodes.find((n) => n.kind === 'start').id, []);
  return out;
};

test('one way from the start to the lot passes every depot, each facing away from its siblings', () => {
  let depots = 0, braided = 0;
  for (const route of TR.ROUTES) {
    for (const spec of SEEDS.map((seed) => TR.MapGen.generate(route, seed)).concat([TR.MapGen.fallback(route)])) {
      const held = spec.segs.filter((sg) => sg.features.some((f) => f.type === 'depot'));
      assert.ok(ways(spec).some((w) => held.every((sg) => w.has(sg.id))), route.id + ' seed ' + spec.seed + ': no way passes segments ' + held.map((sg) => sg.id));
      for (const sg of held) {
        const sibs = spec.segs.filter((o) => o !== sg && o.a === sg.a && o.b === sg.b);
        for (const f of sg.features.filter((g) => g.type === 'depot')) {
          depots++;
          assert.ok(f.dir === 1 || f.dir === -1, 'dir ' + f.dir);
          if (!sibs.length) continue;
          braided++;
          assert.ok(sibs.every((o) => f.dir * (sg.detour - o.detour) > 0), route.id + ' seed ' + spec.seed + ': the depot on ' + sg.id + ' faces a sibling');
        }
      }
    }
  }
  assert.equal(depots, TR.ROUTES.length * (SEEDS.length + 1) * TR.BOXES.length);
  assert.ok(braided > 0);
});

// Every alternative of this braid of three has room for depots; the shortcut is the middle one.
function threeWays() {
  const seg = (id, a, b, role, detour) => ({ id, a, b, role, flow: 1, detour, curvy: 0, tight: 1, wseed: 11 + id, features: [], events: { flock: false, work: false } });
  return {
    nodes: [
      { id: 0, x: 0, y: 0, kind: 'start' },
      { id: 1, x: 0, y: -8000, kind: 'fork' },
      { id: 2, x: 0, y: -20000, kind: 'merge' },
      { id: 3, x: 0, y: -26000, kind: 'lot' },
    ],
    segs: [seg(0, 0, 1, 'trunk', 0), seg(1, 1, 2, 'shortcut', 0), seg(2, 1, 2, 'busy', 2500), seg(3, 1, 2, 'quiet', -2500), seg(4, 2, 3, 'trunk', 0)],
    jams: [],
  };
}

test('in a braid of three the middle alternative holds no depot, and the outer one that does faces out', () => {
  const held = { 1: 0, 2: 0, 3: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const spec = threeWays();
    TR.MapGen.placeDepots(spec, TR.U.rng(seed));
    for (const sg of spec.segs.slice(1, 4)) {
      const ds = sg.features.filter((f) => f.type === 'depot');
      held[sg.id] += ds.length;
      if (sg.role === 'shortcut') continue;
      for (const f of ds) assert.equal(f.dir, sg.role === 'busy' ? 1 : -1, 'seed ' + seed + ': the depot on ' + sg.role + ' faces ' + f.dir);
    }
  }
  assert.equal(held[1], 0, 'depots on the shortcut');
  assert.ok(held[2] > 0 && held[3] > 0, 'depots on busy ' + held[2] + ', on quiet ' + held[3]);
});

test('every fallback map validates', () => {
  for (const route of TR.ROUTES) {
    const v = TR.MapGen.validate(TR.MapGen.fallback(route), route);
    assert.ok(v.ok, route.id + ': ' + v.why.join('; '));
  }
});

test('the validator rejects each clause apart', () => {
  const base = TR.MapGen.validate(validSpec(), fixtureRoute);
  assert.ok(base.ok, base.why.join('; '));
  const cases = {
    1: (s) => { s.nodes[0].kind = 'fork'; },
    '2a': (s) => { s.segs[3].a = 3; s.segs[3].b = 2; },
    '2b': (s) => { s.segs[2].detour = 9000; },
    '3a': (s) => { s.nodes.push({ id: 4, x: 3000, y: -10000, kind: 'fork' }); s.segs.push(Object.assign({}, s.segs[1], { id: 4, a: 4, role: 'trunk' })); },
    '3b': (s) => { s.nodes.push({ id: 4, x: 0, y: -16000, kind: 'merge' }); s.segs.push(Object.assign({}, s.segs[1], { id: 4, b: 4, role: 'trunk' })); },
    '3c': (s) => { s.nodes.push({ id: 4, x: 0, y: -16000, kind: 'merge' }); s.segs.push(Object.assign({}, s.segs[1], { id: 4, b: 4, role: 'trunk' })); },
    '3d': (s) => { s.nodes.push({ id: 4, x: 3000, y: -10000, kind: 'fork' }); s.segs.push(Object.assign({}, s.segs[1], { id: 4, a: 4, role: 'trunk' })); },
    4: (s) => { Object.assign(s.segs[1], { role: 'busy', flow: 1.5 }); Object.assign(s.segs[2], { role: 'shortcut', flow: 0.6 }); },
    5: (s) => { s.segs[2].flow = s.segs[1].flow; },
    '6a': (s) => { s.nodes[2].kind = 'lot'; s.nodes[3].kind = 'merge'; },
    '6b': (s) => { s.nodes[3].y = -18800; },
    '7a': (s) => {
      s.nodes.push({ id: 4, x: 300, y: -9000, kind: 'fork' }, { id: 5, x: 300, y: -17000, kind: 'merge' });
      s.segs.push(Object.assign({}, s.segs[1], { id: 4, a: 4, b: 5, role: 'trunk' }));
    },
    '7b': (s) => { s.segs[2].detour = 200; },
    '8a': (s) => { s.segs[0].features[0].rise = 7600; },
    '8b': (s) => { s.segs[1].features.push(s.segs[0].features.shift()); },
    9: (s, r) => { r.length = 20000; },
    10: (s, r) => { r.features = r.features.concat([{ type: 'radar', s: 9000, kmh: 70 }]); },
    11: (s) => { s.nodes[2].y = -19000; },
    J1: (s) => { s.jams.push(jam(0, 2000)); },
    J2: (s) => { s.jams.push(jam(1, 500, 60, 90)); },
    J3: (s) => { s.jams.push(jam(1, 6000, 40, 80)); },
    J4: (s) => { s.jams.push(jam(1, 2000, 60, 60)); },
    C1: (s) => { s.segs[1].features = []; s.segs[1].events.flock = false; },
    C2: (s) => { s.segs[2].events.flock = true; },
    C3: (s) => { s.segs[1].events.work = true; },
    C5: (s) => { s.segs[1].events.flock = false; s.segs[1].curvy = MAP.TWIST.CURVY; },
  };
  // The shortcut rises 10000 and shares both its nodes with the busy branch, so its clear window is
  // [NODE_R, 10000 - NODE_R]; the trunk into the lot shares neither end, so its window starts at NODE_CLEAR.
  const more = [
    ['J2', (s) => { s.jams.push(jam(1, 2000, 60, 90)); }],
    ['J2', (s) => { s.jams.push(jam(1, 6500, 60, 90)); }],
    ['J2', (s) => { s.jams.push({ seg: 1, rise0: 5000, rise1: 4000, t0: 60, t1: 90 }); }],
    ['C4', (s) => { s.segs[1].events.flock = { rise: 1500 }; }],
    ['C4', (s) => { s.segs[1].events.flock = { rise: 5000 }; }],
    ['C4', (s) => { s.segs[2].events.work = { rise: 9000 }; }],
    ['D1', (s) => { s.segs[3].features.pop(); }],
    ['D1', (s) => { s.segs[3].features[2].box = 0; }],
    ['D1', (s) => { s.segs[3].features.push({ type: 'depot', rise: 4700, dir: -1, box: TR.BOXES.length }); }],
    ['D2', (s) => { s.segs[1].features.push(s.segs[3].features.pop()); s.segs[1].features[1].rise = 5800; }],
    ['D3', (s) => { s.segs[2].features[0].rise = 3100; }],
    ['D3', (s) => { Object.assign(s.segs[2].features[0], { rise: 3150, dir: -1 }); }],
    ['D3', (s) => {
      s.nodes.push({ id: 4, x: -400, y: -16000, kind: 'fork' }, { id: 5, x: -400, y: -23000, kind: 'merge' });
      s.segs.push(Object.assign({}, s.segs[1], { id: 4, a: 4, b: 5, role: 'trunk', features: [] }));
    }],
    // The busy branch bends east at its depot, so the yard, square to the road, swings south onto this
    // segment's end; a yard square to north would stop short of it.
    ['D3', (s) => {
      s.nodes.push({ id: 4, x: 1800, y: -5000, kind: 'fork' }, { id: 5, x: 1800, y: -10800, kind: 'merge' });
      s.segs.push(Object.assign({}, s.segs[1], { id: 4, a: 4, b: 5, role: 'trunk', features: [] }));
    }],
    ['D5', (s) => { s.segs[0].features[2].dir = 0; }],
    ['D4', (s) => { s.segs[0].features[1].rise = 2800; }],
    ['D4', (s) => { s.segs[0].features[2].rise = 4100; }],
  ];
  const placed = validSpec();
  placed.segs[1].events.flock = { rise: 6000 };
  placed.segs[2].events.work = { rise: 5500 };
  placed.jams.push(jam(3, MAP.NODE_CLEAR, 100, 140));
  const v = TR.MapGen.validate(placed, fixtureRoute);
  assert.ok(v.ok, 'placed events and a jam at the trunk floor: ' + v.why.join('; '));
  for (const [clause, change] of Object.entries(cases).concat(more)) {
    const spec = validSpec(), route = Object.assign({}, fixtureRoute);
    change(spec, route);
    const v = TR.MapGen.validate(spec, route);
    assert.equal(v.ok, false, 'clause ' + clause + ' passes');
    assert.ok(v.why.some((y) => y.startsWith(clause + ':')), 'clause ' + clause + ' not named in: ' + v.why.join('; '));
  }
});

test('distance to the lot follows the shortest branch', () => {
  const map = new TR.RoadMap(validSpec(), fixtureRoute);
  const busy = map.segs[2].road.length;
  assert.ok(busy > 10000);
  const expected = {
    0: [[0, 24000], [4000, 20000], [8000, 16000]],
    1: [[0, 16000], [5000, 11000], [10000, 6000]],
    2: [[0, busy + 6000], [busy / 2, busy / 2 + 6000], [busy, 6000]],
    3: [[0, 6000], [3000, 3000], [6000, 0]],
  };
  for (const [seg, rows] of Object.entries(expected)) {
    for (const [s, d] of rows) close(map.distToLot(+seg, s), d, 1e-6, 'seg ' + seg + ' at ' + s);
  }
  assert.equal(map.shortest, 24000);
  assert.equal(map.start, 0);
  assert.equal(map.lotSeg, 3);
});

test('adjacency holds seg ids', () => {
  const map = new TR.RoadMap(validSpec(), fixtureRoute);
  const ids = map.segs.flatMap((s) => s.out.concat(s.in));
  assert.ok(ids.length > 0);
  for (const k of ids) assert.ok(Number.isInteger(k) && map.segs[k] && map.segs[k].id === k, 'not a seg id: ' + k);
  assert.deepEqual([...map.segs[0].out], [1, 2]);
  assert.deepEqual([...map.segs[3].in], [1, 2]);
});

test('candidates near a node take in the segments that meet there', () => {
  const map = new TR.RoadMap(validSpec(), fixtureRoute);
  const len = map.segs[0].road.length;
  assert.ok(len > 2 * MAP.NODE_R);
  assert.deepEqual([...map.candidates(0, len / 2)], [0]);
  assert.deepEqual([...map.candidates(0, len - MAP.NODE_R / 2)], [0, 1, 2]);
  assert.deepEqual([...map.candidates(1, MAP.NODE_R / 2)], [0, 1, 2]);
  assert.deepEqual([...map.candidates(2, MAP.NODE_R / 2)], [0, 1, 2]);
});

// d is the truck's lane offset on each candidate; the northbound lanes are centred at LANE/2 and 1.5 LANE.
const cand = (seg, d, o = {}) => Object.assign({ seg, s: 100, d, len: 8000, open: false }, o);
const { LANE, HALF } = TR.ROAD;

// A truck in the outer lane of its branch where a sibling's centre line runs LANE east of the branch's
// stands in the sibling's inner lane; at its asphalt's edge it is nearer the sibling's lanes than its own.
test('pickSegment keeps the current segment while its asphalt holds the truck', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE * 1.5), cand(2, LANE / 2)], 1, MAP.PICK_HYST), 1);
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF), cand(2, LANE)], 1, MAP.PICK_HYST), 1);
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE), cand(2, -HALF)], 2, MAP.PICK_HYST), 2);
});

test('pickSegment leaves a segment whose asphalt no longer holds the truck', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF + 1), cand(2, -HALF + 1)], 1, MAP.PICK_HYST), 2);
  assert.equal(TR.RoadMap.pickSegment([cand(1, -HALF - 1), cand(2, HALF - 1)], 1, MAP.PICK_HYST), 2);
});

// Leaving, the truck in the outer lane of segment 2 is 27 off its northbound middle and 67.5 off segment 3's.
test('pickSegment leaves onto the segment whose northbound middle is nearest', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF + 5), cand(2, LANE * 1.5), cand(3, -LANE / 4)], 1, MAP.PICK_HYST), 2);
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF + 5), cand(3, -LANE / 4), cand(2, LANE * 1.5)], 1, MAP.PICK_HYST), 2);
});

test('pickSegment off every asphalt keeps the current segment within the hysteresis', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF + 30), cand(2, HALF + 10)], 1, MAP.PICK_HYST), 1);
  assert.equal(TR.RoadMap.pickSegment([cand(1, HALF + 100), cand(2, HALF + 5)], 1, MAP.PICK_HYST), 2);
});

test('pickSegment keeps a segment past its end only when it is open', () => {
  const past = 8000 + MAP.PICK_TOL + 100;
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE + 30), cand(2, LANE, { s: past })], 2, 40), 1);
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE + 30), cand(2, LANE, { s: past, open: true })], 2, 40), 2);
});

test('pickSegment takes no segment before its start', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE, { s: -MAP.PICK_TOL - 1 }), cand(2, LANE + 20)], 9, 0), 2);
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE, { s: -MAP.PICK_TOL }), cand(2, LANE + 20)], 9, 0), 1);
});

test('pickSegment breaks a tie on the lowest seg id', () => {
  assert.equal(TR.RoadMap.pickSegment([cand(3, LANE + 10), cand(1, LANE - 10)], 9, 0), 1);
  assert.equal(TR.RoadMap.pickSegment([cand(1, LANE - 10), cand(3, LANE + 10)], 9, 0), 1);
});
