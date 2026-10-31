'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U, R = TR.ROAD, JN = TR.JUNCTION, DEPOT = TR.DEPOT, POINTS = TR.POINTS, SECTIONS = TR.SECTIONS;

  // A round's road network: northbound segments joined at fork and merge nodes, from the start node in the
  // south to the lot node in the north. Lengths are s lengths of the traced segments, rises are northward
  // distances from a segment's first node.
  //   ATTEMPTS generator tries before the fallback map; END_FLAT the straight run out of every node.
  //   NODE_R: within this rise of a node siblings may overlap, and a driver may pick any segment there;
  //   PICK_HYST and PICK_TOL are the switching hysteresis and the s tolerance of eligibility.
  //   NODE_CLEAR keeps pool features, costs, jams, events and the recover floor away from every node, and
  //   NODE_R keeps them off a node another segment leaves or reaches beside this one (clearRise);
  //   START_CLEAR keeps pool features off the start trunk's first stretch; features stay CLEAR apart.
  //   SEP is the least lateral gap between two segments at one y.
  //   A shortcut is SHORT_MIN shorter than each sibling, a busy road's flow BUSY_MIN above each sibling's.
  //   The shortest path is at most LEN_TOL (a fraction) longer than the route's north span.
  //   The first trunk is TRUNK_MIN long, the lot segment heads north over its last LOT_RUN, and no segment
  //   is shorter than SEG_MIN: the Events spot window and the start trunk's traffic window need it.
  //   DRIFT scales node x and ALT_CURVY a braid alternative's wobble, both against the route's own;
  //   DETOUR_SLOPE caps a detour's peak slope. VIEW_PAD widens a view for visible(); CELL is the side of
  //   onRoad's occupancy grid; SIGN_STEP is the step a sign moves by to find room (signs()).
  //   LINK_R: within this of a node they share, a linked segment's players and cars count for a segment's traffic.
  //   A shortcut pays for being short with COSTS_MIN to COSTS_MAX of COSTS: a dirt or a narrow section
  //   COST_LEN long, bends TWIST.CURVY curvier than its siblings' at TWIST.TIGHT times their wavelength, a
  //   flock of sheep, a radar at COST_KMH or a toll.
  const MAP = (TR.MAP = {
    ATTEMPTS: 40, END_FLAT: R.END_FLAT, NODE_R: 3000, PICK_HYST: 40, PICK_TOL: 16, NODE_CLEAR: 1000,
    START_CLEAR: 4000, CLEAR: 1000, SEP: 400, SHORT_MIN: 400, BUSY_MIN: 0.6, LEN_TOL: 0.15,
    TRUNK_MIN: 8000, LOT_RUN: R.END_FLAT, SEG_MIN: 5500, DRIFT: 0.15, ALT_CURVY: 0.5, DETOUR_SLOPE: 1,
    VIEW_PAD: 800, FEAT_TRIES: 40, CELL: 500, LINK_R: 3000, SIGN_STEP: 40,
    COSTS: ['dirt', 'narrow', 'twisty', 'flock', 'radar', 'toll'], COSTS_MIN: 2, COSTS_MAX: 3,
    COST_LEN: [1000, 1600], TWIST: { CURVY: 0.35, TIGHT: 0.75 }, COST_KMH: 50,
  });
  const FLOW = { shortcut: [0.6, 0.85], busy: [1.5, 1.8], quiet: [0.3, 0.5] };
  // Jams a round brings, COUNT of them, each over EXTENT of rise from START seconds on for DUR. Same-direction
  // cars crawl at V inside one and brake for it at DECEL before it; while it is on, the segment wants FILL
  // times its cars, and respawns go into the jam until it holds MIN_CARS per km.
  const JAM = (TR.JAM = {
    COUNT: [1, 2], EXTENT: [1200, 2200], START: [20, 160], DUR: [50, 100], V: 30, DECEL: 150, FILL: 3, MIN_CARS: 30, KM: 10000,
  });

  const rise = (spec, sg) => spec.nodes[sg.a].y - spec.nodes[sg.b].y;
  const extent = (f) => {
    if (SECTIONS[f.type]) return [f.rise0, f.rise1];
    const h = f.type === 'depot' ? DEPOT.YARD_HW : POINTS[f.type].flat;
    return [f.rise - h, f.rise + h];
  };
  const trunkOnly = (type) => type === 'cross' || type === 'ring';

  // The rise window of sg clear of every other segment: validator clause 7b lets siblings come within SEP
  // only within NODE_R of a node they share, so at an end another segment leaves or reaches too the window
  // keeps NODE_R off it, elsewhere NODE_CLEAR.
  function clearRise(spec, sg) {
    const shared = (end) => spec.segs.some((o) => o !== sg && o[end] === sg[end]);
    const margin = (end) => (shared(end) ? Math.max(MAP.NODE_CLEAR, MAP.NODE_R) : MAP.NODE_CLEAR);
    return [margin('a'), rise(spec, sg) - margin('b')];
  }

  function indexAtY(t, y) {
    let lo = 0, hi = t.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.ys[mid] <= y) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function xAtY(t, y) {
    const lo = indexAtY(t, y);
    if (lo === 0) return t.xs[0];
    const y0 = t.ys[lo - 1], y1 = t.ys[lo];
    return U.lerp(t.xs[lo - 1], t.xs[lo], (y0 - y) / (y0 - y1));
  }

  // Between its two ends, so a segment that stops at a node does not reach past it.
  function within(road, x, y, w) {
    const b = road.bbox;
    if (x < b.x0 - w || x > b.x1 + w || y < b.y0 - w || y > b.y1 + w) return false;
    const c = road.locate(x, y, road.indexForY(y));
    return c.s >= 0 && c.s <= road.length && Math.abs(c.d) < w;
  }

  function westOf(o, r) {
    const top = o.ys[o.n - 1], bot = o.ys[0];
    for (let i = 0; i < r.n; i++) if (r.ys[i] >= top && r.ys[i] <= bot && xAtY(o, r.ys[i]) < r.xs[i] - 1) return true;
    return false;
  }

  const cellKey = (i, j) => i + ',' + j;

  function traceSeg(spec, sg) {
    const flats = sg.features.filter((f) => POINTS[f.type] && POINTS[f.type].flat).map((f) => ({ rise: f.rise, half: POINTS[f.type].flat }));
    return TR.Road.trace(spec.nodes[sg.a], spec.nodes[sg.b], { detour: sg.detour, curvy: sg.curvy, tight: sg.tight, wseed: sg.wseed, flats, endFlat: MAP.END_FLAT });
  }

  // A roadside event a segment holds (events.flock or events.work as { rise }, TR.Events.SPAN around it).
  const EVENTS = ['flock', 'work'];
  const placedEvent = (sg, type) => !!sg.events[type] && typeof sg.events[type] === 'object';
  const eventExtent = (sg, type) => [sg.events[type].rise - TR.Events.SPAN[type][0], sg.events[type].rise + TR.Events.SPAN[type][1]];
  const taken = (sg) => sg.features.map(extent).concat(EVENTS.filter((t) => placedEvent(sg, t)).map((t) => eventExtent(sg, t)));

  // One seeded try for a rise r on sg with [r - before, r + after] inside its clear window, lead clear before
  // r as well, and CLEAR off everything already on sg; null when the try misses.
  function tryRise(spec, sg, before, after, lead, rnd) {
    const [c0, c1] = clearRise(spec, sg);
    const lo = (spec.nodes[sg.a].kind === 'start' ? Math.max(c0, MAP.START_CLEAR) : c0) + Math.max(before, lead);
    const hi = c1 - after;
    if (hi < lo) return null;
    const r = Math.round(rnd.range(lo, hi));
    return taken(sg).some(([g0, g1]) => r - before < g1 + MAP.CLEAR && r + after > g0 - MAP.CLEAR) ? null : r;
  }

  // Puts f (in the route pool's shape) on one of pool's segments, its sign SIGN_LEAD ahead of it inside the
  // clear window too; false when no try found room.
  function placeOne(spec, pool, f, rnd) {
    const sec = !!SECTIONS[f.type];
    const before = sec ? 0 : POINTS[f.type].flat, after = sec ? f.s1 - f.s0 : POINTS[f.type].flat;
    for (let k = 0; k < MAP.FEAT_TRIES; k++) {
      const sg = rnd.pick(pool), r = tryRise(spec, sg, before, after, R.SIGN_LEAD, rnd);
      if (r === null) continue;
      sg.features.push(sec ? { type: f.type, rise0: r - before, rise1: r + after } : Object.assign({ type: f.type, rise: r }, f.kmh ? { kmh: f.kmh } : {}));
      sg.features.sort((p, q) => extent(p)[0] - extent(q)[0]);
      return true;
    }
    return false;
  }

  // Gives sg a flock or road works (type) at a seeded rise; false when no try found room.
  function placeEvent(spec, sg, type, rnd) {
    const [before, after] = TR.Events.SPAN[type];
    for (let k = 0; k < MAP.FEAT_TRIES; k++) {
      const r = tryRise(spec, sg, before, after, 0, rnd);
      if (r === null) continue;
      sg.events[type] = { rise: r };
      return true;
    }
    return false;
  }

  function placeFeatures(spec, route, rnd) {
    for (const f of route.features || []) placeOne(spec, spec.segs.filter((sg) => !trunkOnly(f.type) || sg.role === 'trunk'), f, rnd);
  }

  function addCost(spec, sg, cost, rnd) {
    if (cost === 'twisty') {
      sg.curvy += MAP.TWIST.CURVY;
      sg.tight *= MAP.TWIST.TIGHT;
      return true;
    }
    if (cost === 'flock') return !sg.events.flock && placeEvent(spec, sg, 'flock', rnd);
    const f = SECTIONS[cost] ? { type: cost, s0: 0, s1: Math.round(rnd.range(MAP.COST_LEN[0], MAP.COST_LEN[1])) } : cost === 'radar' ? { type: cost, kmh: MAP.COST_KMH } : { type: cost };
    return placeOne(spec, [sg], f, rnd);
  }

  // Every round has a flock, as it had before shortcuts carried them: the first shortcut in a seeded order
  // gets one before any feature or cost takes its room, and counts it among its costs.
  function placeFlock(spec, rnd) {
    rnd.shuffle(spec.segs.filter((sg) => sg.role === 'shortcut')).some((sg) => placeEvent(spec, sg, 'flock', rnd));
  }

  // Each shortcut draws its costs in a seeded order until it has its count.
  function placeCosts(spec, rnd) {
    const shortcuts = spec.segs.filter((sg) => sg.role === 'shortcut');
    for (const sg of shortcuts) {
      let left = rnd.int(MAP.COSTS_MIN, MAP.COSTS_MAX) - (sg.events.flock ? 1 : 0);
      for (const c of rnd.shuffle(MAP.COSTS.slice())) if (left > 0 && addCost(spec, sg, c, rnd)) left--;
    }
  }

  // The costs a shortcut carries, by their COSTS names; twisty counts when it out-bends every sibling.
  function costsOf(spec, sg) {
    const sibs = spec.segs.filter((o) => o !== sg && o.a === sg.a && o.b === sg.b);
    const has = (type) => sg.features.some((f) => f.type === type && (type !== 'radar' || f.kmh));
    const on = {
      twisty: sibs.length > 0 && sibs.every((o) => sg.curvy - o.curvy >= MAP.TWIST.CURVY - 1e-9),
      flock: !!sg.events.flock,
    };
    return MAP.COSTS.filter((c) => (c in on ? on[c] : has(c)));
  }

  // plain is the fallback recipe: one braid of two alternatives, straight segments, nodes on one line.
  function build(route, rnd, plain) {
    const rc = route.mapRecipe, span = route.length, rimp = MAP.DETOUR_SLOPE / Math.PI;
    const trunkMin = (nb) => MAP.TRUNK_MIN + (nb - 1) * MAP.SEG_MIN + Math.max(MAP.SEG_MIN, MAP.LOT_RUN);
    let nb = plain ? 1 : rnd.int(rc.braids[0], rc.braids[1]);
    while (nb > 1 && (span - trunkMin(nb)) / nb < MAP.SEG_MIN) nb--;
    // A braid is long enough for the recipe's spread at DETOUR_SLOPE, unless the span runs out.
    const fit = rc.spread / rimp + 2 * MAP.END_FLAT + JN.FLAT_RAMP;
    const braid = () => Math.round(Math.min(fit * (plain ? 1 : rnd.range(0.9, 1.1)), (span - trunkMin(nb)) / nb));
    const pieces = [];
    for (let k = 0; k <= nb; k++) {
      pieces.push(k === 0 ? MAP.TRUNK_MIN : k === nb ? Math.max(MAP.SEG_MIN, MAP.LOT_RUN) : MAP.SEG_MIN);
      if (k < nb) pieces.push(braid());
    }
    const w = pieces.map((v, i) => (i % 2 ? 0 : plain ? 1 : rnd.range(0.6, 1.4))), wsum = w.reduce((a, v) => a + v, 0);
    const slack = span - pieces.reduce((a, v) => a + v, 0);
    for (let i = 0; i < pieces.length; i++) pieces[i] = Math.round(pieces[i] + (slack * w[i]) / wsum);
    pieces[pieces.length - 1] += span - pieces.reduce((a, v) => a + v, 0);

    const drift = () => (plain ? 0 : Math.round(rnd.range(-1, 1) * rc.spread * MAP.DRIFT));
    const spec = { ri: TR.ROUTES.indexOf(route), seed: null, attempt: null, nodes: [], segs: [], jams: [] };
    const node = (x, y, kind) => (spec.nodes.push({ id: spec.nodes.length, x, y, kind }), spec.nodes.length - 1);
    const seg = (a, b, role, flow, detour, curvy) => {
      spec.segs.push({
        id: spec.segs.length, a, b, role, flow, detour, curvy, tight: route.tight || 1, wseed: rnd.int(1, 0x7fffffff),
        features: [], events: { flock: false, work: false },
      });
    };
    const trunkCurvy = plain ? 0 : route.curvy, altCurvy = plain ? 0 : route.curvy * MAP.ALT_CURVY;
    let y = 0, at = node(0, 0, 'start');
    for (let k = 0; k < pieces.length; k++) {
      y -= pieces[k];
      if (k % 2 === 0) {
        const to = node(drift(), y, k === pieces.length - 1 ? 'lot' : 'fork');
        seg(at, to, 'trunk', 1, 0, trunkCurvy);
        at = to;
        continue;
      }
      const to = node(drift(), y, 'merge');
      const na = plain ? 2 : Math.min(3, rnd.int(rc.alts[0], rc.alts[1]));
      const side = plain || rnd() < 0.5 ? 1 : -1;
      const cap = Math.min(rc.spread, rimp * (pieces[k] - 2 * MAP.END_FLAT - JN.FLAT_RAMP));
      const amp = () => cap * (plain ? 1 : rnd.range(0.8, 1));
      const flow = (role) => (plain ? FLOW[role][0] : Math.round(rnd.range(FLOW[role][0], FLOW[role][1]) * 100) / 100);
      const shortD = plain ? 0 : Math.round(cap * (na > 2 ? rnd.range(-0.1, 0.1) : -side * rnd.range(0, 0.15)));
      seg(at, to, 'shortcut', flow('shortcut'), shortD, altCurvy);
      seg(at, to, 'busy', flow('busy'), Math.round(side * amp()), altCurvy);
      if (na > 2) seg(at, to, 'quiet', flow('quiet'), Math.round(-side * amp()), altCurvy);
      at = to;
    }
    placeFlock(spec, rnd);
    placeFeatures(spec, route, rnd);
    placeCosts(spec, rnd);
    rnd.shuffle(spec.segs.filter((sg) => sg.role !== 'shortcut')).some((sg) => placeEvent(spec, sg, 'work', rnd));
    placeJams(spec, rnd);
    placeDepots(spec, rnd);
    return spec;
  }

  const isDepot = (f) => f.type === 'depot';

  // Whether the side road or the yard of depot f on segment k comes within RAIL of segment o, both traced in tr.
  function depotMeets(spec, tr, k, f, o) {
    const own = tr[k], jy = spec.nodes[spec.segs[k].a].y - f.rise, jx = xAtY(own, jy), h = own.hs[indexAtY(own, jy)];
    const boxes = [[0, DEPOT.LEN, DEPOT.RAIL], [DEPOT.LEN, DEPOT.LEN + DEPOT.YARD_LEN, DEPOT.YARD_HW]];
    const t = tr[o], reach = DEPOT.LEN + DEPOT.YARD_LEN + R.RAIL;
    for (let i = indexAtY(t, jy + reach); i < t.n && t.ys[i] >= jy - reach; i++) {
      const dx = t.xs[i] - jx, dy = t.ys[i] - jy;
      const u = f.dir * (dx * -Math.sin(h) + dy * Math.cos(h)), v = dx * Math.cos(h) + dy * Math.sin(h);
      for (const [u0, u1, hw] of boxes) {
        const du = Math.max(0, u0 - u, u - u1), dv = Math.max(0, Math.abs(v) - hw);
        if (du * du + dv * dv < R.RAIL * R.RAIL) return true;
      }
    }
    return false;
  }

  // A depot for each box, placed after everything else so the seeded draws before it stay as they were. A
  // trunk's depot faces a seeded side. A braid's depots all go on one of its two outer alternatives, so one
  // way through the braid passes them all, and face away from its siblings. A depot whose yard meets
  // another segment is left to the validator (clause D3) and the next attempt.
  function placeDepots(spec, rnd) {
    const sibs = (sg) => spec.segs.filter((o) => o !== sg && o.a === sg.a && o.b === sg.b);
    const away = (sg) => (sibs(sg).every((o) => o.detour < sg.detour) ? 1 : sibs(sg).every((o) => o.detour > sg.detour) ? -1 : 0);
    const outer = spec.segs.filter((sg) => !sibs(sg).length || away(sg));
    for (let box = 0; box < TR.BOXES.length; box++) {
      const pool = outer.filter((sg) => !sibs(sg).some((o) => o.features.some(isDepot)));
      for (let k = 0; k < MAP.FEAT_TRIES; k++) {
        const sg = rnd.pick(pool), r = tryRise(spec, sg, DEPOT.YARD_HW, DEPOT.YARD_HW, R.SIGN_LEAD, rnd);
        if (r === null) continue;
        sg.features.push({ type: 'depot', rise: r, dir: sibs(sg).length ? away(sg) : rnd() < 0.5 ? 1 : -1, box });
        sg.features.sort((p, q) => extent(p)[0] - extent(q)[0]);
        break;
      }
    }
  }

  const jamFloor = (spec, sg) => Math.max(clearRise(spec, sg)[0], spec.nodes[sg.a].kind === 'start' ? MAP.TRUNK_MIN : 0);
  const jamsMeet = (p, q) => p.seg === q.seg && p.t0 < q.t1 && q.t0 < p.t1;

  function placeJams(spec, rnd) {
    const n = rnd.int(JAM.COUNT[0], JAM.COUNT[1]);
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < MAP.FEAT_TRIES; tries++) {
        const sg = rnd.pick(spec.segs), ext = Math.round(rnd.range(JAM.EXTENT[0], JAM.EXTENT[1]));
        const lo = jamFloor(spec, sg), hi = clearRise(spec, sg)[1] - ext;
        if (hi < lo) continue;
        const rise0 = Math.round(rnd.range(lo, hi)), t0 = Math.round(rnd.range(JAM.START[0], JAM.START[1]));
        const jam = { seg: sg.id, rise0, rise1: rise0 + ext, t0, t1: t0 + Math.round(rnd.range(JAM.DUR[0], JAM.DUR[1])) };
        if (spec.jams.some((o) => jamsMeet(o, jam))) continue;
        spec.jams.push(jam);
        break;
      }
    }
  }

  function validate(spec, route) {
    const why = [], { nodes, segs } = spec;
    const starts = nodes.filter((n) => n.kind === 'start'), lots = nodes.filter((n) => n.kind === 'lot');
    if (starts.length !== 1 || lots.length !== 1) return { ok: false, why: ['1: ' + starts.length + ' start and ' + lots.length + ' lot nodes'] };
    for (const sg of segs) if (nodes[sg.b].y >= nodes[sg.a].y) why.push('2a: segment ' + sg.id + ' does not run north');
    if (why.length) return { ok: false, why };
    const start = starts[0], lot = lots[0];
    const tr = segs.map((sg) => traceSeg(spec, sg));
    segs.forEach((sg, k) => {
      if (tr[k].maxDev > R.MAX_DEV) why.push('2b: segment ' + sg.id + ' turns ' + tr[k].maxDev.toFixed(3) + ' from north');
      if (tr[k].length < MAP.SEG_MIN) why.push('11: segment ' + sg.id + ' is ' + tr[k].length + ' long');
    });

    const reach = (from, fwd) => {
      const seen = new Set([from]), todo = [from];
      while (todo.length) {
        const v = todo.pop();
        for (const sg of segs) {
          const [p, q] = fwd ? [sg.a, sg.b] : [sg.b, sg.a];
          if (p === v && !seen.has(q)) { seen.add(q); todo.push(q); }
        }
      }
      return seen;
    };
    const fromStart = reach(start.id, true), toLot = reach(lot.id, false);
    for (const n of nodes) {
      if (!fromStart.has(n.id)) why.push('3a: node ' + n.id + ' is not reachable from the start');
      if (!toLot.has(n.id)) why.push('3b: the lot is not reachable from node ' + n.id);
      if (n !== lot && !segs.some((sg) => sg.a === n.id)) why.push('3c: node ' + n.id + ' has no outgoing segment');
      if (n !== start && !segs.some((sg) => sg.b === n.id)) why.push('3d: node ' + n.id + ' has no incoming segment');
    }

    segs.forEach((sg, k) => {
      const sibs = segs.filter((o) => o !== sg && o.a === sg.a && o.b === sg.b);
      if (sg.role === 'shortcut' && sibs.some((o) => tr[o.id].length - tr[k].length < MAP.SHORT_MIN)) why.push('4: shortcut ' + sg.id + ' is not shorter than its siblings');
      if (sg.role === 'busy' && sibs.some((o) => sg.flow - o.flow < MAP.BUSY_MIN)) why.push('5: busy segment ' + sg.id + ' is not busier than its siblings');
      if (sg.role === 'shortcut' && costsOf(spec, sg).length < MAP.COSTS_MIN) why.push('C1: shortcut ' + sg.id + ' costs [' + costsOf(spec, sg) + ']');
      if (sg.events.flock && sg.role !== 'shortcut') why.push('C2: a flock on ' + sg.role + ' segment ' + sg.id);
      if (sg.events.work && sg.role === 'shortcut') why.push('C3: road works on shortcut ' + sg.id);
      const [c0, c1] = clearRise(spec, sg);
      for (const t of EVENTS.filter((e) => placedEvent(sg, e))) {
        const [e0, e1] = eventExtent(sg, t);
        const near = sg.features.some((f) => { const [g0, g1] = extent(f); return e0 < g1 + MAP.CLEAR && e1 > g0 - MAP.CLEAR; });
        if (e0 < c0 || e1 > c1 || near) why.push('C4: the ' + t + ' on segment ' + sg.id + ' runs where another segment runs beside it, or by a feature');
      }
    });

    if (segs.some((sg) => sg.role === 'shortcut') && !segs.some((sg) => sg.events.flock)) why.push('C5: no shortcut carries a flock');

    segs.forEach((sg, k) => {
      const t = tr[k];
      if (t.ys.some((y) => y < lot.y - 1e-6)) why.push('6a: segment ' + sg.id + ' runs north of the lot');
      if (sg.b !== lot.id) return;
      let north = t.length >= MAP.LOT_RUN;
      for (let i = 0; i < t.n; i++) if (t.ys[i] <= lot.y + MAP.LOT_RUN && Math.abs(t.hs[i] + Math.PI / 2) > 1e-9) north = false;
      if (!north) why.push('6b: lot segment ' + sg.id + ' does not head north over its last ' + MAP.LOT_RUN);
    });

    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const A = segs[i], B = segs[j], ta = tr[i], tb = tr[j];
        const shared = [A.a, A.b].filter((v) => v === B.a || v === B.b).map((v) => nodes[v]);
        const top = Math.max(ta.ys[ta.n - 1], tb.ys[tb.n - 1]), bot = Math.min(ta.ys[0], tb.ys[0]);
        for (let k = 0; k < ta.n; k++) {
          const y = ta.ys[k];
          if (y < top || y > bot || Math.abs(ta.xs[k] - xAtY(tb, y)) >= MAP.SEP) continue;
          if (!shared.length) { why.push('7a: segments ' + A.id + ' and ' + B.id + ' come within ' + MAP.SEP); break; }
          if (shared.every((n) => Math.abs(y - n.y) > MAP.NODE_R)) { why.push('7b: siblings ' + A.id + ' and ' + B.id + ' come within ' + MAP.SEP); break; }
        }
      }
    }

    segs.forEach((sg, k) => {
      for (const f of sg.features) {
        if (!trunkOnly(f.type)) continue;
        if (sg.role !== 'trunk') why.push('8b: ' + f.type + ' on ' + sg.role + ' segment ' + sg.id);
        const jy = nodes[sg.a].y - f.rise, jx = xAtY(tr[k], jy), flat = POINTS[f.type].flat;
        const hit = tr.some((t, o) => {
          if (o === k) return false;
          for (let i = 0; i < t.n; i++) {
            const dx = Math.max(0, Math.abs(t.xs[i] - jx) - JN.SIDE_LEN), dy = Math.max(0, Math.abs(t.ys[i] - jy) - flat);
            if (dx * dx + dy * dy < R.RAIL * R.RAIL) return true;
          }
          return false;
        });
        if (hit) why.push('8a: the side road of the ' + f.type + ' on segment ' + sg.id + ' meets another segment');
      }
    });

    const depots = segs.flatMap((sg) => sg.features.filter(isDepot).map((f) => ({ sg, f })));
    TR.BOXES.forEach((_, i) => {
      const n = depots.filter((d) => d.f.box === i).length;
      if (n !== 1) why.push('D1: box ' + i + ' has ' + n + ' depots');
    });
    for (const { sg, f } of depots) if (!TR.BOXES[f.box]) why.push('D1: the depot on segment ' + sg.id + ' holds box ' + f.box);
    segs.forEach((sg, k) => {
      const mine = sg.features.filter(isDepot);
      if (!mine.length) return;
      if (segs.some((o) => o.id < sg.id && o.a === sg.a && o.b === sg.b && o.features.some(isDepot))) why.push('D2: segment ' + sg.id + ' holds depots beside a sibling that holds some');
      const [c0, c1] = clearRise(spec, sg);
      for (const f of mine) {
        if (f.dir !== 1 && f.dir !== -1) why.push('D5: the depot at ' + f.rise + ' on segment ' + sg.id + ' faces ' + f.dir);
        const [e0, e1] = extent(f);
        if (e0 < c0 || e1 > c1 || tr.some((t, o) => o !== k && depotMeets(spec, tr, k, f, o))) why.push('D3: the depot at ' + f.rise + ' on segment ' + sg.id + ' runs where another segment runs beside it');
        if (sg.features.some((g) => g !== f && extent(g)[0] < e1 + MAP.CLEAR && extent(g)[1] > e0 - MAP.CLEAR)) why.push('D4: the depot at ' + f.rise + ' on segment ' + sg.id + ' comes within ' + MAP.CLEAR + ' of another feature');
      }
    });

    const best = nodes.map(() => Infinity);
    best[start.id] = 0;
    for (let pass = 0; pass < nodes.length; pass++) {
      for (const sg of segs) best[sg.b] = Math.min(best[sg.b], best[sg.a] + tr[sg.id].length);
    }
    if (best[lot.id] < Infinity && best[lot.id] > route.length * (1 + MAP.LEN_TOL)) why.push('9: shortest path ' + best[lot.id] + ' against ' + route.length);

    const placed = segs.flatMap((sg) => sg.features.map((f) => ({ f, used: false })));
    (route.features || []).forEach((p, k) => {
      const m = placed.find((q) => !q.used && q.f.type === p.type && (SECTIONS[p.type] ? Math.abs(q.f.rise1 - q.f.rise0 - (p.s1 - p.s0)) < 1e-6 : (q.f.kmh || 0) === (p.kmh || 0)));
      if (m) m.used = true;
      else why.push('10: pool entry ' + k + ' (' + p.type + ') is not placed');
    });

    (spec.jams || []).forEach((j, k) => {
      const sg = segs[j.seg];
      if (!sg) { why.push('J2: jam ' + k + ' is on no segment'); return; }
      if (nodes[sg.a].kind === 'start' && j.rise0 < MAP.TRUNK_MIN) why.push('J1: jam ' + k + ' starts ' + j.rise0 + ' into the start trunk');
      const [c0, c1] = clearRise(spec, sg);
      if (j.rise0 < c0 || j.rise1 > c1 || j.rise1 <= j.rise0) why.push('J2: jam ' + k + ' runs outside segment ' + sg.id + ' or where another segment runs beside it');
      if (spec.jams.some((o, i) => i < k && jamsMeet(o, j))) why.push('J3: jam ' + k + ' overlaps another on segment ' + sg.id);
      if (j.t1 <= j.t0) why.push('J4: jam ' + k + ' ends at ' + j.t1 + ', not after its start ' + j.t0);
    });

    return { ok: !why.length, why };
  }

  function generate(route, seed) {
    for (let attempt = 0; attempt < MAP.ATTEMPTS; attempt++) {
      const spec = build(route, U.rng(seed * 31 + 17 + attempt * 7919), false);
      spec.seed = seed;
      spec.attempt = attempt;
      if (validate(spec, route).ok) return spec;
    }
    return fallback(route);
  }

  function fallback(route) {
    const spec = build(route, U.rng(route.seed), true);
    spec.attempt = -1;
    return spec;
  }

  TR.MapGen = { generate, validate, fallback, clearRise, placeDepots };

  class RoadMap {
    constructor(spec, route) {
      this.spec = spec;
      this.route = route;
      this.nodes = spec.nodes;
      const kind = (v) => spec.nodes[v].kind;
      this.segs = spec.segs.map((sg) => ({
        id: sg.id, spec: sg, out: [], in: [],
        road: new TR.Road(route, {
          id: sg.id, a: spec.nodes[sg.a], b: spec.nodes[sg.b], detour: sg.detour, curvy: sg.curvy, tight: sg.tight,
          wseed: sg.wseed, features: sg.features, isStart: kind(sg.a) === 'start', atLot: kind(sg.b) === 'lot',
        }),
      }));
      for (const s of this.segs) {
        for (const o of this.segs) {
          if (o.spec.a === s.spec.b) s.out.push(o.id);
          if (o.spec.b === s.spec.a) s.in.push(o.id);
        }
      }
      this.start = this.segs.find((s) => kind(s.spec.a) === 'start').id;
      this.lotSeg = this.segs.find((s) => kind(s.spec.b) === 'lot').id;
      const indeg = this.segs.map((s) => s.in.length), ready = this.segs.filter((s) => !s.in.length).map((s) => s.id);
      this.order = [];
      while (ready.length) {
        ready.sort((p, q) => p - q);
        const k = ready.shift();
        this.order.push(k);
        for (const o of this.segs[k].out) if (--indeg[o] === 0) ready.push(o);
      }
      for (let i = this.order.length - 1; i >= 0; i--) {
        const s = this.segs[this.order[i]];
        s.road.toLot = s.out.length ? Math.min(...s.out.map((o) => this.segs[o].road.length + this.segs[o].road.toLot)) : 0;
      }
      this.shortest = this.distToLot(this.start, 0);
      for (const s of this.segs) {
        s.ends = [s.spec.a, s.spec.b].map((v) => ({
          y: spec.nodes[v].y, ids: this.segs.filter((o) => o !== s && (o.spec.a === v || o.spec.b === v)).map((o) => o.id),
        }));
        s.coast = this.segs.every((o) => o === s || !westOf(o.road, s.road));
        const others = this.segs.filter((o) => o !== s);
        s.links = {
          next: s.out, prev: s.in,
          endSibs: others.filter((o) => o.spec.b === s.spec.b).map((o) => o.id),
          startSibs: others.filter((o) => o.spec.a === s.spec.a).map((o) => o.id),
        };
      }
      // Before a fork, the boxes down the alternative that holds them, its side by the way its depots face.
      for (const s of this.segs) {
        const ds = s.road.depots;
        if (!ds.length || !s.links.startSibs.some((k) => this.segs[k].spec.b === s.spec.b)) continue;
        for (const k of s.in) {
          const road = this.segs[k].road;
          road.signList.push(TR.Road.boxSign(road.length - R.SIGN_LEAD, ds.map((dp) => dp.box), ds[0].dir > 0 ? '↗' : '↖'));
        }
      }
      this.grid = new Map();
      for (const s of this.segs) {
        const { xs, ys, n } = s.road;
        for (let i = 0; i < n; i++) {
          const key = cellKey(Math.floor(xs[i] / MAP.CELL), Math.floor(ys[i] / MAP.CELL)), ids = this.grid.get(key);
          if (!ids) this.grid.set(key, [s.id]);
          else if (ids[ids.length - 1] !== s.id) ids.push(s.id);
        }
      }
    }

    // Whether (x, y) lies within w of the centre line of another segment (with lower, a lower-id one) that
    // meets seg at a node, near that node: where siblings overlap, one's rails must not run over the other's
    // asphalt, and only one of them draws markings.
    covered(seg, x, y, w, lower) {
      for (const e of this.segs[seg].ends) {
        if (Math.abs(y - e.y) > MAP.NODE_R) continue;
        for (const k of e.ids) if ((!lower || k < seg) && within(this.segs[k].road, x, y, w)) return true;
      }
      return false;
    }

    // The signs of seg, each with its box out of every segment's rails and off every sign kept before it.
    // A signList sign whose own spot is taken moves to the nearest free spot along its segment, SIGN_STEP
    // apart and the earlier of two equally near; the lot and distance signs are left out where they do
    // not fit. Rebuilt when a signList changes: events, assist and the online layout write them.
    signs(seg) {
      const lists = this.segs.map((s) => s.road.signList), c = this.signCache;
      if (!c || lists.some((l, k) => l !== c.lists[k] || l.length !== c.lens[k])) {
        const kept = [], by = this.segs.map(() => []);
        const clear = (g) => {
          const x0 = g.x - g.hw, x1 = g.x + g.hw, y0 = g.y - g.hh, y1 = g.y + g.hh;
          for (let x = x0; x < x1 + R.DS; x += R.DS) if (this.onRoad(Math.min(x, x1), y0, 0, -1) || this.onRoad(Math.min(x, x1), y1, 0, -1)) return false;
          for (let y = y0; y < y1 + R.DS; y += R.DS) if (this.onRoad(x0, Math.min(y, y1), 0, -1) || this.onRoad(x1, Math.min(y, y1), 0, -1)) return false;
          return true;
        };
        const fits = (g) => clear(g) && !kept.some((o) => Math.abs(o.x - g.x) < o.hw + g.hw && Math.abs(o.y - g.y) < o.hh + g.hh);
        const keep = (s, g) => (kept.push(g), by[s.id].push(g));
        const slide = (road, g) => {
          for (let k = 1; g.s - k * MAP.SIGN_STEP >= 0 || g.s + k * MAP.SIGN_STEP <= road.length; k++) {
            for (const s of [g.s - k * MAP.SIGN_STEP, g.s + k * MAP.SIGN_STEP]) {
              if (s < 0 || s > road.length) continue;
              const h = road.signSpot(s, g.text, g.bg, g.src);
              if (fits(h)) return h;
            }
          }
          return g;
        };
        for (const s of this.segs) for (const g of s.road.signSpots()) if (g.src) keep(s, fits(g) ? g : slide(s.road, g));
        for (const s of this.segs) for (const g of s.road.signSpots()) if (!g.src && fits(g)) keep(s, g);
        this.signCache = { lists, lens: lists.map((l) => l.length), by };
      }
      return this.signCache.by[seg];
    }

    // Whether (x, y) lies within RAIL + margin of any segment but except, or within margin of any depot's
    // ground past its segment's barrier, for roadside props.
    onRoad(x, y, margin, except) {
      if (this.segs.some((s) => s.road.depotAt(x, y, margin, R.RAIL))) return true;
      const w = R.RAIL + margin, reach = Math.ceil((w + R.DS) / MAP.CELL);
      const cx = Math.floor(x / MAP.CELL), cy = Math.floor(y / MAP.CELL), seen = new Set();
      for (let i = cx - reach; i <= cx + reach; i++) {
        for (let j = cy - reach; j <= cy + reach; j++) {
          for (const k of this.grid.get(cellKey(i, j)) || []) {
            if (k === except || seen.has(k)) continue;
            seen.add(k);
            if (within(this.segs[k].road, x, y, w)) return true;
          }
        }
      }
      return false;
    }

    // clearRise of seg as [s0, s1] along it.
    clearSpan(seg) {
      const road = this.segs[seg].road;
      return clearRise(this.spec, this.segs[seg].spec).map((r) => road.sAtRise(r));
    }

    distToLot(seg, s) {
      const road = this.segs[seg].road;
      return Math.max(0, road.length - s) + road.toLot;
    }

    // seg's own players, plus each player within LINK_R of a node seg shares with the player's segment, as a
    // record with s in seg's frame; a sibling that shares both nodes counts at the nearer one.
    racersNear(seg, players) {
      const me = this.segs[seg], len = me.road.length, L = me.links, out = [];
      for (const p of players) {
        if (p.seg === seg) { out.push(p); continue; }
        const pl = this.segs[p.seg].road.length, ways = [];
        if (L.next.includes(p.seg)) ways.push([p.s, len + p.s]);
        if (L.prev.includes(p.seg)) ways.push([pl - p.s, p.s - pl]);
        if (L.endSibs.includes(p.seg)) ways.push([pl - p.s, len - (pl - p.s)]);
        if (L.startSibs.includes(p.seg)) ways.push([p.s, p.s]);
        const near = ways.filter((w) => w[0] < MAP.LINK_R).sort((a, b) => a[0] - b[0])[0];
        if (near) out.push({ idx: p.idx, phase: p.phase, s: near[1], d: p.d, truck: p.truck });
      }
      return out;
    }

    // The segment itself plus, within NODE_R of either end, every segment that meets it at that node.
    candidates(seg, s) {
      const me = this.segs[seg], ids = new Set([seg]);
      const at = (v) => this.segs.forEach((o) => { if (o.spec.a === v || o.spec.b === v) ids.add(o.id); });
      if (s > me.road.length - MAP.NODE_R) at(me.spec.b);
      if (s < MAP.NODE_R) at(me.spec.a);
      return [...ids].sort((p, q) => p - q);
    }

    visible(view) {
      const out = [];
      for (const s of this.segs) {
        const b = s.road.bbox;
        if (b.x1 >= view.x0 - MAP.VIEW_PAD && b.x0 <= view.x1 + MAP.VIEW_PAD && b.y1 >= view.y0 - MAP.VIEW_PAD && b.y0 <= view.y1 + MAP.VIEW_PAD) out.push(s.id);
      }
      return out;
    }

    draw(ctx, view) {
      const shown = this.visible(view);
      for (const layer of TR.Road.LAYERS) for (const k of shown) this.segs[k].road.drawLayer(ctx, view, layer, this);
    }

    drawDepots(ctx, view, players, viewer) {
      for (const k of this.visible(view)) this.segs[k].road.drawDepots(ctx, view, players, viewer);
    }

    // The jams on seg at time, each with its span in s as s0, s1. Only its arguments decide it, so the guest's
    // lerped clock gives what the host had at that clock.
    jamsOn(seg, time) {
      const road = this.segs[seg].road;
      return this.spec.jams
        .filter((j) => j.seg === seg && RoadMap.jamOn(j, time))
        .map((j) => Object.assign({}, j, { s0: road.sAtRise(j.rise0), s1: road.sAtRise(j.rise1) }));
    }

    static jamOn(jam, time) {
      return jam.t0 <= time && time < jam.t1;
    }

    // cands are { seg, s, d, len, open }, d a lane offset; open lets a candidate run past its end (the lot
    // segment). The truck keeps cur while cur's asphalt holds it, whichever lane it drives. Else it takes the
    // segment whose asphalt holds it and whose northbound half's middle (LANE east of the centre line) is
    // nearest; off every asphalt, cur stays within hyst of the nearest.
    static pickSegment(cands, cur, hyst) {
      const ok = cands.filter((c) => c.s >= -MAP.PICK_TOL && (c.s <= c.len + MAP.PICK_TOL || c.open));
      if (!ok.length) return cur;
      const mine = ok.find((c) => c.seg === cur), on = ok.filter((c) => Math.abs(c.d) <= R.HALF);
      if (mine && on.includes(mine)) return cur;
      const pool = on.length ? on : ok;
      const off = (c) => Math.abs(c.d - R.LANE);
      const best = pool.reduce((b, c) => (off(c) < off(b) || (off(c) === off(b) && c.seg < b.seg) ? c : b));
      return mine && pool.includes(mine) && off(mine) <= off(best) + hyst ? cur : best.seg;
    }
  }

  TR.RoadMap = RoadMap;
})();
