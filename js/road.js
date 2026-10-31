'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;
  const DS = 8;
  const LANE = 54, HALF = 108, RAIL = 150;
  // MAX_DEV bounds the heading's deviation from north; END_FLAT is how far a segment runs straight north
  // out of each of its nodes.
  // A section's or point's sign stands SIGN_LEAD before it.
  const MAX_DEV = 1.1, END_FLAT = 1000, SIGN_LEAD = 350;
  TR.ROAD = { DS, LANE, HALF, RAIL, START_S: 700, START_LINE: 800, MAX_DEV, END_FLAT, SIGN_LEAD };

  // Road sections a route can carry over [s0, s1). rail is the barrier's (or wall's) distance from the
  // centre line and eases from RAIL over TAPER either side; grip scales the route's own grip. A narrow
  // road's rail stands just past the asphalt's edge, inside a bridge's.
  const TAPER = 160;
  const SECTIONS = (TR.SECTIONS = {
    bridge: { rail: HALF + 16, grip: 1, sign: 'KÖPRÜ', name: 'Köprü' },
    dirt: { rail: RAIL, grip: 0.65, sign: 'TOPRAK YOL', name: 'Toprak yol' },
    tunnel: { rail: HALF + 18, grip: 1, sign: 'TÜNEL', name: 'Tünel' },
    narrow: { rail: HALF + 8, grip: 1, sign: 'DAR YOL', name: 'Dar yol' },
  });
  const DIRT = '#a27c52', DECK = '#9aa0a6', ROCK = '#6d665e', WATER = '#2b86c5';
  // A distance-to-the-lot sign stands every PARK_SIGN along the road.
  const PARK_SIGN = 3000;
  // A rail post is dropped where it stands within RAIL + POST_GAP of another segment: negative, so posts on
  // a rail two coincident siblings share are kept.
  const POST_GAP = -4;
  // Where siblings overlap at a node the lowest-id one draws the lane markings; another's marking is dropped
  // within MARK_CLEAR of a lower sibling's centre line, so no second set runs beside the first.
  const MARK_CLEAR = HALF + LANE / 2;
  // A sign's box is sized without a canvas from SIGN_GLYPH, a bound on the advance of the bold 18px glyphs
  // its texts use, and SIGN_HH, its half height with the shadow; it stands SIGN_GAP clear of its own rail.
  const SIGN_GLYPH = 13, SIGN_GAP = 10, SIGN_HH = 18;

  // Junction geometry. A side road's asphalt reaches SIDE_HW either side of its centre line and its
  // barrier SIDE_RAIL; it runs SIDE_LEN out from the main road's centre. A ring's island has radius RING_R,
  // and the lanes swing out by RING_R around it over RING_LEN either side of its centre. A stop line sits
  // STOP_GAP before the edge of the road it guards; a ring's entries give way at RING_ENTRY from its centre.
  const JN = (TR.JUNCTION = {
    SIDE_HW: 62, SIDE_RAIL: 100, SIDE_LEN: 1400, RING_R: 120, RING_LEN: 270, STOP_GAP: 20, FLAT_RAMP: 900,
  });
  JN.RING_ENTRY = HALF + JN.RING_R + 12;

  // A depot is a dead-end side road to one side of a segment, a box waiting at its end. The side road's
  // barrier stands RAIL either side of its centre line, which leaves the main road square to its heading
  // and runs LEN out from its centre into a yard YARD_LEN deep and YARD_HW either side, where a truck turns
  // round to back onto a ramp. Two ramps of TR.LOT.BAY_W stand on the yard's far wall, DOCK_OFF either side
  // of its centre line, each a platform RAMP_D deep past the wall. A depot keeps the main road's shape: no
  // flat as at a junction, so adding a depot leaves its segment's road where it was.
  const DEPOT = (TR.DEPOT = { RAIL: JN.SIDE_RAIL, LEN: 600, YARD_HW: 150, YARD_LEN: 500, DOCK_OFF: 45, RAMP_D: 120 });
  const DEPOT_FAR = DEPOT.LEN + DEPOT.YARD_LEN;
  // A depot's ground in its own frame (u out from the main road's centre line, v along the road), inside
  // its barrier: the side road and the yard, each as [u0, u1, half width]. Within DEPOT_REACH of it a point
  // is held by the depot's barrier.
  const DEPOT_BOXES = [[0, DEPOT.LEN, DEPOT.RAIL], [DEPOT.LEN, DEPOT_FAR, DEPOT.YARD_HW]];
  const DEPOT_REACH = 200;
  // Player 0's ramp is on the left of a truck driving in, as its bay is in the lot.
  const rampV = (dp, idx) => (idx ? -1 : 1) * dp.dir * DEPOT.DOCK_OFF;
  const YARD = '#585c61', BOX_SIGN = '#5d4037';

  // Point features a route carries at s. A junction (flat > 0) keeps the road running straight north for
  // flat either side of s, easing back into its bends over FLAT_RAMP, so its geometry is drawn and checked
  // against a straight line. kmh is the speed its sign shows and full assist holds from cap[0] before s
  // to cap[1] after it; a radar brings its own kmh. Roadside props keep clear of s by clear.
  const POINTS = (TR.POINTS = {
    cross: { flat: 420, side: true, sign: 'KAVŞAK', name: 'Dört yol ağzı', clear: JN.SIDE_RAIL + 40 },
    ring: {
      flat: 520, side: true, sign: 'DÖNEL KAVŞAK', name: 'Döner kavşak', clear: JN.RING_LEN + 40,
      kmh: 45, cap: [JN.RING_LEN, JN.RING_LEN],
    },
    toll: { flat: 380, sign: 'GİŞE', name: 'Gişe', clear: 140, kmh: 40, cap: [220, 30] },
    radar: { flat: 0, sign: 'RADAR', name: 'Radar', clear: 60, cap: [260, 10] },
  });
  TR.featureName = (f) => (SECTIONS[f.type] || POINTS[f.type]).name;

  // tight scales the bend wavelength (lower is sharper), grip scales the truck's cornering
  // and braking, onSpeed scales oncoming car speed. level is the 1-5 shown on the route card. mapRecipe
  // draws the round's network (js/map.js): braid count, alternatives per braid and the widest detour.
  TR.ROUTES = [
    {
      id: 'sahil', name: 'Sahil Yolu', tag: 'Yoğun trafik', level: 3,
      desc: 'Deniz kenarında kıvrımlı yollar. Kalabalık yolda iki yönde de araç dolu, sollamak için boşluk kollayın. Kestirme kısadır ama bir bedeli vardır.',
      length: 48000, curvy: 0.8, tight: 0.75, same: 22, oncoming: 18, seed: 1907,
      mapRecipe: { braids: [3, 3], alts: [2, 3], spread: 2200 },
      theme: { grass: '#8db650', patch: '#7fa647', decor: 'palm', density: 0.55, sea: true },
      features: [{ type: 'toll', s: 4500 }, { type: 'bridge', s0: 9000, s1: 10400 }, { type: 'radar', s: 16500, kmh: 70 }],
    },
    {
      id: 'ova', name: 'Ova Yolu', tag: 'Uzun ve kalabalık', level: 3,
      desc: 'Uzun ve bol çatallı bir yol ağı. Yavaş kamyon ve otobüs kuyrukları var: ya karşı şeride çıkın ya da sakin bir yola sapın.',
      length: 68000, curvy: 0.6, tight: 0.8, same: 30, oncoming: 22, seed: 777,
      mapRecipe: { braids: [3, 4], alts: [2, 3], spread: 2400 },
      theme: { grass: '#a8c45c', patch: '#99b553', decor: 'field', density: 0.5 },
      features: [{ type: 'cross', s: 7400 }, { type: 'toll', s: 12400 }, { type: 'dirt', s0: 15000, s1: 17600 }, { type: 'ring', s: 25600 }],
    },
    {
      id: 'col', name: 'Çöl Yolu', tag: 'Hızlı karşı trafik', level: 4,
      desc: 'Karşıdan gelenler çok hızlı. Virajın ardını görmeden sollamaya kalkmayın. Kestirmede toprak yol ya da radar çıkabilir.',
      length: 60000, curvy: 0.9, tight: 0.5, same: 14, oncoming: 22, onSpeed: 1.3, seed: 3131,
      mapRecipe: { braids: [3, 4], alts: [2, 3], spread: 2400 },
      theme: { grass: '#d8c08c', patch: '#ccb27a', shoulder: '#c2a878', decor: 'cactus', density: 0.4 },
      features: [
        { type: 'radar', s: 5200, kmh: 70 }, { type: 'dirt', s0: 8200, s1: 10400 }, { type: 'cross', s: 13600 },
        { type: 'radar', s: 18800, kmh: 70 }, { type: 'dirt', s0: 21400, s1: 23200 },
      ],
    },
    {
      id: 'kar', name: 'Karlı Geçit', tag: 'Buzlu yol', level: 5,
      desc: 'Yollar buzlu: tır virajda daha az döner, fren daha geç tutar. Her çatalda iki yol var, kestirmenin virajları daha sert olabilir.',
      length: 48000, curvy: 1.0, tight: 0.5, grip: 0.6, same: 12, oncoming: 16, seed: 1212,
      mapRecipe: { braids: [3, 3], alts: [2, 2], spread: 2000 },
      theme: { grass: '#e9eff3', patch: '#dbe4ea', shoulder: '#c9d2d8', asphalt: '#4d545b', decor: 'snowpine', density: 0.75 },
      features: [{ type: 'tunnel', s0: 7000, s1: 8800 }, { type: 'bridge', s0: 14500, s1: 15600 }],
    },
    {
      id: 'dag', name: 'Dağ Geçidi', tag: 'Keskin virajlar', level: 5,
      desc: 'Arka arkaya dar virajlar. Bazılarını tam gazla dönemezsiniz, karşı trafik de yoğun. Kestirme yolu kısaltır ama daha dar ya da daha kıvrımlı olabilir.',
      length: 52000, curvy: 1.2, tight: 0.35, same: 12, oncoming: 20, seed: 4242,
      mapRecipe: { braids: [3, 3], alts: [2, 3], spread: 2000 },
      theme: { grass: '#6f8a43', patch: '#62793b', decor: 'pine', density: 0.8 },
      features: [
        { type: 'tunnel', s0: 5200, s1: 6800 }, { type: 'bridge', s0: 11500, s1: 12400 }, { type: 'tunnel', s0: 17500, s1: 19300 },
      ],
    },
  ];

  function makeWaves(seed, curvy, tight) {
    const rnd = U.rng(seed);
    const waves = [];
    for (let k = 0; k < 4; k++) {
      waves.push({ amp: curvy * rnd.range(0.14, 0.34), len: rnd.range(1600, 5200) * (tight || 1), ph: rnd.range(0, 6.283) });
    }
    return waves;
  }

  class Road {
    // One network segment from node seg.a to node seg.b, its features placed by rise.
    constructor(route, seg) {
      this.route = route;
      this.theme = route.theme;
      this.seg = seg;
      this.isStart = !!seg.isStart;
      this.atLot = !!seg.atLot;
      this.toLot = 0;
      this.fromSeg(seg);
      const { xs, ys, n } = this;
      this.sides = this.points.filter((j) => POINTS[j.type].side);
      this.rings = this.points.filter((j) => j.type === 'ring');
      this.length = (n - 1) * DS;
      this.endX = xs[n - 1];
      this.endY = ys[n - 1];
      const bbox = (this.bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      for (let i = 0; i < n; i++) {
        bbox.x0 = Math.min(bbox.x0, xs[i]); bbox.x1 = Math.max(bbox.x1, xs[i]);
        bbox.y0 = Math.min(bbox.y0, ys[i]); bbox.y1 = Math.max(bbox.y1, ys[i]);
      }
      // Roadside signs other modules add, as {s, text, bg}; drawn on the right of the northbound lanes.
      this.signList = [];
      for (const sec of this.sections) this.signList.push({ s: sec.s0 - SIGN_LEAD, text: SECTIONS[sec.type].sign, bg: '#37474f' });
      for (const j of this.points) {
        const c = this.posAt(j.s, 0), kmh = j.kmh || POINTS[j.type].kmh;
        j.x = c.x; j.y = c.y;
        this.signList.push({ s: j.s - SIGN_LEAD, text: POINTS[j.type].sign + (kmh ? ' · ' + kmh + ' km/s' : ''), bg: j.type === 'radar' ? '#c62828' : '#37474f' });
      }
      this.depots = (seg.features || []).filter((f) => f.type === 'depot').map((f) => this.depotOf(f));
      for (const dp of this.depots) this.signList.push(Road.boxSign(dp.s - SIGN_LEAD, [dp.box], dp.dir > 0 ? '→' : '←'));
    }

    // The sign for boxes down the way the arrow shows.
    static boxSign(s, boxes, arrow) {
      return { s, text: 'KUTU ' + boxes.map((b) => TR.BOXES[b].label).join(' ') + ' ' + arrow, bg: BOX_SIGN };
    }

    // Depot f in world terms: (x, y) where its side road leaves the centre line, (ox, oy) the unit vector
    // out along the side road and (ax, ay) the one along the main road, square to the road's heading there.
    // mouth is where the side road crosses the main road's barrier, yard the yard's middle and ramps[idx]
    // the middle of player idx's ramp face on the far wall.
    depotOf(f) {
      const y = this.ys[0] - f.rise, s = this.sAtRise(f.rise), x = this.posAt(s, 0).x, h = this.hs[this.indexForY(y)];
      const dp = { box: f.box, dir: f.dir, s, x, y, ox: -Math.sin(h) * f.dir, oy: Math.cos(h) * f.dir, ax: Math.cos(h), ay: Math.sin(h) };
      dp.mouth = Road.depotXY(dp, RAIL, 0);
      dp.yard = Road.depotXY(dp, DEPOT.LEN + DEPOT.YARD_LEN / 2, 0);
      dp.ramps = [0, 1].map((idx) => Road.depotXY(dp, DEPOT_FAR, rampV(dp, idx)));
      return dp;
    }

    static depotXY(dp, u, v) {
      return { x: dp.x + dp.ox * u + dp.ax * v, y: dp.y + dp.oy * u + dp.ay * v };
    }

    static depotUV(dp, x, y) {
      const dx = x - dp.x, dy = y - dp.y;
      return { u: dx * dp.ox + dy * dp.oy, v: dx * dp.ax + dy * dp.ay };
    }

    // Player idx's ramp platform in dp's frame, where its worker walks and its boxes at this depot stand.
    static rampFloor(dp, idx) {
      const v = rampV(dp, idx), hw = TR.LOT.BAY_W / 2;
      return { u0: DEPOT_FAR, u1: DEPOT_FAR + DEPOT.RAMP_D, v0: v - hw, v1: v + hw };
    }

    // The box waiting on player idx's ramp before the round starts.
    static rampBox(dp, idx) {
      const f = Road.rampFloor(dp, idx);
      return Object.assign({ id: dp.box }, Road.depotXY(dp, (f.u0 + f.u1) / 2, (f.v0 + f.v1) / 2));
    }

    // Lot.parkStatus for player idx's ramp at dp: the trailer backed into the bay in front of the ramp, its
    // door at the face.
    static rampStatus(dp, truck, idx) {
      const L = TR.LOT, f = Road.rampFloor(dp, idx), at = (q) => Road.depotUV(dp, q.x, q.y);
      const inside = U.corners(truck.trailerBox()).map(at).every((q) => q.u >= f.u0 - L.BAY_D && q.u <= f.u0 + 3 && q.v >= f.v0 - 1 && q.v <= f.v1 + 1);
      const rear = at(truck.trailerRear());
      const rearDist = Math.max(0, f.u0 - rear.u);
      const angleErr = (Math.abs(U.wrap(truck.phi - Math.atan2(-dp.oy, -dp.ox))) * 180) / Math.PI;
      const lateral = rear.v - (f.v0 + f.v1) / 2;
      const ok = inside && rearDist < L.REAR_TOL && angleErr < L.ANGLE_TOL && Math.abs(truck.v) < L.STOP_TOL;
      return { inside, rearDist, angleErr, lateral, ok };
    }

    // The depot whose ground, from u = from out, holds (x, y) within margin; null outside every depot.
    depotAt(x, y, margin = 0, from = 0) {
      for (const dp of this.depots) {
        const { u, v } = Road.depotUV(dp, x, y);
        if (DEPOT_BOXES.some(([u0, u1, hw]) => u >= Math.max(u0, from) - margin && u <= u1 + margin && Math.abs(v) <= hw + margin)) return dp;
      }
      return null;
    }

    // The push that brings a point back onto a depot's ground or the main road beside it, as Junctions.limit
    // gives it: undefined away from every depot and on the main road's far side, null where the point is fine.
    depotLimit(x, y) {
      for (const dp of this.depots) {
        const { u, v } = Road.depotUV(dp, x, y);
        if (u < 0 || u > DEPOT_FAR + DEPOT_REACH || Math.abs(v) > DEPOT.YARD_HW + DEPOT_REACH) continue;
        const c = this.locate(x, y, -1), sn = Math.sign(c.d);
        let best = { over: Math.abs(c.d) - this.railAt(c.s), nx: -this.nx[c.i] * sn, ny: -this.ny[c.i] * sn };
        if (best.over <= 0) return null;
        for (const [u0, u1, hw] of DEPOT_BOXES) {
          const du = U.clamp(u, u0, u1) - u, dv = U.clamp(v, -hw, hw) - v, over = Math.hypot(du, dv);
          if (!over) return null;
          if (over < best.over) best = { over, nx: (du * dp.ox + dv * dp.ax) / over, ny: (du * dp.oy + dv * dp.ay) / over };
        }
        return best;
      }
      return undefined;
    }

    fromSeg(seg) {
      const features = seg.features || [];
      const points = features.filter((f) => POINTS[f.type]).map((f) => Object.assign({}, f));
      const flats = points.filter((j) => POINTS[j.type].flat).map((j) => ({ rise: j.rise, half: POINTS[j.type].flat }));
      const t = Road.trace(seg.a, seg.b, { detour: seg.detour, curvy: seg.curvy, tight: seg.tight, wseed: seg.wseed, flats, endFlat: END_FLAT });
      Object.assign(this, { n: t.n, xs: t.xs, ys: t.ys, hs: t.hs, nx: t.nx, ny: t.ny });
      this.points = points;
      for (const j of points) j.s = this.sAtRise(j.rise);
      this.sections = features.filter((f) => SECTIONS[f.type]).map((f) => Object.assign({}, f, { s0: this.sAtRise(f.rise0), s1: this.sAtRise(f.rise1) }));
    }

    // The centre line from a to b (b north of a) as a lateral offset over rise: a shift from a.x to b.x,
    // a detour bump and the wobble waves, all held at zero slope within endFlat of either end and within
    // each flat window, so the heading is exactly north there. Resampled to n evenly spaced points.
    static trace(a, b, opts) {
      const R = a.y - b.y, detour = opts.detour || 0, ef = opts.endFlat || 0, flats = opts.flats || [];
      const waves = makeWaves(opts.wseed, opts.curvy || 0, opts.tight);
      const ramp = (r) => {
        let v = U.smooth((r - ef) / JN.FLAT_RAMP) * U.smooth((R - ef - r) / JN.FLAT_RAMP);
        for (const f of flats) v *= U.smooth((Math.abs(r - f.rise) - f.half) / JN.FLAT_RAMP);
        return v;
      };
      const wob = (r) => {
        let v = 0;
        for (const w of waves) v += w.amp * Math.sin((r / w.len) * 6.283 + w.ph);
        return v;
      };
      // A fine grid over rise: tau is the ramp's running integral scaled to 0..1, so it stands still
      // wherever the ramp is zero and the base shift and bump, written in tau, add no slope there.
      const m = Math.max(1, Math.ceil(R / (DS / 4))), dr = R / m;
      const cumR = new Float64Array(m + 1), cumW = new Float64Array(m + 1), gx = new Float64Array(m + 1), arc = new Float64Array(m + 1);
      let g0 = ramp(0), w0 = g0 * wob(0);
      for (let k = 1; k <= m; k++) {
        const r = k === m ? R : k * dr, g = ramp(r), w = g * wob(r);
        cumR[k] = cumR[k - 1] + ((g0 + g) * dr) / 2;
        cumW[k] = cumW[k - 1] + ((w0 + w) * dr) / 2;
        g0 = g; w0 = w;
      }
      const RR = cumR[m], shift = b.x - a.x - cumW[m];
      const tauAt = (k) => cumR[k] / RR;
      for (let k = 0; k <= m; k++) {
        const tau = tauAt(k), sb = Math.sin(Math.PI * tau);
        gx[k] = a.x + cumW[k] + shift * tau + detour * sb * sb;
        if (k) arc[k] = arc[k - 1] + Math.hypot(dr, gx[k] - gx[k - 1]);
      }
      const L = arc[m], n = Math.round(L / DS) + 1, sp = L / (n - 1);
      const xs = new Float64Array(n), ys = new Float64Array(n), hs = new Float64Array(n);
      const nx = new Float64Array(n), ny = new Float64Array(n);
      let maxDev = 0;
      for (let i = 0, k = 1; i < n; i++) {
        let r, x, tau;
        if (i === 0) { r = 0; x = a.x; tau = 0; }
        else if (i === n - 1) { r = R; x = b.x; tau = 1; }
        else {
          const target = i * sp;
          while (arc[k] < target) k++;
          const f = (target - arc[k - 1]) / (arc[k] - arc[k - 1]);
          r = (k - 1 + f) * dr;
          x = U.lerp(gx[k - 1], gx[k], f);
          tau = U.lerp(tauAt(k - 1), tauAt(k), f);
        }
        const g = ramp(r);
        const slope = g * wob(r) + (g / RR) * (shift + detour * Math.PI * Math.sin(2 * Math.PI * tau));
        const dev = Math.atan(slope), h = -Math.PI / 2 + dev;
        maxDev = Math.max(maxDev, Math.abs(dev));
        xs[i] = x; ys[i] = a.y - r; hs[i] = h;
        nx[i] = -Math.sin(h); ny[i] = Math.cos(h);
      }
      return { n, xs, ys, hs, nx, ny, length: (n - 1) * DS, maxDev };
    }

    // The s at which the centre line stands rise north of its first sample.
    sAtRise(rise) {
      const y = this.ys[0] - rise, i = this.indexForY(y);
      if (i === 0) return 0;
      const y0 = this.ys[i - 1], y1 = this.ys[i];
      return (i - 1 + (y0 - y) / (y0 - y1)) * DS;
    }

    // How far the lanes swing out from the centre line at s to clear a ring's island.
    bulgeAt(s) {
      let b = 0;
      for (const j of this.rings) {
        const u = Math.abs(s - j.s) / JN.RING_LEN;
        if (u < 1) b += (JN.RING_R * (1 + Math.cos(Math.PI * u))) / 2;
      }
      return b;
    }

    // Where a lane at offset d from the centre line runs at s, swung out around a ring, with its heading.
    lanePos(s, d) {
      const b = this.bulgeAt(s);
      if (!b || !d) return this.posAt(s, d);
      const k = Math.sign(d), p = this.posAt(s, d + k * b);
      p.h += k * Math.atan((this.bulgeAt(s + 1) - this.bulgeAt(s - 1)) / 2);
      return p;
    }

    // The lane offset of a point d from the centre line: the inverse of the swing lanePos adds.
    laneD(s, d) {
      return Math.sign(d) * Math.max(0, Math.abs(d) - this.bulgeAt(s));
    }

    // World length per unit of s along the lane at offset d: posAt moves 1 - d * dh/ds per unit of s there,
    // so a lane on the inside of a bend is shorter than its s.
    stretchAt(s, d) {
      return 1 - (d * (this.headingAt(s + DS) - this.headingAt(s - DS))) / (2 * DS);
    }

    // The visible samples with the stretch within half of a side road's centre cut out, as separate runs.
    cut(list, half, type) {
      const js = this.sides.filter((j) => !type || j.type === type);
      if (!js.length) return [list];
      return this.split(list, (s) => js.some((j) => Math.abs(s - j.s) < half));
    }

    // The runs of lists with every sample whose point at offset d lies in a depot's mouth cut out. The cut
    // goes by the drawn point, not by s: on a bend a line off the centre runs shorter or longer than s.
    depotCut(lists, d, half) {
      if (!this.depots.length) return lists;
      return lists.flatMap((l) => this.split(l, (s) => this.inMouth(this.posAt(s, d(s)), half)));
    }

    // Whether p lies on a depot's side of the main road, no farther out than its side road and within half
    // of its centre line.
    inMouth(p, half) {
      return this.depots.some((dp) => {
        const { u, v } = Road.depotUV(dp, p.x, p.y);
        return u >= 0 && u <= DEPOT.LEN && Math.abs(v) < half;
      });
    }

    split(list, gone) {
      const out = [[]];
      for (const s of list) {
        if (gone(s)) {
          if (out[out.length - 1].length) out.push([]);
        } else out[out.length - 1].push(s);
      }
      return out.filter((l) => l.length > 1);
    }

    sectionAt(s) {
      return this.sections.find((sec) => s >= sec.s0 && s < sec.s1) || null;
    }

    gripAt(s) {
      const sec = this.sectionAt(s);
      return sec ? SECTIONS[sec.type].grip : 1;
    }

    dirtAt(s) {
      const sec = this.sectionAt(s);
      return !!sec && sec.type === 'dirt';
    }

    railAt(s) {
      let r = RAIL;
      for (const sec of this.sections) {
        const into = Math.min(s - sec.s0 + TAPER, sec.s1 + TAPER - s);
        if (into > 0) r = Math.min(r, U.lerp(RAIL, SECTIONS[sec.type].rail, Math.min(1, into / TAPER)));
      }
      return r;
    }

    // Bridges and tunnels cover the roadside (water, rock), so roadside props skip them.
    coveredAt(s) {
      return this.sections.some((sec) => sec.type !== 'dirt' && sec.type !== 'narrow' && s > sec.s0 - TAPER && s < sec.s1 + TAPER);
    }

    indexForY(y) {
      let lo = 0, hi = this.n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.ys[mid] <= y) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }

    locate(x, y, hint) {
      const { xs, ys, n } = this;
      const useHint = hint != null && hint >= 0;
      const c = useHint ? hint : this.indexForY(y);
      const w = useHint ? 24 : 110;
      const a = Math.max(0, c - w), b = Math.min(n - 1, c + w);
      let best = Infinity, bi = c;
      for (let i = a; i <= b; i++) {
        const dx = x - xs[i], dy = y - ys[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bi = i; }
      }
      if (useHint && ((bi === a && a > 0) || (bi === b && b < n - 1))) return this.locate(x, y, -1);
      const h = this.hs[bi];
      const dx = x - xs[bi], dy = y - ys[bi];
      const t = dx * Math.cos(h) + dy * Math.sin(h);
      return { i: bi, s: bi * DS + t, d: dx * this.nx[bi] + dy * this.ny[bi], h };
    }

    headingAt(s) {
      if (s <= 0) return this.hs[0];
      if (s >= this.length) return this.hs[this.n - 1];
      const f = s / DS, i = Math.floor(f);
      return U.lerp(this.hs[i], this.hs[i + 1], f - i);
    }

    posAt(s, d) {
      const { xs, ys, n } = this;
      let x, y, h;
      if (s <= 0) {
        h = this.hs[0];
        x = xs[0] + Math.cos(h) * s;
        y = ys[0] + Math.sin(h) * s;
      } else if (s >= this.length) {
        h = this.hs[n - 1];
        x = this.endX + Math.cos(h) * (s - this.length);
        y = this.endY + Math.sin(h) * (s - this.length);
      } else {
        const f = s / DS, i = Math.floor(f), t = f - i;
        x = U.lerp(xs[i], xs[i + 1], t);
        y = U.lerp(ys[i], ys[i + 1], t);
        h = U.lerp(this.hs[i], this.hs[i + 1], t);
      }
      return { x: x - Math.sin(h) * d, y: y + Math.cos(h) * d, h };
    }

    // ---------- drawing ----------
    sampleList(view) {
      const i0 = Math.max(0, this.indexForY(view.y1 + 500) - 2);
      const i1 = Math.min(this.n - 1, this.indexForY(view.y0 - 500) + 2);
      const list = [];
      if (i0 === 0 && this.isStart) list.push(-1600, -800);
      for (let i = i0; i <= i1; i++) list.push(i * DS);
      return { list, i0, i1 };
    }

    // d is a fixed offset from the centre line or a function of s.
    edge(list, d, out, reverse) {
      const pts = reverse ? list.slice().reverse() : list;
      for (const s of pts) {
        const p = this.posAt(s, typeof d === 'function' ? d(s) : d);
        out.push(p.x, p.y);
      }
      return out;
    }

    // Splits the visible samples into runs of one section type (null between sections). Neighbouring
    // runs share their boundary sample so the bands meet without a gap.
    runs(list) {
      const out = [];
      let cur = null;
      for (const s of list) {
        const sec = this.sectionAt(s);
        if (!cur || cur.sec !== sec) {
          if (cur) cur.list.push(s);
          cur = { sec, type: sec ? sec.type : null, list: [s] };
          out.push(cur);
        } else cur.list.push(s);
      }
      return out.filter((r) => r.list.length > 1);
    }

    band(ctx, list, d0, d1, color) {
      const pts = this.edge(list, d0, [], false);
      this.edge(list, d1, pts, true);
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    line(ctx, list, d, color, width, dash) {
      ctx.beginPath();
      let first = true;
      for (const s of list) {
        const p = this.posAt(s, typeof d === 'function' ? d(s) : d);
        if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) {
        ctx.setLineDash(dash);
        ctx.lineDashOffset = list[0];
      }
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    }

    // The samples of list whose point at offset d lies more than w from the centre line of every other
    // segment (with lower, of every lower-id one) that shares a node with this one, as separate runs.
    clip(list, d, map, w, lower) {
      const out = [[]];
      for (const s of list) {
        const p = this.posAt(s, typeof d === 'function' ? d(s) : d);
        if (map.covered(this.seg.id, p.x, p.y, w, lower)) {
          if (out[out.length - 1].length) out.push([]);
        } else out[out.length - 1].push(s);
      }
      return out.filter((l) => l.length > 1);
    }

    drawLayer(ctx, view, layer, map) {
      const { list, i0, i1 } = this.sampleList(view);
      if (list.length < 2) return;
      const th = this.theme, asphalt = th.asphalt || '#44474c';
      const runs = this.runs(list);
      const sides = this.sides.filter((j) => j.y > view.y0 - 300 && j.y < view.y1 + 300);
      const depots = this.depotsIn(view);
      const rail = (k, extra) => (s) => k * (this.railAt(s) + this.bulgeAt(s) + extra);
      const off = (d) => (s) => d + Math.sign(d) * this.bulgeAt(s);
      const lines = (lists, d, color, width, dash, mark) => {
        for (const l of lists) for (const c of this.clip(l, d, map, mark ? MARK_CLEAR : HALF, mark)) this.line(ctx, c, d, color, width, dash);
      };
      if (layer === 'under') {
        if (th.sea && map.segs[this.seg.id].coast) this.drawSea(ctx, list, view);
        for (const r of runs) {
          if (r.type === 'bridge') this.drawUnderBridge(ctx, r.list);
          if (r.type === 'tunnel') this.band(ctx, r.list, -RAIL - 260, RAIL + 260, ROCK);
        }
      } else if (layer === 'ground') {
        // A side road's shoulder goes under the main road and its asphalt over it, so the two meet flush.
        for (const j of sides) this.sideBand(ctx, j, JN.SIDE_RAIL + 8, th.shoulder || '#a89a7c');
        for (const dp of depots) {
          this.depotRect(ctx, dp, 0, DEPOT.LEN, -DEPOT.RAIL - 8, DEPOT.RAIL + 8, th.shoulder || '#a89a7c');
          this.depotRect(ctx, dp, DEPOT.LEN, DEPOT_FAR + 8, -DEPOT.YARD_HW - 8, DEPOT.YARD_HW + 8, th.shoulder || '#a89a7c');
        }
        for (const r of runs) {
          const ground = r.type === 'bridge' ? DECK : r.type === 'tunnel' ? '#55595e' : th.shoulder || '#a89a7c';
          this.band(ctx, r.list, rail(-1, 8), rail(1, 8), ground);
        }
      } else if (layer === 'asphalt') {
        for (const r of runs) this.band(ctx, r.list, off(-HALF - 6), off(HALF + 6), r.type === 'dirt' ? DIRT : asphalt);
        for (const j of sides) this.sideBand(ctx, j, JN.SIDE_HW, asphalt);
        for (const dp of depots) {
          this.depotRect(ctx, dp, 0, DEPOT.LEN, -JN.SIDE_HW, JN.SIDE_HW, asphalt);
          this.depotRect(ctx, dp, DEPOT.LEN, DEPOT_FAR, -DEPOT.YARD_HW, DEPOT.YARD_HW, YARD);
        }
      } else if (layer === 'marks') {
        for (const r of runs) {
          if (r.type === 'dirt') {
            this.line(ctx, r.list, -LANE, 'rgba(90,62,35,0.35)', 10);
            this.line(ctx, r.list, LANE, 'rgba(90,62,35,0.35)', 10);
            continue;
          }
          const all = this.cut(r.list, JN.SIDE_HW), cross = this.cut(r.list, JN.SIDE_HW, 'cross');
          lines(this.depotCut(all, off(-HALF + 2), JN.SIDE_HW), off(-HALF + 2), '#f2f2f2', 3, null, true);
          lines(this.depotCut(all, off(HALF - 2), JN.SIDE_HW), off(HALF - 2), '#f2f2f2', 3, null, true);
          lines(cross, off(-LANE), '#e8e8e8', 2.5, [26, 34], true);
          lines(cross, off(LANE), '#e8e8e8', 2.5, [26, 34], true);
          lines(cross, off(-2.5), '#f0c419', 2.5, [40, 20], true);
          lines(cross, off(2.5), '#f0c419', 2.5, [40, 20], true);
        }
        for (const j of sides) this.drawJunction(ctx, j);
        for (const dp of depots) {
          for (const v of [-JN.SIDE_HW + 2, JN.SIDE_HW - 2]) this.depotLine(ctx, dp, [[HALF, v], [DEPOT.LEN, v]], '#f2f2f2', 3);
        }
      } else if (layer === 'rails') {
        for (const r of runs) {
          if (r.type === 'tunnel') {
            this.line(ctx, r.list, rail(-1, 4), '#2f3237', 10);
            this.line(ctx, r.list, rail(1, 4), '#2f3237', 10);
            this.drawPortal(ctx, r.sec.s0);
            this.drawPortal(ctx, r.sec.s1);
          } else {
            const bridge = r.type === 'bridge', cut = this.cut(r.list, JN.SIDE_RAIL);
            lines(this.depotCut(cut, rail(-1, 0), DEPOT.RAIL), rail(-1, 0), bridge ? '#cfd8dc' : '#9aa3ab', bridge ? 6 : 4);
            lines(this.depotCut(cut, rail(1, 0), DEPOT.RAIL), rail(1, 0), bridge ? '#cfd8dc' : '#9aa3ab', bridge ? 6 : 4);
          }
        }
        for (const dp of depots) {
          const [S, Y] = [DEPOT.RAIL, DEPOT.YARD_HW];
          this.depotLine(ctx, dp, [[RAIL, S], [DEPOT.LEN, S], [DEPOT.LEN, Y], [DEPOT_FAR, Y], [DEPOT_FAR, -Y], [DEPOT.LEN, -Y], [DEPOT.LEN, -S], [RAIL, -S]], '#9aa3ab', 4);
        }
        for (const j of sides) {
          for (const k of [-1, 1]) {
            const x0 = j.x + k * (RAIL + this.bulgeAt(j.s + JN.SIDE_RAIL)), x1 = j.x + k * JN.SIDE_LEN;
            for (const y of [j.y - JN.SIDE_RAIL, j.y + JN.SIDE_RAIL]) this.segment(ctx, x0, y, x1, y, '#9aa3ab', 4);
          }
        }
        this.drawPosts(ctx, i0, i1, map);
      } else if (layer === 'props') {
        for (const j of this.points) if (j.y > view.y0 - 300 && j.y < view.y1 + 300) this.drawPoint(ctx, j);
        if (this.isStart) this.drawStart(ctx);
        this.drawSigns(ctx, i0, i1, map);
        this.drawDecor(ctx, i0, i1, map);
      }
    }

    drawSea(ctx, list, view) {
      const pts = this.edge(list, -470, [], false);
      const yTop = pts[pts.length - 1], yBot = pts[1];
      const xFar = view.x0 - 3000;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.lineTo(xFar, yTop);
      ctx.lineTo(xFar, yBot);
      ctx.closePath();
      ctx.fillStyle = '#2b86c5';
      ctx.fill();
      this.band(ctx, list, -470, -330, '#e6d59a');
      this.line(ctx, list, -500, 'rgba(255,255,255,0.55)', 3, [60, 90]);
      this.line(ctx, list, -560, 'rgba(255,255,255,0.3)', 2, [40, 120]);
    }

    // Water under the deck, with the deck's shadow and its piers falling south-east like every other shadow.
    drawUnderBridge(ctx, list) {
      this.band(ctx, list, -RAIL - 300, RAIL + 300, WATER);
      this.line(ctx, list, -RAIL - 120, 'rgba(255,255,255,0.35)', 3, [50, 110]);
      this.line(ctx, list, RAIL + 140, 'rgba(255,255,255,0.3)', 3, [40, 130]);
      ctx.save();
      ctx.translate(14, 18);
      this.band(ctx, list, (s) => -this.railAt(s) - 8, (s) => this.railAt(s) + 8, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      for (const s of list) {
        if (s % 200 !== 0) continue;
        const a = this.posAt(s, -this.railAt(s) - 20), b = this.posAt(s, this.railAt(s) + 20);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 9); ctx.lineTo(b.x, b.y - 9); ctx.lineTo(b.x, b.y + 9); ctx.lineTo(a.x, a.y + 9);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    sideBand(ctx, j, hw, color) {
      ctx.fillStyle = color;
      ctx.fillRect(j.x - JN.SIDE_LEN, j.y - hw, JN.SIDE_LEN * 2, hw * 2);
    }

    depotsIn(view) {
      const reach = DEPOT_FAR + DEPOT.YARD_HW + 300;
      return this.depots.filter((dp) => dp.y > view.y0 - reach && dp.y < view.y1 + reach);
    }

    // Depot shapes are given in dp's frame, (u, v) as depotUV gives them, and drawn through world points:
    // the draw-log tests read a path's points as world coordinates.
    depotPath(ctx, dp, pts) {
      ctx.beginPath();
      pts.forEach(([u, v], k) => {
        const q = Road.depotXY(dp, u, v);
        if (k) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
    }

    depotRect(ctx, dp, u0, u1, v0, v1, color) {
      this.depotPath(ctx, dp, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    depotLine(ctx, dp, pts, color, width) {
      this.depotPath(ctx, dp, pts);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    // Each depot's two ramps in their players' colours, a bay marked out in front of each as in the lot,
    // and the boxes standing on the viewer's own ramp.
    drawDepots(ctx, view, players, viewer) {
      const bd = TR.LOT.BAY_D;
      for (const dp of this.depotsIn(view)) {
        for (const p of players) {
          const f = Road.rampFloor(dp, p.idx);
          this.depotRect(ctx, dp, f.u0, f.u1, f.v0, f.v1, U.shade(p.color, -0.2));
          for (const e of [f.v0, f.v1]) this.depotLine(ctx, dp, [[f.u0, e], [f.u0 - bd, e]], p.color, 5);
        }
        for (const b of viewer.ground[dp.box]) TR.drawBoxStacked(ctx, b.x, b.y, b.id, 0, 30);
      }
    }

    segment(ctx, x0, y0, x1, y1, color, width, dash) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    }

    // Side road markings from where the main road's asphalt ends, then the crossing's stop lines or the
    // ring's give-way lines and island. The road runs straight north here, so offsets are plain x and y.
    drawJunction(ctx, j) {
      const edge = (u) => HALF + this.bulgeAt(j.s + u);
      for (const k of [-1, 1]) {
        const far = j.x + k * JN.SIDE_LEN;
        for (const u of [-JN.SIDE_HW + 2, JN.SIDE_HW - 2]) this.segment(ctx, j.x + k * edge(u), j.y + u, far, j.y + u, '#f2f2f2', 3);
        this.segment(ctx, j.x + k * edge(0), j.y, far, j.y, '#f0c419', 2.5, [40, 20]);
      }
      if (j.type === 'cross') {
        const su = JN.SIDE_HW + JN.STOP_GAP, sx = HALF + JN.STOP_GAP;
        for (const k of [-1, 1]) {
          this.segment(ctx, j.x + k * 2, j.y + k * su, j.x + k * (HALF - 4), j.y + k * su, '#fafafa', 6);
          this.segment(ctx, j.x - k * sx, j.y + k * 2, j.x - k * sx, j.y + k * (JN.SIDE_HW - 4), '#fafafa', 6);
        }
        return;
      }
      for (const k of [-1, 1]) {
        const x = j.x + k * JN.RING_ENTRY;
        this.segment(ctx, x, j.y - k * 2, x, j.y - k * (JN.SIDE_HW - 4), '#fafafa', 5, [10, 8]);
      }
      // A full turn must be exactly 2π here: Chrome's GPU canvas closes a 0..6.283 arc this far from the
      // origin with a chord through the centre and leaves half the island unfilled.
      const r = JN.RING_R, TAU = Math.PI * 2;
      ctx.fillStyle = '#d7dadd';
      ctx.beginPath(); ctx.arc(j.x, j.y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = this.theme.patch;
      ctx.beginPath(); ctx.arc(j.x, j.y, r - 8, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#d84343';
      ctx.lineWidth = 5;
      ctx.setLineDash([14, 14]);
      ctx.beginPath(); ctx.arc(j.x, j.y, r - 3, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      for (let k = 0; k < 3; k++) {
        const a = k * 2.094 + 0.5, x = j.x + Math.cos(a) * r * 0.42, y = j.y + Math.sin(a) * r * 0.42;
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath(); ctx.arc(x + 5, y + 6, 18, 0, TAU); ctx.fill();
        ctx.fillStyle = '#4e7d2f';
        ctx.beginPath(); ctx.arc(x, y, 18, 0, TAU); ctx.fill();
      }
    }

    // A toll's canopy across the road with its office on the east verge; a radar's post on the same side.
    drawPoint(ctx, j) {
      if (j.type === 'toll') {
        this.band(ctx, [j.s - 18, j.s, j.s + 18], -RAIL - 24, RAIL + 24, 'rgba(30,34,40,0.25)');
        ctx.fillStyle = '#78909c';
        for (const k of [-1, 1]) ctx.fillRect(j.x + k * (RAIL + 14) - 7, j.y - 7, 14, 14);
        const x = j.x + RAIL + 40;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x + 6, j.y - 50, 70, 110);
        ctx.fillStyle = '#eceff1';
        ctx.fillRect(x, j.y - 56, 70, 110);
        ctx.fillStyle = '#1565c0';
        ctx.fillRect(x, j.y - 56, 70, 18);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GİŞE', x + 35, j.y - 46);
      } else if (j.type === 'radar') {
        const p = this.posAt(j.s, RAIL + 26);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.arc(p.x + 4, p.y + 5, 7, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#546e7a';
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#263238';
        ctx.fillRect(p.x - 20, p.y - 6, 18, 12);
        ctx.fillStyle = '#90caf9';
        ctx.beginPath(); ctx.arc(p.x - 20, p.y, 3, 0, 6.283); ctx.fill();
      }
    }

    drawPortal(ctx, s) {
      const list = [s - 14, s - 7, s, s + 7, s + 14];
      const w = SECTIONS.tunnel.rail + 8;
      this.band(ctx, list, -w - 70, -w, '#8c8f93');
      this.band(ctx, list, w, w + 70, '#8c8f93');
    }

    drawPosts(ctx, i0, i1, map) {
      ctx.fillStyle = '#6b737a';
      for (let i = i0 - (i0 % 6); i <= i1; i += 6) {
        const s = i * DS;
        if (this.sections.some((sec) => sec.type === 'tunnel' && s >= sec.s0 && s < sec.s1)) continue;
        if (this.sides.some((j) => Math.abs(s - j.s) < JN.SIDE_RAIL)) continue;
        const r = this.railAt(s) + this.bulgeAt(s);
        for (const side of [-1, 1]) {
          const x = this.xs[i] + this.nx[i] * r * side;
          const y = this.ys[i] + this.ny[i] * r * side;
          if (this.inMouth({ x, y }, DEPOT.RAIL) || map.onRoad(x, y, POST_GAP, this.seg.id)) continue;
          ctx.fillRect(x - 3, y - 3, 6, 6);
        }
      }
    }

    drawStart(ctx) {
      const s = TR.ROAD.START_LINE;
      const h = this.headingAt(s);
      const p = this.posAt(s, 0);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(h + Math.PI / 2);
      const cell = 12;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 18; c++) {
          ctx.fillStyle = (r + c) % 2 ? '#111' : '#fafafa';
          ctx.fillRect(-HALF + c * cell, -cell + r * cell, cell, cell);
        }
      }
      ctx.restore();
      const banner = this.posAt(s, -RAIL - 40);
      this.sign(ctx, banner.x, banner.y, 'BAŞLANGIÇ', '#c62828');
    }

    sign(ctx, x, y, text, bg) {
      ctx.save();
      ctx.font = 'bold 18px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 20;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x - w / 2 + 4, y - 14 + 4, w, 28);
      ctx.fillStyle = bg;
      U.roundRect(ctx, x - w / 2, y - 14, w, 28, 4);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 1);
      ctx.restore();
    }

    // Whether a sign at s would stand at least gap from every sign already on this road.
    signFree(s, gap) {
      return Math.abs(s - Math.round(s / PARK_SIGN) * PARK_SIGN) >= gap && this.signList.every((g) => Math.abs(g.s - s) >= gap);
    }

    // A sign at s with its box (half sizes hw, hh) east of the rail; src is the signList entry it shows.
    signSpot(s, text, bg, src) {
      const hw = (SIGN_GLYPH * text.length + 20) / 2, p = this.posAt(s, RAIL + SIGN_GAP + hw);
      return { s, x: p.x, y: p.y, hw, hh: SIGN_HH, text, bg, src: src || null };
    }

    // Every sign of this road: signList first, then the lot sign and the distance signs.
    signSpots() {
      const out = this.signList.map((g) => this.signSpot(g.s, g.text, g.bg, g));
      if (this.atLot) out.push(this.signSpot(this.length - 500, 'TIR PARKI ↑', '#1565c0'));
      for (let s = PARK_SIGN; s <= this.length - 600; s += PARK_SIGN) {
        out.push(this.signSpot(s, 'PARK ALANI ↑ ' + ((this.length - s + this.toLot) / 10000).toFixed(1).replace('.', ',') + ' km', '#2e7d32'));
      }
      return out;
    }

    drawSigns(ctx, i0, i1, map) {
      for (const g of map.signs(this.seg.id)) {
        const i = g.s / DS;
        if (i >= i0 - 60 && i <= i1 + 60) this.sign(ctx, g.x, g.y, g.text, g.bg);
      }
    }

    drawDecor(ctx, i0, i1, map) {
      const th = this.theme, seed = this.route.seed, salt = (this.seg.id + 1) * 7919;
      const beach = th.sea && map.segs[this.seg.id].coast;
      const step = 9;
      for (let k = Math.floor(i0 / step); k * step <= i1; k++) {
        for (let m = 0; m < 2; m++) {
          const key = k * 2 + m + salt;
          if (U.hash(key * 1.37 + seed) > th.density) continue;
          const i = k * step;
          if (this.coveredAt(i * DS) || this.points.some((j) => Math.abs(i * DS - j.s) < POINTS[j.type].clear)) continue;
          let side = U.hash(key * 2.11 + seed) < 0.5 ? -1 : 1;
          let dd = side * (RAIL + 45 + U.hash(key * 3.7 + seed) * 460);
          if (beach && side < 0) {
            if (U.hash(key * 5.3) > 0.4) continue;
            dd = -(360 + U.hash(key * 4.1) * 80);
          }
          const x = this.xs[i] + this.nx[i] * dd;
          const y = this.ys[i] + this.ny[i] * dd;
          const r = 14 + U.hash(key * 9.1 + seed) * 16;
          if (map.onRoad(x, y, r, this.seg.id)) continue;
          drawProp(ctx, x, y, r, beach && side < 0 ? 'palm' : th.decor, key);
        }
      }
    }
  }

  function drawProp(ctx, x, y, r, type, key) {
    if (type === 'pine') {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.arc(x + 6, y + 8, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#2f4f2a';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#3d6634';
      ctx.beginPath(); ctx.arc(x - r * 0.2, y - r * 0.2, r * 0.62, 0, 6.283); ctx.fill();
      if (U.hash(key * 7.7) < 0.3) {
        ctx.fillStyle = '#8a8d8f';
        ctx.beginPath(); ctx.arc(x + r * 1.6, y + r * 0.6, r * 0.5, 0, 6.283); ctx.fill();
      }
    } else if (type === 'palm') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.arc(x + 6, y + 7, r * 0.9, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#3f8f3a';
      ctx.lineWidth = r * 0.32;
      ctx.lineCap = 'round';
      for (let a = 0; a < 6; a++) {
        const ang = a * 1.047 + key;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.fillStyle = '#7a5a33';
      ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, 6.283); ctx.fill();
    } else if (type === 'snowpine') {
      ctx.fillStyle = 'rgba(40,60,80,0.18)';
      ctx.beginPath(); ctx.arc(x + 6, y + 8, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#2c4a3a';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#f4f8fb';
      ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(x + r * 0.35, y + r * 0.2, r * 0.3, 0, 6.283); ctx.fill();
    } else if (type === 'cactus') {
      if (U.hash(key * 6.1) < 0.45) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath(); ctx.ellipse(x + 5, y + 6, r * 0.9, r * 0.6, key, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#a07850';
        ctx.beginPath(); ctx.ellipse(x, y, r * 0.9, r * 0.6, key, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#b98f64';
        ctx.beginPath(); ctx.ellipse(x - r * 0.2, y - r * 0.15, r * 0.45, r * 0.3, key, 0, 6.283); ctx.fill();
        return;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.arc(x + 5, y + 6, r * 0.5, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#3f7a3a';
      ctx.lineWidth = r * 0.34;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - r * 0.8, y); ctx.lineTo(x + r * 0.8, y);
      ctx.moveTo(x - r * 0.8, y); ctx.lineTo(x - r * 0.8, y - r * 0.6);
      ctx.moveTo(x + r * 0.8, y); ctx.lineTo(x + r * 0.8, y + r * 0.5);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = '#4f9447';
      ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, 6.283); ctx.fill();
    } else if (U.hash(key * 3.3) < 0.25) {
      const w = r * 2.2, h = r * 1.6;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x - w / 2 + 6, y - h / 2 + 6, w, h);
      ctx.fillStyle = '#e9dfcf';
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.fillStyle = '#b5452f';
      ctx.fillRect(x - w / 2, y - h / 2, w, h / 2);
      ctx.fillStyle = '#9c3b28';
      ctx.fillRect(x - w / 2, y, w, h / 2);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.arc(x + 6, y + 7, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#4e7d2f';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#62953a';
      ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, 6.283); ctx.fill();
    }
  }

  Road.LAYERS = ['under', 'ground', 'asphalt', 'marks', 'rails', 'props'];
  TR.Road = Road;
})();
