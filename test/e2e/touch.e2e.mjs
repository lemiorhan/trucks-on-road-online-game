// Phones driven by real touch events: a solo round through every phase, where the finger stick drives and
// walks and the pads brake, sound the horn, recover, pick up and pause; an online match the two phones start
// by tapping their own ready boxes, where the guest's finger drives the guest's truck. Then desktop pages: a held mouse button drives, and on a split screen the
// pads sit in their own player's half and drive no one else.
// Run: npm run test:e2e
import { chromium, devices } from 'playwright';
import { serve, checks } from './serve.mjs';

const server = await serve();
const { watch, check, done } = checks();
const browser = await chromium.launch();
const PHONE = devices['iPhone 13 landscape'];

// Records every text the canvas draws and the event each AudioContext was made in.
function spy() {
  window.__texts = new Set();
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (s, ...rest) {
    window.__texts.add(String(s));
    return fill.call(this, s, ...rest);
  };
  window.__audio = [];
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(...args) {
      super(...args);
      window.__audio.push(window.event ? window.event.type : null);
    }
  };
}

// touchStart and touchMove take every finger on the glass; touchEnd takes the fingers that leave it.
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const on = new Map();
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: [...points].map(([id, [x, y]]) => ({ x, y, id })),
  });
  return {
    press: (id, x, y) => (on.set(id, [x, y]), touch('touchStart', on)),
    slide: (id, x, y) => (on.set(id, [x, y]), touch('touchMove', on)),
    lift: (id) => {
      const up = [[id, on.get(id)]];
      on.delete(id);
      return touch('touchEnd', up);
    },
  };
}

const until = (page, what, fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: 5000 }).then(() => check(true, what), () => check(false, what));
const visible = (page, sel) => page.$eval(sel, (el) => getComputedStyle(el).display !== 'none' && el.closest('.hidden') === null);
// The pads shown, by name in alphabetical order.
const padsAre = (page, what, pads) => until(page, what, (pads) => [...document.querySelectorAll('[data-pad]')]
  .filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.pad).sort().join(' ') === pads, pads);
// Whether the pads sit in the bottom-right corner of the left or right half of the window.
const padsIn = (page, what, half) => until(page, what, (half) => {
  const b = document.querySelector('.touch-pads').getBoundingClientRect(), mid = innerWidth / 2;
  const [x0, x1] = half === 'left' ? [0, mid] : [mid, innerWidth];
  return b.left >= x0 && b.right <= x1 && x1 - b.right < 40 && innerHeight - b.bottom < 40;
}, half);
const center = async (page, sel) => {
  const b = await page.locator(sel).boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
// Whether any text the canvas draws in the next few frames includes needle.
const drawn = async (page, needle) => {
  await page.evaluate(() => window.__texts.clear());
  await page.waitForTimeout(300);
  return page.evaluate((s) => [...window.__texts].some((t) => t.includes(s)), needle);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const phone = await browser.newContext(PHONE);
  await phone.addInitScript(spy);
  const page = await phone.newPage();
  watch(page, 'phone');
  const { press, slide, lift } = await fingers(page);

  await page.goto(server.url);
  check(await page.evaluate(() => window.__audio.length === 0), 'no sound starts before the first tap');
  await page.tap('#btnSkipIntro');
  check(await page.evaluate(() => window.__audio[0] === 'click'), 'the first tap starts the sound from its click');
  check(!(await visible(page, '.portrait-note')), 'a phone held sideways is not asked to turn');
  check(!(await visible(page, '[data-go="setup"]')), 'a phone is not offered a match for two on one screen');
  check(await visible(page, '[data-go="solo"]') && await visible(page, '[data-go="online"]'), 'a phone is offered the solo and the online match');
  await page.tap('[data-go="solo"]');
  await page.tap('#segRounds button[data-v="1"]');
  await page.tap('#btnSetupGo');
  await page.waitForFunction(() => TR.UI.current === 'routes');
  await page.tap('#btnRouteStart');
  await page.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  await page.evaluate(() => (window.P = TR.Game.players[0]));

  await until(page, 'a phone shows the pads from the round start', () => !document.getElementById('touch').classList.contains('hidden'));
  check(!(await visible(page, '#stick')), 'no stick shows before a finger is down');
  check(await visible(page, '#touchHint'), 'the hint shows before the first drag');
  check(!(await drawn(page, ': sür')), 'the HUD draws no key hints for the truck the pads drive');
  await press(0, 300, 220);
  check(await visible(page, '#stick'), 'a finger on the road shows the stick');
  check(!(await visible(page, '#touchHint')), 'the first drag puts the hint away');
  await slide(0, 300, 210);
  await page.waitForTimeout(500);
  check(await page.evaluate(() => P.inp.thr === 0 && Math.abs(P.truck.v) < 1), 'a drag of 10 px leaves the truck standing');
  // Dragged 100 px up, the stick's centre follows to 60 px below the finger: (300, 180).
  await slide(0, 300, 120);
  await until(page, 'dragging up gives throttle', () => P.inp.thr === 1 && P.inp.steer === 0);
  await until(page, 'dragging up drives the truck forwards', () => P.truck.v > 30);
  // 20 px below the followed centre, though still 20 px above where the finger landed.
  await slide(0, 300, 200);
  await until(page, 'swinging back down past the followed centre brakes at once', () => P.inp.thr === -1);
  // From (300, 180) the centre follows to about (282, 170): 52 px left and 30 px up of it.
  await slide(0, 230, 140);
  await until(page, 'dragging up and left steers left with the throttle still on', () => P.inp.thr === 1 && P.inp.steer < -0.5);
  await until(page, 'the truck turns its wheels left', () => P.truck.steer < -0.3);

  await padsAre(page, 'the race shows the brake, horn, recover and pause pads', 'brake horn pause reset');
  check((await page.textContent('[data-pad="reset"]')) === 'Yola dön', 'the recover pad says Yola dön in the race');
  check((await page.textContent('#touchHint')).startsWith('Sürükle: yukarı gaz'), 'the hint tells how to drive');

  const brake = await center(page, '[data-pad="brake"]');
  await press(1, ...brake);
  await until(page, 'a second finger on the brake pad brakes while the first still holds the throttle',
    () => P.inp.brake === true && P.inp.thr === 1 && P.truck.braking);
  await lift(1);
  await until(page, 'lifting the brake finger lets go of the brake', () => !P.inp.brake && P.inp.thr === 1);
  await lift(0);
  await until(page, 'lifting the stick finger leaves no throttle or steering', () => P.inp.thr === 0 && P.inp.steer === 0);
  check(!(await visible(page, '#stick')), 'the stick hides once the finger is up');

  // 30 px is half of full lock on the drag, and a third of full lock once the dead zone is taken off.
  await press(0, 300, 220);
  await slide(0, 330, 220);
  await page.waitForTimeout(600);
  check(await page.evaluate(() => Math.abs(P.truck.steer - 1 / 3) < 0.02), 'a drag of 30 px turns the wheels a third of the way');
  await lift(0);

  await page.tap('[data-pad="horn"]');
  await until(page, 'the horn pad sounds the horn', () => P.hornCd > 0);
  const resets = await page.evaluate(() => P.resets);
  await page.tap('[data-pad="reset"]');
  await until(page, 'the recover pad puts the truck back on the road', (n) => P.resets === n + 1, resets);
  await page.waitForTimeout(300);
  check(await page.evaluate((n) => P.resets === n + 1, resets), 'one tap recovers once');

  // The brake finger stays down through the pause and after it.
  await press(1, ...(await center(page, '[data-pad="brake"]')));
  await until(page, 'the brake pad brakes', () => P.inp.brake === true);
  await page.keyboard.press('Escape');
  await until(page, 'Esc pauses the round', () => TR.UI.current === 'pause');
  await page.evaluate(() => document.getElementById('btnResume').click());
  await until(page, 'the round goes on after Devam', () => TR.Game.state === 'play');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !P.inp.brake && !document.querySelector('[data-pad="brake"]').classList.contains('on')),
    'a brake held through a pause does not brake after it');
  await lift(1);

  await page.tap('[data-pad="pause"]');
  await until(page, 'the pause pad pauses the round', () => TR.UI.current === 'pause');
  await until(page, 'the pads hide behind the pause menu', () => document.getElementById('touch').classList.contains('hidden'));
  await page.tap('#btnResume');
  await until(page, 'the round goes on after Devam', () => TR.Game.state === 'play');
  await until(page, 'the pads come back with the round', () => !document.getElementById('touch').classList.contains('hidden'));

  await page.evaluate(() => {
    const bay = TR.Game.lot.bays[0], T = TR.TRUCK;
    P.cargo = [];
    P.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  });
  await page.waitForFunction(() => P.phase === 'park', null, { timeout: 5000 });
  await padsAre(page, 'parking shows the brake, recover and pause pads', 'brake pause reset');
  check((await page.textContent('[data-pad="reset"]')) === 'Girişe dön', 'the recover pad says Girişe dön in the lot');
  check((await page.textContent('#touchHint')).startsWith('Sürükle: yukarı ileri'), 'the hint tells how to back in');
  check(await visible(page, '#touchHint'), 'the lot brings the hint back');

  // Backed square onto its ramp at the first depot, as depot.test.mjs docks a truck.
  await page.evaluate(() => {
    const G = TR.Game, T = TR.TRUCK, k = T.LT + T.TR_REAR;
    const { sg, dp } = G.map.segs.flatMap((sg) => sg.road.depots.map((dp) => ({ sg, dp })))[0];
    const face = dp.ramps[P.idx], phi = Math.atan2(-dp.oy, -dp.ox);
    const x = face.x - dp.ox * 5 + Math.cos(phi) * k, y = face.y - dp.oy * 5 + Math.sin(phi) * k;
    P.truck.place(x, y, phi);
    P.seg = sg.id;
    P.s = sg.road.locate(x, y, -1).s;
    P.hint = -1;
  });
  await page.waitForFunction(() => P.phase === 'load', null, { timeout: 5000 });
  await padsAre(page, 'loading at a depot shows the pick-up, recover and pause pads', 'action pause reset');
  check((await page.textContent('[data-pad="reset"]')) === 'Rampadan çık', 'the recover pad says Rampadan çık at a depot');
  check((await page.textContent('#touchHint')) === 'Sürükle: yürü', 'the hint at a depot tells how to walk');
  await page.tap('[data-pad="reset"]');
  await until(page, 'the Rampadan çık pad takes the truck off the ramp', () => P.phase === 'race');

  await page.evaluate(() => {
    const bay = TR.Game.lot.bays[0], T = TR.TRUCK;
    P.cargo = TR.BOXES.map((_, b) => b);
    P.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  });
  await page.waitForFunction(() => P.phase === 'unload', null, { timeout: 10000 });
  await padsAre(page, 'unloading shows the pick-up and pause pads', 'action pause');
  check((await page.textContent('#touchHint')) === 'Sürükle: yürü', 'the hint tells how to walk');
  check(await visible(page, '#touchHint'), 'a new phase brings the hint back');
  await page.tap('[data-pad="action"]');
  await until(page, 'the pick-up pad takes a box out of the trailer', () => P.unloader.worker.carry != null);
  const x0 = await page.evaluate(() => P.unloader.worker.x);
  await press(0, 300, 220);
  await slide(0, 380, 220);
  await until(page, 'dragging right walks the worker right', (x) => P.unloader.worker.x > x + 20, x0);
  await lift(0);
  await phone.close();

  const upright = await browser.newContext(devices['iPhone 13']);
  const tall = await upright.newPage();
  watch(tall, 'portrait');
  await tall.goto(server.url);
  await tall.tap('#btnSkipIntro');
  check(await visible(tall, '.portrait-note'), 'a phone held upright is asked to turn sideways');
  await upright.close();

  // Two phones online over ?net=local, which links pages of one context only.
  const pair = await browser.newContext(PHONE);
  await pair.addInitScript(spy);
  const open = async (label) => {
    const p = await pair.newPage();
    watch(p, label);
    await p.goto(server.url + '?net=local');
    await p.tap('#btnSkipIntro');
    return p;
  };
  const H = await open('host'), Gp = await open('guest');
  await H.tap('[data-go="online"]');
  await H.fill('#onlineName', 'Ev');
  await H.tap('#btnHost');
  await H.waitForFunction(() => /Oda kodu/.test(TR.Online.status));
  const code = await H.evaluate(() => TR.Online.code);
  await Gp.tap('[data-go="online"]');
  await Gp.fill('#onlineName', 'Misafir');
  await Gp.fill('#onlineCode', code);
  await Gp.tap('#btnJoin');
  await H.waitForFunction(() => TR.UI.current === 'setup');
  await H.tap('#segRounds button[data-v="1"]');
  await H.tap('#btnSetupGo');
  await Gp.waitForFunction(() => TR.UI.current === 'routes');
  await sleep(400);
  check((await Gp.textContent('#ready2')) === 'Hazır mısın? (dokun)', 'a phone tells the guest to tap its ready box');
  await Gp.tap('#ready1');
  await sleep(400);
  check(await H.evaluate(() => !TR.UI.ready[0] && !TR.UI.ready[1]), 'a guest tap on the host ready box marks no one ready');
  await Gp.tap('#ready2');
  await until(H, 'a guest tap on its own ready box marks the guest ready on the host', () => TR.UI.ready[1] && !TR.UI.ready[0]);
  await until(Gp, 'the guest phone shows the guest ready', () => document.getElementById('ready2').classList.contains('on'));
  await H.tap('#ready2');
  await sleep(400);
  check(await H.evaluate(() => TR.UI.ready[1] && !TR.UI.ready[0] && TR.UI.current === 'routes'), 'a host tap on the guest ready box changes nothing');
  await H.tap('#ready1');
  await until(H, 'the host tap on its own ready box starts the round with both ready', () => TR.UI.current === null && TR.Game.state !== 'menu');
  await H.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  await Gp.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });

  await until(Gp, 'the guest phone shows its pads with only its own truck on screen',
    () => TR.Game.viewSizes().length === 1 && !document.getElementById('touch').classList.contains('hidden'));
  // Both trucks on the guest's screen, its own in the right half. The setting is read every frame; after two
  // the game has run one in the new view.
  await Gp.evaluate(() => {
    TR.Settings.set({ onlineView: 'bolunmus' });
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await padsIn(Gp, 'the guest pads sit in the bottom-right corner of the guest half', 'right');
  check(!(await drawn(Gp, 'Ok tuşları: sür')) && await drawn(Gp, 'W A S D: sür'),
    'the guest HUD drops the key hints of the guest truck and keeps the host ones');
  const guest = await fingers(Gp);
  await guest.press(0, 640, 220);
  await guest.slide(0, 640, 120);
  await until(H, 'the guest finger drives the guest truck on the host', () => TR.Game.players[1].truck.v > 30);
  check(await H.evaluate(() => Math.abs(TR.Game.players[0].truck.v) < 1), 'the guest finger leaves the host truck standing');
  await guest.lift(0);

  await H.evaluate(() => {
    const G = TR.Game, bay = G.lot.bays[1], T = TR.TRUCK, q = G.players[1];
    q.cargo = TR.BOXES.map((_, b) => b);
    q.truck.place(bay.cx, bay.y0 + T.LT + T.TR_REAR + 2, Math.PI / 2);
  });
  await H.waitForFunction(() => TR.Game.players[1].phase === 'unload', null, { timeout: 10000 });
  await padsAre(Gp, 'the guest pads follow the guest truck into unloading', 'action pause');
  await padsAre(H, 'the host pads stay on the host truck, still racing', 'brake horn pause reset');
  await pair.close();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  watch(desk, 'desktop');
  await desk.goto(server.url);
  await desk.click('#btnSkipIntro');
  check(await desk.isVisible('[data-go="setup"]'), 'a desktop is offered a match for two on one keyboard');
  check(!(await visible(desk, '.portrait-note')), 'a desktop is not asked to turn');
  await desk.click('[data-go="solo"]');
  await desk.click('#btnSetupGo');
  await desk.waitForFunction(() => TR.UI.current === 'routes');
  await desk.click('#btnRouteStart');
  await desk.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  await desk.mouse.move(640, 500);
  await desk.mouse.down();
  await desk.mouse.move(640, 400, { steps: 5 });
  const drove = await desk.waitForFunction(() => TR.Game.players[0].truck.v > 30, null, { timeout: 5000 }).then(() => true, () => false);
  check(drove, 'a held mouse dragged up drives the truck');
  await desk.mouse.up();
  check(await desk.$eval('#touch', (el) => el.classList.contains('hidden')), 'a mouse alone shows no pads');
  // A touch screen that reports a fine pointer (a laptop's) gets the pads at its first touch.
  const deskTouch = await fingers(desk);
  await deskTouch.press(0, 640, 500);
  await deskTouch.lift(0);
  await until(desk, 'the first touch on a fine-pointer screen shows the pads', () => !document.getElementById('touch').classList.contains('hidden'));
  await desk.close();

  // A match for two on one touch laptop: the pads ride on Mavi's keys, Mavi drives the left half.
  const split = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await split.addInitScript(spy);
  watch(split, 'split');
  await split.goto(server.url);
  await split.click('#btnSkipIntro');
  await split.click('[data-go="setup"]');
  await split.click('#btnSetupGo');
  await split.waitForFunction(() => TR.UI.current === 'routes');
  await split.click('#btnRouteStart');
  await split.waitForFunction(() => TR.Game.state === 'play', null, { timeout: 15000 });
  check(await drawn(split, 'W A S D: sür') && await drawn(split, 'Ok tuşları: sür'), 'before a touch the HUD draws both players key hints');
  const two = await fingers(split);
  await two.press(0, 320, 600);
  await until(split, 'a touch on a split screen shows the pads', () => !document.getElementById('touch').classList.contains('hidden'));
  await padsIn(split, 'on a split screen the pads sit in the bottom-right corner of Mavi\'s half', 'left');
  check(!(await drawn(split, 'W A S D: sür')) && await drawn(split, 'Ok tuşları: sür'), 'the HUD drops the key hints of Mavi only');
  await two.slide(0, 320, 500);
  await until(split, 'the finger drives Mavi', () => TR.Game.players[0].truck.v > 30);
  check(await split.evaluate(() => Math.abs(TR.Game.players[1].truck.v) < 1), 'the finger leaves Kırmızı standing');
  await two.slide(0, 400, 540);
  await until(split, 'dragging right turns Mavi right', () => TR.Game.players[0].truck.steer > 0.3);
  await split.keyboard.down('KeyA');
  await until(split, 'a held A turns Mavi left over the finger', () => TR.Game.players[0].truck.steer < -0.3);
  await split.keyboard.up('KeyA');
  await two.lift(0);
  await split.setViewportSize({ width: 1000, height: 760 });
  await padsIn(split, 'a narrower window moves the pads with Mavi\'s half', 'left');
} finally {
  await browser.close();
  await server.close();
}
done();
