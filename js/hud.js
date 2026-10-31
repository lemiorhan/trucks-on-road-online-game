'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const KEYNAMES = [
    { move: 'W A S D', action: 'Space', reset: 'Q', brake: 'Space', horn: 'E' },
    { move: 'Ok tuşları', action: 'Enter', reset: 'Sağ Shift', brake: 'Sağ Option', horn: 'Enter' },
  ];
  const CONTRACT_STATE = { run: ['devam', '#cfd8dc'], ok: ['tamam', '#69f0ae'], fail: ['bozuldu', '#ff8a80'] };
  TR.KEYNAMES = KEYNAMES;
  const PHASE = { race: 'YARIŞ', load: 'YÜKLEME', park: 'PARK', unload: 'BOŞALTMA', done: 'BİTTİ' };
  const MAP_MARK = {
    bridge: '#4fc3f7', dirt: '#a1887f', tunnel: '#78909c', narrow: '#ffb74d', cross: '#ffd54f', ring: '#81c784', toll: '#ba68c8', radar: '#ef5350',
  };
  // The nav map grows from SMALL to LARGE (capped at VH of the view's height) as a fork comes within GROW_AT,
  // over GROW_LEN, and shrinks the same way past it. A segment's colour is its flow class: below QUIET, from
  // BUSY up, or normal between; active jams go over it in JAM. Polylines take every STEP-th sample.
  const NAV = (TR.NAV = {
    SMALL: { w: 64, h: 240 }, LARGE: { w: 150, h: 400 }, VH: 0.55, GROW_AT: 6000, GROW_LEN: 3000, STEP: 25, PAD: 8, TEXT: 20,
    QUIET: 0.55, BUSY: 1.2, COLOR: { quiet: '#66bb6a', normal: '#e0e0e0', busy: '#ffa726' }, JAM: '#ff1744',
  });
  const TARGET_COL = 44;
  const targetPanelW = (un) => Math.max(220, un.target.length * TARGET_COL + 28);

  function panel(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(14,17,21,0.74)';
    U.roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
  }

  function text(ctx, s, x, y, size, color, align, weight) {
    ctx.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    ctx.fillStyle = color || '#fff';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  function bar(ctx, x, y, w, v, good, color) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, 8);
    ctx.fillStyle = color || (good ? '#43a047' : '#f9a825');
    ctx.fillRect(x, y, w * U.clamp(v, 0, 1), 8);
  }

  function banner(ctx, s, cx, y, size, color) {
    ctx.font = '900 ' + size + 'px ' + FONT;
    const w = ctx.measureText(s).width + 32;
    panel(ctx, cx - w / 2, y - size * 0.8, w, size * 1.6);
    text(ctx, s, cx, y, size, color, 'center', '900');
  }

  function draw(ctx, vp, p, g) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.x, vp.y, vp.w, vp.h);
    ctx.clip();
    if (p.flashT > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.7 * p.flashT / TR.Junctions.FLASH).toFixed(2) + ')';
      ctx.fillRect(vp.x, vp.y, vp.w, vp.h);
    }
    drawHeader(ctx, vp, p, g);
    if (p.phase === 'race' || p.phase === 'load' || p.phase === 'park') drawContract(ctx, vp, p, g);
    if (p.phase === 'race') drawRace(ctx, vp, p, g);
    else if (p.phase === 'load') drawLoad(ctx, vp, p);
    else if (p.phase === 'park') drawPark(ctx, vp, p, g);
    else if (p.phase === 'unload') drawUnload(ctx, vp, p, g);
    else if (p.phase === 'done') drawDone(ctx, vp, p, g);
    drawToast(ctx, vp, p);
    if (g.state === 'finishing' && g.lastChance) drawLastChance(ctx, vp, p, g);
    if (g.state === 'countdown') {
      const bottom = drawIntro(ctx, vp, p, g);
      const n = Math.ceil(g.countdown);
      if (n <= 3) text(ctx, String(n), vp.x + vp.w / 2, Math.max(vp.y + vp.h * 0.4, bottom + 76), 120, '#fff', 'center', '900');
    }
    drawHints(ctx, vp, p);
    ctx.restore();
  }

  function drawHeader(ctx, vp, p, g) {
    panel(ctx, vp.x + 12, vp.y + 12, 300, 56);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(vp.x + 40, vp.y + 40, 17, 0, 6.283);
    ctx.fill();
    text(ctx, String(p.idx + 1), vp.x + 40, vp.y + 41, 18, '#fff', 'center', '900');
    text(ctx, p.name, vp.x + 66, vp.y + 31, 17, '#fff');
    text(ctx, PHASE[p.phase] + (p.phase === 'race' ? ' · ' + g.route.name : ''), vp.x + 66, vp.y + 52, 13, '#b7c0c8', 'left', '600');
    text(ctx, String(TR.roundScore(p, g, g.state === 'roundover').total), vp.x + 300, vp.y + 33, 24, '#ffd54f', 'right', '900');
    const final = TR.isFinalRound(g.series);
    text(ctx, 'tur puanı' + (final ? ' ×' + TR.SCORE_RULES.finalMult : ''), vp.x + 300, vp.y + 55, 11, final ? '#ff8a65' : '#b7c0c8', 'right', '700');

    const tx = Math.max(vp.x + vp.w / 2, vp.x + 390);
    panel(ctx, tx - 66, vp.y + 12, 132, 56);
    text(ctx, U.fmtTime(g.time), tx, vp.y + 32, 22, '#fff', 'center', '800');
    text(ctx, 'Tur ' + g.series.round + ' / ' + g.series.rounds, tx, vp.y + 55, 12, '#b7c0c8', 'center', '700');

    const rank = g.rankOf(p);
    panel(ctx, vp.x + vp.w - 82, vp.y + 12, 70, 56);
    text(ctx, rank + '.', vp.x + vp.w - 47, vp.y + 41, 34, rank === 1 ? '#ffd54f' : '#cfd8dc', 'center', '900');
  }

  function drawIntro(ctx, vp, p, g) {
    const sr = g.series, o = g.players[1 - p.idx];
    const w = Math.min(vp.w - 40, 460), x = vp.x + (vp.w - w) / 2, y = vp.y + vp.h * 0.12;
    const cx = vp.x + vp.w / 2;
    const final = TR.isFinalRound(sr);
    const h = final ? 178 : 148;
    panel(ctx, x, y, w, h);
    text(ctx, 'TUR ' + sr.round + ' / ' + sr.rounds, cx, y + 26, 24, '#fff', 'center', '900');
    const km = (g.map.shortest / 10000).toFixed(1).replace('.', ',') + ' km';
    text(ctx, g.route.name + ' · ' + km + ' · ' + TR.Light.WEATHERS[g.weather], cx, y + 52, 14, '#b7c0c8', 'center', '600');
    text(ctx, 'Toplam puan', cx, y + 76, 12, '#b7c0c8', 'center', '700');
    text(ctx, p.name + '  ' + sr.totals[p.idx] + '   ·   ' + o.name + '  ' + sr.totals[o.idx], cx, y + 99, 18, '#ffd54f', 'center', '800');
    text(ctx, 'Kontrat: ' + g.contract.text + ' · +' + TR.SCORE_RULES.contract, cx, y + 128, 15, '#80cbc4', 'center', '800');
    if (final) text(ctx, 'FİNAL · PUANLAR ×' + TR.SCORE_RULES.finalMult, cx, y + 158, 20, '#ff8a65', 'center', '900');
    return y + h;
  }

  function drawContract(ctx, vp, p, g) {
    const [word, color] = CONTRACT_STATE[g.contract.state(p)];
    const s = 'Kontrat: ' + g.contract.text + ' · ' + word;
    ctx.font = '700 12px ' + FONT;
    panel(ctx, vp.x + 12, vp.y + 72, ctx.measureText(s).width + 20, 20);
    text(ctx, s, vp.x + 22, vp.y + 82, 12, color, 'left', '700');
  }

  // The player still parking or unloading gets the big countdown; the one who finished only sees that the rival still can.
  function drawLastChance(ctx, vp, p, g) {
    const n = Math.max(0, Math.ceil(g.overT));
    if (p.phase === 'done') {
      banner(ctx, 'Rakip son şansında · ' + n + ' sn', vp.x + vp.w / 2, vp.y + vp.h * 0.16 + 46, 18, '#cfd8dc');
      return;
    }
    // Centred in the room beside the target panel, which drawUnload puts on the inner side at this height.
    const side = p.phase === 'unload' ? targetPanelW(p.unloader) + 24 : 0;
    const cx = vp.x + (vp.w - side) / 2 + (p.idx === 1 ? side : 0);
    banner(ctx, 'SON ŞANS · ' + n, cx, vp.y + 112, 32, n <= 5 ? '#ff5252' : '#ffd54f');
  }

  function drawRace(ctx, vp, p, g) {
    const t = p.truck;
    const kmh = Math.round(Math.abs(t.v) * 0.36);
    panel(ctx, vp.x + 12, vp.y + vp.h - 142, 200, 130);
    drawCollected(ctx, vp.x + 28, vp.y + vp.h - 130, p.cargo);
    text(ctx, String(kmh), vp.x + 30, vp.y + vp.h - 72, 46, '#fff', 'left', '900');
    text(ctx, 'km/s', vp.x + 32 + ctx.measureText(String(kmh)).width + 4, vp.y + vp.h - 62, 14, '#b7c0c8', 'left', '600');
    text(ctx, 'Kaza: ' + p.crashes + (p.offroad ? '   · yol dışı' : ''), vp.x + 30, vp.y + vp.h - 30, 15,
      p.offroad ? '#ffb74d' : '#cfd8dc', 'left', '700');
    if (p.draft > 0.3) banner(ctx, 'RÜZGÂR TÜNELİ', vp.x + 112, vp.y + vp.h - 164, 15, '#b3e5fc');
    if (p.turbo > 0) banner(ctx, 'TURBO · ' + Math.ceil(p.turbo) + ' sn', vp.x + 112, vp.y + vp.h - 192, 18, '#ffab40');
    drawNav(ctx, vp, p, g);
    drawBendWarning(ctx, vp, p, g);
  }

  // Warns only when braking is due now, and names what it is due for: the red light ahead while stopping
  // there takes the lower speed (Assist.redLimit), else the bend or point that binds (Assist.bindAt).
  function drawBendWarning(ctx, vp, p, g) {
    if (p.assist === 'kapali') return;
    const t = p.truck, x = vp.x + vp.w / 2, y = vp.y + 112;
    const road = g.map.segs[p.seg].road;
    const front = p.s + TR.TRUCK.CAB_FRONT, lim = TR.Assist.limitAt(road, front);
    const red = TR.Assist.redLimit(p, p.redAhead);
    if (red < lim) {
      if (p.autoT > 0) banner(ctx, 'OTO FREN · KIRMIZI IŞIK', x, y, 24, '#80d8ff');
      else if (t.v > red) banner(ctx, 'KIRMIZI IŞIK! DUR', x, y, 24, '#ff8a80');
      return;
    }
    if (t.v <= lim + 4 && p.autoT <= 0) return;
    const next = TR.Assist.bindAt(road, front);
    if (next.v === Infinity) return;
    const kmh = TR.Assist.signKmh(next.v) + ' km/s';
    if (p.autoT > 0) banner(ctx, 'OTO FREN · ' + kmh, x, y, 24, '#80d8ff');
    else banner(ctx, next.label + '! YAVAŞLA · ' + kmh, x, y, 24, '#ffb74d');
  }

  function drawCollected(ctx, x, y, cargo) {
    TR.BOXES.forEach((b, id) => {
      if (cargo.includes(id)) TR.drawBoxFlat(ctx, x + id * 28, y, 22, 22, id, false);
      else {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + id * 28 + 1, y + 1, 20, 20);
      }
    });
  }

  const progress = (q, g) => U.clamp(1 - g.map.distToLot(q.seg, q.s) / g.map.shortest, 0, 1);

  function forkDist(p, g) {
    const sg = g.map.segs[p.seg];
    const ahead = sg.out.length > 1 ? sg.road.length - p.s : Infinity;
    return Math.min(ahead, sg.links.startSibs.length ? p.s : Infinity);
  }

  function navSize(p, g) {
    const k = U.smooth((NAV.GROW_AT - forkDist(p, g)) / NAV.GROW_LEN);
    return { w: U.lerp(NAV.SMALL.w, NAV.LARGE.w, k), h: U.lerp(NAV.SMALL.h, NAV.LARGE.h, k) };
  }

  const flowColor = (flow) => NAV.COLOR[flow < NAV.QUIET ? 'quiet' : flow >= NAV.BUSY ? 'busy' : 'normal'];

  // The whole map north-up, each axis fitted to the panel on its own: a map is many times taller than wide.
  function drawNav(ctx, vp, p, g) {
    const map = g.map, sz = navSize(p, g), w = sz.w, h = Math.min(sz.h, vp.h * NAV.VH);
    const x = vp.x + vp.w - 12 - w, y = vp.y + 78;
    panel(ctx, x, y, w, h);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const sg of map.segs) {
      const b = sg.road.bbox;
      bx0 = Math.min(bx0, b.x0); by0 = Math.min(by0, b.y0); bx1 = Math.max(bx1, b.x1); by1 = Math.max(by1, b.y1);
    }
    const iw = w - 2 * NAV.PAD, ih = h - 2 * NAV.PAD - NAV.TEXT;
    const at = (q) => ({ x: x + NAV.PAD + ((q.x - bx0) / (bx1 - bx0)) * iw, y: y + NAV.PAD + ((q.y - by0) / (by1 - by0)) * ih });
    const line = (road, i0, i1) => {
      ctx.beginPath();
      for (let i = i0; ; i = Math.min(i + NAV.STEP, i1)) {
        const q = at({ x: road.xs[i], y: road.ys[i] });
        if (i === i0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        if (i === i1) break;
      }
      ctx.stroke();
    };
    ctx.lineWidth = 3;
    for (const sg of map.segs) {
      ctx.strokeStyle = flowColor(sg.spec.flow);
      line(sg.road, 0, sg.road.n - 1);
    }
    ctx.lineWidth = 5;
    for (const sg of map.segs) {
      const road = sg.road, idx = (s) => U.clamp(Math.round(s / TR.ROAD.DS), 0, road.n - 1);
      for (const j of map.jamsOn(sg.id, g.time)) {
        ctx.strokeStyle = NAV.JAM;
        line(road, idx(j.s0), idx(j.s1));
      }
    }
    for (const sg of map.segs) {
      const road = sg.road;
      for (const sec of road.sections) {
        const a = at(road.posAt(sec.s0, 0)), b = at(road.posAt(sec.s1, 0));
        ctx.fillStyle = MAP_MARK[sec.type];
        ctx.fillRect((a.x + b.x) / 2 - 4, b.y, 8, Math.max(3, a.y - b.y));
      }
      for (const j of road.points) {
        const c = at(road.posAt(j.s, 0));
        ctx.fillStyle = MAP_MARK[j.type];
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 3.5, 0, 6.283);
        ctx.fill();
        ctx.stroke();
      }
    }
    const lot = at(map.nodes[map.segs[map.lotSeg].spec.b]);
    ctx.fillStyle = '#90caf9';
    ctx.fillRect(lot.x - 9, lot.y - 5, 18, 10);
    for (const q of g.players) {
      const road = map.segs[q.seg].road;
      const c = at(road.posAt(q.phase === 'race' ? U.clamp(q.s, 0, road.length) : road.length, 0));
      ctx.fillStyle = q.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = q === p ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, q === p ? 6 : 4, 0, 6.283);
      ctx.fill();
      ctx.stroke();
    }
    const pct = Math.round(progress(p, g) * 100);
    text(ctx, '%' + pct, x + w / 2, y + h - NAV.PAD - NAV.TEXT / 2, 12, '#cfd8dc', 'center', '700');
  }

  function drawPark(ctx, vp, p, g) {
    const st = p.park;
    const t = p.truck;
    const x = vp.x + 12, y = vp.y + vp.h - 238, w = 290;
    panel(ctx, x, y, w, 226);
    text(ctx, 'Bölme ' + (p.idx + 1) + "'e geri geri park et", x + 16, y + 22, 16, p.color === '#1e88e5' ? '#90caf9' : '#ef9a9a');
    const gear = t.v < -2 ? 'GERİ' : t.v > 2 ? 'İLERİ' : 'DUR';
    text(ctx, 'Vites: ' + gear + '   ' + Math.round(Math.abs(t.v) * 0.36) + ' km/s', x + 16, y + 46, 14, '#cfd8dc', 'left', '600');
    if (st) {
      const L = TR.LOT;
      const rows = [
        ['Dorse açısı', Math.round(st.angleErr) + '°', 1 - st.angleErr / 45, st.angleErr < L.ANGLE_TOL],
        ['Yan kayma', Math.round(Math.abs(st.lateral)) + '', 1 - Math.abs(st.lateral) / 80, Math.abs(st.lateral) < L.LATERAL_MAX],
        ['Rampaya', Math.round(st.rearDist) + '', 1 - st.rearDist / 400, st.rearDist < L.REAR_TOL],
      ];
      rows.forEach((r, k) => {
        const ry = y + 72 + k * 26;
        text(ctx, r[0], x + 16, ry, 13, '#b7c0c8', 'left', '600');
        text(ctx, r[1], x + 120, ry, 13, r[3] ? '#a5d6a7' : '#fff', 'right', '700');
        bar(ctx, x + 132, ry - 4, 140, r[2], r[3]);
      });
      text(ctx, st.inside ? '✔ Dorse bölmenin içinde' : '✖ Dorse bölmenin dışında', x + 16, y + 154, 13,
        st.inside ? '#a5d6a7' : '#ef9a9a', 'left', '700');
    }
    const jack = Math.abs(t.angle) / TR.TRUCK.JACK;
    const jy = y + 180;
    text(ctx, 'Makas açısı', x + 16, jy, 13, '#b7c0c8', 'left', '600');
    text(ctx, Math.round((Math.abs(t.angle) * 180) / Math.PI) + '°', x + 120, jy, 13, '#fff', 'right', '700');
    bar(ctx, x + 132, jy - 4, 140, jack, false, jack < 0.6 ? '#43a047' : jack < 0.85 ? '#f9a825' : '#e53935');
    const missing = TR.BOXES.map((_, id) => id).filter((id) => !p.cargo.includes(id));
    text(ctx, 'Eksik kutu:', x + 16, jy + 26, 13, '#b7c0c8', 'left', '600');
    if (!missing.length) text(ctx, 'yok', x + 120, jy + 26, 13, '#a5d6a7', 'left', '700');
    missing.forEach((id, k) => TR.drawBoxFlat(ctx, x + 120 + k * 24, jy + 16, 20, 20, id, false));
    if (t.jack > 0) {
      text(ctx, 'MAKAS ATTI! Biraz ileri git', vp.x + vp.w / 2, vp.y + vp.h * 0.24, 30, '#ffb74d', 'center', '900');
    }
  }

  function drawUnload(ctx, vp, p, g) {
    const un = p.unloader;
    const n = un.target.length;
    const colW = TARGET_COL, w = targetPanelW(un), h = 182;
    // Each player's target zone lies on their outer side, so the panel goes on the inner side.
    const x = p.idx === 0 ? vp.x + vp.w - w - 12 : vp.x + 12, y = vp.y + 78;
    panel(ctx, x, y, w, h);
    text(ctx, 'HEDEF DİZİLİM', x + w / 2, y + 18, 14, '#fff', 'center', '800');
    const base = y + h - 34;
    const x0 = x + (w - n * colW) / 2;
    un.target.forEach((col, i) => {
      const st = un.cellState(i);
      const slot = un.mirror > 0 ? i : n - 1 - i;
      const cx = x0 + slot * colW + colW / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(cx - 18, base + 2, 36, 3);
      col.forEach((id, lvl) => {
        const placed = un.cells[i][lvl] === id && un.cells[i].slice(0, lvl).every((v, k) => v === col[k]);
        TR.drawBoxFlat(ctx, cx - 14, base - (lvl + 1) * 30, 28, 28, id, false);
        if (placed) {
          ctx.strokeStyle = '#69f0ae';
          ctx.lineWidth = 3;
          ctx.strokeRect(cx - 15, base - (lvl + 1) * 30 - 1, 30, 30);
        }
      });
      text(ctx, String(i + 1), cx, base + 16, 13, st === 'ok' ? '#69f0ae' : st === 'wrong' ? '#ff8a80' : '#cfd8dc', 'center', '800');
    });
    drawCrew(ctx, vp, un, 'Doğru: ' + un.placedCount() + '/' + TR.BOXES.length);
  }

  function drawLoad(ctx, vp, p) {
    drawCrew(ctx, vp, p.loader, 'Dorsede: ' + p.cargo.length + '/' + TR.BOXES.length);
  }

  function drawCrew(ctx, vp, un, count) {
    const cargo = un.cargoFromDoor();
    const bw = cargoPanelW(cargo);
    const bx = vp.x + 12, by = vp.y + vp.h - 112;
    panel(ctx, bx, by, bw, 100);
    text(ctx, 'Dorse (kapıdan içeri):', bx + 14, by + 20, 13, '#b7c0c8', 'left', '600');
    if (!cargo.length) text(ctx, 'boş', bx + 14, by + 46, 14, '#90a4ae', 'left', '600');
    cargo.forEach((id, k) => TR.drawBoxFlat(ctx, bx + 14 + k * 30, by + 34, 26, 26, id, k === 0));
    const carry = un.worker.carry;
    text(ctx, 'Elinde:', bx + 14, by + 80, 13, '#b7c0c8', 'left', '600');
    if (carry != null) TR.drawBoxFlat(ctx, bx + 70, by + 68, 24, 24, carry, false);
    else text(ctx, '—', bx + 70, by + 80, 14, '#90a4ae', 'left', '600');
    text(ctx, count, bx + bw - 14, by + 80, 14, '#a5d6a7', 'right', '800');
  }

  function drawDone(ctx, vp, p) {
    text(ctx, 'TAMAMLANDI!', vp.x + vp.w / 2, vp.y + vp.h * 0.16, 34, p.color, 'center', '900');
  }

  function drawToast(ctx, vp, p) {
    const msgs = [];
    if (p.toastT > 0) msgs.push({ s: p.toast, c: p.toastColor, big: true, t: p.toastT });
    const crew = p.loader || p.unloader;
    if (crew && crew.msgT > 0) msgs.push({ s: crew.msg, c: '#fff', big: false, t: crew.msgT });
    msgs.forEach((m, k) => {
      ctx.globalAlpha = U.clamp(m.t * 2, 0, 1);
      const y = vp.y + vp.h * (m.big ? 0.32 : 0.62) + k * 4;
      const size = m.big ? 40 : 20;
      ctx.font = '900 ' + size + 'px ' + FONT;
      const w = ctx.measureText(m.s).width + 40;
      panel(ctx, vp.x + vp.w / 2 - w / 2, y - size * 0.8, w, size * 1.6);
      text(ctx, m.s, vp.x + vp.w / 2, y, size, m.c, 'center', '900');
      ctx.globalAlpha = 1;
    });
  }

  // Width of the bottom-left panel each phase draws; hints that do not fit beside it stack upwards.
  const leftPanel = (p) => (p.phase === 'race' ? 200 : p.phase === 'park' ? 290 : cargoPanelW((p.loader || p.unloader).cargoFromDoor()));
  const cargoPanelW = (cargo) => Math.max(250, 120 + cargo.length * 30);

  function drawHints(ctx, vp, p) {
    const k = KEYNAMES[p.idx];
    let parts;
    if (p.phase === 'race') parts = [k.move + ': sür', k.brake + ': motor freni', k.horn + ': korna', k.reset + ': yola dön'];
    else if (p.phase === 'park') parts = [k.move + ': sür (geri = ' + (p.idx === 0 ? 'S' : '↓') + ')', k.brake + ': motor freni', k.reset + ': girişe dön'];
    else if (p.phase === 'unload') parts = [k.move + ': yürü', k.action + ': al / bırak'];
    else if (p.phase === 'load') parts = [k.move + ': yürü', k.action + ': al / bırak', k.reset + ': eli boşken rampadan çık'];
    else return;
    ctx.font = '600 13px ' + FONT;
    const one = parts.join('  ·  ');
    const room = vp.w - leftPanel(p) - 48;
    const lines = ctx.measureText(one).width + 24 <= room ? [one] : parts.slice().reverse();
    lines.forEach((s, i) => {
      const w = ctx.measureText(s).width + 24, y = vp.y + vp.h - 40 - i * 32;
      panel(ctx, vp.x + vp.w - w - 12, y, w, 28);
      text(ctx, s, vp.x + vp.w - 24, y + 14, 13, '#cfd8dc', 'right', '600');
    });
  }

  // With only one truck on screen, a line under the clock tells where the other one is.
  function drawRival(ctx, vp, p, g) {
    if (g.state === 'countdown') return;
    const o = g.players[1 - p.idx];
    const where = o.phase === 'race'
      ? '%' + Math.round(progress(o, g) * 100) + ' · Rakip ' + o.cargo.length + '/' + TR.BOXES.length
      : PHASE[o.phase];
    const s = o.name + ' · ' + where + ' · ' + g.rankOf(o) + '.';
    ctx.font = '800 13px ' + FONT;
    const w = ctx.measureText(s).width + 34, cx = Math.max(vp.x + vp.w / 2, vp.x + 390), y = vp.y + 74;
    panel(ctx, cx - w / 2, y, w, 24);
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.arc(cx - w / 2 + 14, y + 12, 5, 0, 6.283);
    ctx.fill();
    text(ctx, s, cx + 7, y + 12, 13, '#eceff1', 'center', '800');
  }

  TR.HUD = { draw, drawRival, drawNav, navSize };
})();
