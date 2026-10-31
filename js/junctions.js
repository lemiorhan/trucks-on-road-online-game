'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U, T = TR.TRUCK, JN = TR.JUNCTION, POINTS = TR.POINTS;
  const { LANE, HALF, RAIL } = TR.ROAD;

  // Seconds each phase of a crossing's lights lasts. The main road and the side road each get green and
  // then yellow; ALL_RED keeps both red after each yellow so the box empties before the other side moves.
  const LIGHT = { MAIN: 9, SIDE: 4.5, YELLOW: 1.5, ALL_RED: 1.2 };
  const CYCLE = LIGHT.MAIN + LIGHT.SIDE + 2 * (LIGHT.YELLOW + LIGHT.ALL_RED);
  // Side traffic runs while a racer is between AHEAD before a junction and BEHIND past it; each entry gets
  // a car every EVERY seconds (a range) while it holds fewer than MAX. Side cars brake at DECEL, keep
  // under TURN_V in a turn and still stop for their line until their front is SLACK past it. A ring's cars
  // join and leave the main road MERGE from its centre, and EXIT is the share of outer-lane cars that turn off there.
  const SIDE = { AHEAD: 2800, BEHIND: 500, EVERY: [2.2, 4.5], MAX: 5, DECEL: 180, TURN_V: 70, SLACK: 2, MERGE: 90, EXIT: 0.35 };
  // Main-road cars keep under RING_V on a ring and TOLL_V within TOLL_NEAR of a toll's gates.
  const CAR = { RING_V: 95, TOLL_V: 60, TOLL_NEAR: 160 };
  // A toll gate opens for a truck at or under the toll's kmh within OPEN before it and shuts SHUT seconds
  // after its lane clears. A truck through a shut gate breaks it for the round and is stunned for STUN.
  const GATE = { OPEN: 260, SHUT: 1.2, STUN: 0.8 };
  const FLASH = 0.35;

  const kmhOf = (v) => Math.round(v * 0.36);
  const mainStop = JN.SIDE_HW + JN.STOP_GAP;

  // The colour a crossing shows the main or the side road at time. Each crossing starts the cycle at an
  // offset hashed from its position.
  function light(j, axis, time) {
    let t = (time + U.hash(j.s) * CYCLE) % CYCLE;
    if (axis === 'side') t = (t - LIGHT.MAIN - LIGHT.YELLOW - LIGHT.ALL_RED + CYCLE) % CYCLE;
    const green = axis === 'main' ? LIGHT.MAIN : LIGHT.SIDE;
    return t < green ? 'green' : t < green + LIGHT.YELLOW ? 'yellow' : 'red';
  }

  function makePath(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, cum, len: cum[cum.length - 1] };
  }

  function pathAt(path, pos) {
    const { pts, cum } = path;
    pos = U.clamp(pos, 0, path.len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= pos) lo = m;
      else hi = m;
    }
    const a = pts[lo], b = pts[hi], t = (pos - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return { x: U.lerp(a.x, b.x, t), y: U.lerp(a.y, b.y, t), h: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  // A cubic from a, leaving at heading ha, to b, arriving at heading hb: a turn onto or off a side road.
  function bend(a, ha, b, hb) {
    const k = Math.hypot(b.x - a.x, b.y - a.y) * 0.55;
    const c1 = { x: a.x + Math.cos(ha) * k, y: a.y + Math.sin(ha) * k };
    const c2 = { x: b.x - Math.cos(hb) * k, y: b.y - Math.sin(hb) * k };
    const out = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      out.push({ x: w[0] * a.x + w[1] * c1.x + w[2] * c2.x + w[3] * b.x, y: w[0] * a.y + w[1] * c1.y + w[2] * c2.y + w[3] * b.y });
    }
    return out;
  }

  // Everything at a route's junctions and roadside points that moves or keeps score: the crossings'
  // lights and side traffic, a ring's joining and leaving cars, toll gates and radars. The road is
  // straight north through a junction (Road flattens it), so x and y offsets from its centre are exact.
  class Junctions {
    constructor(road, traffic, seed) {
      this.road = road;
      this.traffic = traffic;
      this.rnd = U.rng(seed);
      this.time = 0;
      this.cars = [];
      this.nextId = 0;
      this.paths = [];
      this.states = road.points.map((j) => ({
        j, passed: [false, false], flash: 0, front: [-Infinity, -Infinity],
        gates: j.type === 'toll' ? [-1.5, -0.5, 0.5, 1.5].map((k) => ({ d: k * LANE, open: 0, shut: 0, broken: false })) : null,
      }));
      for (const j of road.sides) {
        for (const k of [-1, 1]) {
          if (j.type === 'cross') this.crossPath(j, k);
          else this.ringPaths(j, k);
        }
      }
    }

    // k = 1 runs east on the south half of the side road, k = -1 west on the north half (traffic keeps right).
    crossPath(j, k) {
      const y = j.y + (k * LANE) / 2;
      const P = makePath([{ x: j.x - k * JN.SIDE_LEN, y }, { x: j.x + k * JN.SIDE_LEN, y }]);
      this.paths.push(Object.assign(P, { j, hold: JN.SIDE_LEN - HALF - JN.STOP_GAP, spawn: true, t: this.rnd.range(0, SIDE.EVERY[1]) }));
    }

    // On the east side (k = 1) cars come in on the north half and turn right into the northbound outer
    // lane; northbound cars leave from that lane onto the south half. The west side is the same turned
    // half a circle, so the ring runs anticlockwise.
    ringPaths(j, k) {
      const back = k > 0 ? 0 : Math.PI, road = this.road, outer = k * 1.5 * LANE;
      const yIn = j.y - (k * LANE) / 2, yOut = j.y + (k * LANE) / 2;
      const m = road.lanePos(j.s + k * SIDE.MERGE, outer);
      const a = { x: j.x + k * JN.RING_ENTRY, y: yIn };
      const entry = makePath([{ x: j.x + k * JN.SIDE_LEN, y: yIn }].concat(bend(a, Math.PI - back, m, m.h + back)));
      const hold = JN.SIDE_LEN - JN.RING_ENTRY;
      this.paths.push(Object.assign(entry, {
        j, hold, turn: [hold, entry.len], merge: { dir: k, s: j.s + k * SIDE.MERGE }, spawn: true, t: this.rnd.range(0, SIDE.EVERY[1]),
      }));
      const e = road.lanePos(j.s - k * SIDE.MERGE, outer);
      const pts = bend(e, e.h + back, { x: j.x + k * JN.RING_ENTRY, y: yOut }, back);
      const turn = makePath(pts).len;
      pts.push({ x: j.x + k * JN.SIDE_LEN, y: yOut });
      this.paths.push(Object.assign(makePath(pts), { j, turn: [0, turn], from: { dir: k, s: j.s - k * SIDE.MERGE } }));
    }

    carFor(path, pos, like) {
      const c = {
        id: ++this.nextId, path, pos, kind: like.kind, len: like.len, wid: like.wid, color: like.color, vBase: like.vBase, v: like.v,
        x: 0, y: 0, h: 0, wreck: null, brake: false, flash: 0,
      };
      this.place(c);
      return c;
    }

    place(c) {
      const q = pathAt(c.path, c.pos);
      c.x = q.x; c.y = q.y; c.h = q.h;
    }

    // A ring side car's place in main-road terms: s along the road and the lane offset d it is at.
    roadPos(c) {
      const j = c.path.j, s = j.s + (j.y - c.y);
      return { s, d: this.road.laneD(s, c.x - j.x) };
    }

    // Whether a side car's front is past where it still stops for its path's line.
    pastLine(c) {
      return c.pos + c.len / 2 >= c.path.hold + SIDE.SLACK;
    }

    // Whether a ring side car at rp (roadPos) takes part in main-road traffic: on the way in once it no
    // longer stops at its give-way line, so a waiting car blocks no one; on the way out while any part of it
    // may still be on the road.
    joined(c, rp) {
      return c.path.merge ? this.pastLine(c) : Math.abs(rp.d) - c.len / 2 <= HALF;
    }

    // The joined ring side cars, as main-road cars of the direction they join or leave, so main traffic
    // follows them and does not appear on or move over them. One coming in from the side holds the outer lane.
    ghosts() {
      const out = [], outer = 1.5 * LANE;
      for (const c of this.cars) {
        const way = c.path.merge || c.path.from;
        if (!way) continue;
        const rp = this.roadPos(c);
        if (!this.joined(c, rp)) continue;
        const d = U.clamp(rp.d, -outer, outer);
        out.push({ s: rp.s, d, dTarget: d, dir: way.dir, v: Math.max(0, -way.dir * c.v * Math.sin(c.h)), len: c.len, wid: c.wid, wreck: c.wreck });
      }
      return out;
    }

    // The fastest a main-road car may go now: slow on a ring and through a toll, and able to stop at a
    // crossing's line while its light is not green or side cars are still in the box.
    carLimit(c) {
      let lim = Infinity;
      for (const { j } of this.states) {
        if (j.type === 'ring' && Math.abs(c.s - j.s) < JN.RING_LEN) lim = Math.min(lim, CAR.RING_V);
        else if (j.type === 'toll' && Math.abs(c.s - j.s) < CAR.TOLL_NEAR) lim = Math.min(lim, CAR.TOLL_V);
        else if (j.type === 'cross') {
          const dist = (j.s - c.s) * c.dir - mainStop - c.len / 2;
          if (dist < -2 || dist > 600) continue;
          const col = light(j, 'main', this.time);
          if (col === 'red' || (col === 'yellow' && dist > (c.v * c.v) / (2 * SIDE.DECEL)) || this.sideInBox(j)) {
            lim = Math.min(lim, Math.sqrt(2 * SIDE.DECEL * Math.max(0, dist - 3)));
          }
        }
      }
      return lim;
    }

    sideInBox(j) {
      return this.cars.some((c) => c.path.j === j && Math.abs(c.x - j.x) < HALF + c.len / 2 + 8 && Math.abs(c.y - j.y) < JN.SIDE_HW);
    }

    mainInBox(j, players) {
      const span = mainStop;
      for (const c of this.traffic.cars) {
        if (c.dormant > 0) continue;
        if (Math.abs(c.s - j.s) < span + c.len / 2) return true;
      }
      for (const p of players) {
        if (p.phase !== 'race') continue;
        for (const b of p.truck.boxes()) {
          for (const q of U.corners(b)) if (Math.abs(q.x - j.x) < HALF + 10 && Math.abs(q.y - j.y) < span) return true;
        }
      }
      return false;
    }

    // Whether a side car must wait at its path's line: a crossing's red, a yellow it can stop for, or a box
    // still in use; a ring's entry until its lane has a gap, no truck is close and a main-road car is free.
    mustHold(P, c, players) {
      if (P.merge) {
        const { dir, s } = P.merge;
        if (!this.traffic.hasSleeper(dir) || !this.traffic.laneFree({ dir, s, v: SIDE.TURN_V, wid: c.wid }, dir * 1.5 * LANE, 140, 300)) return true;
        return players.some((p) => p.phase === 'race' && Math.sign(p.d) === dir && p.s > s - 450 && p.s < s + 150);
      }
      const col = light(P.j, 'side', this.time);
      if (col === 'red') return true;
      if (col === 'yellow' && P.hold - c.pos - c.len / 2 > (c.v * c.v) / (2 * SIDE.DECEL)) return true;
      return this.mainInBox(P.j, players);
    }

    near(j, players) {
      return players.some((p) => p.phase === 'race' && p.s > j.s - SIDE.AHEAD && p.s < j.s + SIDE.BEHIND);
    }

    // Moves the side traffic and judges every racer at the crossings, radars and toll gates. Returns
    // events for the game to score: {type: 'red' | 'radar' | 'gate', p, ...}.
    update(dt, players, time) {
      this.time = time;
      const events = [];
      for (const P of this.paths) {
        if (!P.spawn || !this.near(P.j, players)) continue;
        P.t -= dt;
        if (P.t > 0) continue;
        P.t = this.rnd.range(SIDE.EVERY[0], SIDE.EVERY[1]);
        const mine = this.cars.filter((c) => c.path === P);
        if (mine.length < SIDE.MAX && !mine.some((c) => c.pos < 140)) this.cars.push(this.carFor(P, 0, this.traffic.makeCar(1)));
      }
      for (const P of this.paths) {
        if (!P.from) continue;
        for (const c of this.traffic.cars) {
          if (c.dir !== P.from.dir || c.dormant > 0 || c.wreck || c.lane !== 1 || c.d !== c.dTarget) continue;
          const past = (c.s - P.from.s) * c.dir;
          if (past < 0 || past > c.v * dt + 0.5 || this.rnd() >= SIDE.EXIT) continue;
          this.cars.push(this.carFor(P, past, c));
          this.traffic.retire(c);
        }
      }
      for (const c of this.cars) this.move(c, dt, players);
      this.cars = this.cars.filter((c) => !c.gone);
      for (const st of this.states) this.judge(st, dt, players, events);
      return events;
    }

    move(c, dt, players) {
      if (c.wreck) {
        if (TR.Traffic.moveWreck(c, dt)) c.gone = true;
        return;
      }
      const P = c.path, front = c.pos + c.len / 2;
      let target = c.vBase;
      if (P.turn) {
        if (front < P.turn[0]) target = Math.min(target, Math.sqrt(SIDE.TURN_V * SIDE.TURN_V + 2 * SIDE.DECEL * (P.turn[0] - front)));
        else if (c.pos - c.len / 2 < P.turn[1]) target = Math.min(target, SIDE.TURN_V);
      }
      if (P.hold != null && !this.pastLine(c) && this.mustHold(P, c, players)) {
        target = Math.min(target, Math.sqrt(2 * SIDE.DECEL * Math.max(0, P.hold - front)));
      }
      const follow = (o, gap) => (target = Math.min(target, TR.Traffic.followV(o, gap)));
      for (const o of this.cars) {
        if (o === c || o.path !== P || o.pos <= c.pos) continue;
        follow(o, o.pos - c.pos - (o.len + c.len) / 2);
      }
      // A joined ring car also follows the main-road cars ahead of it in, or moving into, the outer lane.
      const way = P.merge || P.from;
      if (way) {
        const rp = this.roadPos(c), outer = way.dir * 1.5 * LANE;
        if (this.joined(c, rp)) {
          for (const o of this.traffic.cars) {
            if (o.dir !== way.dir || o.dormant > 0 || !TR.Traffic.inLaneOf(o, c, outer)) continue;
            const gap = (o.s - rp.s) * way.dir - (o.len + c.len) / 2;
            if (gap > -5) follow(o, gap);
          }
        }
      }
      c.brake = target < c.v - 1;
      c.v = U.approach(c.v, target, (target < c.v ? 260 : 70) * dt);
      c.pos += c.v * dt;
      if (c.pos < P.len) {
        this.place(c);
        return;
      }
      c.gone = true;
      if (P.merge) this.traffic.adopt(P.merge.dir, P.merge.s, c);
    }

    judge(st, dt, players, events) {
      const j = st.j;
      if (st.flash > 0) st.flash -= dt;
      const hit = [];
      for (const p of players) {
        if (p.phase !== 'race') continue;
        const front = p.s + T.CAB_FRONT, last = st.front[p.idx];
        st.front[p.idx] = front;
        if (j.type === 'cross' && !st.passed[p.idx] && front >= j.s - mainStop) {
          st.passed[p.idx] = true;
          if (light(j, 'main', this.time) === 'red') events.push({ type: 'red', p });
        } else if (j.type === 'radar' && !st.passed[p.idx] && front >= j.s) {
          st.passed[p.idx] = true;
          if (kmhOf(p.truck.v) > j.kmh) {
            st.flash = FLASH;
            events.push({ type: 'radar', p, flash: FLASH });
          }
        } else if (j.type === 'toll') {
          for (const g of st.gates) {
            if (g.broken || Math.abs(p.d - g.d) >= LANE / 2 + T.TR_HW) continue;
            if (g.open < 0.6 && last < j.s && front >= j.s) {
              g.broken = true;
              if (!hit.includes(p)) hit.push(p);
            }
          }
        }
      }
      for (const p of hit) events.push({ type: 'gate', p, stun: GATE.STUN });
      if (!st.gates) return;
      const kmh = POINTS.toll.kmh;
      for (const g of st.gates) {
        if (g.broken) continue;
        let want = this.traffic.cars.some((c) => c.dormant <= 0 && !c.wreck && Math.abs(c.d - g.d) < 20 &&
          (j.s - c.s) * c.dir > -c.len && (j.s - c.s) * c.dir < 120);
        for (const p of players) {
          if (want || p.phase !== 'race' || Math.abs(p.d - g.d) >= LANE / 2 + T.TR_HW) continue;
          const front = p.s + T.CAB_FRONT, rear = p.s - T.LT - T.TR_REAR;
          want = front > j.s - GATE.OPEN && rear < j.s + 10 && (g.open > 0.5 || kmhOf(p.truck.v) <= kmh);
        }
        g.shut = want ? GATE.SHUT : g.shut - dt;
        g.open = U.approach(g.open, g.shut > 0 ? 1 : 0, dt * 2.5);
      }
    }

    collide(players) {
      return TR.Traffic.collideCars(this.cars, players);
    }

    // How far a truck's nose is from the next crossing's stop line while that light is not green.
    stopAhead(p) {
      const front = p.s + T.CAB_FRONT;
      for (const st of this.states) {
        if (st.j.type !== 'cross' || st.passed[p.idx]) continue;
        const dist = st.j.s - mainStop - front;
        return dist >= 0 && light(st.j, 'main', this.time) !== 'green' ? dist : Infinity;
      }
      return Infinity;
    }

    // The push that brings a point back onto a junction's drivable ground: the main road (swung out
    // around a ring) or a side road, never a ring's island; then a depot's (Road.depotLimit). undefined
    // outside every junction and depot, so the caller falls back to the plain barrier; null when the point
    // is fine.
    limit(x, y) {
      for (const j of this.road.sides) {
        const u = j.y - y, dx = x - j.x;
        if (Math.abs(u) > POINTS[j.type].flat || Math.abs(dx) > JN.SIDE_LEN + 200) continue;
        if (j.type === 'ring') {
          const r = Math.hypot(dx, u);
          if (r < JN.RING_R) return r > 1e-6 ? { over: JN.RING_R - r, nx: dx / r, ny: -u / r } : { over: JN.RING_R, nx: 1, ny: 0 };
        }
        const main = RAIL + this.road.bulgeAt(j.s + u) - Math.abs(dx);
        const side = JN.SIDE_RAIL - Math.abs(u);
        if (main >= 0 || (side >= 0 && Math.abs(dx) <= JN.SIDE_LEN)) return null;
        if (Math.abs(dx) > JN.SIDE_LEN || -main < -side) return { over: -main, nx: -Math.sign(dx), ny: 0 };
        return { over: -side, nx: 0, ny: Math.sign(u) };
      }
      return this.road.depotLimit(x, y);
    }

    onSide(x, y) {
      return this.road.sides.some((j) => Math.abs(j.y - y) < JN.SIDE_HW + 4 && Math.abs(x - j.x) < JN.SIDE_LEN) || !!this.road.depotAt(x, y);
    }

    draw(ctx, view) {
      for (const c of this.cars) {
        if (c.x < view.x0 - 100 || c.x > view.x1 + 100 || c.y < view.y0 - 100 || c.y > view.y1 + 100) continue;
        TR.Traffic.drawCar(ctx, c);
      }
      for (const st of this.states) {
        const j = st.j;
        if (j.y < view.y0 - 300 || j.y > view.y1 + 300) continue;
        if (st.gates) for (const g of st.gates) drawGate(ctx, j, g);
        if (st.flash > 0) {
          const p = this.road.posAt(j.s, RAIL + 6), a = st.flash / FLASH;
          const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 160);
          gr.addColorStop(0, 'rgba(255,255,255,' + (0.9 * a).toFixed(2) + ')');
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = gr;
          ctx.beginPath(); ctx.arc(p.x, p.y, 160, 0, Math.PI * 2); ctx.fill();
        }
      }
      this.drawLights(ctx, view);
    }

    // One signal head on the right of each approach, beside its stop line.
    drawLights(ctx, view) {
      const sx = HALF + JN.STOP_GAP;
      for (const { j } of this.states) {
        if (j.type !== 'cross' || j.y < view.y0 - 300 || j.y > view.y1 + 300) continue;
        const main = light(j, 'main', this.time), side = light(j, 'side', this.time);
        for (const k of [-1, 1]) {
          drawHead(ctx, j.x + k * (HALF + 22), j.y + k * mainStop, main);
          drawHead(ctx, j.x - k * sx, j.y + k * (JN.SIDE_HW + 22), side);
        }
      }
    }
  }
  Junctions.FLASH = FLASH;

  const LAMP = { red: '#ff3b30', yellow: '#ffc400', green: '#2ee66b' };

  function drawHead(ctx, x, y, col) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    U.roundRect(ctx, x - 20, y - 6, 44, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#20252a';
    U.roundRect(ctx, x - 23, y - 9, 46, 18, 5);
    ctx.fill();
    ['red', 'yellow', 'green'].forEach((c, i) => {
      ctx.fillStyle = c === col ? LAMP[c] : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(x - 14 + i * 14, y, 5, 0, 6.283);
      ctx.fill();
    });
  }

  // The arm pivots on its lane's outer edge and swings up out of the lane; seen from above it shortens.
  function drawGate(ctx, j, g) {
    const k = Math.sign(g.d), px = j.x + g.d + k * (LANE / 2 - 3);
    const len = g.broken ? 10 : (LANE - 6) * (1 - 0.8 * g.open);
    ctx.fillStyle = '#37474f';
    ctx.fillRect(px - 4, j.y - 4, 8, 8);
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(px, j.y); ctx.lineTo(px - k * len, j.y); ctx.stroke();
    ctx.strokeStyle = '#fafafa';
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(px, j.y); ctx.lineTo(px - k * len, j.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  TR.Junctions = Junctions;
})();
