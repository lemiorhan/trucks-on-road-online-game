// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, linkPair, scriptList } from './harness.mjs';

const FRAME_MS = 1000 / 60;

// A host and a guest world joined by an in-memory link, in a round of route ri on split screens, so that
// both draw both trucks.
function match(ri = 0, guestOpts = {}) {
  const clock = { t: 1000 };
  const pair = linkPair();
  const world = (name, size, view = 'bolunmus') => {
    const w = makeWorld(name, Object.assign({ clock }, size));
    pair.net(w);
    w.TR.Settings.set({ onlineView: view, shake: false, weather: 'karisik', traffic: 'yogun' });
    // Particles are replayed on the guest with its own frame timing, so they are left out of the draw log.
    w.TR.FX.draw = () => {};
    return w;
  };
  const m = { host: world('host'), clock, pair };
  m.host.TR.Online.host();
  pair.flush();
  // A guest joining, the first time or as a reloaded tab. Its own events are built from another seed, as
  // a browser whose floats round differently could build them, so it shows only what the host sent.
  m.join = () => {
    m.guest = world('guest', guestOpts.size, guestOpts.view);
    if (guestOpts.patch) guestOpts.patch(m.guest);
    const E = m.guest.TR.Events;
    m.guest.TR.Events = class extends E {
      constructor(road, seed, ...rest) {
        super(road, seed + 1, ...rest);
      }
    };
    m.guest.TR.Online.join(m.host.TR.Online.code);
    pair.flush();
  };
  m.join();
  m.host.TR.Game.newSeries(['Ev', 'Misafir'], ['tam', 'hafif']);
  m.host.TR.Game.startRound(ri, { seed: 4242 + ri });
  pair.flush();
  m.step = () => {
    clock.t += FRAME_MS;
    m.host.frame();
    const snap = m.host.TR.Online.snapshot();
    pair.flush();
    m.guest.TR.Online.snaps = [];
    m.guest.TR.Online.applySnap(m.guest.TR.Online.dec(m.host.TR.Online.enc(snap)), null, 1);
    m.guest.frame();
    pair.flush();
  };
  // Past the countdown, when presses start to act.
  m.race = () => {
    while (m.host.TR.Game.state === 'countdown') m.step();
  };
  return m;
}

const tap = (w, code) => {
  w.down(code);
  w.up(code);
};

test('the scripts the harness loads include the online modules', () => {
  const list = scriptList();
  assert.ok(list.length >= 15, 'only ' + list.length + ' scripts found in index.html');
  for (const s of ['js/net.js', 'js/online.js', 'js/game.js', 'js/ui.js']) assert.ok(list.includes(s), s);
  assert.ok(list.indexOf('js/online.js') < list.indexOf('js/game.js'));
});

function sameFrame(m, f) {
  const h = m.host.log, g = m.guest.log;
  assert.equal(g.length, h.length, 'frame ' + f + ' draw call count');
  for (let i = 0; i < h.length; i++) if (g[i] !== h[i]) assert.fail('frame ' + f + ' call ' + i + ': host ' + h[i] + ' · guest ' + g[i]);
}

// Puts both trucks on segment seg in their lanes LEAD before s, going V: a fast way to every junction,
// radar and toll.
function dropAt(m, seg, s, LEAD = 900, V = 230) {
  const { R, G } = { R: m.host.TR.ROAD, G: m.host.TR.Game };
  const road = G.map.segs[seg].road;
  for (const p of G.players) {
    const q = road.lanePos(s - LEAD, p.idx === 0 ? R.LANE / 2 : R.LANE * 1.5);
    p.truck.place(q.x, q.y, q.h);
    p.truck.v = V;
    p.seg = seg;
    p.hint = -1;
  }
}

// The oracle is the host's own rendering: whatever the guest is shown must draw the same canvas calls.
for (const ri of [0, 2, 4]) {
  test('a guest draws the same frames as its host, route ' + ri, () => {
    const m = match(ri), { host, guest, step } = m;
    host.down('KeyW');
    guest.down('ArrowUp');
    let compared = 0, carsSeen = 0;
    for (let f = 0; f < 60 * 20; f++) {
      if (f === 400) guest.down('ArrowLeft');
      if (f === 440) guest.up('ArrowLeft');
      if (f === 700) host.down('KeyD');
      if (f === 760) host.up('KeyD');
      step();
      if (f % 15) continue;
      sameFrame(m, f);
      compared++;
      if (host.TR.Game.state !== 'play') continue;
      for (const sg of host.TR.Game.map.segs) carsSeen += sg.traffic.cars.filter((c) => c.dormant <= 0).length;
    }
    // Floors: the comparison ran over a real round, with traffic and both trucks moving.
    assert.ok(compared >= 70, 'compared ' + compared);
    assert.ok(host.log.length > 500, 'host drew only ' + host.log.length + ' calls');
    assert.ok(carsSeen > 0, 'no traffic was ever awake');
    assert.equal(host.TR.Game.state, 'play');
    // Driving with no steering, both trucks grind along the rail in the bends, so the bar is low.
    const map = host.TR.Game.map;
    for (const p of host.TR.Game.players) {
      const done = map.shortest - map.distToLot(p.seg, p.s);
      assert.ok(done > host.TR.ROAD.START_S + 300, p.name + ' only came ' + done + ' from the start');
    }
    assert.notEqual(Math.round(host.TR.Game.players[1].truck.x), Math.round(host.TR.Game.players[0].truck.x));
  });
}

test('a guest sees the host truck\'s headlights blink with its horn', () => {
  const m = match(0), { host } = m;
  m.race();
  tap(host, 'KeyE');
  let lit = 0;
  for (let f = 0; f < 90; f++) {
    m.step();
    sameFrame(m, f);
    if (m.guest.log.some((l) => l.includes('255,244,200'))) lit++;
  }
  assert.ok(lit > 10, 'the guest saw the headlights on for ' + lit + ' frames');
});

// Every route's junctions, radars and tolls, met at speed: side traffic, flashes and broken gates.
test('a guest draws the same frames as its host at every roadside point', () => {
  const seen = { cross: 0, radar: 0, toll: 0, ring: 0 }, met = { cross: 0, radar: 0, toll: 0, ring: 0 };
  for (let ri = 0; ri < 5; ri++) {
    const m = match(ri), { host, guest } = m, G = host.TR.Game;
    host.down('KeyW');
    guest.down('ArrowUp');
    m.race();
    for (const { id: k, road, junctions } of G.map.segs) for (const j of road.points) {
      met[j.type]++;
      const side = j.type === 'cross' || j.type === 'ring';
      // Traffic and bends slow a truck down over a long run-up, so radars and tolls are met from close
      // and fast enough to flash the camera and break the gate. Side cars spawn out of sight and are on
      // screen only once they reach the junction, so there the trucks wait for them.
      if (side) {
        host.up('KeyW');
        guest.up('ArrowUp');
        dropAt(m, k, j.s, 200, 0);
      } else {
        host.down('KeyW');
        guest.down('ArrowUp');
        dropAt(m, k, j.s, 300, 280);
      }
      const st = junctions.states.find((x) => x.j === j);
      const onScreen = () => junctions.cars.some((c) => G.players.some((p) => Math.abs(c.x - p.cam.x) < 500 && Math.abs(c.y - p.cam.y) < 450));
      for (let f = 0; f < 60 * (side ? 12 : 6); f++) {
        m.step();
        if (f % 10 === 0) sameFrame(m, 'route ' + ri + ' seg ' + k + ' ' + j.type + '@' + j.s + ' +' + f);
        if (side && f % 10 === 0 && onScreen()) seen[j.type]++;
        if (j.type === 'radar' && st.flash > 0) seen.radar++;
        if (j.type === 'toll' && st.gates.some((q) => q.broken)) seen.toll++;
      }
    }
  }
  // Floors: each kind on the routes was met, and did the thing the guest has to be shown.
  for (const k of Object.keys(met)) {
    assert.ok(met[k] > 0, 'no route has a ' + k);
    assert.ok(seen[k] > 0, k + ' was met ' + met[k] + ' times and never showed its state');
  }
});

// Both trucks dropped before the first fork, each steered by its keys at a point AIM ahead on the westmost or
// the eastmost branch, SIDE off its centre line. The segments are emptied of cars: in traffic the trucks end
// up behind a car and the fork decides for them.
const AIM = 600, SIDE = 60;
let forkRun = null;
function throughFork() {
  if (forkRun) return forkRun;
  const m = match(0), G = m.host.TR.Game, map = G.map, U = m.host.TR.U;
  m.race();
  const start = map.segs[map.start].road;
  const midX = (k) => map.segs[k].road.xs[map.segs[k].road.n >> 1];
  const outs = map.segs[map.start].out.slice().sort((a, b) => midX(a) - midX(b));
  dropAt(m, map.start, start.length, 400, 200);
  for (const sg of map.segs) sg.traffic.cars = [];
  m.host.down('KeyW');
  m.guest.down('ArrowUp');
  const drivers = [
    { w: m.host, left: 'KeyA', right: 'KeyD', seg: outs[0], side: -1, held: null, hint: -1 },
    { w: m.guest, left: 'ArrowLeft', right: 'ArrowRight', seg: outs[outs.length - 1], side: 1, held: null, hint: -1 },
  ];
  const run = { compared: 0, diff: null, segDiff: null, left: [false, false], ends: null, outs };
  for (let f = 0; f < 60 * 12; f++) {
    G.players.forEach((p, i) => {
      const dr = drivers[i], t = p.truck, road = map.segs[dr.seg].road;
      const loc = road.locate(t.x, t.y, dr.hint);
      dr.hint = loc.i;
      const q = road.posAt(U.clamp(loc.s + AIM, 0, road.length), dr.side * SIDE);
      const goal = U.clamp(2 * U.wrap(Math.atan2(q.y - t.y, q.x - t.x) - t.th), -0.4, 0.4);
      const want = t.steer < goal - 0.04 ? dr.right : t.steer > goal + 0.04 ? dr.left : null;
      if (want === dr.held) return;
      if (dr.held) dr.w.up(dr.held);
      if (want) dr.w.down(want);
      dr.held = want;
    });
    m.step();
    G.players.forEach((p, i) => (run.left[i] = run.left[i] || p.seg !== map.start));
    if (f % 15) continue;
    run.compared++;
    try {
      sameFrame(m, f);
    } catch (e) {
      run.diff = run.diff || e.message;
    }
    const gs = m.guest.TR.Game.players.map((p) => p.seg), hs = G.players.map((p) => p.seg);
    if (!run.segDiff && gs.join() !== hs.join()) run.segDiff = 'frame ' + f + ': host ' + hs + ' · guest ' + gs;
  }
  run.ends = G.players.map((p) => p.seg);
  return (forkRun = run);
}

test('a guest draws the same frames as its host through a fork', () => {
  const run = throughFork();
  assert.equal(run.diff, null);
  assert.ok(run.left.every(Boolean), 'a truck never left the start segment: ' + run.left);
  assert.ok(run.outs.length > 1, 'the start segment does not fork');
  assert.notEqual(run.ends[0], run.ends[1], 'both trucks took segment ' + run.ends[0]);
  assert.ok(run.compared >= 40, 'compared ' + run.compared);
});

test('a guest has each truck on the segment the host has it on', () => {
  const run = throughFork();
  assert.equal(run.segDiff, null);
  assert.ok(run.left.every(Boolean) && run.compared >= 40, 'no truck left the start segment, or too few frames');
});

// The host clock is moved to just before a jam, with both trucks on their way into it.
test('a guest draws the same frames as its host through a jam', () => {
  const m = match(0), G = m.host.TR.Game;
  m.race();
  const jam = G.map.spec.jams[0], road = G.map.segs[jam.seg].road, s0 = road.sAtRise(jam.rise0), s1 = road.sAtRise(jam.rise1);
  G.time = jam.t0 - 1;
  dropAt(m, jam.seg, s0, 500, 150);
  m.host.down('KeyW');
  m.guest.down('ArrowUp');
  const traffic = G.map.segs[jam.seg].traffic;
  let on = 0, queued = 0;
  for (let f = 0; f < 60 * 12; f++) {
    m.step();
    if (f % 10) continue;
    sameFrame(m, 'jam +' + f);
    if (!G.map.jamsOn(jam.seg, G.time).length) continue;
    on++;
    if (traffic.cars.some((c) => c.dormant <= 0 && c.s >= s0 && c.s <= s1 && G.players.some((p) => Math.abs(c.x - p.cam.x) < 500 && Math.abs(c.y - p.cam.y) < 450))) queued++;
  }
  assert.ok(on >= 30, 'the jam was on in only ' + on + ' compared frames');
  assert.ok(queued > 0, 'no jam car was ever on screen');
});

const onScreen = (G, q) => G.players.some((p) => Math.abs(q.x - p.cam.x) < 500 && Math.abs(q.y - p.cam.y) < 450);
const flockSeg = (G) => G.map.segs.find((sg) => sg.events.flocks.length);
const workSeg = (G) => G.map.segs.find((sg) => sg.events.works.length);

// Holds the trucks before a flock off the start segment until its sheep are on their way, comparing frames.
function meetFlock(m, onFrame) {
  const G = m.host.TR.Game, sg = flockSeg(G), f = sg.events.flocks[0];
  dropAt(m, sg.id, f.s, 800, 120);
  m.host.down('KeyW');
  m.guest.down('ArrowUp');
  for (let f2 = 0; f2 < 60 * 4; f2++) {
    m.step();
    onFrame(f2, sg, f);
  }
}

// A flock off the start segment, crossing with racers near, and roadworks with a truck driven through the
// closed lane, on two routes: the guest is shown sheep that walk and cones that fly.
test('a guest draws the same frames as its host at a flock and at roadworks', () => {
  let routes = 0, walking = 0, flying = 0, offStart = 0;
  for (const ri of [0, 2]) {
    const m = match(ri), G = m.host.TR.Game, R = m.host.TR.ROAD;
    m.race();
    if (!flockSeg(G) || !workSeg(G)) continue;
    routes++;
    if (flockSeg(G).id !== G.map.start && workSeg(G).id !== G.map.start) offStart++;
    meetFlock(m, (f2, sg, f) => {
      if (f2 % 10) return;
      sameFrame(m, 'route ' + ri + ' flock on seg ' + sg.id + ' +' + f2);
      if (f.sheep.some((q) => q.moving && onScreen(G, q))) walking++;
    });
    const sg = workSeg(G), w = sg.events.works[0];
    for (const p of G.players) {
      const q = sg.road.lanePos(w.s0 - 400, p.idx === 1 ? w.d : -w.d);
      p.truck.place(q.x, q.y, q.h);
      p.truck.v = 220;
      p.seg = sg.id;
      p.hint = -1;
    }
    for (let f2 = 0; f2 < 60 * 3; f2++) {
      sg.traffic.cars = [];
      m.step();
      if (f2 % 10) continue;
      sameFrame(m, 'route ' + ri + ' roadworks on seg ' + sg.id + ' +' + f2);
      if (w.cones.some((c) => c.fly && onScreen(G, c))) flying++;
    }
  }
  assert.equal(routes, 2, 'a route has no flock or no roadworks');
  assert.equal(offStart, 2, 'a flock or roadworks is on the start segment');
  assert.ok(walking > 0, 'no compared frame showed a walking sheep');
  assert.ok(flying > 0, 'no compared frame showed a flying cone');
});

// The guest draws INTERP_MS behind the host, between two snapshots: everything that moves smoothly is put
// k of the way from the older to the newer, segment by segment. The expected place is worked out here from
// the two snapshots' own rows.
test('a guest blends the trucks and each segment\'s cars, side cars, sheep and clocks between two snapshots', () => {
  const m = match(1), G = m.host.TR.Game, O = m.host.TR.Online, gG = m.guest.TR.Game;
  m.race();
  const sideSeg = G.map.segs.find((sg) => sg.id !== G.map.start && sg.road.points.some((j) => j.type === 'cross' || j.type === 'ring'));
  assert.ok(sideSeg, 'route 1 has no crossing or ring off the start segment');
  const j = sideSeg.road.points.find((q) => q.type === 'cross' || q.type === 'ring');
  const K = 0.3, lerp = (a, b) => a + (b - a) * K, near = (a, b) => Math.abs(a - b) < 1e-6;
  const moved = { cars: new Set(), jcars: 0, sheep: 0, trucks: 0 };
  const blend = (ready) => {
    for (let f = 0; f < 60 * 12 && !ready(); f++) m.step();
    const a = O.dec(O.enc(O.snapshot()));
    for (let f = 0; f < 6; f++) m.step();
    const b = O.dec(O.enc(O.snapshot()));
    m.guest.TR.Online.applySnap(b, a, K);
    assert.ok(near(gG.time, lerp(a.g.time, b.g.time)) && a.g.time !== b.g.time, 'the round clock');
    gG.players.forEach((p, i) => {
      const t0 = a.p[i].truck, t1 = b.p[i].truck;
      assert.ok(near(p.truck.x, lerp(t0.x, t1.x)) && near(p.truck.y, lerp(t0.y, t1.y)), 'truck ' + i);
      if (t0.y !== t1.y) moved.trucks++;
    });
    gG.map.segs.forEach((sg, k) => {
      assert.ok(near(sg.junctions.time, lerp(a.jt, b.jt)) && a.jt !== b.jt, 'junction clock of segment ' + k);
      assert.ok(near(sg.events.time, lerp(a.et, b.et)) && a.et !== b.et, 'event clock of segment ' + k);
      for (const [rows, was, got, what] of [[b.cars[k], a.cars[k], sg.traffic.cars, 'car'], [b.jcars[k], a.jcars[k], sg.junctions.cars, 'side car']]) {
        rows.forEach((r, i) => {
          const p = was.find((q) => q[0] === r[0]);
          if (!p) return;
          assert.ok(near(got[i].x, lerp(p[1], r[1])) && near(got[i].y, lerp(p[2], r[2])), what + ' ' + r[0] + ' of segment ' + k);
          if (p[1] === r[1] && p[2] === r[2]) return;
          if (what === 'car' && k !== gG.map.start) moved.cars.add(k);
          if (what === 'side car') moved.jcars++;
        });
      }
      sg.events.flocks.forEach((f, fi) => f.sheep.forEach((q, si) => {
        const r = b.sheep[k][fi][si], p = a.sheep[k][fi][si];
        assert.ok(near(q.x, lerp(p[0], r[0])) && near(q.y, lerp(p[1], r[1])), 'sheep ' + si + ' of segment ' + k);
        if (p[0] !== r[0] || p[1] !== r[1]) moved.sheep++;
      }));
    });
  };
  dropAt(m, flockSeg(G).id, flockSeg(G).events.flocks[0].s, 800, 120);
  m.host.down('KeyW');
  m.guest.down('ArrowUp');
  blend(() => flockSeg(G).events.flocks[0].sheep.some((q) => q.moving && q.wait <= 0));
  m.host.up('KeyW');
  m.guest.up('ArrowUp');
  dropAt(m, sideSeg.id, j.s, 200, 0);
  blend(() => sideSeg.junctions.cars.length > 0);
  assert.ok(moved.cars.size > 0, 'no car off the start segment moved between the snapshots');
  assert.ok(moved.jcars > 0, 'no side car moved between the snapshots');
  assert.ok(moved.sheep > 0, 'no sheep moved between the snapshots');
  assert.ok(moved.trucks > 0, 'no truck moved between the snapshots');
});

test('a guest builds the host map, not its own', () => {
  const patch = (w) => {
    const generate = w.TR.MapGen.generate;
    w.TR.MapGen.generate = (route, seed) => generate(route, seed + 1);
  };
  const m = match(1, { patch }), h = m.host.TR.Game;
  const spec = JSON.stringify(h.map.spec);
  assert.notEqual(JSON.stringify(m.guest.TR.MapGen.generate(h.route, h.roundOpts.seed)), spec, 'the guest would generate the host map anyway');
  assert.equal(JSON.stringify(m.guest.TR.Game.map.spec), spec, 'at the first join');
  m.race();
  m.join();
  for (let f = 0; f < 5; f++) m.step();
  assert.equal(JSON.stringify(m.guest.TR.Game.map.spec), spec, 'after a rejoin');
});

// A guest showing only its own truck on a smaller screen sees less than the host's halves do; cars must
// still not pop up inside what it sees.
test('the host spawns traffic out of sight of the guest screen too', () => {
  const m = match(0, { size: { width: 900, height: 560 }, view: 'tek' });
  const views = [];
  const G = m.host.TR.Game, traffic = G.map.segs[G.map.start].traffic;
  const update = traffic.update.bind(traffic);
  traffic.update = (dt, players, vs, ...rest) => (views.push(vs), update(dt, players, vs, ...rest));
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  const last = views[views.length - 1];
  assert.ok(views.length > 0, 'traffic.update never ran');
  assert.equal(last.length, 3, 'host halves plus the guest screen');
  const g = last[2];
  assert.ok(Math.abs((g.x1 - g.x0) * g.z - 900) < 1e-6 && Math.abs((g.y1 - g.y0) * g.z - 560) < 1e-6, 'the third view is not the guest screen');
});

// Q (reset) counts in p.resets, so every press the host acts on is on record.
test('each guest press acts on the host once', () => {
  const m = match();
  m.race();
  const p1 = m.host.TR.Game.players[1];
  for (let k = 1; k <= 3; k++) {
    tap(m.guest, 'KeyQ');
    for (let f = 0; f < 20; f++) m.step();
    assert.equal(p1.resets, k, 'after press ' + k);
  }
  assert.equal(m.host.TR.Game.players[0].resets, 0, 'the guest press moved the host truck');
});

// A reloaded tab counts its presses from zero again, below what the host has already seen.
test('a reloaded guest is heard from its first press', () => {
  const m = match();
  m.race();
  const p1 = m.host.TR.Game.players[1];
  for (let k = 0; k < 3; k++) {
    tap(m.guest, 'KeyQ');
    for (let f = 0; f < 20; f++) m.step();
  }
  assert.equal(p1.resets, 3);
  m.join();
  for (let f = 0; f < 5; f++) m.step();
  assert.equal(p1.resets, 3, 'the rejoin replayed old presses');
  tap(m.guest, 'KeyQ');
  for (let f = 0; f < 20; f++) m.step();
  assert.equal(p1.resets, 4, 'the first press after the rejoin was lost');
});

function until(m, ok, what, frames = 60 * 20) {
  for (let f = 0; f < frames && !ok(); f++) m.step();
  assert.ok(ok(), what);
}

function finishPlayer(m, p) {
  const G = m.host.TR.Game, T = m.host.TR.TRUCK, bay = G.lot.bays[p.idx];
  m.race();
  p.cargo = m.host.TR.BOXES.map((_, b) => b);
  p.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  until(m, () => p.phase === 'unload', p.name + ' never started unloading');
  p.unloader.cells = p.unloader.target.map((c) => c.slice());
  p.unloader.trailer = [];
  until(m, () => p.phase !== 'unload', p.name + ' never finished unloading');
}

// Parks each truck in its bay and empties its trailer, the way a player ends a round, until the host is on
// its round result.
function finishRound(m) {
  const G = m.host.TR.Game;
  for (const p of G.players) finishPlayer(m, p);
  until(m, () => G.state === 'roundover', 'the round never ended');
}

const screen = (w) => w.TR.UI.current;

test('a guest back mid-round is put in the round, not on the screen before it', () => {
  const m = match();
  m.host.TR.Online.share('wait', { text: 'ayarlar' });
  m.host.TR.Game.startRound(0, { seed: 4242 });
  m.pair.flush();
  m.race();
  m.join();
  for (let f = 0; f < 10; f++) m.step();
  assert.equal(screen(m.guest), null, 'after a rejoin over the pre-round screen');
  assert.equal(m.guest.TR.Game.state, 'play');
  m.host.TR.Game.pause();
  m.pair.flush();
  m.join();
  assert.equal(screen(m.guest), 'pause', 'after a rejoin into a paused round');
  m.host.TR.Game.resume();
  m.pair.flush();
  m.join();
  for (let f = 0; f < 10; f++) m.step();
  assert.equal(screen(m.guest), null, 'after a rejoin over a pause that has ended');
  assert.equal(m.guest.TR.Game.state, 'play');
});

test('a guest back on a result screen sees it and keeps one record of it', () => {
  const m = match();
  m.host.TR.Game.series.rounds = 1;
  finishRound(m);
  m.pair.flush();
  assert.equal(screen(m.guest), 'roundResult');
  const rounds = m.guest.TR.Scores.rounds().length;
  assert.ok(rounds > 0, 'the guest recorded no round to keep');
  m.guest.TR.Online.join(m.host.TR.Online.code);
  m.pair.flush();
  assert.equal(screen(m.guest), 'roundResult', 'after a rejoin on the round result');
  assert.equal(m.guest.TR.Game.winner.idx, m.host.TR.Game.winner.idx);
  assert.equal(m.guest.TR.Scores.rounds().length, rounds, 'the replayed round result was recorded again');
  // A guest world of its own has its own records: it missed the result, and keeps it the first time.
  const before = m.guest;
  m.join();
  assert.equal(screen(m.guest), 'roundResult');
  assert.equal(m.guest.TR.Scores.rounds().length, rounds, 'a guest that missed the round result never recorded it');
  m.guest = before;
  m.guest.TR.Online.join(m.host.TR.Online.code);
  m.pair.flush();
  m.host.TR.UI.lockT = 0;
  m.host.down('Enter');
  m.step();
  m.host.up('Enter');
  assert.equal(screen(m.host), 'matchResult', 'host Enter did not open the match result');
  m.pair.flush();
  assert.equal(screen(m.guest), 'matchResult');
  assert.equal(m.guest.TR.Scores.matches().length, 1);
  m.guest.TR.Online.join(m.host.TR.Online.code);
  m.pair.flush();
  assert.equal(screen(m.guest), 'matchResult', 'after a rejoin on the match result');
  assert.equal(m.guest.TR.Scores.matches().length, 1, 'the replayed match result was recorded again');
  m.join();
  assert.equal(screen(m.guest), 'matchResult');
  assert.equal(m.guest.TR.Scores.matches().length, 1, 'a guest that missed the match result never recorded it');
});

// A guest's link closes; its retries open nothing until the host is reachable again.
function cutGuest(m) {
  const join = m.guest.TR.Net.join;
  let tries = 0;
  m.guest.TR.Net.join = () => (tries++, { send() {}, close() {}, drop() {} });
  m.pair.sides.guest.onClose();
  return { tries: () => tries, heal: () => (m.guest.TR.Net.join = join) };
}

test('a guest that loses the link retries until it is back in the round', () => {
  const m = match(), O = m.guest.TR.Online;
  m.race();
  const cut = cutGuest(m);
  assert.ok(O.lost, 'the guest does not count the link as lost');
  m.clock.t += 3100;
  m.guest.frame();
  assert.equal(cut.tries(), 1, 'no retry after the retry time');
  assert.equal(screen(m.guest), null);
  cut.heal();
  m.clock.t += 3100;
  m.guest.frame();
  m.pair.flush();
  assert.equal(O.lost, null, 'the guest did not get back in');
  for (let f = 0; f < 30; f++) m.step();
  assert.equal(m.guest.TR.Game.state, 'play');
});

test('a guest that cannot get back gives up after the rejoin window', () => {
  const m = match(), O = m.guest.TR.Online;
  m.race();
  const cut = cutGuest(m);
  for (let s = 0; s < 29; s++) {
    m.clock.t += 1000;
    m.guest.frame();
  }
  assert.equal(O.role, 'guest', 'the guest gave up before the rejoin window ended');
  assert.ok(cut.tries() >= 9, 'only ' + cut.tries() + ' retries in 29 s');
  m.clock.t += 2000;
  m.guest.frame();
  assert.equal(O.role, null, 'the guest is still trying after the rejoin window');
  assert.equal(screen(m.guest), 'online');
});

// A first connection can close before the host has said who it is; the guest then retries like any lost
// link, and a broker that does not know the room yet does not end that.
test('a guest that loses its link before the welcome keeps retrying through broker errors', () => {
  const clock = { t: 1000 }, w = makeWorld('guest', { clock });
  let h = null;
  w.TR.Net.join = (code, handlers) => ((h = handlers), { send() {}, close() {}, drop() {} });
  w.TR.Online.join('ABCDE');
  h.onClose();
  assert.ok(w.TR.Online.lost, 'the closed first link was not taken as lost');
  h.onError('missing');
  assert.equal(w.TR.Online.role, 'guest', 'a broker error ended the retries');
});

test('a guest whose first connection never opens gives up', () => {
  const clock = { t: 1000 }, w = makeWorld('guest', { clock });
  w.TR.Net.join = () => ({ send() {}, close() {}, drop() {} });
  w.TR.Online.join('ABCDE');
  clock.t += 19 * 1000;
  w.frame();
  assert.equal(w.TR.Online.role, 'guest', 'gave up before the join time');
  clock.t += 2 * 1000;
  w.frame();
  assert.equal(w.TR.Online.role, null, 'still waiting after the join time');
  assert.equal(screen(w), 'online');
});

test('either side leaving takes the other out of the room', () => {
  let m = match();
  m.race();
  m.host.TR.Online.leave(null);
  m.pair.flush();
  assert.equal(m.guest.TR.Online.role, null, 'the guest stayed in a closed room');
  assert.equal(screen(m.guest), 'online');
  m = match();
  m.race();
  m.guest.TR.Online.leave(null);
  m.pair.flush();
  assert.equal(m.host.TR.Online.role, null, 'the host stayed in a room its guest left');
  assert.equal(screen(m.host), 'online');
});

test('the guest shows host text on its result screen as text', () => {
  const m = match();
  const score = m.host.TR.roundScore;
  m.host.TR.roundScore = (...a) => {
    const sc = score(...a);
    sc.items.push({ label: '<img src=x onerror=alert(1)>', pts: '<i>1</i>' });
    sc.total = '<u>9</u>';
    return sc;
  };
  m.host.TR.Game.series.rounds = 1;
  finishRound(m);
  m.host.TR.Game.series.history[0].scores = ['<s>1</s>', 2];
  m.host.TR.Game.series.wins = ['<q>1</q>', 0];
  m.host.TR.Online.share('matchResult');
  m.pair.flush();
  const doc = m.guest.ctx.document, html = doc.getElementById('rrBody').innerHTML;
  assert.ok(html.includes('&lt;img src=x'), 'the label is not on the guest screen');
  for (const tag of ['<img', '<i>', '<u>']) assert.ok(!html.includes(tag), tag + ' went into the round result as markup');
  const mr = doc.getElementById('mrBody').innerHTML + doc.getElementById('mrTotals').innerHTML;
  assert.ok(mr.length > 0, 'the guest drew no match result');
  for (const tag of ['<s>', '<q>']) assert.ok(!mr.includes(tag), tag + ' went into the match result as markup');
});

test('a lost link pauses the host, and a guest that never comes back ends the match', () => {
  const m = match(), { host } = m, O = host.TR.Online;
  m.race();
  m.pair.sides.host.onClose();
  m.pair.flush();
  assert.equal(host.TR.Game.state, 'paused');
  assert.ok(O.lost, 'the host does not count the guest as lost');
  m.clock.t += 29 * 1000;
  host.frame();
  assert.equal(O.role, 'host', 'the host gave up before the rejoin window ended');
  m.clock.t += 2 * 1000;
  host.frame();
  assert.equal(O.role, null, 'the host is still waiting after the rejoin window');
  assert.equal(screen(host), 'online');
});

test('a guest that stops being heard is lost on the host after the dead time', () => {
  const m = match(), { host } = m, O = host.TR.Online;
  m.race();
  m.clock.t += 3 * 1000;
  host.frame();
  assert.equal(O.lost, null, 'lost before the dead time');
  m.clock.t += 2 * 1000;
  host.frame();
  assert.ok(O.lost, 'not lost after the dead time');
  assert.equal(host.TR.Game.state, 'paused');
});

test('a host records nothing to replay while its guest is away', () => {
  const m = match(), { host } = m, O = host.TR.Online;
  m.race();
  const played = () => {
    host.TR.Audio.beep();
    host.TR.FX.emit('spark', 0, 0, 0, 0, '#fff');
    const s = O.snapshot();
    return s.audio.length + s.fx.length;
  };
  assert.ok(played() >= 2, 'a beep and a particle in a round were not recorded');
  // In the last seconds of a round a lost link does not pause it, so no snapshot empties the queues.
  finishPlayer(m, host.TR.Game.players[0]);
  assert.equal(host.TR.Game.state, 'finishing');
  host.TR.Audio.beep();
  m.pair.sides.host.onClose();
  assert.equal(host.TR.Game.state, 'finishing');
  assert.equal(played(), 0, 'sounds and particles were kept for a guest that is away');
});

test('the host takes guest messages only in the shape a guest sends', () => {
  const m = match(), { host } = m, O = host.TR.Online;
  m.race();
  const send = (msg) => m.pair.sides.host.onData(O.enc(msg));
  send({ t: 'in', h: { thr: 50, steer: 'x', mx: -9, brake: 1 }, e: { action: '9', reset: 2 } });
  const inp = host.TR.Input.player(1);
  assert.deepEqual([inp.thr, inp.steer, inp.mx, inp.my, inp.brake], [1, 0, -1, 0, true]);
  assert.deepEqual([inp.action, inp.reset], [false, true], 'a press counted from a string, or a real press lost');
  send({ t: 'in' });
  assert.equal(host.TR.Input.player(1).thr, 0, 'an input with no keys');
  const view = (idx, w, h) => ({ idx, w, h });
  send({ t: 'vps', vps: [view(7, 10, 10), view(1, 1e9, 5), 'x', null, view(1, 0, 400), view(1, 640, -1), Object.assign(view(1, 640, 400), { extra: '<' }), view(0, 300, 200), view(1, 200, 100)] });
  assert.equal(JSON.stringify(O.remoteViewports()), JSON.stringify([view(1, 640, 400), view(0, 300, 200)]));
  send({ t: 'vps', vps: 'none' });
  assert.equal(JSON.stringify(O.remoteViewports()), '[]');
  for (let f = 0; f < 5; f++) host.frame();
  const UI = host.TR.UI;
  UI.current = 'routes';
  UI.picks = [0, 0];
  for (const i of [99, -1, 1.5, '2']) send({ t: 'pick', i });
  assert.equal(UI.picks[1], 0, 'a route that does not exist was picked');
  send({ t: 'pick', i: 2 });
  assert.equal(UI.picks[1], 2, 'a real pick was not taken');
});

test('a broker error ends a room nobody joined, but not a running match', () => {
  const m = match();
  m.race();
  for (const kind of ['network', 'taken', 'missing']) {
    m.pair.sides.host.onError(kind);
    m.pair.sides.guest.onError(kind);
  }
  assert.equal(m.host.TR.Online.role, 'host', 'the host left the match');
  assert.equal(m.guest.TR.Online.role, 'guest', 'the guest left the match');
  for (let f = 0; f < 10; f++) m.step();
  assert.equal(m.host.TR.Game.state, 'play');
  const alone = makeWorld('alone', { clock: m.clock }), pair = linkPair();
  pair.net(alone);
  alone.TR.Online.host();
  pair.flush();
  pair.sides.host.onError('network');
  assert.equal(alone.TR.Online.role, null, 'a room with no guest stayed open with no broker');
});

test('a guest pauses and resumes both machines', () => {
  const m = match();
  m.race();
  m.guest.TR.Game.pause();
  m.pair.flush();
  assert.equal(m.host.TR.Game.state, 'paused');
  assert.equal(screen(m.guest), 'pause');
  m.guest.TR.Game.resume();
  m.pair.flush();
  assert.equal(m.host.TR.Game.state, 'play');
  assert.equal(screen(m.guest), null);
});

test('off line, each player drives with its own keys only', () => {
  const w = makeWorld('local', { clock: { t: 1000 } }), I = w.TR.Input;
  w.down('KeyW');
  assert.deepEqual([I.player(0).thr, I.player(1).thr], [1, 0], 'W');
  w.up('KeyW');
  w.down('ArrowUp');
  assert.deepEqual([I.player(0).thr, I.player(1).thr], [0, 1], 'ArrowUp');
});

const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

// Which truck loads, and at which depot: truck 0 at the map's first depot, and truck 1 at the second depot
// of a segment with two, so that neither a depot's place in the map nor in its segment is the first.
const LOADS = [
  { who: 0, name: 'truck 0 at the first depot', pick: (segs) => segs.find((s) => s.road.depots.length).road.depots[0] },
  { who: 1, name: 'truck 1 at a segment\'s second depot', pick: (segs) => segs.find((s) => s.road.depots.length > 1).road.depots[1] },
];

// Before the round is on, puts truck `who` backed square onto its own ramp at the depot load.pick gives and
// the other truck in the lot, or where place(q, p, dp) puts it, and joins the guest again, so that its referee
// starts from there. play(n, a, b) then steps n frames with the loading truck given a and the other one b,
// calling onFrame after each.
function atRamp(m, load, onFrame = () => {}, place = null) {
  const TR = m.host.TR, G = TR.Game, T = TR.TRUCK, p = G.players[load.who], q = G.players[1 - load.who];
  const dp = load.pick(G.map.segs), sg = G.map.segs.find((s) => s.road.depots.includes(dp));
  const all = G.map.segs.flatMap((s) => s.road.depots);
  if (load.who) assert.ok(all.indexOf(dp) > 0 && sg.road.depots.indexOf(dp) > 0, 'the depot is first in the map or its segment');
  const k = T.LT + T.TR_REAR, face = dp.ramps[p.idx], phi = Math.atan2(-dp.oy, -dp.ox);
  p.truck.place(face.x - dp.ox * 5 + Math.cos(phi) * k, face.y - dp.oy * 5 + Math.sin(phi) * k, phi);
  p.seg = sg.id;
  p.s = sg.road.locate(p.truck.x, p.truck.y, -1).s;
  p.hint = -1;
  if (place) place(q, p, dp);
  else {
    q.truck.place(G.lot.ox, G.lot.oy - 200, Math.PI / 2);
    q.seg = G.map.lotSeg;
  }
  q.hint = -1;
  m.join();
  m.race();
  const play = (n, a = {}, b = {}) => {
    const inputs = load.who ? [b, a] : [a, b];
    TR.Input.sources = inputs.map((inp) => () => Object.assign({}, NONE, inp));
    for (let f = 0; f < n; f++) {
      m.step();
      onFrame();
    }
  };
  return { p, q, dp, play };
}

for (const load of LOADS) test('a box ' + load.name + ' loads is in the guest\'s cargo and off its ramp, and the guest draws the loading as the host does', () => {
  const m = match();
  let compared = 0;
  const { p, dp, play } = atRamp(m, load, () => {
    if (p.phase !== 'load') return;
    sameFrame(m, compared);
    compared++;
  });
  const g = () => m.guest.TR.Game.players[load.who];
  play(60);
  assert.equal(p.phase, 'load');
  assert.equal(g().phase, 'load');
  assert.ok(g().loader instanceof m.guest.TR.Loader, 'the guest loader is not a Loader');
  assert.equal(g().loader.dp.box, dp.box);
  assert.equal(g().ground[dp.box].length, 1);
  play(6, { mx: dp.ox, my: dp.oy });
  play(1, { action: true });
  play(1);
  assert.equal(p.loader.worker.carry, dp.box);
  assert.equal(g().loader.worker.carry, dp.box);
  assert.equal(g().ground[dp.box].length, 0, 'the box taken up still shows on the guest ramp');
  play(10, { mx: -dp.ox, my: -dp.oy });
  play(1, { action: true });
  play(1);
  assert.deepEqual([...p.cargo], [dp.box]);
  assert.deepEqual([...g().cargo], [dp.box]);
  assert.equal(g().loader.trailer, g().cargo);
  assert.deepEqual([...g().loader.cargoFromDoor()], [dp.box]);
  play(1, { reset: true });
  assert.equal(p.phase, 'race');
  assert.equal(g().loader, null);
  assert.ok(compared > 20, 'compared ' + compared);
});

for (const load of LOADS) test('a round in which ' + load.name + ' loads at its ramp and the other drives out of the lot and back breaks no rule', () => {
  const m = match(), seen = [new Set(), new Set()];
  let frames = 0;
  const { p, q, dp, play } = atRamp(m, load, () => Ref.round.players && Ref.round.players.forEach((sh, i) => seen[i].add(sh.phase)));
  const Ref = m.guest.TR.Referee, onData = m.pair.sides.guest.onData;
  m.pair.sides.guest.onData = (s) => {
    const msg = m.guest.TR.Online.dec(s);
    if (msg.t === 'snap') frames += msg.frames.length;
    onData(s);
  };
  play(60);
  assert.equal(p.phase, 'load');
  assert.equal(q.phase, 'park');
  play(6, { mx: dp.ox, my: dp.oy });
  play(1, { action: true });
  play(1);
  play(10, { mx: -dp.ox, my: -dp.oy });
  play(1, { action: true });
  play(1);
  assert.deepEqual([...p.cargo], [dp.box]);
  play(1, { reset: true });
  assert.equal(p.phase, 'race');
  const G = m.host.TR.Game;
  for (let f = 0; f < 600 && q.truck.y < G.lot.oy + 150; f++) play(1, { thr: 1 }, { thr: 1 });
  assert.equal(q.phase, 'race');
  assert.ok(p.truck.v > 20, 'the loaded truck did not drive off');
  for (let f = 0; f < 600 && q.phase === 'race'; f++) play(1, {}, { thr: -1 });
  assert.equal(q.phase, 'park');
  play(30);
  // Floors: the referee replayed both trucks through each phase change, on frames the host sent.
  assert.equal(Ref.on, true);
  assert.ok(frames > 200, 'only ' + frames + ' frames reached the guest');
  assert.deepEqual([...seen[p.idx]].sort(), ['load', 'race']);
  assert.deepEqual([...seen[q.idx]].sort(), ['park', 'race']);
  assert.deepEqual([Ref.round.players[p.idx].phase, Ref.round.players[q.idx].phase], ['race', 'park']);
  Ref.round.counts.forEach((c, i) => assert.ok(Object.values(c).every((n) => n === 0), 'truck ' + i + ': ' + JSON.stringify(c)));
});

// Truck 0 drives head on into the cab of truck 1 at its ramp and keeps pushing while truck 1 leaves it: on that
// frame truck 1 is no longer fixed, and the push moves both trucks. Truck 1 holds its wheels turned, which an
// update on that frame, which the host does not run, would turn back.
test('a truck pressing one that leaves its ramp breaks no rule on the frame it leaves', () => {
  const m = match(), G = m.host.TR.Game;
  const { p, play } = atRamp(m, LOADS[1], () => {}, (q, p, dp) => {
    const th = Math.atan2(dp.oy, dp.ox), gap = 2 * m.host.TR.TRUCK.CAB_FRONT + 40;
    q.truck.place(p.truck.x - dp.ox * gap, p.truck.y - dp.oy * gap, th);
    q.seg = p.seg;
  });
  const Ref = m.guest.TR.Referee;
  let frames = 0;
  const onData = m.pair.sides.guest.onData;
  m.pair.sides.guest.onData = (s) => {
    const msg = m.guest.TR.Online.dec(s);
    if (msg.t === 'snap') frames += msg.frames.length;
    onData(s);
  };
  const turned = { steer: 1 };
  play(60, turned);
  assert.equal(p.phase, 'load');
  let pressed = 0;
  for (let f = 0; f < 120 && pressed < 20; f++) {
    play(1, turned, { thr: 1 });
    pressed = G.touchCd === 0.5 ? pressed + 1 : 0;
  }
  assert.equal(pressed, 20, 'truck 0 is not pressing truck 1');
  const was = [p.truck.x, p.truck.y];
  assert.ok(p.truck.steer > 0.5, 'the wheels are not turned: ' + p.truck.steer);
  play(1, { reset: true, steer: 1 }, { thr: 1 });
  assert.equal(p.phase, 'race');
  assert.equal(G.touchCd, 0.5, 'the trucks did not touch on the frame truck 1 left');
  assert.ok(Math.hypot(p.truck.x - was[0], p.truck.y - was[1]) > 0.01, 'the push did not move truck 1');
  play(30, turned, { thr: 1 });
  assert.equal(Ref.on, true);
  assert.ok(frames > 100, 'only ' + frames + ' frames reached the guest');
  assert.deepEqual([...Ref.round.players.map((sh) => sh.phase)], ['race', 'race']);
  Ref.round.counts.forEach((c, i) => assert.ok(Object.values(c).every((n) => n === 0), 'truck ' + i + ': ' + JSON.stringify(c)));
});

test('the guest takes the host round layout over its own', () => {
  const { host, guest } = match(1);
  const h = host.TR.Game, g = guest.TR.Game;
  assert.equal(g.roundOpts.seed, h.roundOpts.seed);
  assert.equal(g.map.segs.length, h.map.segs.length);
  const flocks = (G) => G.map.segs.reduce((n, sg) => n + sg.events.flocks.length, 0);
  h.map.segs.forEach((sg, k) => {
    assert.equal(JSON.stringify(g.map.segs[k].road.signList), JSON.stringify(sg.road.signList), 'signs of segment ' + k);
    assert.equal(JSON.stringify(g.map.segs[k].events.works), JSON.stringify(sg.events.works), 'works of segment ' + k);
    assert.equal(JSON.stringify(g.map.segs[k].events.flocks), JSON.stringify(sg.events.flocks), 'flocks of segment ' + k);
  });
  assert.ok(h.map.segs.some((sg) => sg.id !== h.map.start && sg.road.signList.length > 0), 'no sign off the start segment to compare');
  assert.ok(h.map.segs.some((sg) => sg.events.works.length > 0) && flocks(h) > 0, 'no roadworks or no flock to compare');
});
