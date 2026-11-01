// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;
// The game's arrays come from the vm's realm, which deepEqual tells apart from this one's.
const plain = (v) => JSON.parse(JSON.stringify(v));

function world(solo) {
  const clock = { t: 1000 };
  const w = makeWorld('solo', { clock });
  w.TR.Settings.set({ traffic: 'normal', weather: 'gunduz', rounds: 1, names: ['Ali', 'Veli'], assist: ['hafif', 'hafif'] });
  w.G = w.TR.Game;
  w.step = (n = 1) => {
    for (let f = 0; f < n; f++) {
      clock.t += FRAME_MS;
      w.frame();
    }
  };
  w.race = () => {
    while (w.G.state === 'countdown') w.step();
  };
  w.press = (code) => {
    w.TR.UI.lockT = 0;
    w.down(code);
    w.step();
    w.up(code);
  };
  w.G.newSeries(null, null, solo);
  w.G.startRound(0, { seed: 4242 });
  return w;
}

function menu() {
  const clock = { t: 1000 };
  const w = makeWorld('menu', { clock });
  w.TR.Settings.set({ rounds: 1, names: ['Ali', 'Veli'] });
  w.press = (code) => {
    w.TR.UI.lockT = 0;
    w.down(code);
    clock.t += FRAME_MS;
    w.frame();
    w.up(code);
  };
  w.text = (id) => w.ctx.document.getElementById(id).textContent;
  return w;
}

// Puts the truck at its ramp with every box stacked right, so the next frame finishes its round.
function unloaded(TR, p) {
  const G = TR.Game;
  p.cargo = TR.BOXES.map((_, b) => b);
  p.phase = 'unload';
  p.unloader = new TR.Unloader(p.idx, G.lot, { target: G.plan.target, trailer: p.cargo }, p.color);
  p.unloader.cells = p.unloader.target.map((c) => c.slice());
  p.unloader.trailer = [];
}

test('a solo series has one player and one full-width view', () => {
  const { G } = world(true);
  assert.equal(G.series.solo, true);
  assert.deepEqual([...G.series.names], ['Ali']);
  assert.deepEqual([...G.series.totals], [0]);
  assert.equal(G.players.length, 1);
  assert.deepEqual(plain(G.viewSizes().map((v) => [v.idx, v.w, v.h])), [[0, 1280, 760]]);
  const duo = world(false).G;
  assert.equal(duo.players.length, 2);
  assert.equal(duo.viewSizes().length, 2);
});

test("either player's keys drive the solo truck", () => {
  for (const key of ['KeyW', 'ArrowUp']) {
    const w = world(true), p = w.G.players[0];
    w.race();
    w.down(key);
    w.step(60);
    assert.ok(p.truck.v > 20, key + ' left the truck at ' + p.truck.v);
  }
  // Two players: the arrows are the red truck's, not the blue one's.
  const w = world(false), [a, b] = w.G.players;
  w.race();
  w.down('ArrowUp');
  w.step(60);
  assert.ok(Math.abs(a.truck.v) < 1, 'the arrows drove the blue truck at ' + a.truck.v);
  assert.ok(b.truck.v > 20);
});

test('a solo HUD shows no rank and no rival', () => {
  const ranks = (w) => w.log.filter((l) => /fillText\("[12]\."/.test(l));
  const solo = world(true);
  solo.race();
  solo.step(5);
  assert.deepEqual(ranks(solo), []);
  assert.ok(!solo.log.some((l) => l.includes('Rakip')), 'a rival line was drawn');
  assert.ok(solo.log.some((l) => l.includes('"tur puan')), 'the solo frame drew no HUD');
  const duo = world(false);
  duo.race();
  duo.step(5);
  assert.equal(ranks(duo).length, 2, 'the floor: two players are each drawn a rank');
});

test("the lot draws bay 2 as nobody's in a solo round", () => {
  const w = world(true), b = w.G.lot.bounds, ctx = w.ctx.document.getElementById('game').getContext('2d');
  w.log.length = 0;
  w.G.lot.draw(ctx, { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 + 400 }, w.G.players);
  assert.ok(w.log.includes('game.strokeStyle="#78909c"'), 'bay 2 was not drawn unowned');
  assert.ok(w.log.includes('game.strokeStyle="#1e88e5"'), "bay 1 lost its owner's colour");
});

test('a solo round ends as soon as its truck finishes', () => {
  const w = world(true), { TR, G } = w, p = G.players[0];
  w.race();
  p.crashes = 2;
  unloaded(TR, p);
  w.step();
  assert.equal(G.winner, p);
  assert.equal(G.state, 'finishing');
  assert.equal(G.lastChance, false);
  assert.ok(p.toast.startsWith('TURU BİTİRDİN!'), p.toast);
  for (let f = 0; f < 600 && G.state !== 'roundover'; f++) w.step();
  assert.equal(G.state, 'roundover');
  assert.ok(G.overT <= 0 && G.time < 10, 'the round waited ' + G.time + ' s');
  assert.deepEqual([...G.series.wins], [1]);
  assert.equal(w.ctx.document.getElementById('rrTitle').textContent, 'ALI TURU BİTİRDİ!');
  // Leading needs a rival: two crashes make no Kaza Kralı alone.
  assert.deepEqual(plain(TR.roundTitles(G.players)), [[]]);
  const rec = TR.Scores.rounds()[0];
  assert.equal(rec.name, 'Ali');
  assert.equal(rec.solo, true);
});

test('a solo match result, record and rematch', () => {
  const w = world(true), { TR, G } = w, doc = w.ctx.document;
  w.race();
  unloaded(TR, G.players[0]);
  for (let f = 0; f < 600 && G.state !== 'roundover'; f++) w.step();
  w.press('Enter');
  assert.equal(TR.UI.current, 'matchResult');
  assert.equal(doc.getElementById('mrTitle').textContent, 'MAÇ BİTTİ!');
  assert.equal(doc.getElementById('mrHead3').textContent, 'Süre');
  assert.ok(!doc.getElementById('mrTotals').innerHTML.includes('Veli'), doc.getElementById('mrTotals').innerHTML);
  const m = TR.Scores.matches()[0];
  assert.equal(m.solo, true);
  assert.deepEqual(plain([m.names, m.totals]), [['Ali'], [G.series.totals[0]]]);
  w.press('Enter');
  assert.equal(TR.UI.current, 'routes');
  assert.equal(G.series.solo, true);
  assert.equal(G.series.history.length, 0);
  // The arrows pick for the one player, and its pick is never tossed against the unused second one.
  vm.runInContext('Math.random = () => 0.9', w.ctx);
  w.press('ArrowRight');
  assert.deepEqual(plain(TR.UI.picks), [1, 0]);
  // One ready press starts a solo round; two players would wait for the second.
  w.press('Space');
  assert.equal(G.state, 'countdown');
  assert.equal(G.players.length, 1);
  assert.equal(G.routeIdx, 1);
});

test('the setup screen starts a solo series, and Esc from its routes keeps it solo', () => {
  const w = menu(), { TR } = w, G = TR.Game;
  TR.UI.current = 'setup';
  TR.UI.solo = true;
  w.press('Enter');
  assert.equal(TR.UI.current, 'routes');
  assert.equal(G.series.solo, true);
  assert.equal(w.text('standP2'), '');
  assert.equal(w.text('routesName2'), '');
  assert.equal(w.text('ready1'), 'Hazır mısın? (Space / Enter)');
  assert.ok(w.text('pickNote').includes('Par süreden'), w.text('pickNote'));
  w.press('Escape');
  assert.equal(TR.UI.current, 'setup');
  assert.equal(w.text('setupTitle'), 'Tek Başına');
  w.press('Enter');
  assert.equal(G.series.solo, true);
  // Back to the title and into a new match: two players again.
  w.press('Escape');
  w.press('Escape');
  assert.equal(TR.UI.current, 'title');
  w.press('Enter');
  assert.equal(w.text('setupTitle'), 'Yeni Maç');
  w.press('Enter');
  assert.equal(G.series.solo, false);
  assert.match(w.text('standP2'), /^0 {2}\S/);
  assert.equal(w.text('ready1'), 'Hazır mısın? (Space)');
});

test('two players still wait for each other on the route screen', () => {
  const w = world(false), { TR, G } = w;
  w.race();
  for (const p of G.players) unloaded(TR, p);
  for (let f = 0; f < 600 && G.state !== 'roundover'; f++) w.step();
  // What a solo match result before this one leaves in the header.
  w.ctx.document.getElementById('mrHead3').textContent = 'Süre';
  w.press('Enter');
  assert.equal(w.ctx.document.getElementById('mrHead3').textContent, 'Kazanan');
  w.press('Enter');
  assert.equal(TR.UI.current, 'routes');
  w.press('Space');
  assert.equal(TR.UI.current, 'routes');
  assert.equal(G.players.length, 2);
});
