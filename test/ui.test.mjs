// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;

function menu() {
  const clock = { t: 1000 };
  const w = makeWorld('ui', { clock });
  w.step = () => {
    clock.t += FRAME_MS;
    w.frame();
  };
  return w;
}

// A preview frame translates to the screen centre, scales, then translates by minus its camera.
function previewCam(log) {
  const i = log.findIndex((l) => l.startsWith('game.scale('));
  assert.ok(log[i + 1].startsWith('game.translate('), log[i + 1]);
  const m = log[i + 1].match(/\(([^,]+),([^)]+)\)/);
  return { x: -Number(m[1]), y: -Number(m[2]) };
}

test('parList', () => {
  const { TR, ctx } = menu();
  const text = ctx.document.getElementById('parList').textContent;
  // Sahil's 48000: 48000 / 120 + 120 = 520 s.
  assert.ok(text.includes('Sahil Yolu ≈ 8:40'), text);
  const named = TR.ROUTES.filter((r) => new RegExp(r.name + ' ≈ \\d+:\\d\\d').test(text));
  assert.equal(named.length, TR.ROUTES.length, text);
  assert.ok(TR.ROUTES.length >= 5);
});

test('preview draws', () => {
  const w = menu(), G = w.TR.Game;
  const visited = [];
  w.TR.ROUTES.forEach((route, i) => {
    G.previewIdx = i;
    w.step();
    assert.equal(G.state, 'menu');
    assert.equal(G.map, null);
    assert.ok(G.preview.route === route, route.name + ' has no preview of its own');
    const asphalt = route.theme.asphalt || '#44474c';
    assert.ok(w.log.includes('game.fillStyle=' + JSON.stringify(asphalt)), route.name + ' drew no asphalt');
    visited.push(route.id);
  });
  assert.deepEqual(visited, ['sahil', 'ova', 'col', 'kar', 'dag']);
});

// start (0,0) → fork (0,-8000) → { 1 shortcut straight, 2 busy detoured by busy } → merge (0,-18000) →
// lot (0,-24000), in MapGen's id order: the shortcut first. roles swaps the two branches' roles.
function forkSpec(busy, roles = ['shortcut', 'busy']) {
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
    segs: [seg(0, 0, 1, 'trunk', 1, 0), seg(1, 1, 2, roles[0], 0.6, 0), seg(2, 1, 2, roles[1], 1.5, busy), seg(3, 2, 3, 'trunk', 1, 0)],
  };
}

// The camera mid-braid on the preview of spec.
function midBraid(spec) {
  const w = menu(), G = w.TR.Game;
  w.TR.MapGen.generate = () => spec;
  G.preview = null;
  G.previewIdx = 0;
  w.step();
  // 1200 + 75 s × 160 = 13200 along the path: 5200 into the branch, mid-braid.
  G.previewT = 75;
  w.step();
  const cam = previewCam(w.log);
  assert.ok(cam.y < -11000 && cam.y > -15000, 'camera at y ' + cam.y);
  return cam;
}

test('preview follows neither ids nor roles', () => {
  for (const roles of [['shortcut', 'busy'], ['busy', 'shortcut']]) {
    const east = midBraid(forkSpec(2000, roles)), west = midBraid(forkSpec(-2000, roles));
    assert.ok(Math.abs(east.x) < 300, roles + ': the busy branch east, camera at x ' + east.x + ', not on the straight branch');
    assert.ok(west.x < -1000, roles + ': the busy branch west, camera at x ' + west.x + ', not on the detoured branch');
  }
});

// A generated round past its countdown, with a canvas of its own for the HUD.
function round() {
  const clock = { t: 1000 };
  const w = makeWorld('hud', { clock }), TR = w.TR, G = TR.Game;
  TR.Settings.set({ traffic: 'normal', weather: 'gunduz' });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(0, { seed: 1 });
  G.map.draw = () => {};
  TR.Light.draw = () => {};
  while (G.state === 'countdown') {
    clock.t += FRAME_MS;
    w.frame();
  }
  const ctx = w.ctx.document.getElementById('hudtest').getContext('2d');
  const VP = { x: 0, y: 0, w: 640, h: 760 };
  const draw = (fn, p) => {
    w.log.length = 0;
    TR.HUD[fn](ctx, VP, p, G);
    return w.log.filter((l) => l.startsWith('hudtest.'));
  };
  return { TR, G, draw };
}

// Each call of a name with its numeric arguments and the fill and stroke styles it was made in.
function calls(log, name) {
  const out = [];
  let fill = null, stroke = null;
  for (const l of log) {
    if (l.startsWith('hudtest.fillStyle=')) fill = JSON.parse(l.slice('hudtest.fillStyle='.length));
    else if (l.startsWith('hudtest.strokeStyle=')) stroke = JSON.parse(l.slice('hudtest.strokeStyle='.length));
    else if (l.startsWith('hudtest.' + name + '(')) out.push({ fill, stroke, a: l.slice(name.length + 9, -1).split(',').map(Number) });
  }
  return out;
}
const texts = (log) => log.filter((l) => l.startsWith('hudtest.fillText(')).map((l) => JSON.parse(l.slice(17, l.indexOf('",') + 1)));
const boxIds = (TR, list, color) => list.map((c) => TR.BOXES.findIndex((b) => b.color === c[color])).filter((id) => id >= 0);

test('the race HUD fills a square for each box in the trailer and outlines the rest', () => {
  const { TR, G, draw } = round(), p = G.players[0];
  for (const cargo of [[], [4, 1], [0, 1, 2, 3, 4, 5]]) {
    p.cargo.length = 0;
    p.cargo.push(...cargo);
    const log = draw('draw', p);
    const full = calls(log, 'fillRect').filter((c) => c.a[2] === 22 && c.a[3] === 22);
    const empty = calls(log, 'strokeRect').filter((c) => c.a[2] === 20 && c.a[3] === 20);
    assert.deepEqual(boxIds(TR, full, 'fill'), [...cargo].sort(), 'filled for ' + cargo);
    assert.deepEqual(boxIds(TR, empty, 'stroke'), [0, 1, 2, 3, 4, 5].filter((id) => !cargo.includes(id)), 'outlined for ' + cargo);
  }
});

test('the rival line gives the racing rival\'s box count', () => {
  const { G, draw } = round(), [me, o] = G.players;
  o.cargo.push(0, 2, 3, 5);
  const line = texts(draw('drawRival', me));
  assert.equal(line.length, 1);
  assert.match(line[0], /^B · %\d+ · Rakip 4\/6 · \d\.$/);
  o.phase = 'load';
  assert.match(texts(draw('drawRival', me))[0], /^B · YÜKLEME · \d\.$/);
});

test('the park HUD shows the boxes still missing, or none', () => {
  const { TR, G, draw } = round(), p = G.players[0];
  p.phase = 'park';
  p.cargo.push(0, 3, 1, 2);
  const log = draw('draw', p);
  assert.ok(texts(log).includes('Eksik kutu:'));
  assert.deepEqual(boxIds(TR, calls(log, 'fillRect').filter((c) => c.a[2] === 20 && c.a[3] === 20), 'fill'), [4, 5]);
  p.cargo.push(5, 4);
  const full = draw('draw', p);
  assert.ok(texts(full).includes('yok'));
  assert.equal(calls(full, 'fillRect').filter((c) => c.a[2] === 20 && c.a[3] === 20).length, 0);
});

test('the load HUD names the phase, the trailer\'s count and the key that leaves the ramp', () => {
  const { TR, G, draw } = round(), p = G.players[0];
  const dp = G.map.segs.flatMap((sg) => sg.road.depots)[0];
  p.cargo.push(2, 0);
  p.phase = 'load';
  p.loader = new TR.Loader(p.idx, dp, p.color, p.cargo, p.ground[dp.box]);
  const all = texts(draw('draw', p));
  assert.ok(all.includes('YÜKLEME'), all.join(' | '));
  assert.ok(all.includes('Dorsede: 2/6'), all.join(' | '));
  const hint = TR.KEYNAMES[0].reset + ': eli boşken rampadan çık';
  assert.ok(all.some((s) => s.includes(hint)), all.join(' | '));
  assert.ok(all.includes('Kontrat: ' + G.contract.text + ' · devam'), all.join(' | '));
});

test('the unload HUD counts the boxes stacked right', () => {
  const { TR, G, draw } = round(), p = G.players[0];
  p.cargo.push(0, 1, 2, 3, 4, 5);
  p.phase = 'unload';
  p.unloader = new TR.Unloader(p.idx, G.lot, { target: G.plan.target, trailer: p.cargo }, p.color);
  const tall = G.plan.target.findIndex((c) => c.length > 1), want = G.plan.target[tall];
  // The cell's bottom box right and the one on it wrong: one right in all.
  p.unloader.cells[tall].push(want[0], [0, 1, 2].find((id) => id !== want[0] && id !== want[1]));
  const all = texts(draw('draw', p));
  assert.ok(all.includes('Doğru: 1/6'), all.join(' | '));
});

// previewPath's comment rests on this: MapGen does not keep one role furthest west.
test('no one role runs furthest west at every fork', () => {
  const w = menu(), TR = w.TR, G = TR.Game, roles = {};
  let forks = 0;
  for (let i = 0; i < TR.ROUTES.length; i++) {
    G.preview = null;
    G.previewIdx = i;
    w.step();
    const map = G.preview;
    for (const sg of map.segs) {
      if (sg.out.length < 2) continue;
      forks++;
      const west = sg.out.reduce((b, k) => (map.segs[k].road.xs[map.segs[k].road.n >> 1] < map.segs[b].road.xs[map.segs[b].road.n >> 1] ? k : b));
      roles[map.segs[west].spec.role] = (roles[map.segs[west].spec.role] || 0) + 1;
    }
  }
  assert.ok(forks >= 2 * TR.ROUTES.length, forks + ' forks');
  assert.ok(roles.shortcut > 0 && roles.shortcut < forks, 'the preview takes the shortcut at ' + roles.shortcut + ' of ' + forks + ' forks');
  assert.ok(roles.busy > 0, 'the busy branch is never furthest west: ' + JSON.stringify(roles));
});
