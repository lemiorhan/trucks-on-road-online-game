'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR;
  const G = () => TR.Game;
  const Truck = TR.Truck, update = Truck.prototype.update;

  // A frame record is one frame the host simulated: [G.time, dt, ...truck 0, ...truck 1]. A truck goes as
  // [reset, thr, steer, brake, cap, grip, phase, ...FIELDS], its state at the frame's end after what its
  // update ran on; a truck whose update did not run sends zeros up to grip.
  const FIELDS = ['x', 'y', 'th', 'phi', 'v', 'steer', 'stun', 'jack'];
  const PHASES = ['race', 'park', 'unload', 'done', 'load'];
  const STEP = 7, TRUCK = STEP + FIELDS.length, ROW = 2 + 2 * TRUCK;
  const RULES = ['fizik', 'girdi', 'hız sınırı', 'tutuş', 'süreklilik', 'aşama', 'zaman'];
  // Only update turns a truck or its wheels; a push moves it, and what the guest cannot replay (traffic,
  // sheep, a gate, the park) only slows it down and stuns it.
  const TURNED = ['th', 'phi', 'steer', 'jack'], MOVED = ['x', 'y'];
  // A rule broken fewer than MIN_HITS times in a round is not shown: in another browser a float can land the
  // other side of a test once, a cheat breaks it every frame.
  const EPS = 1e-6, MIN_HITS = 3;

  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36) + '.' + s.length;
  };
  // Taken on first use, once the scripts after this one have handed in theirs too.
  let fp = null;

  const blank = () => [0, 1].map(() => Object.fromEntries(RULES.map((k) => [k, 0])));
  const Ref = (TR.Referee = { FIELDS, PHASES, RULES, EPS, MIN_HITS, on: false, off: null, round: null, match: null });

  Ref.fingerprint = () => fp || (fp = hash(TR.files.map(String).join('')));
  Ref.fields = (t) => FIELDS.map((k) => t[k]);
  Ref.row = (time, dt, players, steps) => [time, dt].concat(...players.map((p, i) =>
    (steps[i] || [0, 0, 0, 0, 0]).concat(p.truck.grip, PHASES.indexOf(p.phase), Ref.fields(p.truck))));

  // A host on another version would break the rules by the code it runs, not by cheating.
  Ref.peer = (theirs) => {
    Ref.on = theirs === Ref.fingerprint();
    Ref.off = Ref.on ? null : 'Rakip farklı bir version kullanıyor, hile kontrolü kapalı.';
  };

  const shown = (c) => c.map((r) => Object.fromEntries(RULES.filter((k) => r[k] >= MIN_HITS).map((k) => [k, r[k]])));

  // The guest's own copy of a player, which only the referee moves. at is the box of the depot it loads at;
  // a box in a loading worker's hands came off that trailer or ramp and goes back onto one of them.
  const shadow = (p, idx = p.idx) => {
    const at = p.loader ? p.loader.box : null, ground = p.ground.map((l) => l.map((b) => b.id));
    if (at != null && p.loader.worker.carry != null) ground[at].push(p.loader.worker.carry);
    return {
      idx, phase: p.phase, seg: p.seg, s: p.s, d: p.d, hint: p.hint, cargo: p.cargo.slice(), ground, at, left: false,
      truck: Object.assign(new Truck(idx, '', 0, 0, 0), Object.fromEntries(FIELDS.map((k) => [k, p.truck[k]]))),
    };
  };

  // Each round message starts a new chain. A new round's starts from the guest's own start of it; a round a
  // guest comes back into starts from the host's next snapshot, taken on trust.
  Ref.reset = (players, route, series, back) => {
    if (!Ref.match || Ref.match.id !== series.id) Ref.match = { id: series.id, counts: blank() };
    else if (Ref.round) shown(Ref.round.counts).forEach((r, i) => { for (const k in r) Ref.match.counts[i][k] += r[k]; });
    Ref.round = {
      turboLen: players.map((p) => p.turboLen), counts: blank(), turbo: [0, 0],
      players: back ? null : players.map((p) => shadow(p)), time: 0, resets: players.map((p) => p.resets),
    };
  };

  const hit = (i, rule) => Ref.round.counts[i][rule]++;
  const both = (rule) => [0, 1].forEach((i) => hit(i, rule));
  const unpack = (row, at) => Object.fromEntries(FIELDS.map((k, n) => [k, row[at + n]]));
  const wrap = TR.U.wrap;
  const gap = (k, a, b) => (k === 'th' || k === 'phi' ? Math.abs(wrap(a - b)) : Math.abs(a - b));
  const racing = (p) => p.phase === 'race' || p.phase === 'park';
  const same = (a, b) => a.length === b.length && a.every((x, j) => x === b[j]);

  // The worker takes boxes off the trailer's door end onto the ramp and puts on any standing there, so a stay
  // can leave the trailer with any of those, in any order.
  const reload = (p, cargo) => {
    const pool = p.cargo.concat(p.ground[p.at]);
    for (const b of cargo) {
      const j = pool.indexOf(b);
      if (j < 0) return false;
      pool.splice(j, 1);
    }
    p.cargo = cargo.slice();
    p.ground[p.at] = pool;
    return true;
  };

  // Plays one host frame on the shadow players in the order the host's update runs, then holds the result
  // against the host's and takes the host's truck fields: a single float apart stays a single break. A truck
  // whose part of the frame is broken stays where it was.
  function frame(row, resets) {
    const r = Ref.round, g = G(), sh = r.players, T = TR.TRUCK;
    if (!Array.isArray(row) || row.length !== ROW) return both('girdi');
    const [time, dt] = row, at = (i) => 2 + i * TRUCK;
    if (!(Number.isFinite(time) && dt > 0 && dt <= g.MAX_DT + EPS)) return both('girdi');
    if (Math.abs(time - r.time - dt) > EPS) both('zaman');
    r.time = time;
    const ok = sh.map((p, i) => row.slice(at(i), at(i + 1)).every(Number.isFinite));
    ok.forEach((good, i) => good || hit(i, 'girdi'));
    // The host's update leaves the ramp before the trucks push each other and runs no truck update for it.
    const left = sh.map((p, i) => ok[i] && p.phase === 'load' && PHASES[row[at(i) + STEP - 1]] === 'race');
    left.forEach((l, i) => l && Object.assign(sh[i], { phase: 'race', left: true }));

    sh.forEach((p, i) => {
      if (!ok[i] || left[i] || !racing(p)) return;
      const [reset, thr, steer, brake, cap, grip] = row.slice(at(i), at(i) + 6);
      if (Math.abs(thr) > 1 || Math.abs(steer) > 1) hit(i, 'girdi');
      // An honest turbo runs turboLen from the frame it starts in, so up to one frame over.
      const boosted = cap > T.MAX_FWD * (1 + g.DRAFT.BOOST) + EPS;
      if (boosted) r.turbo[i] += dt;
      if (cap > T.MAX_FWD * (1 + g.DRAFT.BOOST + g.TURBO.BOOST) + EPS || (boosted && r.turbo[i] > r.turboLen[i] + g.MAX_DT + EPS)) hit(i, 'hız sınırı');
      if (reset) {
        resets[i]++;
        g.putBack(p);
      }
      g.follow(p);
      p.truck.grip = g.gripOf(p);
      if (Math.abs(grip - p.truck.grip) > EPS) hit(i, 'tutuş');
      update.call(p.truck, dt, { thr, steer, brake: !!brake }, cap);
    });
    g.pushTrucks(sh[0], sh[1], dt);
    sh.forEach((p, i) => {
      if (!ok[i] || !racing(p)) return;
      g.pushRails(p, dt);
      g.lot.collideTruck(p.truck);
      if (p.phase === 'race' && g.inLot(p.truck)) p.phase = 'park';
      else if (p.phase === 'park' && g.outOfLot(p.truck)) p.phase = 'race';
    });

    sh.forEach((p, i) => {
      if (!ok[i]) return;
      const t = p.truck, now = unpack(row, at(i) + STEP), phase = PHASES[row[at(i) + STEP - 1]];
      const off = (k) => !(gap(k, now[k], t[k]) <= EPS);
      if (TURNED.some(off)) hit(i, 'fizik');
      else if (MOVED.some(off)) hit(i, 'süreklilik');
      if (!(Math.abs(now.v) <= Math.abs(t.v) + EPS && Math.sign(now.v) * Math.sign(t.v) >= 0 && now.stun >= t.stun - EPS)) hit(i, 'süreklilik');
      const parked = p.phase === 'park' && phase === 'unload' && p.cargo.length === TR.BOXES.length && g.lot.parkStatus(t, i).ok;
      const dp = p.phase === 'race' && phase === 'load' && g.map.segs[p.seg].road.depotAt(t.x, t.y);
      const docked = !!dp && TR.Road.rampStatus(dp, t, i).ok;
      Object.assign(t, now);
      // A phase the replay does not reach is not taken: a shadow that took it would stop being replayed.
      if (phase === undefined) hit(i, 'girdi');
      else if (phase === p.phase || parked || docked || (p.phase === 'unload' && phase === 'done')) {
        if (docked) p.at = dp.box;
        p.phase = phase;
      } else hit(i, 'aşama');
    });
  }

  const box = (b) => Number.isInteger(b) && b >= 0 && b < TR.BOXES.length;
  const loaderOk = (l) => l == null || (box(l.box) && !!l.worker && (l.worker.carry == null || box(l.worker.carry)));
  const snapOk = (s) => s && s.g && Number.isFinite(s.g.time) && Array.isArray(s.p) && s.p.length === 2 &&
    s.p.every((p) => p && p.truck && FIELDS.every((k) => Number.isFinite(p.truck[k])) && Number.isFinite(p.resets) &&
      Number.isInteger(p.seg) && p.seg >= 0 && p.seg < G().map.segs.length &&
      Array.isArray(p.cargo) && p.cargo.every(box) && loaderOk(p.loader) &&
      Array.isArray(p.ground) && p.ground.length === TR.BOXES.length &&
      p.ground.every((l) => Array.isArray(l) && l.every((b) => b && box(b.id))));

  // Called with every snapshot a guest gets, in order. The trucks it shows are where the chain left them.
  Ref.check = (s) => {
    const r = Ref.round;
    if (!Ref.on || !r) return;
    if (!snapOk(s)) return both('girdi');
    if (!r.players) {
      r.players = s.p.map((p, idx) => shadow(p, idx));
      r.time = s.g.time;
      r.resets = s.p.map((p) => p.resets);
      return;
    }
    const resets = [0, 0];
    for (const row of Array.isArray(s.frames) ? s.frames : []) frame(row, resets);
    if (Math.abs(s.g.time - r.time) > EPS) both('zaman');
    s.p.forEach((p, i) => {
      const sh = r.players[i];
      if (FIELDS.some((k) => !(gap(k, p.truck[k], sh.truck[k]) <= EPS)) || p.resets - r.resets[i] !== resets[i]) hit(i, 'süreklilik');
      if (p.phase !== sh.phase) hit(i, 'aşama');
      r.resets[i] = p.resets;
      // A loading worker's hands are not in the frames, so the trailer is held to the rules when it leaves.
      if (sh.phase === 'load') return;
      if (sh.left ? !reload(sh, p.cargo) : !same(p.cargo, sh.cargo)) hit(i, 'aşama');
      sh.left = false;
    });
  };

  // The line under a result screen: the round's broken rules, or the whole match's.
  Ref.line = (names, whole) => {
    if (Ref.off) return Ref.off;
    if (!Ref.on || !Ref.round) return '';
    const counts = shown(Ref.round.counts);
    if (whole) counts.forEach((c, i) => { for (const k in Ref.match.counts[i]) if (Ref.match.counts[i][k]) c[k] = (c[k] || 0) + Ref.match.counts[i][k]; });
    const parts = counts.map((c, i) => {
      const rules = Object.keys(c).map((k) => k + ' ×' + c[k]);
      return rules.length ? names[i] + ': ' + rules.join(', ') : null;
    }).filter(Boolean);
    return parts.length ? 'Şüpheli hareket · ' + parts.join(' · ') : '';
  };
})();
