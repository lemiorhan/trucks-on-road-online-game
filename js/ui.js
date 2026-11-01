'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U, G = TR.Game, ON = TR.Online;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['intro', 'title', 'online', 'setup', 'routes', 'howto', 'settings', 'scores', 'pause', 'roundResult', 'matchResult'];
  const SUB = ['howto', 'settings', 'scores'];
  const RESULT_LOCK_MS = 1200;
  const INTRO_MS = 6500;
  // Names are typed by users, and an online guest fills its result screens from what the host sends; all of
  // it ends up in innerHTML.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // solo: the setup screen is for a solo series; once one runs, G.series.solo says so.
  const UI = (TR.UI = { current: null, returnTo: 'title', lockT: 0, picks: [0, 0], ready: [false, false], confirmYes: null, solo: false });
  const solo = () => (G.series ? G.series.solo : UI.solo);

  function show(id) {
    // A control left focused (a checkbox in settings, say) would react to the players' Space/Enter.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
    document.body.classList.toggle('guest', ON.role === 'guest');
    document.body.classList.toggle('net', !!ON.role);
    document.body.classList.toggle('solo', !!solo());
    UI.current = id;
    UI.lockT = performance.now() + (id === 'roundResult' || id === 'matchResult' ? RESULT_LOCK_MS : 150);
  }
  UI.hideAll = () => show(null);

  function openSub(id) {
    UI.returnTo = UI.current;
    if (id === 'settings') fillSettings();
    if (id === 'scores') fillScores();
    show(id);
  }

  function back() {
    const c = UI.current;
    if (SUB.includes(c)) return show(UI.returnTo || 'title');
    if (c === 'online' || (c === 'setup' && ON.role)) return toTitle();
    if (c === 'setup') {
      UI.solo = false;
      return show('title');
    }
    if (c === 'routes') {
      if (ON.role === 'guest') return confirmBox('Online maçtan çıkılsın mı?', toTitle);
      if (G.series && G.series.history.length) return confirmBox('Maçtan çıkılsın mı? Bu maçın toplam puanı kaybolur.', toTitle);
      const alone = G.series.solo;
      G.toMenu();
      return openSetup(alone);
    }
    if (c === 'pause') return G.resume();
    if (c === 'matchResult') return toTitle();
  }

  // Leaving any screen for the title also ends an online match, for the other machine too.
  function toTitle() {
    ON.leave(null);
    G.toMenu();
    UI.solo = false;
    show('title');
  }

  function endIntro() {
    if (UI.current === 'intro') show('title');
  }

  function confirmBox(text, yes) {
    $('confirmText').textContent = text;
    UI.confirmYes = yes;
    $('confirm').classList.remove('hidden');
    UI.lockT = performance.now() + 150;
  }

  function closeConfirm(ok) {
    $('confirm').classList.add('hidden');
    const f = UI.confirmYes;
    UI.confirmYes = null;
    if (ok && f) f();
  }

  // ---------- setup ----------
  function segSet(id, value) {
    $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === value));
  }

  const clean = (v, d) => (v || '').trim().slice(0, 14) || d;
  const assistName = (id) => (TR.ASSIST_LEVELS.find((l) => l.id === id) || { name: id }).name;

  // Online, the players' names and assists come from each one's online screen, so the host's setup shows
  // only the match settings.
  function openSetup(alone) {
    const s = TR.Settings.get();
    UI.solo = !!alone;
    $('setupTitle').textContent = UI.solo ? 'Tek Başına' : 'Yeni Maç';
    $('name1').value = s.names[0];
    $('name2').value = s.names[1];
    segSet('segRounds', String(s.rounds));
    segSet('segTraffic', s.traffic);
    segSet('segWeather', s.weather);
    segSet('segAssist1', s.assist[0]);
    segSet('segAssist2', s.assist[1]);
    const net = ON.role === 'host';
    $('setup').classList.toggle('online', net);
    $('setupOnline').classList.toggle('hidden', !net);
    if (net) {
      $('setupOnline').innerHTML = '<b>Mavi:</b> ' + esc(s.onlineName) + ' · yardım ' + esc(assistName(s.onlineAssist)) +
        ' &nbsp; <b>Kırmızı:</b> ' + esc(ON.peer.name) + ' · yardım ' + esc(assistName(ON.peer.assist));
      ON.share('wait', { text: s.onlineName + ' maç ayarlarını yapıyor…' });
    }
    show('setup');
  }

  function startMatch() {
    const s = TR.Settings.get();
    if (ON.role === 'host') G.newSeries([s.onlineName, ON.peer.name], [s.onlineAssist, ON.peer.assist]);
    else {
      TR.Settings.set({ names: [clean($('name1').value, 'Mavi Tır'), clean($('name2').value, 'Kırmızı Tır')] });
      $('name1').blur();
      $('name2').blur();
      G.newSeries(null, null, UI.solo);
    }
    openRoutes();
  }

  // ---------- online ----------
  function openOnline() {
    const s = TR.Settings.get();
    $('onlineName').value = s.onlineName;
    segSet('segAssistOnline', s.onlineAssist);
    const ok = TR.Net.available();
    $('btnHost').disabled = !ok;
    $('btnJoin').disabled = !ok;
    UI.onlineStatus(ok ? ON.status : 'Bağlantı kütüphanesi yüklenemedi. Online maç için internet bağlantısı gerekir.');
    show('online');
  }

  function saveOnlineName() {
    TR.Settings.set({ onlineName: clean($('onlineName').value, 'Oyuncu') });
  }

  function hostRoom() {
    saveOnlineName();
    ON.host();
  }

  function joinRoom() {
    saveOnlineName();
    ON.join($('onlineCode').value);
  }

  UI.onlineStatus = (text) => {
    $('onlineStatus').textContent = text || '';
  };

  UI.onlineGuestJoined = () => openSetup();

  UI.onlineLeft = (why) => {
    $('confirm').classList.add('hidden');
    G.toMenu();
    ON.status = '';
    openOnline();
    UI.onlineStatus(why);
  };

  UI.netWait = (text) => {
    $('netwait').classList.toggle('hidden', text == null);
    if (text != null) $('netwaitText').textContent = text;
  };

  UI.mirrorWait = () => {
    if (UI.current !== 'online') openOnline();
  };

  UI.remotePick = (i) => {
    if (UI.current !== 'routes' || UI.ready[1]) return;
    UI.picks[1] = i;
    refreshRoutes();
  };

  UI.mirrorRoutes = (picks, ready) => {
    if (UI.current !== 'routes') openRoutes();
    UI.picks = picks;
    UI.ready = ready;
    refreshRoutes();
  };

  // A guest back from a dropped link or a reload is shown the result screen again, which it may or may not
  // have seen and recorded before; it keeps the results it has recorded, across reloads.
  function firstSight(key) {
    const seen = TR.Store.load('netSeen', []);
    if (seen.includes(key)) return false;
    TR.Store.save('netSeen', [key].concat(seen).slice(0, 20));
    return true;
  }

  UI.mirrorRoundResult = (scores, titles) => {
    ON.applyLatest();
    const fresh = firstSight(G.series.id + ':' + G.series.history.length);
    UI.showRoundResult(scores, fresh ? G.recordRound(scores) : scores.map(() => -1), titles);
    refereeLine('rrReferee', false);
  };

  UI.mirrorMatchResult = () => {
    showMatchResult(!firstSight(G.series.id + ':match'));
    refereeLine('mrReferee', true);
  };

  function refereeLine(id, whole) {
    const text = TR.Referee.line(G.series.names, whole);
    $(id).textContent = text;
    $(id).classList.toggle('hidden', !text);
  }

  // ---------- route select ----------
  // A card's par is the theme's nominal span; the round's own map may run up to MAP.LEN_TOL longer.
  const approxPar = (r) => '≈ ' + U.fmtTime(TR.parTime(r.length)).replace(/\.\d$/, '');

  // "Tünel ×2 · Köprü": the theme's pool, which the round's map places anywhere on its segments.
  function featureList(r) {
    const seen = [];
    for (const f of r.features) {
      const name = TR.featureName(f), e = seen.find((x) => x.name === name);
      if (e) e.n++;
      else seen.push({ name, n: 1 });
    }
    return seen.map((x) => x.name + (x.n > 1 ? ' ×' + x.n : '')).join(' · ');
  }

  function buildRoutes() {
    const box = $('routeCards');
    TR.ROUTES.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'route';
      el.dataset.i = i;
      el.innerHTML =
        '<div class="route-tag">' + r.tag + '</div><h3>' + r.name + '</h3>' +
        '<div class="route-level" title="Zorluk ' + r.level + ' / 5">' +
        '<b>' + '●'.repeat(r.level) + '</b>' + '●'.repeat(5 - r.level) + '</div><p>' + r.desc + '</p>' +
        '<div class="route-meta">≈ ' + (r.length / 10000).toFixed(1).replace('.', ',') + ' km · par ' + approxPar(r) + '</div>' +
        (r.features && r.features.length ? '<div class="route-feats">' + featureList(r) + '</div>' : '') +
        '<div class="picks"><span class="pk p1">1</span><span class="pk p2">2</span></div>';
      // Online, a click picks for the player at this machine only.
      el.addEventListener('click', () => {
        TR.Audio.unlock();
        if (ON.ask('pick', { i })) return;
        if (!UI.ready[0]) UI.picks[0] = i;
        if (!UI.ready[1] && !ON.role) UI.picks[1] = i;
        refreshRoutes();
      });
      box.appendChild(el);
    });
  }

  function openRoutes() {
    G.state = 'menu';
    UI.ready = [false, false];
    const sr = G.series;
    const next = sr.history.length + 1;
    $('standRound').textContent = 'Tur ' + next + ' / ' + sr.rounds + (TR.isFinalRound(sr, next) ? ' · FİNAL, puanlar ×' + TR.SCORE_RULES.finalMult : '');
    $('standP1').textContent = sr.names[0] + '  ' + sr.totals[0];
    $('standP2').textContent = sr.solo ? '' : sr.totals[1] + '  ' + sr.names[1];
    $('routesName1').textContent = sr.names[0];
    $('routesName2').textContent = sr.solo ? '' : sr.names[1];
    refreshRoutes();
    show('routes');
  }

  function refreshRoutes() {
    const alone = solo();
    document.querySelectorAll('.route').forEach((el) => {
      const i = +el.dataset.i;
      el.classList.toggle('sel1', UI.picks[0] === i);
      el.classList.toggle('sel2', !alone && UI.picks[1] === i);
    });
    $('ready1').classList.toggle('on', UI.ready[0]);
    $('ready2').classList.toggle('on', UI.ready[1]);
    const keys = ON.role || alone ? ['Space / Enter', 'Space / Enter'] : ['Space', 'Enter'];
    $('ready1').textContent = UI.ready[0] ? 'HAZIR ✔' : 'Hazır mısın? (' + keys[0] + ')';
    $('ready2').textContent = UI.ready[1] ? 'HAZIR ✔' : 'Hazır mısın? (' + keys[1] + ')';
    $('pickNote').textContent = alone
      ? 'Yollar her tur yeniden çizilir. Par süreden hızlı bitirirsen hız bonusu alırsın.'
      : UI.picks[0] === UI.picks[1]
        ? 'İki oyuncu da aynı haritayı seçti. Yollar her tur yeniden çizilir.'
        : 'Farklı haritalar seçildi: ikiniz de hazır olunca yazı-tura atılacak.';
    G.previewIdx = UI.picks[ON.meIdx()];
    ON.share('routes', { picks: UI.picks, ready: UI.ready });
  }

  function routesInput() {
    const n = TR.ROUTES.length, count = G.series.names.length;
    for (let i = 0; i < count; i++) {
      const inp = G.input(i);
      if (!UI.ready[i] && inp.left) { UI.picks[i] = (UI.picks[i] + n - 1) % n; refreshRoutes(); }
      if (!UI.ready[i] && inp.right) { UI.picks[i] = (UI.picks[i] + 1) % n; refreshRoutes(); }
      if (inp.action) {
        TR.Audio.unlock();
        UI.ready[i] = !UI.ready[i];
        TR.Audio.beep();
        refreshRoutes();
      }
    }
    if (UI.ready.slice(0, count).every(Boolean)) startRound();
  }

  function startRound() {
    let ri = UI.picks[0], note = null;
    if (!G.series.solo && UI.picks[0] !== UI.picks[1]) {
      ri = UI.picks[Math.random() < 0.5 ? 0 : 1];
      note = 'Yazı-tura: ' + TR.ROUTES[ri].name;
    }
    G.startRound(ri);
    UI.hideAll();
    if (note) G.players.forEach((p) => { p.toast = note; p.toastColor = '#ffd54f'; p.toastT = 3.5; });
  }

  // ---------- results ----------
  UI.showPause = () => show('pause');

  UI.showRoundResult = (scores, places, titles) => {
    const sr = G.series, w = G.winner;
    $('rrTitle').textContent = w.name.toUpperCase() + (sr.solo ? ' TURU BİTİRDİ!' : ' TURU KAZANDI!');
    $('rrTitle').style.color = w.color;
    $('rrSub').textContent = 'Tur ' + sr.history.length + ' / ' + sr.rounds + ' · ' + G.route.name + ' · ' + U.fmtTime(w.times.unload);
    const seg = (a, b) => (a != null && b != null ? U.fmtTime(a - b) : '—');
    $('rrBody').innerHTML = G.players.map((p, i) => {
      const sc = scores[i], t = p.times;
      const rows = sc.items.map((it) => '<tr><td>' + esc(it.label) + '</td><td class="' + (it.pts < 0 ? 'neg' : 'pos') + '">' +
        (it.pts > 0 ? '+' : '') + Number(it.pts) + '</td></tr>').join('') || '<tr><td colspan="2" class="muted">Puan yok</td></tr>';
      const floor = sc.sum < 0 ? '<div class="muted small">Tur puanı 0\'ın altına düşmez.</div>' : '';
      const place = places[i] >= 0 ? '<div class="badge">🏅 Rekor listesinde ' + (places[i] + 1) + '. sıra</div>' : '';
      const mult = sc.mult > 1 ? '<tr><td>Final turu ×' + Number(sc.mult) + '</td><td class="pos">+' + (sc.total - sc.base) + '</td></tr>' : '';
      const chips = titles[i].map((t) => '<span class="title-chip">' + esc(t) + '</span>').join('');
      return '<div class="rr-col" style="--pc:' + esc(p.color) + '"><h3>' + esc(p.name) + (p === w ? ' 🏆' : '') + '</h3>' +
        (chips ? '<div class="titles">' + chips + '</div>' : '') +
        '<table class="score">' + rows + mult + '<tr class="sum"><td>Tur puanı</td><td>' + Number(sc.total) + '</td></tr>' +
        '<tr class="sum total"><td>Maç toplamı</td><td>' + Number(sr.totals[i]) + '</td></tr></table>' + floor +
        '<div class="times">Yarış ' + U.fmtTime(t.race) + ' · Park ' + seg(t.park, t.race) + ' · Boşaltma ' + seg(t.unload, t.park) + '</div>' +
        place + '</div>';
    }).join('');
    $('btnNext').textContent = G.isLastRound() ? 'Maç sonucu (Enter)' : 'Sonraki tur (Enter)';
    show('roundResult');
  };

  function nextFromRound() {
    if (G.isLastRound()) showMatchResult();
    else openRoutes();
  }

  function showMatchResult(recorded) {
    if (G.series.solo) return showSoloResult();
    const sr = G.series;
    const [a, b] = sr.totals;
    const champ = a === b ? -1 : a > b ? 0 : 1;
    $('mrTitle').textContent = champ < 0 ? 'BERABERE!' : sr.names[champ].toUpperCase() + ' ŞAMPİYON!';
    $('mrTitle').style.color = champ < 0 ? '#fff' : ['#1e88e5', '#e53935'][champ];
    $('mrTotals').innerHTML =
      '<div class="tot p1"><span>' + esc(sr.names[0]) + '</span><b>' + Number(a) + '</b><small>' + Number(sr.wins[0]) + ' tur</small></div>' +
      '<div class="vs">–</div>' +
      '<div class="tot p2"><span>' + esc(sr.names[1]) + '</span><b>' + Number(b) + '</b><small>' + Number(sr.wins[1]) + ' tur</small></div>';
    $('mrHead1').textContent = sr.names[0];
    $('mrHead2').textContent = sr.names[1];
    $('mrHead3').textContent = 'Kazanan';
    $('mrBody').innerHTML = sr.history.map((h, k) =>
      '<tr><td>' + (k + 1) + '</td><td>' + esc(h.route) + '</td><td>' + Number(h.scores[0]) + '</td><td>' + Number(h.scores[1]) + '</td><td>' +
      esc(sr.names[h.winner]) + ' · ' + U.fmtTime(h.time) + '</td></tr>').join('');
    if (!recorded) TR.Scores.addMatch({ date: Date.now(), names: sr.names.slice(), totals: sr.totals.slice(), champ, rounds: sr.rounds });
    G.state = 'matchover';
    show('matchResult');
    ON.share('matchResult');
  }

  // Solo matches are never online, so they are recorded every time.
  function showSoloResult() {
    const sr = G.series, total = sr.totals[0];
    $('mrTitle').textContent = 'MAÇ BİTTİ!';
    $('mrTitle').style.color = '#fff';
    $('mrTotals').innerHTML = '<div class="tot p1"><span>' + esc(sr.names[0]) + '</span><b>' + Number(total) + '</b><small>' +
      Number(sr.rounds) + ' tur · toplam puan</small></div>';
    $('mrHead1').textContent = sr.names[0];
    $('mrHead2').textContent = '';
    $('mrHead3').textContent = 'Süre';
    $('mrBody').innerHTML = sr.history.map((h, k) =>
      '<tr><td>' + (k + 1) + '</td><td>' + esc(h.route) + '</td><td>' + Number(h.scores[0]) + '</td><td class="duo-only"></td><td>' +
      U.fmtTime(h.time) + '</td></tr>').join('');
    TR.Scores.addMatch({ date: Date.now(), names: sr.names.slice(), totals: sr.totals.slice(), champ: 0, rounds: sr.rounds, solo: true });
    G.state = 'matchover';
    show('matchResult');
  }

  function rematch() {
    G.newSeries(null, null, G.series.solo);
    openRoutes();
  }

  // ---------- settings and scores ----------
  function applySettings() {
    const s = TR.Settings.get();
    TR.Audio.setMuted(!s.sound);
    TR.Audio.setVolume(s.volume);
  }

  function fillSettings() {
    const s = TR.Settings.get();
    $('setSound').checked = s.sound;
    $('setVolume').value = Math.round(s.volume * 100);
    $('setShake').checked = s.shake;
    $('setAutoPause').checked = s.autoPause;
    segSet('segOnlineView', s.onlineView);
  }

  function fillScores() {
    const day = (t) => new Date(t).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const rounds = TR.Scores.rounds();
    const assistTag = (id) => {
      const lv = TR.ASSIST_LEVELS.find((l) => l.id === id);
      return lv && lv.id !== 'kapali' ? ' <span class="tag">yardım: ' + lv.name + '</span>' : '';
    };
    $('hiBody').innerHTML = rounds.length
      ? rounds.map((r, k) => '<tr><td>' + (k + 1) + '</td><td><span class="dot" style="--pc:' + esc(r.color) + '"></span>' + esc(r.name) +
        assistTag(r.assist) + (r.solo ? ' <span class="tag">tek başına</span>' : '') + '</td><td>' + esc(r.route) + '</td><td><b>' + Number(r.score) + '</b></td><td>' + day(r.date) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="muted">Henüz kayıtlı tur yok.</td></tr>';
    const matches = TR.Scores.matches();
    $('matchBody').innerHTML = matches.length
      ? matches.map((m) => '<tr><td>' + day(m.date) + '</td><td>' + (m.solo
        ? esc(m.names[0]) + ' ' + Number(m.totals[0]) + ' <span class="tag">tek başına</span>'
        : esc(m.names[0]) + ' ' + Number(m.totals[0]) + ' – ' + Number(m.totals[1]) + ' ' + esc(m.names[1])) +
        '</td><td>' + Number(m.rounds) + ' tur</td><td>' + (m.solo ? '—' : m.champ < 0 ? 'Berabere' : esc(m.names[m.champ])) + '</td></tr>').join('')
      : '<tr><td colspan="4" class="muted">Henüz bitmiş maç yok.</td></tr>';
  }

  function fillHowto() {
    $('ruleBody').innerHTML = TR.scoreRuleRows().map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
    $('parList').textContent = TR.ROUTES.map((r) => r.name + ' ' + approxPar(r)).join(' · ');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ---------- keyboard ----------
  UI.handleKeys = () => {
    const I = TR.Input;
    const enter = ['Enter', 'NumpadEnter'];
    if (!$('confirm').classList.contains('hidden')) {
      if (performance.now() < UI.lockT) return;
      if (I.wasHit(enter)) closeConfirm(true);
      else if (I.wasHit(['Escape'])) closeConfirm(false);
      return;
    }
    const c = UI.current;
    if (c === null) {
      if (I.wasHit(['Escape', 'KeyP'])) G.pause();
      return;
    }
    if (performance.now() < UI.lockT) return;
    // A guest's route keys reach the host as its input; the host moves the match on.
    const guest = ON.role === 'guest';
    if (c === 'routes') {
      if (I.wasHit(['Escape'])) back();
      else if (!guest) routesInput();
    } else if (c === 'pause') {
      if (I.wasHit(['Escape', 'KeyP'])) G.resume();
    } else if (c === 'intro') {
      if (I.wasHit(enter.concat('Escape', 'Space'))) endIntro();
    } else if (c === 'title') {
      if (I.wasHit(enter)) openSetup();
    } else if (c === 'online') {
      if (I.wasHit(enter) && TR.Net.cleanCode($('onlineCode').value).length === TR.Net.CODE_LEN) joinRoom();
      else if (I.wasHit(['Escape'])) back();
    } else if (c === 'setup') {
      if (I.wasHit(enter)) startMatch();
      else if (I.wasHit(['Escape'])) back();
    } else if (c === 'roundResult') {
      if (!guest && I.wasHit(enter.concat('Space'))) nextFromRound();
    } else if (c === 'matchResult') {
      if (!guest && I.wasHit(enter.concat('Space'))) rematch();
      else if (I.wasHit(['Escape'])) toTitle();
    } else if (I.wasHit(['Escape'])) back();
  };

  // ---------- wiring ----------
  function init() {
    applySettings();
    buildRoutes();
    fillHowto();
    const go = { setup: () => openSetup(false), solo: () => openSetup(true), online: openOnline };
    document.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => (go[b.dataset.go] ? go[b.dataset.go]() : openSub(b.dataset.go))));
    $('btnHost').addEventListener('click', hostRoom);
    $('btnJoin').addEventListener('click', joinRoom);
    $('onlineName').addEventListener('change', saveOnlineName);
    $('btnNetLeave').addEventListener('click', toTitle);
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));
    document.querySelectorAll('.seg').forEach((seg) =>
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        let v = seg.dataset.key === 'rounds' ? +b.dataset.v : b.dataset.v;
        // A seg with data-idx sets one player's entry of a per-player list.
        if (seg.dataset.idx != null) {
          const list = TR.Settings.get()[seg.dataset.key].slice();
          list[+seg.dataset.idx] = v;
          v = list;
        }
        TR.Settings.set({ [seg.dataset.key]: v });
        segSet(seg.id, b.dataset.v);
      })));
    $('btnSetupGo').addEventListener('click', startMatch);
    $('btnRouteStart').addEventListener('click', startRound);
    $('btnResume').addEventListener('click', () => G.resume());
    $('btnRestart').addEventListener('click', () => confirmBox('Bu tur baştan başlasın mı? Turdaki puanlar silinir.', () => {
      G.restartRound();
      UI.hideAll();
    }));
    $('btnPauseMenu').addEventListener('click', () => confirmBox('Ana menüye dönülsün mü? Bu maçın puanları kaydedilmez.', toTitle));
    $('btnNext').addEventListener('click', nextFromRound);
    $('btnRematch').addEventListener('click', rematch);
    $('btnMatchMenu').addEventListener('click', toTitle);
    $('btnYes').addEventListener('click', () => closeConfirm(true));
    $('btnNo').addEventListener('click', () => closeConfirm(false));
    $('btnFullscreen').addEventListener('click', toggleFullscreen);
    $('btnClearScores').addEventListener('click', () => confirmBox('Tüm skorlar silinsin mi?', () => {
      TR.Scores.clear();
      fillScores();
    }));
    $('setSound').addEventListener('change', (e) => { TR.Settings.set({ sound: e.target.checked }); applySettings(); });
    $('setVolume').addEventListener('input', (e) => { TR.Settings.set({ volume: e.target.value / 100 }); applySettings(); });
    $('setShake').addEventListener('change', (e) => TR.Settings.set({ shake: e.target.checked }));
    $('setAutoPause').addEventListener('change', (e) => TR.Settings.set({ autoPause: e.target.checked }));
    // Fullscreen needs a user gesture, so it is handled in the key event itself rather than in the frame loop.
    // F sits next to P1's D and E, so it is ignored while a round is running.
    const driving = () => ['countdown', 'play', 'finishing'].includes(TR.Game.state);
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF' || driving()) return;
      if (!(e.target instanceof HTMLInputElement && e.target.type === 'text')) toggleFullscreen();
    });
    window.addEventListener('keydown', () => TR.Audio.unlock(), { once: true });
    // A focused button would swallow the players' Space/Enter presses.
    document.addEventListener('click', (e) => {
      if (e.target instanceof HTMLButtonElement) e.target.blur();
    });
    $('btnSkipIntro').addEventListener('click', endIntro);
    show('intro');
    setTimeout(endIntro, INTRO_MS);
    G.start();
  }

  init();
})();
