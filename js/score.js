'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;

  const RULES = (TR.SCORE_RULES = {
    firstToLot: 200,
    parkMax: 200,
    perBox: 50,
    win: 500,
    speedPerSec: 2,
    crash: -100,
    bump: -20,
    reset: -50,
    finalMult: 2,
    nearMiss: 30,
    nearMissMax: 5,
    redLight: -60,
    speeding: -40,
    contract: 150,
    contractBumps: 2,
    contractPark: 150,
    contractNear: 2,
  });

  // Both players get the same task each round. Every way to fail one is permanent within the round:
  // the counters only grow, and parkPts and the park time are set once.
  TR.CONTRACTS = [
    { text: 'Hiç kaza yapma', state: (p) => (p.crashes ? 'fail' : 'run') },
    { text: 'Kurtarma tuşuna basma', state: (p) => (p.resets ? 'fail' : 'run') },
    { text: 'En fazla ' + RULES.contractBumps + ' temas', state: (p) => (p.bumps > RULES.contractBumps ? 'fail' : 'run') },
    {
      text: 'Park puanı en az ' + RULES.contractPark,
      state: (p) => (p.stats.parkPts == null ? 'run' : p.stats.parkPts >= RULES.contractPark ? 'ok' : 'fail'),
    },
    {
      text: 'En az ' + RULES.contractNear + ' kıl payı',
      state: (p) => (p.nearMisses >= RULES.contractNear ? 'ok' : p.times.park == null ? 'run' : 'fail'),
    },
  ];

  TR.contractPays = (c, p) => p.times.park != null && c.state(p) !== 'fail';

  // The last round of a match of several rounds counts RULES.finalMult times.
  TR.isFinalRound = (sr, round = sr.round) => sr.rounds > 1 && round === sr.rounds;

  // Every second the winner saves under the par time of the map's shortest path is worth RULES.speedPerSec.
  TR.parTime = (length) => Math.round(length / 120 + 120);

  TR.parkPrecision = (st) => {
    const a = U.clamp(1 - st.angleErr / TR.LOT.ANGLE_TOL, 0, 1);
    const l = U.clamp(1 - Math.abs(st.lateral) / TR.LOT.LATERAL_MAX, 0, 1);
    return Math.round((RULES.parkMax * (a + l)) / 2);
  };

  // Rows for the scoring table on the how-to screen; kept next to RULES so the two cannot drift.
  TR.scoreRuleRows = () => [
    ['Park alanına ilk giren', '+' + RULES.firstToLot],
    ['Park hassasiyeti (dorse açısı ve ortalama)', '0 … +' + RULES.parkMax],
    ['Hedefte doğru yerdeki her kutu', '+' + RULES.perBox],
    ['Turu kazanan', '+' + RULES.win],
    ['Hız bonusu (kazanan, par süreden kalan her saniye)', '+' + RULES.speedPerSec],
    ['Kaza (araca çarpma)', String(RULES.crash)],
    ['Bariyere veya duvara sürtünme, öbür tıra çarpma (hızlı giden öder), gişe kolunu kırma, dubaya çarpma', String(RULES.bump)],
    ['Kırmızı ışıkta geçmek', String(RULES.redLight)],
    ['Radarda hız sınırını aşmak', String(RULES.speeding)],
    ['Kurtarma tuşu (yola / girişe dönüş)', String(RULES.reset)],
    ['Kıl payı: hızlıyken karşıdan gelen araca çok yakın geçmek (turda en çok ' + RULES.nearMissMax + ' kez)', '+' + RULES.nearMiss],
    ['Tur kontratı (görevi bozmadan park etmek, tur sonunda yazılır)', '+' + RULES.contract],
    ['Maçın son turu (maç birden çok turluysa)', 'tur puanı ×' + RULES.finalMult],
  ];

  // The contract pays only once the round is over (atEnd), so the in-round HUD total leaves it out.
  TR.roundScore = (p, G, atEnd) => {
    const items = [];
    const add = (label, pts) => items.push({ label, pts });
    if (p.stats.firstToLot) add('Park alanına ilk giriş', RULES.firstToLot);
    if (p.stats.parkPts != null) add('Park hassasiyeti', p.stats.parkPts);
    const boxes = p.unloader ? p.unloader.placedCount() : 0;
    if (boxes) add('Doğru kutu × ' + boxes, boxes * RULES.perBox);
    if (G.winner === p) {
      add('Turu kazandı', RULES.win);
      const spare = Math.floor(TR.parTime(G.map.shortest) - p.times.unload);
      if (spare > 0) add('Hız bonusu (' + spare + ' sn)', spare * RULES.speedPerSec);
    }
    if (p.crashes) add('Kaza × ' + p.crashes, p.crashes * RULES.crash);
    if (p.bumps) add('Temas × ' + p.bumps, p.bumps * RULES.bump);
    if (p.resets) add('Kurtarma × ' + p.resets, p.resets * RULES.reset);
    if (p.redLights) add('Kırmızı ışık × ' + p.redLights, p.redLights * RULES.redLight);
    if (p.speeding) add('Radar × ' + p.speeding, p.speeding * RULES.speeding);
    if (p.nearMisses) add('Kıl payı × ' + p.nearMisses, p.nearMisses * RULES.nearMiss);
    if (atEnd && TR.contractPays(G.contract, p)) add('Kontrat: ' + G.contract.text, RULES.contract);
    const sum = items.reduce((a, it) => a + it.pts, 0);
    const base = Math.max(0, sum);
    const mult = TR.isFinalRound(G.series) ? RULES.finalMult : 1;
    return { items, sum, base, mult, total: base * mult };
  };

  // A title goes to the one player who leads its stat; a tie gives it to nobody. "Temiz Sürücü" is not a
  // ranking, so both players can earn it; solo, with no one to lead, it is the only title.
  TR.roundTitles = (players) => {
    const titles = players.map(() => []);
    const lead = (name, stat, min) => {
      if (players.length < 2) return;
      const vals = players.map(stat);
      const best = Math.max(...vals);
      if (best < min || vals.filter((v) => v === best).length > 1) return;
      titles[vals.indexOf(best)].push(name);
    };
    lead('Park Ustası', (p) => (p.stats.parkPts == null ? -1 : p.stats.parkPts), 1);
    lead('Kaza Kralı', (p) => p.crashes, 1);
    lead('Kıl Payı Kralı', (p) => p.nearMisses, 1);
    players.forEach((p, i) => {
      if (p.times.race != null && !p.crashes && !p.bumps) titles[i].push('Temiz Sürücü');
    });
    return titles;
  };
})();
