// A whole online match in two tabs of one Chromium, linked over ?net=local: the menus on both sides, a
// round to its result, the match result, a rematch, the guest tab dying and coming back, the guest leaving.
// Run: npm run test:e2e
import { chromium } from 'playwright';
import { serve, checks } from './serve.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await serve();
const URL = server.url + '?net=local';
const { watch, check, done } = checks();
const browser = await chromium.launch();

try {
  // BroadcastChannel links pages of one context only.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const open = async (label) => {
    const p = await ctx.newPage();
    watch(p, label);
    await p.goto(URL);
    await p.click('#btnSkipIntro');
    return p;
  };
  // A key pressed in the first moments of a screen is dropped by the menu's input lock.
  const press = async (p, key) => {
    await sleep(400);
    await p.keyboard.press(key);
  };
  const H = await open('host');
  let Gp = await open('guest');

  await H.click('[data-go="online"]');
  await H.fill('#onlineName', 'Ev');
  await H.click('#btnHost');
  await H.waitForFunction(() => /Oda kodu/.test(TR.Online.status));
  const code = await H.evaluate(() => TR.Online.code);
  const join = async (p) => {
    await p.click('[data-go="online"]');
    await p.fill('#onlineName', 'Misafir');
    await p.fill('#onlineCode', code);
    await p.click('#btnJoin');
  };
  await join(Gp);
  await H.waitForFunction(() => TR.UI.current === 'setup');
  check(await H.evaluate(() => document.getElementById('setupOnline').innerHTML.includes('Misafir')), 'host setup names the guest');
  await H.click('#segRounds button[data-v="1"]');
  await H.click('#btnSetupGo');
  await Gp.waitForFunction(() => TR.UI.current === 'routes');
  await press(Gp, 'ArrowRight');
  await H.waitForFunction(() => TR.UI.picks[1] === 1, null, { timeout: 3000 });
  check(true, 'host sees the guest move its route pick');
  await press(Gp, 'ArrowLeft');
  await press(H, 'Space');
  await press(Gp, 'Space');
  await H.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  const spec = (p) => p.evaluate(() => JSON.stringify(TR.Game.map.spec));
  check(await spec(Gp) === await spec(H), 'guest builds the host map');

  // Parks player i in its bay with every box on; the game then starts unloading. Unloading is then finished by hand.
  const park = (i) => H.evaluate((i) => {
    const G = TR.Game, bay = G.lot.bays[i], T = TR.TRUCK;
    G.players[i].cargo = TR.BOXES.map((_, b) => b);
    G.players[i].truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  }, i);
  const unload = (i) => H.evaluate((i) => {
    const u = TR.Game.players[i].unloader;
    u.cells = u.target.map((c) => c.slice());
    u.trailer = [];
  }, i);

  await park(0);
  await H.waitForFunction(() => TR.Game.players[0].phase === 'unload', null, { timeout: 10000 });
  await sleep(500);
  check(await Gp.evaluate(() => !!TR.Game.players[0].unloader && TR.Game.players[0].phase === 'unload'), 'guest sees the host unloading');
  await unload(0);
  await H.waitForFunction(() => TR.Game.state === 'finishing');
  await sleep(400);
  check(await Gp.evaluate(() => TR.Game.state === 'finishing' && TR.Game.winner && TR.Game.winner.idx === 0), 'guest knows the host won');
  await park(1);
  await H.waitForFunction(() => TR.Game.players[1].phase === 'unload', null, { timeout: 10000 });
  await unload(1);
  await H.waitForFunction(() => TR.UI.current === 'roundResult', null, { timeout: 15000 });
  await Gp.waitForFunction(() => TR.UI.current === 'roundResult', null, { timeout: 5000 });
  // The two tabs share one localStorage, so each gets its own place in the one record list: the place
  // badge is left out of the comparison.
  const rr = (p) => p.evaluate(() => ({
    title: document.getElementById('rrTitle').textContent,
    body: document.getElementById('rrBody').innerHTML.replace(/<div class="badge">.*?<\/div>/g, ''),
  }));
  const hr = await rr(H), gr = await rr(Gp);
  check(hr.title === gr.title && hr.title.includes('EV'), 'both show the same round winner');
  check(gr.body === hr.body && gr.body.length > 200, 'the guest round result matches the host');
  check(await Gp.evaluate(() => getComputedStyle(document.getElementById('btnNext')).display === 'none'), 'guest has no next button');

  await sleep(1300);
  await H.keyboard.press('Enter');
  await Gp.waitForFunction(() => TR.UI.current === 'matchResult', null, { timeout: 5000 });
  const champ = (p) => p.evaluate(() => document.getElementById('mrTitle').textContent);
  check(await champ(Gp) === await champ(H), 'both show the same champion');

  // Rematch, then the guest tab dies mid-round and a new one takes its place.
  await sleep(1300);
  await H.keyboard.press('Enter');
  await Gp.waitForFunction(() => TR.UI.current === 'routes', null, { timeout: 5000 });
  await press(H, 'Space');
  await press(Gp, 'Space');
  await H.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  await Gp.close();
  await H.waitForFunction(() => !document.getElementById('netwait').classList.contains('hidden'), null, { timeout: 8000 });
  check(await H.evaluate(() => TR.Game.state) === 'paused', 'host pauses when the guest is gone');

  Gp = await open('guest2');
  await join(Gp);
  await H.waitForFunction(() => document.getElementById('netwait').classList.contains('hidden'), null, { timeout: 10000 });
  await Gp.waitForFunction(() => !!TR.Game.map &&TR.UI.current === 'pause', null, { timeout: 5000 });
  check(true, 'reloaded guest is back in the paused round');
  check(await spec(Gp) === await spec(H), 'reloaded guest builds the host map');
  await press(H, 'Escape');
  await Gp.waitForFunction(() => TR.Game.state === 'play' && TR.UI.current === null, null, { timeout: 5000 });
  await Gp.keyboard.down('ArrowUp');
  await sleep(2500);
  const v = await H.evaluate(() => TR.Game.players[1].truck.v);
  check(v > 50, 'reloaded guest drives again (v=' + Math.round(v) + ')');
  await Gp.keyboard.up('ArrowUp');

  await Gp.evaluate(() => TR.Online.leave(null));
  await H.waitForFunction(() => TR.UI.current === 'online', null, { timeout: 5000 });
  check(/çıktı/.test(await H.evaluate(() => document.getElementById('onlineStatus').textContent)), 'host is told the guest left');
} finally {
  await browser.close();
  await server.close();
}
done();
