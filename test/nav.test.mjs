// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;
const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };
const QUIET = '#66bb6a', NORMAL = '#e0e0e0', BUSY = '#ffa726', JAM = '#ff1744';
const ROLE_COLOR = { trunk: NORMAL, shortcut: NORMAL, busy: BUSY, quiet: QUIET };

const w0 = makeWorld('nav', { clock: { t: 1000 } }), TR = w0.TR;
const nav = w0.ctx.document.getElementById('nav').getContext('2d');
const VP = { x: 0, y: 0, w: 640, h: 760 };

const seg = (id, a, b, role, flow, detour) => ({
  id, a, b, role, flow, detour, curvy: 0, tight: 1, wseed: 11 + id, features: [], events: { flock: false, work: false },
});
// start (0,0) → fork (0,-12000) → { 1, 2 } → merge (0,-30000) → lot (0,-36000).
function forkSpec(d1, d2, jams = []) {
  return {
    ri: 0, seed: 1, attempt: 0, jams,
    nodes: [
      { id: 0, x: 0, y: 0, kind: 'start' },
      { id: 1, x: 0, y: -12000, kind: 'fork' },
      { id: 2, x: 0, y: -30000, kind: 'merge' },
      { id: 3, x: 0, y: -36000, kind: 'lot' },
    ],
    segs: [seg(0, 0, 1, 'trunk', 1, 0), seg(1, 1, 2, 'shortcut', 0.7, d1), seg(2, 1, 2, 'quiet', 0.4, d2), seg(3, 2, 3, 'busy', 1.6, 0)],
  };
}

const player = (idx, segId, s) => ({ idx, seg: segId, s, phase: 'race', color: idx ? '#e53935' : '#1e88e5', cargo: [] });
const world = (spec, route = TR.ROUTES[0]) => new TR.RoadMap(spec, route);
const gOf = (map, p, time = 0) => ({ map, time, players: [p, player(1 - p.idx, map.start, 0)] });

function drawLog(g) {
  w0.log.length = 0;
  TR.HUD.drawNav(nav, VP, g.players[0], g);
  return w0.log.filter((l) => l.startsWith('nav.'));
}

// Each stroke with the strokeStyle it was drawn in and the number of moveTo calls in its path.
function strokes(log) {
  const out = [];
  let style = null, moves = 0;
  for (const l of log) {
    if (l.startsWith('nav.strokeStyle=')) style = JSON.parse(l.slice('nav.strokeStyle='.length));
    else if (l === 'nav.beginPath()') moves = 0;
    else if (l.startsWith('nav.moveTo(')) moves++;
    else if (l === 'nav.stroke()') out.push({ style, moves });
  }
  return out;
}
const segStrokes = (log) => strokes(log).filter((s) => [QUIET, NORMAL, BUSY].includes(s.style));

const sizeAt = (map, segId, s) => TR.HUD.navSize(player(0, segId, s), gOf(map, player(0, segId, s)));

test('the nav map grows near a fork', () => {
  const map = world(forkSpec(0, 2000)), NAV = TR.NAV, len = map.segs[0].road.length;
  assert.ok(len > NAV.GROW_AT, 'the fixture trunk is too short to start small');
  assert.deepEqual(sizeAt(map, 0, 0), NAV.SMALL);
  assert.deepEqual(sizeAt(map, 0, len), NAV.LARGE);
  assert.ok(NAV.LARGE.w > NAV.SMALL.w && NAV.LARGE.h > NAV.SMALL.h);
  let last = sizeAt(map, 0, 0), grew = 0;
  for (let s = 0; s <= len; s += 100) {
    const z = sizeAt(map, 0, s);
    assert.ok(z.w >= last.w && z.h >= last.h, 'shrank at s ' + s);
    if (z.h > last.h) grew++;
    last = z;
  }
  assert.ok(grew > 10, 'grew in only ' + grew + ' steps');
});

test('the nav map shrinks again past the fork', () => {
  const map = world(forkSpec(0, 2000)), NAV = TR.NAV;
  assert.deepEqual(sizeAt(map, 1, 0), NAV.LARGE);
  let last = sizeAt(map, 1, 0);
  for (let s = 0; s <= NAV.GROW_AT + 1000; s += 100) {
    const z = sizeAt(map, 1, s);
    assert.ok(z.h <= last.h, 'grew at s ' + s);
    last = z;
  }
  assert.deepEqual(last, NAV.SMALL);
});

test('only forks grow the nav map', () => {
  const map = world(forkSpec(0, 2000)), NAV = TR.NAV;
  for (const k of [1, 2, 3]) {
    const len = map.segs[k].road.length;
    for (let s = Math.max(len - NAV.GROW_AT - 1000, k === 3 ? 0 : NAV.GROW_AT + 1); s <= len; s += 100) {
      assert.deepEqual(sizeAt(map, k, s), NAV.SMALL, 'segment ' + k + ' s ' + s);
    }
  }
});

test('every segment is drawn in its traffic colour', () => {
  let segs = 0;
  const classes = new Set();
  for (const route of TR.ROUTES) {
    for (const seed of [1, 98, 195]) {
      const map = world(TR.MapGen.generate(route, seed), route), g = gOf(map, player(0, map.start, 0));
      const got = segStrokes(drawLog(g));
      const at = route.id + ' seed ' + seed;
      assert.deepEqual(got.map((s) => s.style), [...map.segs].map((sg) => ROLE_COLOR[sg.spec.role]), at);
      assert.ok(got.every((s) => s.moves === 1), at + ': a segment drew more than one polyline');
      segs += got.length;
      got.forEach((s) => classes.add(s.style));
    }
  }
  assert.ok(segs >= TR.ROUTES.length * 3 * 4, 'only ' + segs + ' segments drawn');
  assert.deepEqual([...classes].sort(), [BUSY, NORMAL, QUIET].sort());
});

test('a jam is drawn only while it is on', () => {
  const jam = { seg: 1, rise0: 6000, rise1: 8000, t0: 30, t1: 60 };
  const map = world(forkSpec(0, 2000, [jam]));
  const jams = (time) => strokes(drawLog(gOf(map, player(0, 0, 0), time))).filter((s) => s.style === JAM).length;
  assert.equal(jams(0), 0);
  assert.equal(jams(29.99), 0);
  assert.equal(jams(30.01), 1);
  assert.equal(jams(59.99), 1);
  assert.equal(jams(60), 0);
  assert.equal(jams(200), 0);
});

test('the nav map does not mark the shortest alternative', () => {
  const a = world(forkSpec(0, 2000)), b = world(forkSpec(2000, 0));
  const len = (m, k) => m.segs[k].road.length;
  assert.ok(len(a, 1) < len(a, 2) && len(b, 2) < len(b, 1), 'the fixtures do not swap the shortest alternative');
  const colours = (m) => segStrokes(drawLog(gOf(m, player(0, 0, 0)))).map((s) => s.style);
  assert.deepEqual(colours(a), [NORMAL, NORMAL, QUIET, BUSY]);
  assert.deepEqual(colours(b), colours(a));
});

test('the nav map shows the viewer\'s progress', () => {
  const map = world(forkSpec(0, 2000)), len = (k) => map.segs[k].road.length;
  const shortest = len(0) + Math.min(len(1), len(2)) + len(3), s = 3000;
  const want = '%' + Math.round((s / shortest) * 100);
  assert.notEqual(want, '%0');
  const log = drawLog(gOf(map, player(0, 0, s)));
  assert.equal(log.filter((l) => l.startsWith('nav.fillText("' + want + '"')).length, 1, 'no ' + want + ' text');
});

// The canvas calls of one name, each with its numeric arguments and the fillStyle it was made in.
function calls(log, name) {
  const out = [];
  let fill = null;
  for (const l of log) {
    if (l.startsWith('nav.fillStyle=')) fill = JSON.parse(l.slice('nav.fillStyle='.length));
    else if (l.startsWith('nav.' + name + '(')) out.push({ fill, a: l.slice(name.length + 5, -1).split(',').map(Number) });
  }
  return out;
}

// Each segment's polyline as the nav map drew it, in G.map.segs order.
function polylines(log) {
  const out = [];
  let pts = null;
  for (const l of log) {
    const m = /^nav\.(moveTo|lineTo)\(([^,]+),([^)]+)\)$/.exec(l);
    if (l === 'nav.beginPath()') pts = [];
    else if (m && pts) pts.push({ x: Number(m[2]), y: Number(m[3]) });
    else if (l === 'nav.stroke()' && pts && pts.length > 1) out.push(pts);
  }
  return out;
}

const distTo = (pl, q) => Math.min(...pl.slice(1).map((b, i) => {
  const a = pl[i], dx = b.x - a.x, dy = b.y - a.y, k = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(q.x - a.x - k * dx, q.y - a.y - k * dy);
}));

// The fork fixture with a narrow and a dirt section and two points, at rises (north of their segment's start)
// chosen here, so where each mark goes is known without the nav map's own arithmetic.
const MARKS = {
  2: [{ type: 'narrow', rise0: 3000, rise1: 5000 }, { type: 'radar', rise: 9000 }],
  3: [{ type: 'dirt', rise0: 1500, rise1: 2500 }, { type: 'toll', rise: 4000 }],
};
const MARK_COLOR = { narrow: '#ffb74d', dirt: '#a1887f', radar: '#ef5350', toll: '#ba68c8' };
function markedSpec() {
  const spec = forkSpec(0, 2000);
  for (const [k, fs] of Object.entries(MARKS)) spec.segs[k].features = fs;
  return spec;
}

// North-up: the nav y of a world y is linear, fixed by the trunk's first point (y 0) and the lot segment's
// last (y -36000). Every node is at x 0, so the straight trunk's x is the nav x of world x 0.
function navFrame(log) {
  const pl = polylines(log), y0 = pl[0][0].y, y1 = pl[3][pl[3].length - 1].y;
  return { pl, x0: pl[0][0].x, ny: (wy) => y0 + ((y1 - y0) * wy) / -36000 };
}

test('each racer dot is drawn on its own segment at its own s', () => {
  const map = world(forkSpec(0, 2000)), road = (k) => map.segs[k].road;
  const s2 = road(2).length / 2, me = player(0, 0, 3000), other = player(1, 2, s2);
  const g = { map, time: 0, players: [me, other] };
  const log = drawLog(g), f = navFrame(log);
  const dot = (r) => calls(log, 'arc').find((c) => c.a[2] === r);
  const mine = dot(6), theirs = dot(4);
  assert.equal(mine.fill, me.color);
  assert.equal(theirs.fill, other.color);
  assert.ok(Math.abs(mine.a[0] - f.x0) < 1e-6, 'the viewer dot is off the trunk: ' + mine.a[0] + ' vs ' + f.x0);
  assert.ok(Math.abs(mine.a[1] - f.ny(-3000)) < 0.5, 'the viewer dot is not 3000 up the trunk: ' + mine.a[1] + ' vs ' + f.ny(-3000));
  const q = { x: theirs.a[0], y: theirs.a[1] };
  assert.ok(Math.abs(q.y - f.ny(road(2).posAt(s2, 0).y)) < 0.5, 'the rival dot is not at its s');
  assert.ok(distTo(f.pl[2], q) < 1, 'the rival dot is off its segment by ' + distTo(f.pl[2], q));
  assert.ok(distTo(f.pl[1], q) > 5, 'the fixture does not part the two branches on the nav map');
  // Once off the road, a racer is shown at the end of its segment: the lot.
  other.seg = 3;
  other.s = 0;
  other.phase = 'park';
  const parked = calls(drawLog(g), 'arc').find((c) => c.a[2] === 4);
  assert.ok(Math.abs(parked.a[0] - f.x0) < 1e-6 && Math.abs(parked.a[1] - f.ny(-36000)) < 0.5, 'a parking racer is not drawn at the lot');
});

test('the lot is marked at the end of the lot segment', () => {
  const map = world(forkSpec(0, 2000)), log = drawLog(gOf(map, player(0, 0, 0))), f = navFrame(log);
  const lot = calls(log, 'fillRect').filter((c) => c.fill === '#90caf9');
  assert.equal(lot.length, 1);
  const [x, y, w, h] = lot[0].a;
  assert.ok(Math.abs(x + w / 2 - f.x0) < 1e-6 && Math.abs(y + h / 2 - f.ny(-36000)) < 0.5, 'the lot mark is at ' + [x + w / 2, y + h / 2]);
});

test('every section and point is marked on its segment, in its colour', () => {
  const map = world(markedSpec()), log = drawLog(gOf(map, player(0, 0, 0))), f = navFrame(log);
  const sections = [], points = [];
  for (const k of Object.keys(MARKS)) for (const m of MARKS[k]) (m.rise0 != null ? sections : points).push({ k: +k, m });
  const y0 = (k) => map.nodes[map.segs[k].spec.a].y;
  const colours = new Set(sections.concat(points).map(({ m }) => MARK_COLOR[m.type]));
  const bars = calls(log, 'fillRect').filter((c) => colours.has(c.fill));
  assert.deepEqual(bars.map((c) => c.fill), sections.map(({ m }) => MARK_COLOR[m.type]));
  sections.forEach(({ k, m }, i) => {
    const [x, y, w, h] = bars[i].a, top = f.ny(y0(k) - m.rise1), bottom = f.ny(y0(k) - m.rise0);
    assert.ok(Math.abs(y - top) < 0.5 && Math.abs(y + h - bottom) < 0.5, m.type + ' spans ' + [y, y + h] + ', not ' + [top, bottom]);
    assert.ok(distTo(f.pl[k], { x: x + w / 2, y: y + h / 2 }) < 1.5, m.type + ' is off segment ' + k);
  });
  const dots = calls(log, 'arc').filter((c) => c.a[2] === 3.5);
  assert.deepEqual(dots.map((c) => c.fill), points.map(({ m }) => MARK_COLOR[m.type]));
  points.forEach(({ k, m }, i) => {
    const q = { x: dots[i].a[0], y: dots[i].a[1] };
    assert.ok(Math.abs(q.y - f.ny(y0(k) - m.rise)) < 0.5, m.type + ' is not at its rise');
    assert.ok(distTo(f.pl[k], q) < 1, m.type + ' is off segment ' + k);
  });
});

test('the rival panel shows the rival\'s progress, not the viewer\'s', () => {
  const map = world(forkSpec(0, 2000)), len = (k) => map.segs[k].road.length;
  const shortest = len(0) + Math.min(len(1), len(2)) + len(3);
  const me = player(0, 0, 1000), other = player(1, 3, 3000);
  const g = { map, time: 0, state: 'play', rankOf: (q) => (q === other ? 1 : 2), players: [me, other] };
  const want = '%' + Math.round(((shortest - (len(3) - 3000)) / shortest) * 100);
  assert.notEqual(want, '%' + Math.round((1000 / shortest) * 100));
  w0.log.length = 0;
  TR.HUD.drawRival(nav, VP, me, g);
  const texts = w0.log.filter((l) => l.startsWith('nav.fillText('));
  assert.equal(texts.length, 1);
  assert.ok(texts[0].startsWith('nav.fillText(' + JSON.stringify(other.name + ' · ' + want + ' · Rakip 0/6 · 1.')), texts[0]);
  other.phase = 'park';
  w0.log.length = 0;
  TR.HUD.drawRival(nav, VP, me, g);
  assert.ok(w0.log.some((l) => l.startsWith('nav.fillText(' + JSON.stringify(other.name + ' · PARK · 1.'))), 'a parking rival shows a %');
});

test('the round intro gives the shortest path in km', () => {
  const clock = { t: 1000 };
  const w = makeWorld('navintro', { clock }), T = w.TR, G = T.Game;
  T.Settings.set({ traffic: 'normal', weather: 'gunduz', shake: false });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(0, { seed: 1, mapSpec: forkSpec(0, 6000) });
  const len = (k) => G.map.segs[k].road.length;
  const km = (d) => (d / 10000).toFixed(1).replace('.', ',') + ' km';
  const want = km(len(0) + Math.min(len(1), len(2)) + len(3)), longest = km(len(0) + Math.max(len(1), len(2)) + len(3));
  assert.notEqual(want, longest, 'the fixture branches round to the same km');
  clock.t += FRAME_MS;
  w.frame();
  assert.equal(G.state, 'countdown');
  const intro = w.log.filter((l) => /\.fillText\(".* km ·/.test(l));
  assert.equal(intro.length, 2, 'not one intro line per player');
  for (const l of intro) assert.ok(l.includes(' · ' + want + ' · '), l + ' does not give ' + want);
});

test('the race HUD draws the nav map', () => {
  const clock = { t: 1000 };
  const w = makeWorld('navround', { clock }), T = w.TR, G = T.Game;
  T.Settings.set({ traffic: 'normal', weather: 'gunduz', shake: false });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(0, { seed: 1, mapSpec: forkSpec(0, 2000) });
  T.Input.sources = [() => NONE, () => NONE];
  while (G.state === 'countdown') { clock.t += FRAME_MS; w.frame(); }
  clock.t += FRAME_MS;
  w.frame();
  assert.equal(G.players[0].phase, 'race');
  assert.equal(w.log.filter((l) => /\.fillText\("%\d+"/.test(l)).length, 2, 'not one progress text per player');
});
