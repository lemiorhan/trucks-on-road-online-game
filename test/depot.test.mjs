// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' against ' + b);

// A generated round in play with no traffic, junction cars or events, so a truck's run depends only on its
// own input; draw keeps the map, the lot and the depots drawing.
function world(ri, seed, draw = false) {
  const clock = { t: 1000 };
  const w = makeWorld('depot', { clock });
  const TR = w.TR, G = TR.Game;
  TR.Settings.set({ traffic: 'normal', weather: 'gunduz' });
  G.newSeries(['A', 'B'], ['kapali', 'kapali']);
  G.startRound(ri, { seed });
  for (const sg of G.map.segs) {
    sg.traffic.cars.length = 0;
    sg.traffic.update = () => {};
    sg.junctions.cars.length = 0;
    sg.junctions.update = () => [];
    sg.events.update = () => [];
  }
  if (!draw) G.map.draw = () => {};
  TR.Light.draw = () => {};
  TR.HUD.draw = () => {};
  w.step = () => {
    clock.t += FRAME_MS;
    w.frame();
  };
  while (G.state === 'countdown') w.step();
  return w;
}

const RI = 0, SEED = 1;

// Every depot of the round's map, with the segment it stands on.
const depots = (G) => G.map.segs.flatMap((sg) => sg.road.depots.map((dp) => ({ sg, dp })));

const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

function park(w, p) {
  p.truck.place(p.idx * 900 - 6000, 2000, -Math.PI / 2);
  p.truck.v = 0;
  p.seg = w.TR.Game.map.start;
  p.hint = -1;
}

// dp's frame for the dock run: x out along the side road with the ramps' face at x = 0, y a quarter
// turn clockwise from it, so steering right turns towards +y as it does in the world.
function dockFrame(TR, dp) {
  const D = TR.DEPOT, far = D.LEN + D.YARD_LEN, base = Math.atan2(dp.oy, dp.ox), wx = -dp.oy, wy = dp.ox;
  return {
    base,
    local: (x, y) => ({ x: (x - dp.x) * dp.ox + (y - dp.y) * dp.oy - far, y: (x - dp.x) * wx + (y - dp.y) * wy }),
    world: (x, y) => ({ x: dp.x + dp.ox * (x + far) + wx * y, y: dp.y + dp.oy * (x + far) + wy * y }),
  };
}

function put(w, p, sg, x, y, th) {
  p.truck.place(x, y, th);
  p.seg = sg.id;
  p.s = sg.road.locate(x, y, -1).s;
  p.hint = -1;
}

test('a depot stands square to its road, with its mouth, yard and ramps where its knobs put them', () => {
  const w = makeWorld('a', { clock: { t: 1000 } }), TR = w.TR;
  const seg = {
    id: 0, a: { x: 0, y: 0 }, b: { x: 0, y: -12000 }, detour: 0, curvy: 0, tight: 1, wseed: 3,
    features: [{ type: 'depot', rise: 3000, dir: 1, box: 2 }, { type: 'depot', rise: 7000, dir: -1, box: 4 }],
  };
  const [east, west] = new TR.Road(TR.ROUTES[0], seg).depots;
  const at = (q) => [Math.round(q.x), Math.round(q.y)];
  assert.deepEqual([east.box, east.dir, at(east), at(east.mouth), at(east.yard)], [2, 1, [0, -3000], [150, -3000], [850, -3000]]);
  assert.deepEqual([...east.ramps].map(at), [[1100, -3045], [1100, -2955]]);
  assert.deepEqual([west.box, west.dir, at(west), at(west.mouth), at(west.yard)], [4, -1, [0, -7000], [-150, -7000], [-850, -7000]]);
  assert.deepEqual([...west.ramps].map(at), [[-1100, -6955], [-1100, -7045]]);

  let bent = 0, n = 0;
  const G = world(RI, SEED).TR.Game;
  for (const { sg, dp } of depots(G)) {
    // Roadside props keep off the depot's ground past the barrier, and the centre line stays its own segment's.
    const far = { x: dp.x + dp.ox * (TR.DEPOT.LEN + TR.DEPOT.YARD_LEN + 10), y: dp.y + dp.oy * (TR.DEPOT.LEN + TR.DEPOT.YARD_LEN + 10) };
    assert.equal(G.map.onRoad(dp.yard.x, dp.yard.y, 0, sg.id), true, 'box ' + dp.box + ': props in the yard');
    assert.equal(G.map.onRoad(far.x, far.y, 20, sg.id), true, 'box ' + dp.box + ': props within the margin of the far wall');
    assert.equal(G.map.onRoad(dp.x, dp.y, 0, sg.id), false, 'box ' + dp.box + ': the centre line is another road');
    const road = sg.road, h = road.headingAt(dp.s), at = 'segment ' + sg.id + ' box ' + dp.box;
    n++;
    if (Math.abs(h + Math.PI / 2) > 0.05) bent++;
    close(dp.y, road.posAt(dp.s, 0).y, 1e-6, at + ': y');
    close(dp.x, road.posAt(dp.s, 0).x, 1e-6, at + ': x');
    close(Math.hypot(dp.ox, dp.oy), 1, 1e-9, at + ': out is a unit vector');
    close(dp.ox * dp.ax + dp.oy * dp.ay, 0, 1e-9, at + ': out is square to along');
    close(Math.atan2(dp.ay, dp.ax), h, 0.01, at + ': along follows the road');
    close(road.locate(dp.mouth.x, dp.mouth.y, -1).d, dp.dir * TR.ROAD.RAIL, 2, at + ': the mouth is on the barrier, on its own side');
  }
  assert.equal(n, w.TR.BOXES.length);
  assert.ok(bent > 0, 'no depot on a bend');
});

test('a truck standing in a depot\'s side road or yard is neither pushed nor off the road', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, D = TR.DEPOT, p = G.players[0];
  park(w, G.players[1]);
  TR.Input.sources[p.idx] = () => NONE;
  const all = depots(G);
  let spots = 0;
  for (const { sg, dp } of all) {
    const out = Math.atan2(dp.oy, dp.ox), along = Math.atan2(dp.ay, dp.ax);
    const at = (u, v) => ({ x: dp.x + dp.ox * u + dp.ax * v, y: dp.y + dp.oy * u + dp.ay * v });
    // Down the side road, then the yard's middle crosswise and its far corner by the ramps, the cab 4 off its walls.
    const corner = [D.LEN + D.YARD_LEN - 4 - TR.TRUCK.CAB_HW, D.YARD_HW - 4 - TR.TRUCK.CAB_FRONT, along];
    for (const [u, v, th] of [[350, 0, out], [D.LEN + D.YARD_LEN / 2, 0, along], corner]) {
      const q = at(u, v), what = 'box ' + dp.box + ' at u ' + u + ' v ' + v;
      put(w, p, sg, q.x, q.y, th);
      for (let f = 0; f < 10; f++) {
        w.step();
        assert.deepEqual([p.truck.x, p.truck.y], [q.x, q.y], what + ': pushed on frame ' + f);
        assert.equal(p.offroad, false, what + ': off the road on frame ' + f);
      }
      spots++;
    }
  }
  assert.equal(p.bumps, 0);
  assert.equal(all.length, TR.BOXES.length);
  assert.equal(spots, 3 * all.length);
});

test('past a depot\'s barrier the push brings a point back; off the depot it is the road\'s own', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, D = TR.DEPOT, far = D.LEN + D.YARD_LEN;
  let n = 0;
  for (const { sg, dp } of depots(G)) {
    const lim = (u, v) => sg.junctions.limit(dp.x + dp.ox * u + dp.ax * v, dp.y + dp.oy * u + dp.ay * v);
    const what = 'box ' + dp.box;
    // [u, v] past a wall, the overshoot and the push's direction in the depot's frame [along u, along v].
    const cases = [
      [[far + 20, 0], 20, [-1, 0]],
      [[far + 20, -D.YARD_HW + 30], 20, [-1, 0]],
      [[D.LEN + 200, D.YARD_HW + 15], 15, [0, -1]],
      [[D.LEN + 200, -D.YARD_HW - 15], 15, [0, 1]],
      [[300, D.RAIL + 10], 10, [0, -1]],
      [[300, -D.RAIL - 10], 10, [0, 1]],
      [[D.LEN - 10, D.RAIL + 30], 10, [1, 0]],
    ];
    for (const [[u, v], over, [pu, pv]] of cases) {
      const push = lim(u, v), at = what + ' at u ' + u + ' v ' + v;
      assert.ok(push, at + ': no push');
      close(push.over, over, 1e-6, at + ': over');
      close(push.nx, pu * dp.ox + pv * dp.ax, 1e-6, at + ': nx');
      close(push.ny, pu * dp.oy + pv * dp.ay, 1e-6, at + ': ny');
    }
    for (const [u, v] of [[0, 0], [300, D.RAIL - 1], [far - 1, D.YARD_HW - 1], [D.LEN + 1, -D.YARD_HW + 1], [TR.ROAD.HALF, D.RAIL + 30]]) {
      assert.equal(lim(u, v), null, what + ' at u ' + u + ' v ' + v + ': pushed');
    }
    assert.equal(lim(-200, 0), undefined, what + ': the main road\'s far side');
    assert.equal(lim(far + 400, 0), undefined, what + ': past the depot');
    n++;
  }
  assert.equal(n, TR.BOXES.length);
});

// The dock run: in along y = Y0, a forward U-turn on STEER from x = X_TURN, HOLD straight on the ramp's
// line, then reverse with the trailer steered onto it until the door is at the face; then out up the side
// road onto the main road, or, with stay, standing there until the loading starts.
const Y0 = -80, X_TURN = -390, STEER = 0.48, HOLD = 300, VF = 40, VR = 30;

function dockRun(w, sg, dp, idx, stay = false) {
  const TR = w.TR, U = TR.U, G = TR.Game, p = G.players[0], F = dockFrame(TR, dp);
  const e = F.local(dp.ramps[idx].x, dp.ramps[idx].y).y;
  const sat = (v, m) => Math.max(-m, Math.min(m, v));
  const s0 = F.world(-TR.DEPOT.LEN - TR.DEPOT.YARD_LEN + 200, Y0);
  put(w, p, sg, s0.x, s0.y, F.base);
  let phase = 0, turned = 0, held = 0, last = null;
  TR.Input.sources[p.idx] = () => {
    const t = p.truck, q = F.local(t.x, t.y), th = U.wrap(t.th - F.base), phi = U.wrap(t.phi - F.base);
    if (last) {
      if (last.phase === 1 || last.phase === 2) turned += U.wrap(t.th - last.th);
      if (last.phase === 2) held += Math.hypot(t.x - last.x, t.y - last.y);
    }
    let st = 0, thr = 0, brake = false;
    if (phase === 0) { thr = 1; if (q.x >= X_TURN) phase = 1; }
    if (phase === 1) { thr = 1; st = STEER; if (turned >= Math.PI - 0.15) phase = 2; }
    if (phase === 2) {
      thr = 1;
      st = sat(3 * U.wrap(Math.PI + sat(0.02 * (q.y - e), 0.4) - th), 1);
      if (held >= HOLD) phase = 3;
    }
    if (phase === 3) { brake = true; if (Math.abs(t.v) < 0.5) { t.v = 0; phase = 4; } }
    if (phase === 4) {
      thr = -1;
      const rr = F.local(t.trailerRear().x, t.trailerRear().y);
      const relT = sat(2 * U.wrap(phi - (Math.PI - sat(0.02 * (rr.y - e), 0.2))), 0.6);
      st = sat(3 * (U.wrap(th - phi) - relT), 1);
      if (rr.x >= -8) phase = 5;
    }
    if (phase === 5) { brake = true; if (Math.abs(t.v) < 0.5) phase = 6; }
    if (phase === 6 && !stay) {
      thr = 1;
      st = sat(3 * U.wrap(Math.PI + sat(0.02 * q.y, 0.4) - th), 1);
    }
    if (thr && Math.abs(t.v) >= (thr > 0 ? VF : VR)) thr = 0;
    last = { phase, th: t.th, x: t.x, y: t.y };
    return Object.assign({}, NONE, { thr, steer: st, brake });
  };
  const rows = [];
  let docked = null, still = 0;
  for (let f = 0; f < 60 * 120; f++) {
    const { x, y } = p.truck;
    w.step();
    rows.push({ bumps: p.bumps, offroad: p.offroad, jack: p.truck.jack, x, y, s: p.s });
    if (phase === 6 && !docked) {
      const r = F.local(p.truck.trailerRear().x, p.truck.trailerRear().y);
      docked = { door: -r.x, lateral: r.y - e, angle: (Math.abs(U.wrap(U.wrap(p.truck.phi - F.base) - Math.PI)) * 180) / Math.PI };
    }
    if (stay && (p.phase === 'load' || (phase === 6 && ++still > 120))) return { rows, docked, phase, load: p.phase === 'load' };
    if (phase === 6 && sg.road.locate(p.truck.x, p.truck.y, -1).d * dp.dir < TR.ROAD.HALF) return { rows, docked, phase, out: true };
  }
  return { rows, docked, phase, out: false };
}

test('a U-turn in the yard and a reverse back onto either ramp of every depot and drives out without touching a rail', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, L = TR.LOT;
  park(w, G.players[1]);
  let runs = 0;
  for (const { sg, dp } of depots(G)) {
    for (const idx of [0, 1]) {
      const at = 'box ' + dp.box + ' ramp ' + idx, bumps0 = G.players[0].bumps;
      const { rows, docked, phase, out } = dockRun(w, sg, dp, idx);
      assert.ok(docked, at + ': never docked, stopped in phase ' + phase);
      assert.ok(out, at + ': never drove back onto the main road');
      assert.ok(docked.door < L.REAR_TOL && Math.abs(docked.lateral) <= L.LATERAL_MAX && docked.angle < L.ANGLE_TOL, at + ': ' + JSON.stringify(docked));
      rows.forEach((r, f) => {
        assert.equal(r.bumps, bumps0, at + ': touched a rail on frame ' + f);
        assert.equal(r.offroad, false, at + ': off the road on frame ' + f);
        assert.ok(!(r.jack > 0), at + ': jackknifed on frame ' + f);
      });
      runs++;
    }
  }
  assert.equal(runs, 2 * TR.BOXES.length);
});

test('a truck in a depot\'s side road or yard is at the depot\'s s on every frame, and back on the main road at its own', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, D = TR.DEPOT, R = TR.ROAD, p = G.players[0], far = D.LEN + D.YARD_LEN;
  park(w, G.players[1]);
  let runs = 0, worstJump = 0;
  for (const { sg, dp } of depots(G)) {
    const at = 'box ' + dp.box, { rows, out } = dockRun(w, sg, dp, 0);
    assert.ok(out, at + ': never drove back onto the main road');
    TR.Input.sources[p.idx] = () => NONE;
    for (let f = 0; f < 30; f++) {
      const { x, y } = p.truck;
      w.step();
      rows.push({ x, y, s: p.s });
    }
    let pinned = 0, own = 0, last = null;
    rows.forEach((r, f) => {
      const { u, v } = TR.Road.depotUV(dp, r.x, r.y);
      const inside = (u >= R.RAIL && u <= D.LEN && Math.abs(v) <= D.RAIL) || (u >= D.LEN && u <= far && Math.abs(v) <= D.YARD_HW);
      const nearest = sg.road.locate(r.x, r.y, -1).s;
      if (inside) {
        assert.equal(r.s, dp.s, at + ': s in the depot on frame ' + f);
        if (last != null) worstJump = Math.max(worstJump, Math.abs(nearest - last));
        last = nearest;
        pinned++;
      } else {
        close(r.s, nearest, 1e-6, at + ': s on the main road on frame ' + f);
        own++;
      }
    });
    assert.ok(pinned > 0 && own > 30, at + ': ' + pinned + ' frames in the depot, ' + own + ' out of it');
    runs++;
  }
  assert.equal(runs, TR.BOXES.length);
  assert.ok(worstJump > 100, 'no depot on a bend where the nearest road point jumps a frame: ' + worstJump);
});

test('a truck driven back onto its ramp of every depot and left standing there starts loading', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, a = G.players[0];
  park(w, G.players[1]);
  let runs = 0;
  for (const { sg, dp } of depots(G)) {
    if (a.phase === 'load') play(w, a, [RESET]);
    const { load, phase } = dockRun(w, sg, dp, a.idx, true);
    assert.ok(load, 'box ' + dp.box + ': no loading, stopped in phase ' + phase + ' with ' + JSON.stringify(a.dock));
    assert.equal(a.loader.dp, dp);
    runs++;
  }
  assert.equal(runs, TR.BOXES.length);
});

test('a truck in the northbound lane turns off into every depot\'s side road and reaches its yard without touching a rail', () => {
  const w = world(RI, SEED), TR = w.TR, U = TR.U, R = TR.ROAD, G = TR.Game, p = G.players[0];
  park(w, G.players[1]);
  const LOOK = 140, V = 80, K = 2.5;
  let runs = 0;
  for (const { sg, dp } of depots(G)) {
    const road = sg.road, at = 'box ' + dp.box, s0 = dp.s - 900, q0 = road.lanePos(s0, R.LANE / 2);
    put(w, p, sg, q0.x, q0.y, q0.h);
    // The lane's middle up to 250 short of the mouth, then the side road's centre line out to the yard.
    const path = [];
    for (let s = s0; s < dp.s - 250; s += 20) path.push(road.posAt(s, R.LANE / 2));
    for (let u = 60; u <= 900; u += 20) path.push(TR.Road.depotXY(dp, u, 0));
    let next = 0;
    TR.Input.sources[p.idx] = () => {
      const t = p.truck, dist = (q) => Math.hypot(q.x - t.x, q.y - t.y);
      while (next < path.length - 1 && dist(path[next + 1]) < dist(path[next])) next++;
      let k = next;
      while (k < path.length - 1 && dist(path[k]) < LOOK) k++;
      const steer = Math.max(-1, Math.min(1, K * U.wrap(Math.atan2(path[k].y - t.y, path[k].x - t.x) - t.th)));
      return Object.assign({}, NONE, { thr: t.v < V ? 1 : 0, steer });
    };
    const bumps0 = p.bumps;
    let yard = false;
    for (let f = 0; f < 60 * 40 && !yard; f++) {
      w.step();
      assert.equal(p.bumps, bumps0, at + ': touched a rail on frame ' + f);
      assert.equal(p.offroad, false, at + ': off the road on frame ' + f);
      assert.ok(!(p.truck.jack > 0), at + ': jackknifed on frame ' + f);
      const rear = p.truck.trailerRear();
      yard = TR.Road.depotUV(dp, rear.x, rear.y).u > TR.DEPOT.LEN;
    }
    assert.ok(yard, at + ': the trailer never got into the yard');
    runs++;
  }
  assert.equal(runs, TR.BOXES.length);
});

test('each depot is signed before its mouth, and each fork before the alternative that holds boxes', () => {
  const LABELS = 'ABCDEF', RIS = [0, 1, 2], SEEDS = [1, 98, 195];
  let signed = 0, forks = 0, boxes = 0;
  for (const ri of RIS) {
    for (const seed of SEEDS) {
      const TR = world(ri, seed).TR, map = TR.Game.map, LEAD = TR.ROAD.SIGN_LEAD;
      boxes = TR.BOXES.length;
      for (const sg of map.segs) {
        const road = sg.road;
        for (const dp of road.depots) {
          const text = 'KUTU ' + LABELS[dp.box] + ' ' + (dp.dir > 0 ? '→' : '←');
          assert.ok(road.signList.some((g) => g.text === text && Math.abs(g.s - (dp.s - LEAD)) < 1e-6), ri + '/' + seed + ': no "' + text + '" on segment ' + sg.id);
          signed++;
        }
        const sibs = map.segs.filter((o) => o !== sg && o.spec.a === sg.spec.a && o.spec.b === sg.spec.b);
        if (!road.depots.length || !sibs.length) continue;
        const east = sibs.every((o) => o.spec.detour < sg.spec.detour);
        const text = 'KUTU ' + road.depots.map((dp) => LABELS[dp.box]).join(' ') + ' ' + (east ? '↗' : '↖');
        for (const k of sg.in) {
          const into = map.segs[k].road;
          assert.ok(into.signList.some((g) => g.text === text && Math.abs(g.s - (into.length - LEAD)) < 1e-6), ri + '/' + seed + ': no "' + text + '" on segment ' + k);
          forks++;
        }
      }
    }
  }
  assert.equal(signed, RIS.length * SEEDS.length * boxes);
  assert.ok(forks > 0, 'no fork sign checked');
});

test('a box shows on its ramp only in the viewport of a player who has not taken it', () => {
  const w = world(RI, SEED, true), TR = w.TR, G = TR.Game, [a, b] = G.players;
  const { sg, dp } = depots(G)[0];
  const at = (u, v) => ({ x: dp.x + dp.ox * u + dp.ax * v, y: dp.y + dp.oy * u + dp.ay * v });
  const D = TR.DEPOT, out = Math.atan2(dp.oy, dp.ox);
  for (const [p, v] of [[a, 60], [b, -60]]) {
    const q = at(D.LEN + 100, v);
    put(w, p, sg, q.x, q.y, out);
    TR.Input.sources[p.idx] = () => NONE;
  }
  for (let f = 0; f < 120; f++) w.step();
  const calls = [], draw = TR.drawBoxStacked;
  TR.drawBoxStacked = (ctx, x, y, id, lvl, size) => {
    calls.push({ x, y, id });
    draw(ctx, x, y, id, lvl, size);
  };
  const uv = (q) => ({ u: (q.x - dp.x) * dp.ox + (q.y - dp.y) * dp.oy, v: (q.x - dp.x) * dp.ax + (q.y - dp.y) * dp.ay });
  // The ramp whose platform, RAMP_D deep past its face and BAY_W wide, the box stands on.
  const onRamp = (c) => dp.ramps.findIndex((r) => {
    const q = uv(c), f = uv(r);
    return q.u > f.u && q.u < f.u + D.RAMP_D && Math.abs(q.v - f.v) < TR.LOT.BAY_W / 2;
  });
  const shown = () => {
    calls.length = 0;
    w.step();
    return calls.filter((c) => Math.hypot(c.x - dp.yard.x, c.y - dp.yard.y) < 600).map((c) => {
      assert.equal(c.id, dp.box);
      return onRamp(c);
    }).sort();
  };
  assert.deepEqual(shown(), [0, 1]);
  // The yard's concrete, a path from its corner by the side road filled in the lot's floor colour.
  const c = at(D.LEN, -D.YARD_HW), from = '.moveTo(' + c.x + ',' + c.y + ')';
  assert.ok(w.log.some((l, i) => l.endsWith(from) && w.log.slice(i, i + 8).join('|').includes('.fillStyle="#585c61"|')), 'the yard is not drawn');
  a.ground[dp.box].length = 0;
  assert.deepEqual(shown(), [1]);
  b.ground[dp.box].length = 0;
  assert.deepEqual(shown(), []);
});

// A canvas stand-in that keeps each stroke's style and vertices and each fillRect's style and centre.
function recorder() {
  const st = { fillStyle: null, strokeStyle: null, lineWidth: 1 }, out = { strokes: [], rects: [] };
  let path = [];
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k in st) return st[k];
      if (k === 'beginPath') return () => { path = []; };
      if (k === 'moveTo' || k === 'lineTo') return (x, y) => path.push([x, y]);
      if (k === 'stroke') return () => out.strokes.push({ style: st.strokeStyle, width: st.lineWidth, pts: path.slice() });
      if (k === 'fillRect') return (x, y, rw, rh) => out.rects.push({ style: st.fillStyle, x: x + rw / 2, y: y + rh / 2 });
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
      return () => {};
    },
    set: (t, k, v) => ((st[k] = v), true),
  });
  return { ctx, out };
}

// In a depot's frame, (u, v) as depotUV gives them: the side road's barrier from the main road's (RAIL 150 out)
// along v = ±100 to the yard, round the yard's 150 either side and 1100 out, and back; its edge lines from the
// main road's asphalt edge (108) to the yard (600), 2 inside its asphalt's 62.
const RAILED = [[150, 100], [600, 100], [600, 150], [1100, 150], [1100, -150], [600, -150], [600, -100], [150, -100]];
const EDGED = [[[108, -60], [600, -60]], [[108, 60], [600, 60]]];

test('a depot\'s mouth cuts the main road\'s rail, edge line and posts on its side only, and its own road is railed and lined', () => {
  const TR = makeWorld('draw', { clock: { t: 1000 } }).TR, D = TR.DEPOT, R = TR.ROAD;
  const isRail = (st) => st.style === '#9aa3ab' && st.width === 4, isEdge = (st) => st.style === '#f2f2f2' && st.width === 3;
  // Seeds with depots on tight bends among them, where a line off the centre runs much shorter or longer than s.
  const SEEDS = [1, 583, 1456, 2038];
  let n = 0;
  for (const route of TR.ROUTES) {
    for (const seed of SEEDS) {
      const map = new TR.RoadMap(TR.MapGen.generate(route, seed), route);
      for (const sg of map.segs) {
        for (const dp of sg.road.depots) {
          const at = route.id + ' seed ' + seed + ' box ' + dp.box, rec = recorder();
          const view = { z: 1, x0: dp.x - 1500, x1: dp.x + 1500, y0: dp.y - 1500, y1: dp.y + 1500 };
          for (const layer of ['marks', 'rails']) sg.road.drawLayer(rec.ctx, view, layer, map);
          const uv = ([x, y]) => TR.Road.depotUV(dp, x, y);
          const shaped = (st, pts) => st.pts.length === pts.length && st.pts.every((p, k) => Math.abs(uv(p).u - pts[k][0]) < 1e-6 && Math.abs(uv(p).v - pts[k][1]) < 1e-6);
          const own = (pick, shapes) => {
            const strokes = rec.out.strokes.filter(pick);
            for (const pts of shapes) assert.equal(strokes.filter((st) => shaped(st, pts)).length, 1, at + ': ' + JSON.stringify(pts));
            return strokes.filter((st) => !shapes.some((pts) => shaped(st, pts)));
          };
          // The main road's line either side of its centre line: none of it in the mouth on the depot's side,
          // where it reaches the side road's barrier from both ends; all of it on the far side. On a tight
          // bend the line on the inside meets the barrier well out from its own offset.
          const NEAR = 300, near = (q) => Math.abs(q.u) < NEAR && Math.abs(q.v) < NEAR;
          const mouth = (strokes, half, what) => {
            const pts = strokes.flatMap((st) => st.pts.map(uv)).filter(near);
            const mine = pts.filter((q) => q.u > 0), far = pts.filter((q) => q.u < 0);
            for (const q of mine) assert.ok(Math.abs(q.v) >= half, at + ': the ' + what + ' runs into the mouth at v ' + q.v.toFixed(1));
            for (const sign of [-1, 1]) {
              const edge = Math.min(...mine.filter((q) => q.v * sign > 0).map((q) => Math.abs(q.v)));
              assert.ok(edge <= half + 2 * R.DS, at + ': the ' + what + ' stops ' + edge.toFixed(1) + ' off the mouth\'s centre on its ' + (sign > 0 ? '+v' : '-v') + ' side');
            }
            assert.ok(far.some((q) => Math.abs(q.v) < half), at + ': the ' + what + ' is cut on the far side');
          };
          mouth(own(isRail, [RAILED]), D.RAIL, 'rail');
          mouth(own(isEdge, EDGED), 62, 'edge line');
          const posts = rec.out.rects.filter((r) => r.style === '#6b737a').map((r) => uv([r.x, r.y])).filter((q) => q.u > 0 && near(q));
          for (const q of posts) assert.ok(Math.abs(q.v) >= D.RAIL, at + ': a post in the mouth at v ' + q.v.toFixed(1));
          assert.ok(posts.length > 0, at + ': no post beside the mouth');
          n++;
        }
      }
    }
  }
  assert.equal(n, TR.ROUTES.length * SEEDS.length * TR.BOXES.length);
});

// Puts p's truck backed onto its ramp at dp, the trailer's door short of the face and side along it off its
// middle, turned by turn degrees about the door.
function dock(w, p, sg, dp, turn = 0, short = 5, side = 0) {
  const T = w.TR.TRUCK, k = T.LT + T.TR_REAR, face = dp.ramps[p.idx];
  const phi = Math.atan2(-dp.oy, -dp.ox) + (turn * Math.PI) / 180;
  const x = face.x - dp.ox * short + dp.ax * side, y = face.y - dp.oy * short + dp.ay * side;
  put(w, p, sg, x + Math.cos(phi) * k, y + Math.sin(phi) * k, phi);
}

// One frame for each input given to player p, NONE after.
function play(w, p, inputs) {
  for (const inp of inputs) {
    w.TR.Input.sources[p.idx] = () => Object.assign({}, NONE, inp);
    w.step();
  }
  w.TR.Input.sources[p.idx] = () => NONE;
}

const frames = (n, inp) => Array.from({ length: n }, () => inp);
// The game's arrays come from the world's own realm, which deepEqual does not take for this one's.
const here = (list) => [...list];
const TAP = [{ action: true }, {}];
// The up key, as Input.keys gives it: gas for the truck and a step up the screen for the worker.
const GAS = { thr: 1, my: -1 };
const RESET = { reset: true };

// Walks p's worker straight to (x, y), a frame at a time.
function walkTo(w, p, x, y) {
  const wk = (p.loader || p.unloader).worker;
  for (let f = 0; f < 600 && Math.hypot(x - wk.x, y - wk.y) > 3; f++) play(w, p, [{ mx: x - wk.x, my: y - wk.y }]);
  assert.ok(Math.hypot(x - wk.x, y - wk.y) <= 3, 'the worker did not get to ' + x + ', ' + y);
}

// Whether the frame w draws next has a draw call that includes needle.
function drawn(w, needle) {
  w.step();
  return w.log.some((l) => l.includes(needle));
}

// A round with player 1 parked out of the way and player 0 loading at the first depot.
function loading() {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  const { sg, dp } = depots(G)[0];
  dock(w, a, sg, dp);
  play(w, a, frames(60, {}));
  assert.equal(a.phase, 'load');
  return { w, G, a, b, sg, dp };
}

test('a truck backed square onto its ramp starts loading after standing there; turned past the angle tolerance it does not', () => {
  const w = world(RI, SEED), TR = w.TR, G = TR.Game, [a, b] = G.players;
  park(w, b);
  const { sg, dp } = depots(G)[0];
  dock(w, a, sg, dp, TR.LOT.ANGLE_TOL + 0.5);
  play(w, a, frames(120, {}));
  assert.equal(a.phase, 'race');
  assert.ok(a.dock.inside && a.dock.rearDist < TR.LOT.REAR_TOL, 'only the angle should be off: ' + JSON.stringify(a.dock));
  assert.ok(a.dock.angleErr > TR.LOT.ANGLE_TOL);

  dock(w, a, sg, dp, TR.LOT.ANGLE_TOL - 1);
  play(w, a, frames(30, {}));
  assert.equal(a.phase, 'race', 'loading before the hold ran out');
  play(w, a, frames(30, {}));
  assert.equal(a.phase, 'load');
  assert.equal(a.loader.dp, dp);
  assert.equal(b.phase, 'race');
});

test('a truck square at its ramp starts no loading with its door short of REAR_TOL, off the ramp\'s side, or rolling at STOP_TOL', () => {
  const L = makeWorld('l', { clock: { t: 1000 } }).TR.LOT;
  // [what, short, side, speed, which of inside and the door's reach should hold]
  const cases = [
    ['door short', L.REAR_TOL + 5, 0, 0, [true, false]],
    ['off the side', 5, L.LATERAL_MAX + 4, 0, [false, true]],
    ['rolling', 5, 0, L.STOP_TOL + 4, [true, true]],
    ['rolling slower', 5, 0, L.STOP_TOL - 2, [true, true]],
  ];
  for (const [what, short, side, speed, want] of cases) {
    const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
    park(w, b);
    const { sg, dp } = depots(G)[0];
    dock(w, a, sg, dp, 0, short, side);
    let loaded = false;
    for (let f = 0; f < 90 && !loaded; f++) {
      if (speed) {
        dock(w, a, sg, dp, 0, short, side);
        a.truck.v = speed;
      }
      play(w, a, [{}]);
      loaded = a.phase === 'load';
      if (loaded) break;
      assert.deepEqual([a.dock.inside, a.dock.rearDist < L.REAR_TOL], want, what + ' on frame ' + f + ': ' + JSON.stringify(a.dock));
      assert.ok(a.dock.angleErr < L.ANGLE_TOL, what + ': the angle is off');
      assert.equal(Math.abs(a.truck.v) > L.STOP_TOL, speed > L.STOP_TOL, what + ' on frame ' + f + ': v ' + a.truck.v);
    }
    assert.equal(loaded, what === 'rolling slower', what);
  }
});

test('the box carried from the ramp to the door goes onto the end of the cargo', () => {
  const { w, a, dp } = loading();
  a.cargo.push(3, 1);
  play(w, a, frames(6, { mx: dp.ox, my: dp.oy }).concat(TAP));
  assert.equal(a.loader.worker.carry, dp.box);
  assert.equal(a.ground[dp.box].length, 0);
  play(w, a, frames(10, { mx: -dp.ox, my: -dp.oy }).concat(TAP));
  assert.deepEqual(here(a.cargo), [3, 1, dp.box]);
  assert.equal(a.loader.worker.carry, null);
});

test('a box taken out of the trailer and put down stays on the ramp after the truck leaves, out of the cargo', () => {
  const { w, a, dp } = loading();
  a.cargo.push(3, 1);
  play(w, a, frames(15, { mx: -dp.ox, my: -dp.oy }).concat(TAP));
  assert.equal(a.loader.worker.carry, 1, 'the door end comes out first');
  play(w, a, frames(45, { mx: dp.ox, my: dp.oy }).concat(TAP));
  assert.equal(a.loader.worker.carry, null);
  const left = a.ground[dp.box].find((g) => g.id === 1);
  assert.ok(left, 'not put down: ' + JSON.stringify(a.ground[dp.box]));
  play(w, a, [RESET]);
  assert.equal(a.phase, 'race');
  assert.equal(a.loader, null);
  play(w, a, frames(60, GAS));
  assert.deepEqual(here(a.cargo), [3]);
  assert.deepEqual(here(a.ground[dp.box].map((g) => g.id)).sort(), [1, dp.box].sort());
  assert.ok(a.ground[dp.box].includes(left));
  assert.ok(a.truck.v > 20, 'the truck did not drive off');
});

test('reset leaves the ramp only with the worker\'s hands empty, and gas never does', () => {
  const { w, a, dp } = loading();
  play(w, a, frames(30, GAS));
  assert.equal(a.phase, 'load', 'gas left the ramp with the hands empty');
  assert.equal(a.loader.worker.carry, null);
  const box = a.ground[dp.box][0];
  walkTo(w, a, box.x, box.y);
  play(w, a, TAP);
  assert.equal(a.loader.worker.carry, dp.box);
  play(w, a, [RESET]);
  assert.equal(a.phase, 'load', 'reset left the ramp with a box in hand');
  play(w, a, frames(30, GAS));
  assert.equal(a.phase, 'load');
  assert.equal(a.truck.v, 0);
  walkTo(w, a, dp.ramps[a.idx].x, dp.ramps[a.idx].y);
  play(w, a, TAP.concat([RESET]));
  assert.deepEqual(here(a.cargo), [dp.box]);
  assert.equal(a.phase, 'race');
  assert.equal(a.resets, 0, 'leaving the ramp counted as a reset');
  // The truck has not moved off the ramp yet, which does not start loading again.
  play(w, a, frames(60, {}));
  assert.equal(a.phase, 'race');
});

test('a racing truck that runs into one loading at its ramp is pushed off it, and the loading one does not move', () => {
  const { w, a, dp } = loading(), b = w.TR.Game.players[1], T = w.TR.TRUCK;
  const side = { x: dp.ramps[1].x - dp.ramps[0].x, y: dp.ramps[1].y - dp.ramps[0].y }, n = Math.hypot(side.x, side.y);
  // b side by side with a, its trailer 10 into a's.
  const off = 2 * T.TR_HW - 10;
  b.truck.place(a.truck.x + (side.x / n) * off, a.truck.y + (side.y / n) * off, a.truck.th);
  b.seg = a.seg;
  b.hint = -1;
  w.TR.Input.sources[b.idx] = () => NONE;
  const at = [a.truck.x, a.truck.y], b0 = [b.truck.x, b.truck.y];
  for (let f = 0; f < 10; f++) {
    play(w, a, [{}]);
    assert.deepEqual([a.truck.x, a.truck.y], at, 'the loading truck moved on frame ' + f);
    assert.equal(a.phase, 'load');
  }
  assert.ok(Math.hypot(b.truck.x - b0[0], b.truck.y - b0[1]) > 5, 'the trucks never touched');
  assert.equal(b.phase, 'race');
});

// The headlights' beam (Truck.drawTractor) and the trailer's brake and reversing lights (Truck.drawTrailer).
const BEAM = '255,244,200', BRAKE_LIGHT = '#ff3b30', REVERSE_LIGHT = 'rgba(255,255,255,0.25)';

// The beam blinks, so a flash left over would stay lit or dark depending on where it stopped; the horns,
// half a blink apart, leave it at both.
test('a horn just before the loading starts leaves no headlights on through it', () => {
  for (const at of [26, 30, 34, 38]) {
    const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
    park(w, b);
    const { sg, dp } = depots(G)[0];
    dock(w, a, sg, dp);
    play(w, a, frames(at, {}));
    w.TR.Input.sources[a.idx] = () => Object.assign({}, NONE, { horn: true });
    const lit = [drawn(w, BEAM)];
    w.TR.Input.sources[a.idx] = () => NONE;
    while (a.phase === 'race' && lit.length < 60) lit.push(drawn(w, BEAM));
    assert.equal(a.phase, 'load', 'horn on frame ' + at);
    assert.ok(lit.some(Boolean), 'horn on frame ' + at + ': nothing lit before the loading');
    for (let f = 0; f < 60; f++) assert.equal(drawn(w, BEAM), false, 'horn on frame ' + at + ': lit on frame ' + f + ' of the loading');
  }
});

test('a truck held on its brake, or rolling back slower than STOP_TOL, starts loading stopped with its lights out', () => {
  for (const roll of [false, true]) {
    const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players, what = roll ? 'rolling back' : 'on the brake';
    park(w, b);
    const { sg, dp } = depots(G)[0];
    dock(w, a, sg, dp);
    const light = roll ? REVERSE_LIGHT : BRAKE_LIGHT;
    w.TR.Input.sources[a.idx] = () => Object.assign({}, NONE, { brake: !roll });
    let before = false;
    for (let f = 0; f < 120 && a.phase === 'race'; f++) {
      if (roll) a.truck.v = -w.TR.LOT.STOP_TOL + 1;
      before = drawn(w, light) || before;
    }
    assert.equal(a.phase, 'load', what);
    assert.ok(before, what + ': the light was never on before the loading');
    for (let f = 0; f < 30; f++) {
      assert.equal(drawn(w, light), false, what + ': lit on frame ' + f + ' of the loading');
      assert.equal(a.truck.v, 0, what + ': moving on frame ' + f + ' of the loading');
    }
  }
});

test('a truck loading is drawn with its trailer open and its cargo in it, and with its worker', () => {
  const { w, a } = loading();
  a.cargo.push(3, 1);
  w.step();
  // Each box drawn 19 by 24 in the open trailer, with the fill it was drawn in.
  const inTrailer = () => {
    const out = [];
    let fill = null;
    for (const l of w.log) {
      if (l.startsWith('game.fillStyle=')) fill = JSON.parse(l.slice('game.fillStyle='.length));
      else if (/^game\.fillRect\([^,]+,-12,19,24\)$/.test(l)) out.push(w.TR.BOXES.findIndex((bx) => bx.color === fill));
    }
    return out;
  };
  assert.ok(w.log.includes('game.fillStyle="#7b6146"'), 'the trailer is not drawn open');
  // Per viewport, door end first.
  assert.deepEqual(inTrailer(), [1, 3, 1, 3]);
  // The worker's head (Porter.drawWorker), drawn in both viewports.
  assert.equal(w.log.filter((l) => l === 'game.fillStyle="#f9a825"').length, 2, 'the worker is not drawn');
});

test('loading puts out the turbo and the slipstream, and they stay out after it', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  const { sg, dp } = depots(G)[0];
  // As after a turbo fired: once a round.
  a.turboS = Infinity;
  dock(w, a, sg, dp);
  play(w, a, frames(20, {}));
  a.turbo = 5;
  a.draft = 1;
  for (let f = 0; f < 60 && a.phase === 'race'; f++) play(w, a, [{}]);
  assert.equal(a.phase, 'load');
  assert.deepEqual([a.turbo, a.draft], [0, 0], 'at the start of the loading');
  play(w, a, [RESET].concat(frames(30, {})));
  assert.equal(a.phase, 'race');
  assert.deepEqual([a.turbo, a.draft], [0, 0], 'after the loading');
});

// Puts p's truck backed into its bay in the lot, square and stopped.
function inBay(w, p) {
  const G = w.TR.Game, T = w.TR.TRUCK, bay = G.lot.bays[p.idx];
  put(w, p, G.map.segs[G.map.lotSeg], bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
}

test('a truck parked with boxes missing stays in the park and is told which; with all six it unloads', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  a.cargo.push(0, 1, 2, 3, 4);
  inBay(w, a);
  play(w, a, frames(120, {}));
  assert.equal(a.phase, 'park');
  assert.ok(a.park.ok, 'the park itself should be good: ' + JSON.stringify(a.park));
  assert.equal(a.unloader, null);
  assert.equal(a.toast, 'EKSİK KUTU: F');
  // The near-miss contract closes with the park, not with the lot: a truck here can still drive out for its box.
  const near = w.TR.CONTRACTS.find((c) => c.text.includes('kıl payı'));
  assert.equal(near.state(a), 'run');
  a.cargo.push(5);
  play(w, a, frames(5, {}));
  assert.equal(a.phase, 'unload');
  assert.equal(near.state(a), 'fail');
});

test('the unloading worker stacks a box on a cell, takes it back, puts it back in the trailer, and keeps to its floor', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  a.cargo.push(2, 0, 1, 3, 4, 5);
  inBay(w, a);
  play(w, a, frames(60, {}));
  assert.equal(a.phase, 'unload');
  const un = a.unloader, wk = un.worker, door = G.lot.doors[a.idx], cell = un.cellPos[0];
  play(w, a, TAP);
  assert.equal(wk.carry, 5, 'the door end comes out first');
  walkTo(w, a, cell.x, cell.y);
  play(w, a, TAP);
  assert.deepEqual([here(un.cells[0]), wk.carry], [[5], null]);
  play(w, a, TAP);
  assert.deepEqual([here(un.cells[0]), wk.carry], [[], 5]);
  walkTo(w, a, door.x, door.y - 30);
  play(w, a, TAP);
  assert.deepEqual([here(un.trailer), wk.carry], [[2, 0, 1, 3, 4, 5], null]);
  assert.equal(un.msg, 'Kutu dorseye geri kondu');
  const f = G.lot.floors[a.idx];
  for (const [mx, my] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    play(w, a, frames(400, { mx, my }));
    assert.ok(wk.x >= f.x0 && wk.x <= f.x1 && wk.y >= f.y0 && wk.y <= f.y1, 'walking ' + [mx, my] + ' the worker left its floor: ' + wk.x + ', ' + wk.y);
  }
});

test('a truck with more boxes ranks ahead of one nearer the lot, parked there or not', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  const start = G.map.segs[G.map.start], lotSeg = G.map.segs[G.map.lotSeg];
  const at = (p, sg, s) => {
    const q = sg.road.posAt(s, 0);
    put(w, p, sg, q.x, q.y, -Math.PI / 2);
  };
  at(a, lotSeg, lotSeg.road.length / 2);
  at(b, start, 500);
  a.cargo.push(0);
  b.cargo.push(0, 1);
  assert.ok(G.map.distToLot(a.seg, a.s) < G.map.distToLot(b.seg, b.s));
  assert.deepEqual([G.rankOf(a), G.rankOf(b)], [2, 1], 'racing');
  a.cargo.push(1);
  assert.deepEqual([G.rankOf(a), G.rankOf(b)], [1, 2], 'racing with as many boxes');
  inBay(w, a);
  play(w, a, frames(2, {}));
  assert.equal(a.phase, 'park');
  b.cargo.push(2);
  assert.deepEqual([G.rankOf(a), G.rankOf(b)], [2, 1], 'parked with fewer boxes');
});

test('the first truck into the lot with boxes missing does not take the first-to-lot bonus; the next one, loaded, does', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  a.cargo.push(0, 1, 2, 3, 4);
  inBay(w, a);
  play(w, a, frames(2, {}));
  assert.equal(a.phase, 'park');
  assert.equal(G.firstLot, null);
  assert.equal(a.stats.firstToLot, false);
  b.cargo.push(5, 4, 3, 2, 1, 0);
  inBay(w, b);
  play(w, b, frames(2, {}));
  assert.equal(b.phase, 'park');
  assert.equal(G.firstLot, b);
  assert.deepEqual([a.stats.firstToLot, b.stats.firstToLot], [false, true]);
});

test('a truck driving into the lot with boxes missing is told which at once, and its race time is its first entry with all six', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players, lotSeg = G.map.segs[G.map.lotSeg];
  park(w, b);
  const enter = () => {
    put(w, a, lotSeg, G.lot.ox, G.lot.oy + 200, Math.PI / 2);
    play(w, a, [{}]);
    assert.equal(a.phase, 'race');
    put(w, a, lotSeg, G.lot.ox, G.lot.oy - 200, Math.PI / 2);
    play(w, a, [{}]);
    assert.equal(a.phase, 'park');
  };
  a.cargo.push(0, 2, 3, 5);
  enter();
  assert.equal(a.toast, 'EKSİK KUTU: B E');
  assert.equal(a.times.race, null);
  a.cargo.push(1, 4);
  enter();
  const first = G.time;
  assert.equal(a.times.race, first);
  assert.match(a.toast, /^PARKA İLK SEN GELDİN!/);
  play(w, a, frames(30, {}));
  enter();
  assert.equal(a.times.race, first, 'entering again moved the race time');
  assert.equal(a.toast, 'PARK ALANI!');
});

// a unloads and finishes while b, with the cargo given, stands in the lot short of its bay; returns the round.
function finishBeside(cargo) {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  a.cargo.push(0, 1, 2, 3, 4, 5);
  b.cargo.push(...cargo);
  inBay(w, a);
  put(w, b, G.map.segs[G.map.lotSeg], G.lot.ox, G.lot.oy - 200, Math.PI / 2);
  w.TR.Input.sources[b.idx] = () => NONE;
  play(w, a, frames(60, {}));
  assert.deepEqual([a.phase, b.phase], ['unload', 'park']);
  a.unloader.cells = G.plan.target.map((c) => c.slice());
  play(w, a, [{}]);
  assert.equal(G.winner, a);
  return { G, b };
}

test('the winner\'s rival gets the last chance parked with every box, and not parked with boxes missing', () => {
  const short = finishBeside([0, 1, 2, 3, 4]);
  assert.equal(short.G.lastChance, false);
  assert.ok(short.G.overT < 3, 'the round closes in ' + short.G.overT + ' s');
  assert.equal(short.b.toast, 'A bitirdi!');
  const full = finishBeside([0, 1, 2, 3, 4, 5]);
  assert.equal(full.G.lastChance, true);
  assert.ok(full.G.overT > 19, 'the round closes in ' + full.G.overT + ' s');
  assert.equal(full.b.toast, 'A bitirdi! Kutuları yetiştir!');
});

test('a truck driven out of the lot through its entrance is racing again, and parking once it drives back in', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  a.cargo.push(0, 1, 2);
  put(w, a, G.map.segs[G.map.lotSeg], G.lot.ox, G.lot.oy - 200, Math.PI / 2);
  play(w, a, [{}]);
  assert.equal(a.phase, 'park');
  // Between where the lot starts and its entrance line a parking truck is still parking.
  put(w, a, G.map.segs[G.map.lotSeg], G.lot.ox, G.lot.oy - 20, Math.PI / 2);
  play(w, a, frames(2, {}));
  assert.equal(a.phase, 'park');
  for (let f = 0; f < 600 && a.truck.y < G.lot.oy + 150; f++) play(w, a, [GAS]);
  assert.ok(a.truck.y >= G.lot.oy + 150, 'the truck did not get out of the lot: y ' + (a.truck.y - G.lot.oy) + ' from the entrance');
  assert.equal(a.phase, 'race');
  for (let f = 0; f < 600 && a.phase === 'race'; f++) play(w, a, [{ thr: -1 }]);
  assert.equal(a.phase, 'park');
  assert.ok(a.truck.y < G.lot.oy - 40);
});

test('the unloader gets the boxes in the order the truck collected them, B then A first', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  park(w, b);
  const order = [1, 0, 2, 3, 4, 5];
  for (const box of order) {
    const { sg, dp } = depots(G).find((d) => d.dp.box === box);
    park(w, a);
    play(w, a, [{}]);
    dock(w, a, sg, dp);
    play(w, a, frames(60, {}));
    assert.equal(a.phase, 'load', 'not loading at box ' + box);
    play(w, a, frames(6, { mx: dp.ox, my: dp.oy }).concat(TAP));
    assert.equal(a.loader.worker.carry, box);
    play(w, a, frames(10, { mx: -dp.ox, my: -dp.oy }).concat(TAP, [RESET]));
    assert.equal(a.phase, 'race');
  }
  inBay(w, a);
  play(w, a, frames(60, {}));
  assert.equal(a.phase, 'unload');
  assert.deepEqual(here(a.unloader.trailer), [1, 0, 2, 3, 4, 5]);
});

test('two players loading at one depot each move only their own boxes', () => {
  const w = world(RI, SEED), G = w.TR.Game, [a, b] = G.players;
  const { sg, dp } = depots(G)[0];
  dock(w, a, sg, dp);
  dock(w, b, sg, dp);
  play(w, a, frames(60, {}));
  assert.deepEqual([a.phase, b.phase], ['load', 'load']);
  const theirs = JSON.stringify(b.ground[dp.box]);
  const toB = { mx: dp.ramps[1].x - dp.ramps[0].x, my: dp.ramps[1].y - dp.ramps[0].y };
  play(w, a, frames(20, toB).concat(frames(10, TAP).flat()));
  // a's worker stops at the side of its own ramp, BAY_W wide about the ramp's face.
  const wk = a.loader.worker, side = (wk.x - dp.ramps[0].x) * dp.ax + (wk.y - dp.ramps[0].y) * dp.ay;
  assert.ok(Math.abs(Math.abs(side) - w.TR.LOT.BAY_W / 2) < 1e-6, 'the worker is ' + side + ' off its ramp\'s middle');
  assert.equal(JSON.stringify(b.ground[dp.box]), theirs);
  assert.equal(a.loader.worker.carry, null);
  assert.equal(b.loader.worker.carry, null);

  play(w, b, TAP.concat(TAP));
  assert.deepEqual([here(a.cargo), here(b.cargo)], [[], [dp.box]]);
  assert.equal(a.ground[dp.box].length, 1);
  play(w, a, frames(14, { mx: -toB.mx, my: -toB.my }).concat(TAP, TAP));
  assert.deepEqual([here(a.cargo), here(b.cargo)], [[dp.box], [dp.box]]);
  assert.deepEqual([a.ground[dp.box].length, b.ground[dp.box].length], [0, 0]);
});
