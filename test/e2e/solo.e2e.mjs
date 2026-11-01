// A solo match in Chromium from the title button: what the screens hide, a round to its result, the match
// result, and the score table.
// Run: npm run test:e2e
import { chromium } from 'playwright';
import { serve, checks } from './serve.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await serve();
const { watch, check, done } = checks();
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  watch(page, 'solo');
  await page.goto(server.url);
  await page.click('#btnSkipIntro');
  // A key pressed in the first moments of a screen is dropped by the menu's input lock.
  const press = async (key) => {
    await sleep(400);
    await page.keyboard.press(key);
  };
  // A selector that matches nothing would pass every "all shown" and "all hidden" check below.
  const shown = async (sel) => {
    const seen = await page.$$eval(sel, (els) => els.map((el) => getComputedStyle(el).display !== 'none'));
    if (!seen.length) throw new Error(sel + ' matches nothing');
    return seen;
  };

  await page.click('[data-go="solo"]');
  check(await page.textContent('#setupTitle') === 'Tek Başına', 'the solo button opens the solo setup');
  check((await shown('#setup .field.p2')).every((v) => !v), 'setup hides player 2');
  check((await shown('#setup .field.p1')).every(Boolean), 'setup shows player 1');
  check((await shown('#setup .solo-only')).every(Boolean), 'setup shows the solo note');
  await page.click('#segRounds button[data-v="1"]');
  await page.click('#btnSetupGo');
  await page.waitForFunction(() => TR.UI.current === 'routes');
  check((await shown('.player.p2')).every((v) => !v), 'routes hide player 2');
  // Player 2's pick would sit on card 0; player 1 moves to card 1.
  await press('ArrowRight');
  await page.waitForFunction(() => TR.UI.picks[0] === 1);
  check(await page.$$eval('.route.sel2', (els) => els.length) === 0, 'no route card carries a second pick');
  check((await shown('.route .pk.p2')).every((v) => !v), 'no route card shows a 2 badge');
  await press('Space');
  await page.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  check(await page.evaluate(() => TR.Game.players.length === 1 && TR.Game.viewSizes().length === 1), 'one truck on one view');

  await page.evaluate(() => {
    const G = TR.Game, bay = G.lot.bays[0], T = TR.TRUCK;
    G.players[0].cargo = TR.BOXES.map((_, b) => b);
    G.players[0].truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  });
  await page.waitForFunction(() => TR.Game.players[0].phase === 'unload', null, { timeout: 10000 });
  await page.evaluate(() => {
    const u = TR.Game.players[0].unloader;
    u.cells = u.target.map((c) => c.slice());
    u.trailer = [];
  });
  await page.waitForFunction(() => TR.UI.current === 'roundResult', null, { timeout: 10000 });
  check(/TURU BİTİRDİ!$/.test(await page.textContent('#rrTitle')), 'the round result says the round is finished');
  await sleep(1300);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => TR.UI.current === 'matchResult');
  check(await page.textContent('#mrTitle') === 'MAÇ BİTTİ!', 'the match result has no champion');
  check((await shown('#mrHead2')).every((v) => !v), 'the match table hides player 2');
  check(await page.textContent('#mrHead3') === 'Süre', 'the match table shows times');

  await sleep(1300);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => TR.UI.current === 'title');
  check(!(await page.evaluate(() => document.body.classList.contains('solo'))), 'the title is not left in solo');
  await page.click('[data-go="scores"]');
  check((await page.textContent('#matchBody')).includes('tek başına'), 'the match list tags the solo match');
  check(!(await page.textContent('#matchBody')).includes('undefined'), 'the match list row is whole');
  check((await page.textContent('#hiBody')).includes('tek başına'), 'the round records tag the solo round');

  check((await page.textContent('#matchBody')).includes('—'), 'the match list names no champion for a solo match');
  await page.click('#scores [data-back]');

  // Leaving a solo setup by Esc, from its routes and then from setup, must not carry solo into the next setup.
  await page.click('[data-go="solo"]');
  await page.click('#btnSetupGo');
  await page.waitForFunction(() => TR.UI.current === 'routes');
  await press('Escape');
  await page.waitForFunction(() => TR.UI.current === 'setup');
  await press('Escape');
  await page.waitForFunction(() => TR.UI.current === 'title');
  check(!(await page.evaluate(() => document.body.classList.contains('solo'))), 'Esc out of a solo setup leaves the title not in solo');
  await press('Enter');
  await page.waitForFunction(() => TR.UI.current === 'setup');
  check((await shown('#setup .field.p2')).every(Boolean), 'Enter after leaving solo opens a setup with player 2');
  await press('Escape');
  await page.waitForFunction(() => TR.UI.current === 'title');

  await page.click('[data-go="setup"]');
  check(await page.textContent('#setupTitle') === 'Yeni Maç', 'the match button opens the two-player setup');
  check((await shown('#setup .field.p2')).every(Boolean), 'a two-player setup shows player 2');
  check((await shown('#setup .solo-only')).every((v) => !v), 'a two-player setup hides the solo note');
} finally {
  await browser.close();
  await server.close();
}
done();
