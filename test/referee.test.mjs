// Run: node --test test/referee.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeWorld, linkPair, scriptList } from './harness.mjs';

const FRAME_MS = 1000 / 60;
const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

// A host and a guest world joined by an in-memory link, in a round of route ri. The guest only takes the
// host's messages: its referee runs on them, not in its frame. Before the countdown ends both trucks are put
// BEFORE short of the lot, or in their bays with every box on, and the guest joins again so that its referee starts from there;
// with before null they stay at the start.
function match(ri = 0, { before = 2500, bays = false, hostPatch, hostSource, traffic = 'yogun' } = {}) {
  const clock = { t: 1000 }, pair = linkPair();
  const world = (name) => {
    // hostSource(file, text) gives the host world other script text: a host on another version.
    const read = fs.readFileSync;
    if (name === 'host' && hostSource) fs.readFileSync = (p, ...a) => hostSource(String(p), read(p, ...a));
    let w;
    try {
      w = makeWorld(name, { clock, width: 400, height: 300 });
    } finally {
      fs.readFileSync = read;
    }
    // A wreck spins by Math.random; a seeded one makes every run of a test the same run.
    vm.runInContext('(() => { let s = 12345; Math.random = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })()', w.ctx);
    pair.net(w);
    w.TR.Settings.set({ onlineView: 'tek', shake: false, weather: 'gunduz', traffic });
    for (const k of ['FX', 'Light', 'HUD']) w.TR[k].draw = () => {};
    return w;
  };
  const m = { host: world('host'), guest: world('guest'), clock, pair };
  if (hostPatch) hostPatch(m.host);
  m.host.TR.Online.host();
  pair.flush();
  m.guest.TR.Online.join(m.host.TR.Online.code);
  // The guest's status right after the welcome, before any later message overwrites it.
  const guestData = pair.sides.guest.onData;
  pair.sides.guest.onData = (s) => {
    guestData(s);
    if (m.guest.TR.Online.dec(s).t === 'welcome') m.welcomeStatus = m.guest.ctx.document.getElementById('onlineStatus').textContent;
  };
  pair.flush();
  const TR = m.host.TR, G = TR.Game, R = TR.ROAD, T = TR.TRUCK;
  G.newSeries(['Ev', 'Misafir'], ['tam', 'hafif']);
  G.startRound(ri, { seed: 4242 + ri });
  pair.flush();
  G.map.draw = () => {};
  const map = G.map;
  m.path = [map.start];
  for (let sg = map.segs[map.start]; sg.out.length; sg = map.segs[m.path[m.path.length - 1]]) {
    m.path.push(sg.out.reduce((b, k) => (map.distToLot(k, 0) < map.distToLot(b, 0) ? k : b)));
  }
  m.lanes = [R.LANE / 2, R.LANE * 1.5];
  if (bays) {
    for (const p of G.players) {
      const bay = G.lot.bays[p.idx];
      p.cargo = TR.BOXES.map((_, b) => b);
      p.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
      p.seg = m.path[m.path.length - 1];
      p.hint = -1;
    }
    rejoin(m);
  } else if (before != null) {
    const k = m.path[m.path.length - 1];
    putOn(m, k, map.segs[k].road.length - before);
  }
  m.resets = new Set();
  m.f = 0;
  m.vmax = 330;
  m.drive = [null, null];
  // Each truck follows its lane on the shortest path at up to vmax; in the lot it drives at a wall and
  // backs off, turn about. A reset in m.resets is pressed on its frame; m.drive[i] drives truck i instead.
  TR.Input.sources = G.players.map((p, i) => () => {
    const t = p.truck, reset = m.resets.has(i + ':' + m.f);
    if (m.drive[i]) return Object.assign({}, NONE, m.drive[i](p, t), { reset });
    if (p.phase !== 'race') return Object.assign({}, NONE, { thr: Math.floor(m.f / 120) % 2 ? -1 : 1, steer: i ? 0.5 : -0.5, reset });
    let s = p.s + 300, j = m.path.indexOf(p.seg), rd = map.segs[p.seg].road;
    while (s > rd.length && j >= 0 && j < m.path.length - 1) {
      s -= rd.length;
      rd = map.segs[m.path[++j]].road;
    }
    const q = rd.lanePos(Math.min(s, rd.length), m.lanes[i]);
    const err = TR.U.wrap(Math.atan2(q.y - t.y, q.x - t.x) - t.th);
    return Object.assign({}, NONE, { thr: t.v < m.vmax ? 1 : 0, steer: TR.U.clamp(err * 4, -1, 1), reset });
  });
  m.step = () => {
    clock.t += FRAME_MS;
    m.host.frame();
    pair.flush();
    m.guest.TR.Online.tick(clock.t);
    pair.flush();
    m.f++;
  };
  m.race = () => {
    while (G.state === 'countdown') m.step();
  };
  m.counts = () => m.guest.TR.Referee.round.counts;
  return m;
}

// The guest joins again, as one back from a dropped link does: its referee starts over from the host's next
// snapshot, wherever the trucks are.
function rejoin(m) {
  m.guest.TR.Online.join(m.host.TR.Online.code);
  m.pair.flush();
}

// Puts both trucks in their lanes at s on segment k, before the round is on.
function putOn(m, k, s) {
  const G = m.host.TR.Game, road = G.map.segs[k].road;
  for (const p of G.players) {
    const q = road.lanePos(s, m.lanes[p.idx]);
    p.truck.place(q.x, q.y, q.h);
    p.seg = k;
    p.s = s;
    p.hint = -1;
  }
  rejoin(m);
}

// Counts each way the guest's referee moved a truck while it replayed the host's frames. Set again after a
// round message: the guest builds a new map and lot for it.
function watch(m) {
  const TR = m.guest.TR, G = TR.Game, seen = { rails: 0, junction: 0, ring: 0, touch: 0, recover: 0, lot: 0, park: 0, unload: 0, depot: 0 };
  let crossed = null;
  G.map.segs.forEach(({ junctions: J }) => {
    const limit = J.limit.bind(J);
    J.limit = (x, y) => {
      const push = limit(x, y);
      if (!(push && push.over > 0 && crossed)) return push;
      const j = J.road.sides.find((j) => Math.abs(j.y - y) <= TR.POINTS[j.type].flat && Math.abs(x - j.x) <= TR.JUNCTION.SIDE_LEN + 200);
      if (j) crossed.push(j.type);
      else {
        assert.deepEqual(push, J.road.depotLimit(x, y), 'a push at ' + x + ', ' + y + ' near no side road is not a depot\'s');
        seen.depot++;
      }
      return push;
    };
  });
  const count = (obj, name, key, hit = (r) => r) => {
    const f = obj[name].bind(obj);
    obj[name] = (...a) => {
      const r = f(...a);
      if (hit(r)) seen[key]++;
      return r;
    };
  };
  const rails = G.pushRails;
  G.pushRails = (p, dt) => {
    crossed = [];
    const pushed = rails(p, dt);
    if (pushed) {
      seen.rails++;
      if (crossed.length) seen.junction++;
      if (crossed.includes('ring')) seen.ring++;
    }
    crossed = null;
    return pushed;
  };
  count(G, 'pushTrucks', 'touch');
  count(G, 'putBack', 'recover', () => true);
  count(G, 'inLot', 'park');
  count(G.lot, 'collideTruck', 'lot');
  count(G.lot, 'parkStatus', 'unload', (st) => st.ok);
  return seen;
}

const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
const broken = (c) => Object.keys(c).filter((k) => c[k] > 0);
const blank = () => Object.fromEntries(['fizik', 'girdi', 'hız sınırı', 'tutuş', 'süreklilik', 'aşama', 'zaman'].map((k) => [k, 0]));
const clean = (m) => m.counts().forEach((c, i) => assert.equal(total(c), 0, 'truck ' + i + ': ' + JSON.stringify(c)));

test('the referee loads after the truck, whose update it keeps', () => {
  const list = scriptList();
  assert.ok(list.indexOf('js/truck.js') < list.indexOf('js/referee.js'));
});

// The trucks hit traffic, scrape the barrier, touch each other, are recovered on the road and in the lot,
// and drive into the lot walls; every frame of that keeps to the rules.
test('an honest round breaks no rule', () => {
  const m = match(0, { before: 6000 }), G = m.host.TR.Game, seen = watch(m);
  const { LANE, HALF } = m.host.TR.ROAD, sum = (k) => G.players.reduce((a, p) => a + p[k], 0);
  const parkedAt = [null, null];
  let crashed = false, frames = 0;
  const onData = m.pair.sides.guest.onData;
  m.pair.sides.guest.onData = (s) => {
    const msg = m.guest.TR.Online.dec(s);
    if (msg.t === 'snap') frames += msg.frames.length;
    onData(s);
  };
  m.race();
  // The second truck moves into the first one's lane, both drive along the barrier, then the first one
  // takes the oncoming lane until it hits a car, and both are recovered.
  for (let f = 0; f < 6000; f++) {
    if (f === 60) m.lanes[1] = m.lanes[0];
    if (f === 200) m.lanes = [-HALF - 60, HALF + 60];
    if (f === 350) m.lanes = [-LANE / 2, LANE * 1.5];
    if (!crashed && sum('crashes') > 0) {
      crashed = true;
      m.lanes = [LANE / 2, LANE * 1.5];
      [0, 1].forEach((i) => m.resets.add(i + ':' + (m.f + 120)));
    }
    G.players.forEach((p, i) => {
      if (p.phase !== 'park' || parkedAt[i] != null) return;
      parkedAt[i] = f;
      m.resets.add(i + ':' + (m.f + 200));
      m.resets.add(i + ':' + (m.f + 500));
    });
    m.step();
    if (parkedAt.every((x) => x != null && f > x + 700)) break;
  }
  // Floors: the round went through every path that moves a truck outside its own update.
  assert.ok(sum('crashes') > 0, 'no truck hit traffic');
  assert.ok(G.players.every((p) => p.resets >= 2), 'resets ' + G.players.map((p) => p.resets));
  assert.equal(seen.recover, sum('resets'));
  assert.ok(seen.rails > 0, 'no truck scraped the barrier');
  assert.ok(seen.touch > 0, 'the trucks never touched');
  assert.ok(seen.lot > 0, 'no truck hit the lot walls');
  assert.equal(seen.park, 2);
  assert.ok(G.players.every((p) => p.phase === 'park'), 'phases ' + G.players.map((p) => p.phase));
  assert.ok(frames > 2000, 'only ' + frames + ' frames reached the guest');
  assert.equal(m.guest.TR.Referee.on, true);
  clean(m);
});

// Each route from its real start, where the guest's referee starts from its own start of the round: the
// trucks change lanes onto the shoulders and the oncoming lane, and recover after each crash, when stuck and
// in the lot. Light traffic keeps a long route short.
const ROUTES = makeWorld('routes', { clock: { t: 0 } }).TR.ROUTES, depotHolds = {};
for (const [ri, route] of ROUTES.entries()) {
  test('an honest round of ' + route.name + ' from the start to the lot breaks no rule', () => {
    const m = match(ri, { before: null, traffic: 'az' }), G = m.host.TR.Game, seen = watch(m), { LANE, HALF } = m.host.TR.ROAD;
    const crashes = [0, 0], slow = [0, 0], parkedAt = [null, null];
    m.race();
    for (let f = 0; f < 30000; f++) {
      const cyc = f % 900;
      if (cyc === 100) m.lanes = [LANE / 2, LANE / 2];
      if (cyc === 300) m.lanes = [-HALF - 60, HALF + 60];
      if (cyc === 420) m.lanes = [-LANE / 2, LANE * 1.5];
      if (cyc === 600) m.lanes = [LANE / 2, LANE * 1.5];
      G.players.forEach((p, i) => {
        slow[i] = p.phase === 'race' && Math.abs(p.truck.v) < 30 ? slow[i] + 1 : 0;
        if (p.crashes > crashes[i] || slow[i] === 180) {
          crashes[i] = p.crashes;
          m.resets.add(i + ':' + (m.f + 90));
        }
        if (p.phase === 'park' && parkedAt[i] == null) {
          parkedAt[i] = f;
          m.resets.add(i + ':' + (m.f + 200));
        }
      });
      m.step();
      if (parkedAt.some((x) => x != null && f > x + 400)) break;
    }
    depotHolds[route.name] = seen.depot;
    assert.ok(seen.park >= 1, 'no truck reached the lot');
    assert.ok(seen.rails > 0, 'no truck scraped the barrier');
    assert.ok(seen.touch > 0, 'the trucks never touched');
    assert.ok(seen.recover > 0 && seen.recover === G.players.reduce((a, p) => a + p.resets, 0), 'recovers ' + seen.recover);
    clean(m);
  });
}

// Floor for watch's depot branch: some route's barrier play above runs into a depot's barrier.
test('a depot\'s barrier holds a truck in an honest round of some route', () => {
  assert.deepEqual(Object.keys(depotHolds), [...ROUTES.map((r) => r.name)], 'the route rounds above did not all run');
  assert.ok(Object.values(depotHolds).some((n) => n > 0), JSON.stringify(depotHolds));
});

// A truck rides beside the other one on the shoulder and is recovered into the other one's lane, on top of
// it: the push that follows moves both.
test('a recover onto the other truck breaks no rule', () => {
  const m = match(0, { before: 6000 }), G = m.host.TR.Game, R = m.host.TR.ROAD;
  m.lanes = [R.LANE * 1.5 + 44, R.LANE * 1.5];
  m.vmax = 60;
  const p0 = G.players[0];
  putOn(m, p0.seg, p0.s);
  const seen = watch(m);
  m.race();
  for (let f = 0; f < 90; f++) m.step();
  assert.equal(seen.touch, 0, 'the trucks touched before the recover');
  m.resets.add('0:' + m.f);
  const was = G.players.map((p) => [p.truck.x, p.truck.y]);
  m.step();
  assert.deepEqual(Array.from(G.players, (p) => p.resets), [1, 0]);
  const moved = G.players.map((p, i) => Math.hypot(p.truck.x - was[i][0], p.truck.y - was[i][1]));
  assert.ok(moved[1] > 12, 'the other truck was pushed ' + moved[1]);
  for (let f = 0; f < 60; f++) m.step();
  assert.ok(seen.touch > 0, 'the recover did not land on the other truck');
  clean(m);
});

// Every route's side roads and rings: map list read once, from a world of its own.
const junctions = (() => {
  const w = makeWorld('junctions', { clock: { t: 0 } }), G = w.TR.Game, out = [];
  w.TR.ROUTES.forEach((route, ri) => {
    G.newSeries(['Ev', 'Misafir'], ['tam', 'hafif']);
    G.startRound(ri, { seed: 4242 + ri });
    G.map.segs.forEach((sg, k) => sg.road.sides.forEach((j, n) => out.push({ ri, k, n, type: j.type })));
  });
  return out;
})();

test('the routes have side roads and rings for the tests below', () => {
  assert.ok(sideRoads.length > 0);
  assert.ok(junctions.some((j) => j.type === 'ring'));
});

// A truck drives out along a side road to its far barrier and is recovered back onto the main road, over a
// jump of about the side road's length: on each route's first side road, both ways.
const sideRoads = junctions.filter((j) => j.type !== 'ring');
for (const ri of new Set(sideRoads.map((j) => j.ri))) {
  const { k, n } = sideRoads.find((j) => j.ri === ri);
  for (const dir of [-1, 1]) {
    test('a recover from the far end of a side road on route ' + ri + ', heading ' + (dir > 0 ? 'east' : 'west') + ', breaks no rule', () => {
      const m = match(ri, { before: null, traffic: 'az' }), G = m.host.TR.Game, p = G.players[0], j = G.map.segs[k].road.sides[n];
      p.truck.place(j.x + dir * 300, j.y, dir > 0 ? 0 : Math.PI);
      p.seg = k;
      p.hint = -1;
      rejoin(m);
      const seen = watch(m);
      m.drive = [() => ({ thr: 1, steer: 0 }), () => ({})];
      m.race();
      // The far barrier throws the truck back to the main road in one frame; it drives out again and is
      // recovered there.
      const out = () => Math.abs(p.truck.x - j.x);
      let thrown = 0, jump = 0;
      for (let f = 0; f < 1800 && !jump; f++) {
        const was = { x: p.truck.x, y: p.truck.y, out: out() };
        if (thrown && was.out > 1100) m.resets.add('0:' + m.f);
        m.step();
        const moved = Math.hypot(p.truck.x - was.x, p.truck.y - was.y);
        if (p.resets) jump = moved;
        else if (moved > 900) thrown++;
      }
      assert.equal(thrown, 1, 'the far barrier did not throw the truck back');
      assert.ok(seen.junction > 0);
      assert.equal(p.resets, 1);
      assert.ok(jump > 900, 'the recover jumped ' + jump);
      for (let f = 0; f < 30; f++) m.step();
      clean(m);
    });
  }
}

// A truck drives straight down the middle of the road into a ring's island, which pushes it out.
test('a truck driving into a ring\'s island breaks no rule', () => {
  const { ri, k, n } = junctions.find((j) => j.type === 'ring');
  const m = match(ri, { before: null }), G = m.host.TR.Game, p = G.players[0], road = G.map.segs[k].road, j = road.sides[n];
  const q = road.posAt(j.s - 500, 0);
  p.truck.place(q.x, q.y, q.h);
  p.seg = k;
  p.s = j.s - 500;
  p.hint = -1;
  rejoin(m);
  const seen = watch(m);
  m.drive = [() => ({ thr: 1, steer: 0 }), () => ({})];
  m.race();
  for (let f = 0; f < 240; f++) m.step();
  assert.ok(seen.ring > 0, 'the island never pushed');
  clean(m);
});

test('a host that changes the truck itself breaks physics for both trucks', () => {
  const m = match(0);
  m.race();
  m.host.TR.TRUCK.MAX_FWD *= 1.3;
  for (let f = 0; f < 300; f++) m.step();
  m.counts().forEach((c, i) => assert.ok(c.fizik >= 3, 'truck ' + i + ': ' + JSON.stringify(c)));
});

// The host's own link changes the frames, or the snapshot around them, on their way.
function tamper(m, change) {
  const O = m.host.TR.Online, link = O.link, send = link.send;
  link.send = (s) => {
    const msg = O.dec(s);
    if (msg.t === 'snap') {
      change(msg);
      s = O.enc(msg);
    }
    send(s);
  };
}

// The frame layout written out here, not read from the referee: [time, dt, then per truck reset, thr, steer,
// brake, cap, grip, phase and the 8 fields at the frame's end].
const PHYSICS = ['x', 'y', 'th', 'phi', 'v', 'steer', 'stun', 'jack'];
const at = (i, k) => 2 + i * 15 + k;
const field = (i, name) => at(i, 7 + PHYSICS.indexOf(name));
// Which rule a frame end off in each field breaks: update alone turns a truck and its wheels.
const OFF = { x: 'süreklilik', y: 'süreklilik', th: 'fizik', phi: 'fizik', v: 'süreklilik', steer: 'fizik', stun: 'süreklilik', jack: 'fizik' };
for (const name of PHYSICS) {
  test('a host that sends one truck a frame end with a different ' + name + ' breaks ' + OFF[name], () => {
    const m = match(0);
    assert.deepEqual([...m.guest.TR.Referee.FIELDS], PHYSICS);
    m.race();
    // Down for v and stun, which may only go down outside update, and up for the rest; an angle by little
    // enough that the trailer does not swing into the other truck.
    const by = { v: -0.5, stun: -0.5, th: 0.01, phi: 0.01 }[name] || 0.5;
    let n = 0;
    tamper(m, (msg) => msg.frames.forEach((r) => n++ % 3 || (r[field(0, name)] += by)));
    for (let f = 0; f < 90; f++) m.step();
    const [c0, c1] = m.counts();
    assert.ok(c0[OFF[name]] >= 25, JSON.stringify(c0));
    assert.equal(total(c1), 0, JSON.stringify(c1));
  });
}

// What a host can do to its own truck between two frames, outside every move the game makes.
const between = {
  'moves it ahead by 5': [(t) => {
    t.x += Math.cos(t.th) * 5;
    t.y += Math.sin(t.th) * 5;
  }, ['süreklilik']],
  'speeds it up': [(t) => (t.v += 5), ['süreklilik']],
  'turns its speed around': [(t) => (t.v = -t.v * 0.5), ['süreklilik']],
  'takes its stun away': [(t, f) => (t.stun = f % 2), ['süreklilik']],
  'turns it': [(t) => (t.th += 0.02), ['fizik']],
  'swings its trailer': [(t) => (t.phi += 0.02), ['fizik']],
  // Further than update turns them back in a frame.
  'turns its wheels': [(t, f) => (t.steer += f % 2 ? 0.3 : -0.3), ['fizik']],
  'sets its jackknife timer': [(t, f) => (t.jack = f % 2 ? 0.5 : 0), ['fizik']],
};
for (const [what, [cheat, rules]] of Object.entries(between)) {
  test('a host that ' + what + ' between frames breaks ' + rules.join(' and '), () => {
    const m = match(0, { before: 6000 }), t = m.host.TR.Game.players[0].truck;
    m.race();
    for (let f = 0; f < 60; f++) {
      m.step();
      cheat(t, f);
    }
    const [c0, c1] = m.counts();
    assert.deepEqual(broken(c0), rules);
    rules.forEach((k) => assert.ok(c0[k] >= 25, JSON.stringify(c0)));
    assert.equal(total(c1), 0, JSON.stringify(c1));
  });
}

// The chain the frames make is honest, but the snapshot shows the truck somewhere else.
test('a host that shows a truck off its chain breaks continuity', () => {
  const m = match(0);
  m.race();
  tamper(m, (msg) => (msg.p[0].truck.x += 30));
  for (let f = 0; f < 60; f++) m.step();
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['süreklilik']);
  assert.ok(c0['süreklilik'] >= 25, JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

test('a host that shows a truck in another phase than its chain breaks the phase rule', () => {
  const m = match(0);
  m.race();
  tamper(m, (msg) => (msg.p[1].phase = 'park'));
  for (let f = 0; f < 60; f++) m.step();
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c1), ['aşama']);
  assert.ok(c1['aşama'] >= 25, JSON.stringify(c1));
  assert.equal(total(c0), 0, JSON.stringify(c0));
});

// From one frame on, the frames and snapshots say truck 0 is in the park while it races on the road. Phase 1
// is park. The referee keeps truck 0 racing, so every frame after breaks the rule again.
test('a host that says a racing truck is in the park breaks the phase rule every frame', () => {
  const m = match(0), G = m.host.TR.Game;
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  tamper(m, (msg) => {
    msg.frames.forEach((r) => (r[at(0, 6)] = 1));
    msg.p[0].phase = 'park';
  });
  for (let f = 0; f < 60; f++) m.step();
  assert.equal(G.players[0].phase, 'race');
  assert.equal(m.guest.TR.Referee.round.players[0].phase, 'race');
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['aşama']);
  assert.ok(c0['aşama'] >= 50, JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// A phase number with no phase behind it would leave the shadow in no phase at all, and unreplayed.
test('a host that sends a phase that does not exist breaks the input rule every frame', () => {
  const m = match(0);
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  tamper(m, (msg) => msg.frames.forEach((r) => (r[at(0, 6)] = 7)));
  for (let f = 0; f < 60; f++) m.step();
  assert.equal(m.guest.TR.Referee.round.players[0].phase, 'race');
  const [c0, c1] = m.counts();
  assert.ok(c0.girdi >= 50, JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// Truck 0 unloads in its bay and truck 1 drives into its side: an unloading truck does not give way, so the
// push moves truck 1 alone.
test('a truck pushing one that unloads breaks no rule', () => {
  const m = match(0, { bays: true }), G = m.host.TR.Game, [p0, p1] = G.players, bay = G.lot.bays[0];
  p1.truck.place(bay.cx + 120, bay.y0 + 60, Math.PI);
  rejoin(m);
  const seen = watch(m);
  m.drive = [() => ({}), () => ({})];
  m.race();
  for (let f = 0; f < 240 && p0.phase !== 'unload'; f++) m.step();
  assert.equal(p0.phase, 'unload');
  assert.equal(seen.touch, 0, 'the trucks touched before truck 0 unloaded');
  const stood = [p0.truck.x, p0.truck.y];
  m.drive[1] = () => ({ thr: 0.6, steer: 0 });
  for (let f = 0; f < 120; f++) m.step();
  assert.ok(seen.touch > 10, 'truck 1 touched truck 0 on ' + seen.touch + ' frames');
  assert.equal(p0.phase, 'unload');
  assert.deepEqual([p0.truck.x, p0.truck.y], stood);
  clean(m);
});

// One frame turns the truck's speed around at a lower speed, and the snapshot after it agrees; the round is
// looked at before any frame runs on from there.
test('a host that turns a truck\'s speed around outside update breaks continuity', () => {
  const m = match(0);
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  let armed = true;
  tamper(m, (msg) => {
    if (!armed || !msg.frames.length) return;
    armed = false;
    const r = msg.frames[msg.frames.length - 1], v = -r[field(0, 'v')] * 0.5;
    assert.ok(v < -20, 'truck 0 is not moving ahead: ' + v);
    r[field(0, 'v')] = msg.p[0].truck.v = v;
  });
  for (let f = 0; armed && f < 60; f++) m.step();
  assert.equal(armed, false, 'no snapshot carried a frame');
  assert.deepEqual({ ...m.counts()[0] }, Object.assign(blank(), { süreklilik: 1 }));
  clean({ counts: () => [m.counts()[1]] });
});

// The same for the wheels: off on the frame itself, not only through the turn they give the next frame.
test('a host that turns a truck\'s wheels outside update breaks physics on that frame', () => {
  const m = match(0);
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  let armed = true;
  tamper(m, (msg) => {
    if (!armed || !msg.frames.length) return;
    armed = false;
    const r = msg.frames[msg.frames.length - 1];
    r[field(0, 'steer')] = msg.p[0].truck.steer = r[field(0, 'steer')] + 0.3;
  });
  for (let f = 0; armed && f < 60; f++) m.step();
  assert.equal(armed, false, 'no snapshot carried a frame');
  assert.deepEqual({ ...m.counts()[0] }, Object.assign(blank(), { fizik: 1 }));
  clean({ counts: () => [m.counts()[1]] });
});

// Each recover is one reset on the snapshot's count, which costs the player; a host may not drop one, nor
// count one that never happened.
test('a host whose reset count does not follow its recovers breaks continuity', () => {
  const m = match(0, { before: 6000 }), G = m.host.TR.Game, p = G.players[0];
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  for (let k = 0; k < 3; k++) {
    m.resets.add('0:' + m.f);
    m.step();
    assert.equal(p.resets, 1);
    p.resets = 0;
    for (let f = 0; f < 20; f++) m.step();
  }
  assert.deepEqual({ ...m.counts()[0] }, Object.assign(blank(), { süreklilik: 3 }));
  G.players[1].resets = 2;
  for (let f = 0; f < 20; f++) m.step();
  assert.deepEqual({ ...m.counts()[1] }, Object.assign(blank(), { süreklilik: 1 }));
});

test('a host that jumps a truck ahead with no recover breaks continuity once', () => {
  const m = match(0, { before: 6000 }), G = m.host.TR.Game, p = G.players[0];
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  const q = G.map.segs[p.seg].road.lanePos(p.s + 400, m.lanes[0]);
  p.truck.place(q.x, q.y, q.h);
  for (let f = 0; f < 30; f++) m.step();
  const [c0, c1] = m.counts();
  assert.ok(c0.fizik + c0['süreklilik'] >= 1, JSON.stringify(c0));
  assert.ok(total(c0) <= 2, JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// A frame with no snapshot sent after it, so its record waits in the host's queue.
function quietFrame(m) {
  m.clock.t += 1;
  m.host.frame();
  m.pair.flush();
}

// In the last seconds of a round a lost link does not pause the host; the frames it runs while the guest is
// away go nowhere, not into the snapshot the guest gets back on.
test('a host keeps no frames for a guest that is away', () => {
  const m = match(0, { bays: true }), O = m.host.TR.Online, G = m.host.TR.Game, p0 = G.players[0];
  m.drive = [() => ({}), () => ({})];
  m.race();
  for (let f = 0; f < 240 && p0.phase !== 'unload'; f++) m.step();
  p0.unloader.cells = p0.unloader.target.map((c) => c.slice());
  p0.unloader.trailer = [];
  for (let f = 0; f < 60 && p0.phase === 'unload'; f++) m.step();
  assert.equal(G.state, 'finishing');
  const sent = [], send = O.link.send;
  O.link.send = (s) => {
    const msg = O.dec(s);
    if (msg.t === 'snap') sent.push(msg);
    send(s);
  };
  m.pair.sides.host.onClose();
  assert.ok(O.lost);
  const away = G.time;
  for (let f = 0; f < 30; f++) {
    m.clock.t += FRAME_MS;
    m.host.frame();
  }
  assert.ok(G.time > away + 0.4, 'the host stood still while the guest was away');
  rejoin(m);
  assert.equal(O.lost, null, 'the guest did not get back in');
  assert.ok(sent.length > 0, 'no snapshot went to the guest that came back');
  const late = sent.flatMap((s) => s.frames).filter((r) => r[0] > away);
  assert.deepEqual(late, []);
});

test('a guest back from a dropped link starts a new chain from the next snapshot', () => {
  const m = match(0, { before: 6000 }), G = m.host.TR.Game, p = G.players[0];
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  quietFrame(m);
  const q = G.map.segs[p.seg].road.lanePos(p.s + 2000, m.lanes[0]);
  p.truck.place(q.x, q.y, q.h);
  p.s += 2000;
  p.hint = -1;
  rejoin(m);
  const R = m.guest.TR.Referee, time = R.round.time;
  for (let f = 0; f < 60; f++) m.step();
  clean(m);
  assert.ok(R.round.time > time + 0.9, 'no frame reached the guest after it came back');
});

// A round message no hello asked for starts a round: the chain starts from the guest's own start of it.
test('a round the guest did not come back into starts the chain at the round\'s start', () => {
  const m = match(0), O = m.host.TR.Online, G = m.host.TR.Game;
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  O.share('round', G.roundOpts);
  m.pair.flush();
  for (let f = 0; f < 30; f++) m.step();
  const c = m.counts();
  c.forEach((r, i) => assert.ok(r['süreklilik'] >= 25, 'truck ' + i + ': ' + JSON.stringify(r)));
});

test('a host frame after a long stall steps by MAX_DT and breaks nothing', () => {
  const m = match(0), G = m.host.TR.Game;
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  const time = G.time;
  m.clock.t += 2000;
  m.step();
  assert.ok(Math.abs(G.time - time - G.MAX_DT) < 1e-9, 'the stalled frame stepped ' + (G.time - time));
  for (let f = 0; f < 10; f++) m.step();
  clean(m);
});

test('a host that sends a frame with a value missing breaks the input rule for that truck', () => {
  const m = match(0);
  m.race();
  tamper(m, (msg) => msg.frames.forEach((r) => (r[at(1, 1)] = null)));
  for (let f = 0; f < 30; f++) m.step();
  const [c0, c1] = m.counts();
  assert.ok(c1.girdi >= 28, JSON.stringify(c1));
  assert.equal(total(c0), 0, JSON.stringify(c0));
});

test('a host that sends a frame with a value too many breaks the input rule', () => {
  const m = match(0);
  m.race();
  tamper(m, (msg) => msg.frames.forEach((r) => r.push(0)));
  for (let f = 0; f < 30; f++) m.step();
  m.counts().forEach((c, i) => assert.ok(c.girdi >= 28, 'truck ' + i + ': ' + JSON.stringify(c)));
});

test('a host that sends a frame of no time or too long breaks the input rule', () => {
  for (const dt of [0, -1 / 60, 0.2]) {
    const m = match(0);
    m.race();
    tamper(m, (msg) => msg.frames.forEach((r) => (r[1] = dt)));
    for (let f = 0; f < 30; f++) m.step();
    m.counts().forEach((c, i) => assert.ok(c.girdi >= 28, dt + ', truck ' + i + ': ' + JSON.stringify(c)));
  }
});

// Wraps a host truck's update so that it runs with what change(dt, inp, cap, truck) returns, or not at all.
function bend(m, i, change) {
  const t = m.host.TR.Game.players[i].truck, update = Object.getPrototypeOf(t).update;
  t.update = function (dt, inp, cap) {
    const args = change(dt, inp, cap, this);
    if (args) update.apply(this, args);
  };
}

// The keys a truck's update runs on, changed where the frame record reads them too.
const press = (m, i, keys) => bend(m, i, (dt, inp, cap) => [dt, Object.assign(inp, keys(inp)), cap]);

// A truck's update runs on cap, and the frame record says so.
function capAt(m, i, cap) {
  bend(m, i, (dt, inp) => [dt, inp, cap]);
  tamper(m, (msg) => msg.frames.forEach((r) => (r[at(i, 4)] = cap)));
}

// The frame's dt is right; the truck's update ran on another.
const steps = {
  'backwards in time': (dt) => -dt,
  'by four frames at a time': (dt) => dt * 4,
  'by time lent from frame to frame': (dt, k) => dt * (k % 2 ? 0.5 : 1.5),
};
for (const [how, dtOf] of Object.entries(steps)) {
  test('a host that steps one truck ' + how + ' breaks physics for it', () => {
    const m = match(0);
    let k = 0;
    bend(m, 0, (dt, inp, cap) => [dtOf(dt, k++), inp, cap]);
    m.race();
    for (let f = 0; f < 30; f++) m.step();
    const [c0, c1] = m.counts();
    assert.ok(c0.fizik >= 25, JSON.stringify(c0));
    assert.equal(c0.zaman + c0.girdi, 0, JSON.stringify(c0));
    assert.equal(total(c1), 0, JSON.stringify(c1));
  });
}

test('a host that leaves one truck\'s update out of a frame breaks the rules for it', () => {
  const m = match(0);
  let k = 0;
  bend(m, 0, (dt, inp, cap) => (k++ % 4 ? [dt, inp, cap] : null));
  m.race();
  for (let f = 0; f < 120; f++) m.step();
  const [c0, c1] = m.counts();
  assert.ok(total(c0) >= 25, JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

test('a truck braking hard breaks no rule', () => {
  const m = match(0);
  let f = 0, braked = 0;
  const t = m.host.TR.Game.players[0].truck;
  press(m, 0, () => {
    const brake = f % 40 >= 30;
    if (brake && t.v > 20 && !(t.stun > 0)) braked++;
    return { brake };
  });
  m.race();
  f = braked = 0;
  for (; f < 120; f++) m.step();
  assert.ok(braked >= 10, 'braked at speed ' + braked + ' times');
  clean(m);
});

test('a host that pauses while frames wait in its queue breaks no rule', () => {
  const m = match(0), G = m.host.TR.Game;
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  quietFrame(m);
  G.pause();
  m.pair.flush();
  G.resume();
  m.pair.flush();
  for (let f = 0; f < 30; f++) m.step();
  assert.ok(m.guest.TR.Referee.round.time > 0.5);
  clean(m);
});

// Each truck against its own turbo length; the two lengths differ.
for (const i of [0, 1]) {
  test('a host that keeps truck ' + i + '\'s turbo on past its length breaks the speed limit', () => {
    const m = match(0), { TRUCK: T, Game: G } = m.host.TR, lens = G.players.map((p) => p.turboLen);
    assert.ok(Math.abs(lens[0] - lens[1]) > 0.5, 'turbo lengths ' + lens);
    capAt(m, i, T.MAX_FWD * (1 + G.TURBO.BOOST));
    m.race();
    const frames = Math.ceil(lens[i] * 60);
    for (let f = 0; f < frames - 10; f++) m.step();
    assert.equal(total(m.counts()[i]), 0, 'within its turbo length: ' + JSON.stringify(m.counts()[i]));
    for (let f = 0; f < 70; f++) m.step();
    const c = m.counts();
    assert.deepEqual(broken(c[i]), ['hız sınırı']);
    assert.ok(c[i]['hız sınırı'] >= 40, JSON.stringify(c[i]));
    assert.equal(total(c[1 - i]), 0, JSON.stringify(c[1 - i]));
  });
}

test('a truck in the slipstream all round long breaks no speed limit', () => {
  const m = match(0, { before: 6000 }), { TRUCK: T, Game: G } = m.host.TR;
  [0, 1].forEach((i) => capAt(m, i, T.MAX_FWD * (1 + G.DRAFT.BOOST)));
  m.race();
  const frames = Math.ceil(Math.max(...G.players.map((p) => p.turboLen)) * 60) + 60;
  for (let f = 0; f < frames; f++) m.step();
  clean(m);
});

test('a host that raises the cap above any boost breaks the speed limit at once', () => {
  const m = match(0), T = m.host.TR.TRUCK;
  capAt(m, 1, T.MAX_FWD * 2);
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  const [c0, c1] = m.counts();
  assert.equal(total(c0), 0, JSON.stringify(c0));
  assert.deepEqual(broken(c1), ['hız sınırı']);
  assert.ok(c1['hız sınırı'] >= 8, JSON.stringify(c1));
});

test('a host that gives a truck more grip than the route breaks the grip rule', () => {
  const m = match(3);
  bend(m, 0, (dt, inp, cap, t) => ((t.grip = 1), [dt, inp, cap]));
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  assert.ok(m.host.TR.Game.route.grip < 1, 'route 3 is not slippery');
  gripped(m);
});

test('a host that gives a truck more grip than 1 on a route with no grip of its own breaks the grip rule', () => {
  const m = match(0);
  assert.equal(m.host.TR.Game.route.grip, undefined, 'route 0 has a grip of its own');
  bend(m, 0, (dt, inp, cap, t) => ((t.grip = 1.3), [dt, inp, cap]));
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  gripped(m);
});

// Truck 0 broke the grip rule on every frame, and physics where the grip it ran on changed its moves.
function gripped(m) {
  const [c0, c1] = m.counts();
  assert.ok(c0['tutuş'] >= 25, JSON.stringify(c0));
  assert.ok(broken(c0).every((k) => k === 'tutuş' || k === 'fizik'), JSON.stringify(c0));
  assert.equal(total(c1), 0, JSON.stringify(c1));
}

// The route's grip is right, but on a dirt section the road's own is left out.
test('a host that leaves a dirt road\'s grip out breaks the grip rule', () => {
  const w = makeWorld('dirt', { clock: { t: 0 } }), G0 = w.TR.Game;
  let found = null;
  for (let ri = 0; ri < w.TR.ROUTES.length && !found; ri++) {
    G0.newSeries(['Ev', 'Misafir'], ['tam', 'hafif']);
    G0.startRound(ri, { seed: 4242 + ri });
    G0.map.segs.forEach(({ road }, k) => {
      const sec = road.sections.find((s) => s.type === 'dirt' && s.s1 - s.s0 > 1500);
      if (!found && sec) found = { ri, k, s: sec.s0 + 300 };
    });
  }
  assert.ok(found, 'no route has a dirt road');
  const m = match(found.ri, { before: null }), G = m.host.TR.Game;
  putOn(m, found.k, found.s);
  bend(m, 0, (dt, inp, cap, t) => ((t.grip = G.route.grip || 1), [dt, inp, cap]));
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  assert.ok(G.map.segs[G.players[0].seg].road.gripAt(G.players[0].s) < 1, 'truck 0 is not on dirt');
  gripped(m);
});

test('a host that sends keys no player can press breaks the input rule', () => {
  const m = match(0);
  press(m, 0, () => ({ thr: 2 }));
  press(m, 1, () => ({ steer: -1.5 }));
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  m.counts().forEach((c, i) => assert.deepEqual(broken(c), ['girdi'], 'truck ' + i));
});

test('a host that leaves out whole frames breaks the time rule', () => {
  const m = match(0);
  m.host.TR.Game.players.forEach((p) => (p.truck.stun = 0));
  m.race();
  // The first frame of every snapshot.
  tamper(m, (msg) => msg.frames.shift());
  for (let f = 0; f < 120; f++) m.step();
  m.counts().forEach((c, i) => assert.ok(c.zaman >= 3, 'truck ' + i + ': ' + JSON.stringify(c)));
});

test('a host snapshot whose round time is off its frames breaks the time rule', () => {
  const m = match(0);
  m.race();
  tamper(m, (msg) => (msg.g.time += 0.01));
  for (let f = 0; f < 60; f++) m.step();
  m.counts().forEach((c, i) => assert.ok(c.zaman >= 25, 'truck ' + i + ': ' + JSON.stringify(c)));
});

test('a host snapshot with no trucks in it breaks the input rule', () => {
  const m = match(0);
  m.race();
  for (let f = 0; f < 5; f++) m.step();
  const R = m.guest.TR.Referee;
  for (const bad of [{ t: 'snap' }, { t: 'snap', g: { time: 1 }, p: [] }, { t: 'snap', g: { time: 1 }, p: [{ truck: {} }, null] }]) R.check(bad);
  m.counts().forEach((c, i) => assert.equal(c.girdi, 3, 'truck ' + i + ': ' + JSON.stringify(c)));
});

test('the guest copies each truck\'s turbo length at the round start', () => {
  const m = match(1);
  assert.equal(JSON.stringify(m.guest.TR.Referee.round.turboLen), JSON.stringify(m.host.TR.Game.players.map((p) => p.turboLen)));
  assert.ok(m.host.TR.Game.players.every((p) => p.turboLen > 0));
});

const OFFLINE = 'Rakip farklı bir version kullanıyor, hile kontrolü kapalı.';
// A host on another version: its fingerprint, or the script text the fingerprint is taken from, differs.
const versions = [
  ['another fingerprint', { hostPatch: (w) => (w.TR.Referee.fingerprint = () => 'another version') }],
  ['no fingerprint', { hostPatch: (w) => (w.TR.Referee.fingerprint = () => undefined) }],
  ['another truck constant', { hostSource: (p, s) => (p.endsWith('truck.js') ? s.replace('MAX_FWD: 265', 'MAX_FWD: 266') : s) }],
  ['another truck update', { hostSource: (p, s) => (p.endsWith('truck.js') ? s.replace('update(dt, inp, cap) {', 'update(dt, inp, cap) {;') : s) }],
  ['another slipstream boost', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('BOOST: 0.12', 'BOOST: 0.13') : s) }],
  ['another turbo boost', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('BOOST: 0.45', 'BOOST: 0.46') : s) }],
  ['another barrier push', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('Math.pow(0.35, dt)', 'Math.pow(0.36, dt)') : s) }],
  ['another push between trucks', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('Math.pow(0.25, dt)', 'Math.pow(0.26, dt)') : s) }],
  ['another recover stun', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('p.truck.stun = 1.5', 'p.truck.stun = 1.6') : s) }],
  ['another road follow', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('function follow(p) {', 'function follow(p) {;') : s) }],
  ['another road grip', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('road.gripAt(p.s) : 1)', 'road.gripAt(p.s) : 0.9)') : s) }],
  ['another lot line', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('G.lot.oy - 40', 'G.lot.oy - 41') : s) }],
  ['another barrier line', { hostSource: (p, s) => (p.endsWith('game.js') ? s.replace('Math.abs(loc.d) - road.railAt(loc.s)', 'Math.abs(loc.d) - road.railAt(loc.s) - 1') : s) }],
  ['another ring island', { hostSource: (p, s) => (p.endsWith('road.js') ? s.replace('RING_R: 120', 'RING_R: 121') : s) }],
  ['another junction limit', { hostSource: (p, s) => (p.endsWith('junctions.js') ? s.replace('if (r < JN.RING_R)', 'if (r <= JN.RING_R)') : s) }],
  ['another lot wall push', { hostSource: (p, s) => (p.endsWith('lot.js') ? s.replace('m.depth + 0.05', 'm.depth + 0.06') : s) }],
  ['another road rail', { hostSource: (p, s) => (p.endsWith('road.js') ? s.replace('RAIL = 150', 'RAIL = 151') : s) }],
];

test('every script the page loads hands its whole text in for the fingerprint, in page order', () => {
  const m = match(0), files = m.guest.TR.files, list = scriptList();
  assert.ok(list.length >= 20, 'only ' + list.length + ' scripts in index.html');
  assert.equal(files.length, list.length);
  list.forEach((src, k) => {
    const text = fs.readFileSync(new URL('../' + src, import.meta.url), 'utf8');
    assert.ok(text.includes(String(files[k])) && String(files[k]).length > text.length - 40, src);
  });
});
for (const [what, opts] of versions) {
  test('a host with ' + what + ' turns the referee off, and the guest is told', () => {
    const m = match(0, opts), R = m.guest.TR.Referee;
    assert.equal(R.on, false);
    assert.equal(R.off, OFFLINE);
    assert.ok(m.welcomeStatus.endsWith(' ' + OFFLINE), 'the welcome status: ' + m.welcomeStatus);
    assert.ok(m.guest.ctx.document.getElementById('onlineStatus').textContent.includes(OFFLINE), 'the guest was not told');
    m.race();
    m.host.TR.TRUCK.MAX_FWD *= 1.3;
    for (let f = 0; f < 120; f++) m.step();
    clean(m);
    assert.equal(R.line(['Ev', 'Misafir'], false), OFFLINE);
  });
}

test('the same host fingerprint turns the referee on', () => {
  const m = match(0);
  assert.equal(m.guest.TR.Referee.on, true);
  assert.equal(m.guest.TR.Referee.off, null);
  assert.equal(m.guest.TR.Referee.fingerprint(), m.host.TR.Referee.fingerprint());
});

// Both trucks start in their bays, park and are emptied; setup(m) runs before the guest joins again and
// cheat(m) once the round is on.
function finish(cheat, setup) {
  const m = match(0, { bays: true }), G = m.host.TR.Game;
  if (setup) {
    setup(m);
    rejoin(m);
  }
  m.seen = watch(m);
  m.frames = [];
  const onData = m.pair.sides.guest.onData;
  m.pair.sides.guest.onData = (s) => {
    const msg = m.guest.TR.Online.dec(s);
    if (msg.t === 'snap') m.frames.push(...msg.frames);
    onData(s);
  };
  // The harness's elements ignore classes; these two remember whether they are hidden, as index.html starts them.
  m.hidden = {};
  for (const id of ['rrReferee', 'mrReferee']) {
    m.hidden[id] = true;
    m.guest.ctx.document.getElementById(id).classList = { toggle: (c, on) => c === 'hidden' && (m.hidden[id] = on), add() {}, remove() {}, contains: () => false };
  }
  G.series.rounds = 1;
  m.host.TR.Input.sources = [() => NONE, () => NONE];
  m.race();
  if (cheat) cheat(m);
  for (let f = 0; f < 600 && G.state !== 'roundover'; f++) {
    for (const p of G.players) {
      if (p.phase !== 'unload' || p.unloader.complete()) continue;
      p.unloader.cells = p.unloader.target.map((c) => c.slice());
      p.unloader.trailer = [];
    }
    m.step();
  }
  assert.equal(G.state, 'roundover');
  m.pair.flush();
  const doc = m.guest.ctx.document;
  const rr = doc.getElementById('rrReferee').textContent, rrHidden = m.hidden.rrReferee;
  m.host.TR.UI.lockT = 0;
  m.host.down('Enter');
  m.step();
  m.host.up('Enter');
  m.pair.flush();
  assert.equal(m.guest.TR.UI.current, 'matchResult');
  return {
    m, rr, rrHidden, mr: doc.getElementById('mrReferee').textContent, mrHidden: m.hidden.mrReferee,
    hostRr: m.host.ctx.document.getElementById('rrReferee').textContent,
  };
}

test('the guest result screens show no line after an honest round', () => {
  const { m, rr, rrHidden, mr, mrHidden, hostRr } = finish();
  // Floor: both trucks went from park to unload and done under the referee.
  assert.equal(m.seen.unload, 2);
  assert.deepEqual(Array.from(m.host.TR.Game.players, (p) => p.phase), ['done', 'done']);
  // A truck that starts a frame unloading or done runs no update, and its frame record says so with zeros.
  const idle = m.frames.slice(1).flatMap((r, k) => [0, 1].filter((i) => m.frames[k][at(i, 6)] >= 2).map((i) => Array.from(r.slice(at(i, 0), at(i, 5)))));
  assert.ok(idle.length > 0);
  idle.forEach((step) => assert.deepEqual(step, [0, 0, 0, 0, 0]));
  clean(m);
  assert.equal(rr, '');
  assert.equal(mr, '');
  assert.equal(rrHidden, true);
  assert.equal(mrHidden, true);
  assert.equal(hostRr, '');
});

test('the guest result screens name the truck and the rule it broke', () => {
  const { m, rr, rrHidden, mr, mrHidden, hostRr } = finish((m) => capAt(m, 1, m.host.TR.TRUCK.MAX_FWD * 2));
  const n = m.counts()[1]['hız sınırı'];
  assert.ok(n >= 3);
  assert.equal(rr, 'Şüpheli hareket · Misafir: hız sınırı ×' + n);
  assert.equal(mr, rr);
  assert.equal(rrHidden, false);
  assert.equal(mrHidden, false);
  assert.equal(hostRr, '', 'the host screen shows the line');
});

// Truck 0 parks with its wheels held turned; unloading, it runs no update, so they stay turned.
test('a truck that starts unloading with its wheels turned breaks no rule', () => {
  const { m } = finish((m) => (m.host.TR.Input.sources[0] = () => Object.assign({}, NONE, { steer: 1 })));
  const t = m.host.TR.Game.players[0].truck;
  assert.equal(m.seen.unload, 2);
  assert.ok(t.steer > 0.5, 'the wheels are not turned: ' + t.steer);
  clean(m);
});

// The host's lot takes any stop for truck 0's park, and truck 0 stands at the lot's entrance.
test('a host that unloads a truck that is not parked breaks the phase rule', () => {
  const { m, rr } = finish(null, (m) => {
    const lot = m.host.TR.Game.lot, status = lot.parkStatus.bind(lot), e = lot.entrance();
    lot.parkStatus = (t, i) => Object.assign(status(t, i), i === 0 ? { ok: true } : {});
    m.host.TR.Game.players[0].truck.place(e.x, e.y, e.th);
  });
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['aşama']);
  assert.ok(rr.startsWith('Şüpheli hareket · Ev: aşama ×'), rr);
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// Truck 0's snapshots show a box short of what the host has on it, the trailer the guest takes on trust as the
// round goes on; the host unloads it all the same.
test('a host that unloads a truck with a box missing breaks the phase rule', () => {
  const { m, rr } = finish(null, (m) => tamper(m, (msg) => (msg.p[0].cargo = msg.p[0].cargo.slice(1))));
  assert.equal(m.host.TR.Game.players[0].phase, 'done');
  assert.equal(m.guest.TR.Referee.round.players[0].cargo.length, m.host.TR.BOXES.length - 1);
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['aşama']);
  assert.ok(c0['aşama'] >= 25, JSON.stringify(c0));
  assert.ok(rr.startsWith('Şüpheli hareket · Ev: aşama ×'), rr);
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// Racing on the road, the host puts every box on truck 0 without a stop at any depot.
test('a host that fills a truck\'s cargo on the road breaks the phase rule on every snapshot', () => {
  const m = match(0), G = m.host.TR.Game;
  m.race();
  for (let f = 0; f < 10; f++) m.step();
  G.players[0].cargo = m.host.TR.BOXES.map((_, b) => b);
  let snaps = 0;
  tamper(m, () => snaps++);
  for (let f = 0; f < 60; f++) m.step();
  assert.equal(G.players[0].phase, 'race');
  assert.deepEqual([...m.guest.TR.Referee.round.players[0].cargo], []);
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['aşama']);
  assert.ok(snaps >= 25, 'only ' + snaps + ' snapshots');
  assert.equal(c0['aşama'], snaps);
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

// The guest takes truck 0's six boxes on trust as it comes back; from then on the snapshots keep the count and
// change what is on the trailer.
for (const [what, change] of [
  ['in another order', (c) => c.slice().reverse()],
  ['with one box shown twice', (c) => [c[1]].concat(c.slice(1))],
]) test('a host that shows a truck\'s boxes ' + what + ' breaks the phase rule on every snapshot', () => {
  const m = match(0, { bays: true });
  for (let f = 0; f < 10; f++) m.step();
  const kept = [...m.guest.TR.Referee.round.players[0].cargo];
  assert.deepEqual(kept, [0, 1, 2, 3, 4, 5]);
  let snaps = 0;
  tamper(m, (msg) => {
    msg.p[0].cargo = change(msg.p[0].cargo);
    snaps++;
  });
  for (let f = 0; f < 60; f++) m.step();
  assert.deepEqual([...m.guest.TR.Referee.round.players[0].cargo], kept);
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c0), ['aşama']);
  assert.ok(snaps >= 25, 'only ' + snaps + ' snapshots');
  assert.equal(c0['aşama'], snaps);
  assert.equal(total(c1), 0, JSON.stringify(c1));
});

for (const [what, change] of [
  ['no cargo', (p) => delete p.cargo],
  ['no ground', (p) => delete p.ground],
  ['a ground that is not lists', (p) => (p.ground = p.ground.map(() => 1))],
  ['a cargo box that is no box', (p) => (p.cargo = [6])],
  ['a ground box with no id', (p) => (p.ground = p.ground.map(() => [{ x: 0, y: 0 }]))],
  ['a ground short of a depot', (p) => (p.ground = p.ground.slice(1))],
  ['a loader at no depot\'s box', (p) => (p.loader = { box: '__proto__', worker: { carry: null } })],
  ['a loader with no worker', (p) => (p.loader = { box: 0 })],
  ['a loader whose worker carries no box', (p) => (p.loader = { box: 0, worker: { carry: -1 } })],
  ['a loader at half a box', (p) => (p.loader = { box: 0.5, worker: { carry: null } })],
  ['a ground with a hole in it', (p) => (p.ground = p.ground.map(() => [null]))],
  ['a segment the map does not have', (p) => (p.seg = 999)],
  ['a segment before the first', (p) => (p.seg = -1)],
  ['half a segment', (p) => (p.seg = 0.5)],
]) {
  test('a host snapshot with a truck of ' + what + ' breaks the input rule', () => {
    const m = match(0);
    m.race();
    tamper(m, (msg) => change(msg.p[1]));
    for (let f = 0; f < 60; f++) m.step();
    m.counts().forEach((c, i) => {
      assert.deepEqual(broken(c), ['girdi'], 'truck ' + i);
      assert.ok(c.girdi >= 25, JSON.stringify(c));
    });
  });

  test('a guest that comes back to a host snapshot with a truck of ' + what + ' counts the input rule', () => {
    const m = match(0, { before: null });
    tamper(m, (msg) => change(msg.p[1]));
    rejoin(m);
    m.race();
    for (let f = 0; f < 60; f++) m.step();
    assert.equal(m.guest.TR.Referee.round.players, null);
    m.counts().forEach((c, i) => {
      assert.deepEqual(broken(c), ['girdi'], 'truck ' + i);
      assert.ok(c.girdi >= 25, JSON.stringify(c));
    });
  });
}

// JSON keeps a "__proto__" key as the truck's own: a loader under it is not the truck's loader.
test('a guest that comes back to a truck with a loader under its "__proto__" key takes no loader', () => {
  const m = match(0, { before: null });
  tamper(m, (msg) => {
    const p = msg.p[1];
    delete p.loader;
    Object.defineProperty(p, '__proto__', { value: { loader: { box: '__proto__', worker: { carry: 3 } } }, enumerable: true });
  });
  rejoin(m);
  m.race();
  for (let f = 0; f < 60; f++) m.step();
  assert.equal(m.guest.TR.Referee.round.players[1].at, null);
  assert.equal(vm.runInContext('[][0]', m.guest.ctx), undefined);
  m.counts().forEach((c, i) => assert.equal(total(c), 0, 'truck ' + i + ': ' + JSON.stringify(c)));
});

// The host's depots take any stop for truck 1's ramp, and truck 1 stands in the middle of the yard of a
// segment's second depot.
test('a host that loads a truck that is not at its ramp breaks the phase rule', () => {
  const m = match(0), TR = m.host.TR, G = TR.Game, p = G.players[1], status = TR.Road.rampStatus;
  TR.Road.rampStatus = (dp, t, i) => Object.assign(status(dp, t, i), i === 1 ? { ok: true } : {});
  const sg = G.map.segs.find((s) => s.road.depots.length > 1), dp = sg.road.depots[1];
  const at = TR.Road.depotXY(dp, TR.DEPOT.LEN + TR.DEPOT.YARD_LEN / 2, 0);
  p.truck.place(at.x, at.y, Math.atan2(dp.oy, dp.ox));
  p.seg = sg.id;
  p.s = sg.road.locate(at.x, at.y, -1).s;
  p.hint = -1;
  rejoin(m);
  m.drive = [() => ({}), () => ({})];
  m.race();
  for (let f = 0; f < 120; f++) m.step();
  assert.equal(p.phase, 'load');
  assert.equal(status(dp, p.truck, 1).ok, false, 'truck 1 is at its ramp');
  assert.equal(m.guest.TR.Referee.round.players[1].phase, 'race');
  const [c0, c1] = m.counts();
  assert.deepEqual(broken(c1), ['aşama']);
  assert.ok(c1['aşama'] >= 25, JSON.stringify(c1));
  assert.equal(total(c0), 0, JSON.stringify(c0));
});

// An earlier round of the match, as the guest's referee carried it over.
test('the round screen shows only its round, the match screen the whole match', () => {
  const { rr, mr } = finish((m) => (m.guest.TR.Referee.match.counts[0].fizik = 5));
  assert.equal(rr, '');
  assert.equal(mr, 'Şüpheli hareket · Ev: fizik ×5');
});

const nudge = (t) => (t.x += 5);

// The threshold is written out here, not read from the referee: twice is hidden, the third time is shown.
test('a rule broken fewer than three times is not shown', () => {
  const m = match(0), R = m.guest.TR.Referee, t = m.host.TR.Game.players[0].truck;
  m.race();
  for (let k = 1; k <= 3; k++) {
    for (let f = 0; f < 10; f++) m.step();
    nudge(t);
    for (let f = 0; f < 10; f++) m.step();
    assert.equal(m.counts()[0]['süreklilik'], k);
    assert.equal(R.line(['Ev', 'Misafir'], false), k < 3 ? '' : 'Şüpheli hareket · Ev: süreklilik ×' + k, 'after ' + k);
  }
});

// The guest's line for the whole match adds up each round's shown counts.
test('a new round starts a new count, and the match line keeps the old round', () => {
  const m = match(0), R = m.guest.TR.Referee, G = m.host.TR.Game;
  m.race();
  for (let k = 0; k < 4; k++) {
    m.step();
    nudge(G.players[0].truck);
  }
  // The other truck breaks a rule once, too few times to be shown in the round or the match.
  nudge(G.players[1].truck);
  for (let f = 0; f < 5; f++) m.step();
  assert.equal(m.counts()[0]['süreklilik'], 4);
  assert.equal(m.counts()[1]['süreklilik'], 1);
  quietFrame(m);
  G.startRound(1, { seed: 99 });
  m.pair.flush();
  assert.equal(R.line(['Ev', 'Misafir'], true), 'Şüpheli hareket · Ev: süreklilik ×4');
  assert.equal(R.line(['Ev', 'Misafir'], false), '');
  // The frames the old round left in the host's queue do not reach the new one.
  m.race();
  for (let f = 0; f < 30; f++) m.step();
  clean(m);
  G.newSeries(['Ev', 'Misafir'], ['tam', 'hafif']);
  G.startRound(1, { seed: 99 });
  m.pair.flush();
  assert.equal(R.line(['Ev', 'Misafir'], true), '', 'a new match kept the old one\'s count');
});

test('a host snapshot carries every frame since the last one it sent, once', () => {
  const m = match(0), O = m.host.TR.Online, G = m.host.TR.Game;
  m.race();
  const got = [];
  const onData = m.pair.sides.guest.onData;
  m.pair.sides.guest.onData = (s) => {
    const msg = O.dec(s);
    if (msg.t === 'snap') got.push(...msg.frames);
    onData(s);
  };
  const from = G.time;
  for (let f = 0; f < 30; f++) {
    m.step();
    // A snapshot taken for anything else, as the tests do, takes nothing away.
    O.snapshot();
  }
  assert.equal(got.length, 30);
  got.reduce((t, r) => (assert.ok(Math.abs(r[0] - t - r[1]) < 1e-9, 'a frame at ' + r[0] + ' after ' + t), r[0]), from);
  assert.equal(got[got.length - 1][0], G.time);
});
