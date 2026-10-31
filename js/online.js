'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;
  const G = () => TR.Game;
  // The host sends SNAP_HZ snapshots a second. A guest draws INTERP_MS behind the newest one so that it
  // always has two to blend between, and keeps BUFFER of them. A side that hears nothing for DEAD_MS takes
  // the link as lost and then waits REJOIN_S seconds for it to come back, a guest retrying every RETRY_MS.
  // A guest input older than INPUT_STALE_MS counts as no keys held.
  // A guest gives up on a first connection that has not opened after JOIN_MS: PeerJS reports no error when
  // the WebRTC handshake itself stalls.
  const SNAP_HZ = 30, INTERP_MS = 70, BUFFER = 8;
  const PING_MS = 1000, DEAD_MS = 4000, REJOIN_S = 30, RETRY_MS = 3000, INPUT_STALE_MS = 500, JOIN_MS = 20000;
  const HOST = 0, GUEST = 1;
  const ROUND_STATES = ['countdown', 'play', 'finishing', 'paused'];
  const HELD = ['thr', 'steer', 'mx', 'my', 'brake'];
  const EDGES = ['action', 'reset', 'horn', 'left', 'right'];
  const NO_KEYS = { thr: 0, steer: 0, mx: 0, my: 0, brake: false };
  // Engine sound follows the snapshot on each side; these are not events to replay.
  const AUDIO_LOCAL = ['engine', 'unlock', 'setMuted', 'setVolume'];

  // JSON has no Infinity, and the game keeps some (redAhead, a car's near-miss gap).
  const INF = '\u0000inf';
  const enc = (m) => JSON.stringify(m, (k, v) => (v === Infinity ? INF : v === -Infinity ? '-' + INF : v));
  const dec = (s) => JSON.parse(s, (k, v) => (v === INF ? Infinity : v === '-' + INF ? -Infinity : v));

  const O = (TR.Online = {
    role: null, code: null, link: null, peer: null,
    status: '', lost: null, snaps: [], offset: Infinity,
    SNAP_HZ, INTERP_MS, HOST, GUEST, enc, dec,
  });

  const now = () => performance.now();
  const me = () => (O.role === 'guest' ? GUEST : HOST);
  const inRound = () => G().map && ROUND_STATES.includes(G().state);

  // ---------- what a host records for its guest ----------
  let recording = false;
  const audioQ = [], fxQ = [], frameQ = [];
  const audio = {};
  for (const name of Object.keys(TR.Audio)) {
    if (AUDIO_LOCAL.includes(name)) continue;
    const f = (audio[name] = TR.Audio[name]);
    TR.Audio[name] = (...args) => {
      if (recording && !O.lost) audioQ.push([name, args]);
      return f(...args);
    };
  }
  O.audioNames = Object.keys(audio);
  // The host picks the spin a particle starts with, so the guest's copy turns the same way.
  const emit = TR.FX.emit;
  TR.FX.emit = (kind, x, y, vx, vy, color, rot) => {
    if (rot == null) rot = Math.random() * 6.283;
    if (recording && !O.lost) fxQ.push([kind, x, y, vx, vy, color, rot]);
    emit(kind, x, y, vx, vy, color, rot);
  };
  // Every frame the host simulates goes to the guest's referee.
  O.record = (dt, steps) => {
    if (recording && !O.lost) frameQ.push(TR.Referee.row(G().time, dt, G().players, steps));
  };

  // ---------- snapshots ----------
  // A player goes over whole but for its camera, which each machine moves for itself; an unloader whole but
  // for the lot it was built on, which the guest already has. A loader goes without its depot, which goes by
  // its box, and without the player's cargo and ramp list it works on, which go with the player.
  const PLAYER_LOCAL = ['cam', 'truck', 'unloader', 'loader'];
  const UNLOADER_REF = ['lot'];
  const LOADER_REF = ['dp', 'trailer', 'loose'];
  const idxOf = (p) => (p ? p.idx : -1);
  const own = (o, skip) => {
    const out = {};
    for (const k of Object.keys(o)) if (!skip.includes(k)) out[k] = o[k];
    return out;
  };
  const carRow = (key, c) => [key, c.x, c.y, c.h, c.len, c.wid, c.kind, c.color, c.brake ? 1 : 0, c.flash, c.wreck ? c.wreck.t : -1];

  // Cars, side cars, junction states, sheep and cones go as one group per map segment, in G.map.segs order.
  O.snapshot = () => {
    const g = G(), segs = g.map.segs;
    const cars = segs.map(({ traffic }) => {
      const rows = [];
      traffic.cars.forEach((c, i) => c.dormant <= 0 && rows.push(carRow(i, c)));
      return rows;
    });
    const cones = segs.map(({ events }) => {
      const rows = [];
      events.works.forEach((w, wi) => w.cones.forEach((c, ci) => c.fly && rows.push([wi, ci, c.x, c.y, c.h])));
      return rows;
    });
    return {
      t: 'snap', ts: now(),
      g: { state: g.state, time: g.time, countdown: g.countdown, overT: g.overT, lastChance: g.lastChance, winner: idxOf(g.winner), firstLot: idxOf(g.firstLot) },
      p: g.players.map((p) => Object.assign(own(p, PLAYER_LOCAL), {
        truck: own(p.truck, []),
        unloader: p.unloader ? own(p.unloader, UNLOADER_REF) : null,
        loader: p.loader ? Object.assign(own(p.loader, LOADER_REF), { box: p.loader.dp.box }) : null,
      })),
      cars,
      jcars: segs.map(({ junctions }) => junctions.cars.map((c) => carRow(c.id, c))),
      jt: segs[g.map.start].junctions.time,
      js: segs.map(({ junctions }) => junctions.states.map((st) => [st.flash, st.gates ? st.gates.map((q) => [q.open, q.broken ? 1 : 0]) : 0])),
      et: segs[g.map.start].events.time,
      sheep: segs.map(({ events }) => events.flocks.map((f) => f.sheep.map((q) => [q.x, q.y, q.h, q.moving ? 1 : 0]))),
      cones,
      audio: audioQ.splice(0),
      fx: fxQ.splice(0),
    };
  };

  // Where each segment's flocks, roadworks and their signs went. A guest builds its own roads and events from
  // the same spec, but in another browser a float can land the other side of a test, so it takes the host's.
  O.layout = () => ({
    segs: G().map.segs.map(({ road, events }) => ({
      signs: road.signList,
      flocks: events.flocks.map((f) => Object.assign({}, f, { pass: [] })),
      works: events.works,
    })),
  });

  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpA = (a, b, k) => a + U.wrap(b - a) * k;
  const carObj = (r, p, k) => ({
    x: p ? lerp(p[1], r[1], k) : r[1], y: p ? lerp(p[2], r[2], k) : r[2], h: p ? lerpA(p[3], r[3], k) : r[3],
    len: r[4], wid: r[5], kind: r[6], color: r[7], brake: !!r[8], flash: r[9], wreck: r[10] >= 0 ? { t: r[10] } : null, dormant: 0,
  });
  const byKey = (rows) => new Map((rows || []).map((r) => [r[0], r]));

  // Shows snapshot cur, moved k of the way back from prev towards it for anything that moves smoothly.
  O.applySnap = (cur, prev, k) => {
    const g = G();
    if (!g.map || !g.players.length) return;
    const pk = prev ? k : 1;
    Object.assign(g, { state: cur.g.state, countdown: cur.g.countdown, overT: cur.g.overT, lastChance: cur.g.lastChance });
    g.time = prev ? lerp(prev.g.time, cur.g.time, pk) : cur.g.time;
    cur.p.forEach((d, i) => {
      const p = g.players[i], pd = prev && prev.p[i];
      Object.assign(p, own(d, PLAYER_LOCAL));
      Object.assign(p.truck, d.truck);
      if (pd) {
        const t = p.truck, a = pd.truck;
        t.x = lerp(a.x, d.truck.x, pk); t.y = lerp(a.y, d.truck.y, pk);
        t.th = lerpA(a.th, d.truck.th, pk); t.phi = lerpA(a.phi, d.truck.phi, pk);
      }
      if (!d.unloader) p.unloader = null;
      else {
        if (!p.unloader) p.unloader = new TR.Unloader(i, g.lot, { target: g.plan.target, trailer: p.cargo }, p.color);
        Object.assign(p.unloader, d.unloader);
      }
      if (!d.loader) p.loader = null;
      else {
        const dp = g.map.segs.flatMap((sg) => sg.road.depots).find((q) => q.box === d.loader.box);
        if (!p.loader) p.loader = new TR.Loader(i, dp, p.color, p.cargo, p.ground[dp.box]);
        Object.assign(p.loader, own(d.loader, ['box']), { dp, trailer: p.cargo, loose: p.ground[dp.box] });
      }
    });
    g.winner = cur.g.winner >= 0 ? g.players[cur.g.winner] : null;
    g.firstLot = cur.g.firstLot >= 0 ? g.players[cur.g.firstLot] : null;
    const jt = prev ? lerp(prev.jt, cur.jt, pk) : cur.jt, et = prev ? lerp(prev.et, cur.et, pk) : cur.et;
    g.map.segs.forEach(({ traffic, junctions, events }, k) => {
      const pc = prev && byKey(prev.cars[k]), pj = prev && byKey(prev.jcars[k]);
      traffic.cars = cur.cars[k].map((r) => carObj(r, pc && pc.get(r[0]), pk));
      junctions.cars = cur.jcars[k].map((r) => carObj(r, pj && pj.get(r[0]), pk));
      junctions.time = jt;
      junctions.states.forEach((st, i) => {
        const r = cur.js[k][i];
        if (!r) return;
        st.flash = r[0];
        if (st.gates && r[1]) st.gates.forEach((q, gi) => { q.open = r[1][gi][0]; q.broken = !!r[1][gi][1]; });
      });
      events.time = et;
      const sheep = cur.sheep[k], was = prev && prev.sheep[k];
      events.flocks.forEach((f, fi) => f.sheep.forEach((q, si) => {
        const r = sheep[fi] && sheep[fi][si];
        if (!r) return;
        const a = was && was[fi] && was[fi][si];
        q.x = a ? lerp(a[0], r[0], pk) : r[0]; q.y = a ? lerp(a[1], r[1], pk) : r[1]; q.h = a ? lerpA(a[2], r[2], pk) : r[2];
        q.moving = !!r[3];
      }));
      for (const [wi, ci, x, y, h] of cur.cones[k]) {
        const c = events.works[wi] && events.works[wi].cones[ci];
        if (c) Object.assign(c, { x, y, h, fly: c.fly || {} });
      }
    });
  };

  // Plays a snapshot's sounds and particles once, when the guest first shows it.
  function fire(s) {
    if (s.fired) return;
    s.fired = true;
    for (const [name, args] of s.audio) if (audio[name]) audio[name](...args);
    for (const q of s.fx) emit(...q);
  }

  O.apply = () => {
    const buf = O.snaps;
    if (!buf.length) return;
    const at = now() - O.offset - INTERP_MS;
    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].ts >= at) i--;
    // buf[i] is the oldest snapshot not yet in the past; blend from the one before it.
    const cur = buf[i], prev = buf[i - 1];
    for (let k = 0; k <= i; k++) fire(buf[k]);
    const k = prev ? U.clamp((at - prev.ts) / (cur.ts - prev.ts || 1), 0, 1) : 1;
    O.applySnap(cur, prev, k);
  };

  // For a screen about how the round ended: shows the newest snapshot now, not INTERP_MS later.
  O.applyLatest = () => {
    const buf = O.snaps;
    if (!buf.length) return;
    buf.forEach(fire);
    O.snaps = [buf[buf.length - 1]];
    O.applySnap(O.snaps[0], null, 1);
  };

  // ---------- input ----------
  const remote = { held: NO_KEYS, cnt: {}, used: {}, at: 0, sync: true };
  function remoteInput() {
    const held = now() - remote.at > INPUT_STALE_MS ? NO_KEYS : remote.held;
    const out = Object.assign({}, held);
    for (const k of EDGES) out[k] = (remote.cnt[k] || 0) > (remote.used[k] || 0);
    return out;
  }
  // A remote press, like a key press, is seen for one frame.
  TR.Input.onEndFrame(() => Object.assign(remote.used, remote.cnt));
  const bothMaps = () => TR.Input.keys(TR.KEYS);
  const sent = { cnt: {} };
  function sendInput() {
    const inp = bothMaps();
    for (const k of EDGES) if (inp[k]) sent.cnt[k] = (sent.cnt[k] || 0) + 1;
    const h = {};
    for (const k of HELD) h[k] = inp[k];
    send({ t: 'in', h, e: sent.cnt });
  }

  // ---------- link ----------
  let lastHeard = 0, lastPing = 0, lastSnap = 0, lastVps = '', retryAt = 0, joinBy = 0;
  // The screen a guest coming back should be on; null while a round runs with nothing over it.
  let lastScreen = null, helloSent = false;
  const send = (m) => O.link && O.link.send(enc(m));
  // Frames go only into a snapshot that is sent: one taken for anything else would swallow them.
  const sendSnap = () => send(Object.assign(O.snapshot(), { frames: frameQ.splice(0) }));

  function ui(name, ...args) {
    const f = TR.UI && TR.UI[name];
    if (f) f(...args);
  }

  function setStatus(text) {
    O.status = text;
    ui('onlineStatus', text);
  }

  function open(role, code, linkFor) {
    O.role = role;
    O.code = code;
    O.snaps = [];
    O.offset = Infinity;
    O.lost = null;
    O.peer = null;
    lastHeard = now();
    joinBy = now() + JOIN_MS;
    O.link = linkFor(handlers(role));
    TR.Input.sources = role === 'host' ? [bothMaps, remoteInput] : [null, null];
  }

  function handlers(role) {
    return {
      onReady: () => setStatus('Oda kodu: ' + O.code + ' · rakip bekleniyor…'),
      onOpen: () => {
        lastHeard = now();
        if (role === 'guest') {
          const s = TR.Settings.get();
          helloSent = true;
          send({ t: 'hello', name: s.onlineName, assist: s.onlineAssist, rejoin: !!O.lost });
        }
      },
      onData: (text) => {
        lastHeard = now();
        receive(dec(text));
      },
      onClose: () => linkLost(),
      onError: (kind) => {
        // The broker only introduces the two sides. A match runs on the data channel, and the dead check
        // sees it if that goes too.
        if (O.peer || O.lost) return;
        const why = { taken: 'Bu oda kodu kullanımda, yeniden deneyin.', missing: 'Bu kodla açık bir oda yok.' }[kind] ||
          'Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin.';
        O.leave(why, true);
      },
    };
  }

  O.host = () => {
    if (O.role) O.leave(null, true);
    const code = TR.Net.makeCode();
    open('host', code, (h) => TR.Net.host(code, h));
    setStatus('Oda kuruluyor…');
  };

  O.join = (raw) => {
    const code = TR.Net.cleanCode(raw);
    if (code.length !== TR.Net.CODE_LEN) return setStatus('Oda kodu ' + TR.Net.CODE_LEN + ' harf olmalı.');
    if (O.role) O.leave(null, true);
    open('guest', code, (h) => TR.Net.join(code, h));
    setStatus('Bağlanılıyor…');
  };

  // quiet leaves without telling the other side, for a link that never opened or already broke.
  O.leave = (why, quiet) => {
    if (!O.role) return;
    if (!quiet) send({ t: 'bye' });
    const link = O.link;
    O.link = null;
    O.role = null;
    O.peer = null;
    O.lost = null;
    O.snaps = [];
    lastScreen = null;
    TR.Input.sources = [null, null];
    recording = false;
    if (link) link.close();
    ui('netWait', null);
    if (why != null) ui('onlineLeft', why);
  };

  function linkLost() {
    if (!O.role || O.lost) return;
    if (O.role === 'host' && !O.peer) return;
    O.lost = { until: now() + REJOIN_S * 1000 };
    if (O.role === 'host') {
      // What happens while the guest is away is not recorded: it would all play at once on its return.
      audioQ.length = 0;
      fxQ.length = 0;
      O.link.drop();
      if (G().state === 'play' || G().state === 'countdown') G().pause();
    } else retryAt = now() + RETRY_MS;
  }

  function relinked() {
    O.lost = null;
    ui('netWait', null);
  }

  // ---------- messages ----------
  function receive(m) {
    if (m.t === 'ping') return;
    if (m.t === 'bye') return O.leave(O.role === 'host' ? 'Rakip maçtan çıktı.' : 'Oda kapandı.', true);
    if (O.role === 'host') hostReceive(m);
    else guestReceive(m);
  }

  // The guest's keys, views and route pick go into the host's own simulation every frame, so they are taken
  // only in the shape a real guest sends. A view is no larger than MAX_VIEW on a side.
  const MAX_VIEW = 8192;
  const unit = (v) => (Number.isFinite(v) ? U.clamp(v, -1, 1) : 0);
  const held = (h) => (h ? { thr: unit(h.thr), steer: unit(h.steer), mx: unit(h.mx), my: unit(h.my), brake: !!h.brake } : NO_KEYS);
  const counts = (e) => Object.fromEntries(EDGES.map((k) => [k, Number.isFinite(e && e[k]) ? e[k] : 0]));
  const side = (v) => Number.isFinite(v) && v >= 1 && v <= MAX_VIEW;
  const viewSizes = (vps) => (Array.isArray(vps) ? vps : [])
    .filter((v) => v && (v.idx === HOST || v.idx === GUEST) && side(v.w) && side(v.h))
    .slice(0, 2)
    .map((v) => ({ idx: v.idx, w: v.w, h: v.h }));

  function hostReceive(m) {
    if (m.t === 'hello') {
      const first = !O.peer;
      // The guest's name and assist end up in the host's records and screens like a local player's.
      const assist = TR.ASSIST_LEVELS.some((l) => l.id === m.assist) ? m.assist : 'hafif';
      O.peer = { name: String(m.name || '').trim().slice(0, 14) || 'Kırmızı Tır', assist };
      O.vps = [];
      remote.sync = true;
      send({ t: 'welcome', name: TR.Settings.get().onlineName, fp: TR.Referee.fingerprint() });
      O.status = 'Oda ' + O.code + ' · rakip: ' + O.peer.name;
      if (first) return ui('onlineGuestJoined', O.peer);
      relinked();
      // A guest back from a dropped link rebuilds the round and screen it missed. The snapshot comes after
      // the round, which clears the winner, and before a result screen, which reads it. The guest's referee
      // starts over from that snapshot.
      if (G().map && G().state !== 'menu') {
        send({ t: 'round', o: G().roundOpts, series: G().series, layout: O.layout() });
        sendSnap();
      }
      if (lastScreen) send(lastScreen);
    } else if (m.t === 'in') {
      const cnt = counts(m.e);
      if (remote.sync) {
        remote.used = Object.assign({}, cnt);
        remote.sync = false;
      }
      remote.held = held(m.h);
      remote.cnt = cnt;
      remote.at = now();
    } else if (m.t === 'vps') O.vps = viewSizes(m.vps);
    else if (m.t === 'pause') G().pause();
    else if (m.t === 'resume') G().resume();
    else if (m.t === 'pick' && Number.isInteger(m.i) && m.i >= 0 && m.i < TR.ROUTES.length) ui('remotePick', m.i);
  }

  const refereeOff = () => (TR.Referee.off ? ' ' + TR.Referee.off : '');
  function guestReceive(m) {
    // A host answers a hello with the round still on, if any, so a round right after the welcome is one this
    // guest comes back into, not one that starts.
    const back = helloSent && m.t === 'round';
    if (m.t !== 'welcome') helloSent = false;
    if (m.t === 'welcome') {
      O.peer = { name: m.name };
      TR.Referee.peer(m.fp);
      if (O.lost) return relinked();
      return setStatus('Bağlandı. ' + m.name + ' maç ayarlarını yapıyor…' + refereeOff());
    }
    if (m.t === 'round') {
      G().series = m.series;
      G().startRound(m.o.ri, m.o);
      TR.Referee.reset(G().players, G().route, m.series, back);
      G().map.segs.forEach(({ road, events }, k) => {
        const l = m.layout.segs[k];
        road.signList = l.signs;
        events.flocks = l.flocks;
        events.works = l.works;
      });
      O.snaps = [];
      return ui('hideAll');
    }
    if (m.t === 'snap') {
      TR.Referee.check(m);
      O.offset = Math.min(O.offset, now() - m.ts);
      O.snaps.push(m);
      if (O.snaps.length > BUFFER) O.snaps.shift();
      return;
    }
    if (m.series) G().series = m.series;
    if (m.t === 'routes') ui('mirrorRoutes', m.picks, m.ready);
    else if (m.t === 'pause') ui('showPause');
    else if (m.t === 'resume') ui('hideAll');
    else if (m.t === 'roundResult') ui('mirrorRoundResult', m.scores, m.titles);
    else if (m.t === 'matchResult') ui('mirrorMatchResult');
    else if (m.t === 'wait') {
      setStatus(m.text + refereeOff());
      ui('mirrorWait');
    }
  }

  // ---------- host side ----------
  // What the host's game and menus tell the guest. A screen goes after a fresh snapshot so the guest shows
  // the state the screen is about.
  O.share = (type, data) => {
    if (O.role !== 'host') return;
    if (type === 'round') {
      recording = true;
      audioQ.length = 0;
      fxQ.length = 0;
      frameQ.length = 0;
      lastScreen = null;
      return send({ t: 'round', o: data, series: G().series, layout: O.layout() });
    }
    if (inRound() || type === 'roundResult') sendSnap();
    const m = Object.assign({ t: type, series: G().series }, data);
    lastScreen = type === 'resume' ? null : m;
    if (type === 'roundResult' || type === 'matchResult') recording = false;
    send(m);
  };

  // The guest's own controls, which a guest sends to the host instead of acting on them.
  O.ask = (type, data) => {
    if (O.role !== 'guest') return false;
    send(Object.assign({ t: type }, data));
    return true;
  };

  O.remoteViewports = () => (O.role === 'host' && O.peer && !O.lost ? O.vps || [] : []);
  O.soloIdx = () => (O.role && TR.Settings.get().onlineView === 'tek' ? me() : -1);
  O.meIdx = me;

  // Called every frame by the game loop, after the simulation step.
  O.tick = (t) => {
    if (!O.role) return;
    if (O.lost) {
      const left = Math.ceil((O.lost.until - t) / 1000);
      if (left <= 0) return O.leave(O.role === 'host' ? 'Rakip geri dönmedi.' : 'Odaya yeniden bağlanılamadı.', true);
      ui('netWait', O.role === 'host'
        ? 'Bağlantı koptu. ' + O.peer.name + ' bekleniyor… ' + left
        : 'Bağlantı koptu. Yeniden bağlanılıyor… ' + left);
      if (O.role === 'guest' && t >= retryAt) {
        retryAt = t + RETRY_MS;
        if (O.link) O.link.close();
        O.link = TR.Net.join(O.code, handlers('guest'));
      }
      return;
    }
    if (O.role === 'guest' && !O.peer && t > joinBy) return O.leave('Odaya bağlanılamadı. Kodu kontrol edip yeniden deneyin.', true);
    if (O.peer && t - lastHeard > DEAD_MS) return linkLost();
    const pinged = t - lastPing > PING_MS;
    if (pinged) {
      lastPing = t;
      send({ t: 'ping' });
    }
    if (O.role === 'guest') {
      if (!O.peer) return;
      sendInput();
      // Sent on every change and again with each ping, so a host that lost one still learns it.
      const sizes = G().viewSizes(), vps = JSON.stringify(sizes);
      if (vps !== lastVps || pinged) {
        lastVps = vps;
        send({ t: 'vps', vps: sizes });
      }
    } else if (O.peer && G().state !== 'paused' && inRound() && t - lastSnap >= 1000 / SNAP_HZ) {
      lastSnap = t;
      sendSnap();
    }
  };
})();
