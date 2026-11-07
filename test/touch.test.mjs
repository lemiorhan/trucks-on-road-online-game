// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;
const plain = (v) => JSON.parse(JSON.stringify(v));
const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

function world(solo, size = {}) {
  const clock = { t: 1000 };
  const w = makeWorld('touch', Object.assign({ clock }, size));
  w.TR.Settings.set({ traffic: 'normal', weather: 'gunduz', rounds: 1, names: ['Ali', 'Veli'], assist: ['kapali', 'kapali'] });
  w.G = w.TR.Game;
  w.step = () => {
    clock.t += FRAME_MS;
    w.frame();
  };
  w.G.newSeries(null, null, solo);
  w.G.startRound(0, { seed: 4242 });
  w.TR.UI.hideAll();
  while (w.G.state === 'countdown') w.step();
  return w;
}

test('the stick reads a drag', () => {
  const { read } = makeWorld('read', { clock: { t: 0 } }).TR.Touch;
  // R 60, DEAD 0.25: a drag under 15 px counts as none, and steering grows from there to full lock at 60 px.
  assert.deepEqual(plain(read(0, -60)), { thr: 1, steer: 0, mx: 0, my: -1 });
  assert.deepEqual(plain(read(0, 90)), { thr: -1, steer: 0, mx: 0, my: 1 });
  assert.deepEqual(plain(read(0, -14)), { thr: 0, steer: 0, mx: 0, my: 0 });
  assert.deepEqual(plain(read(0, -20)), { thr: 1, steer: 0, mx: 0, my: -1 / 3 });
  assert.deepEqual(plain(read(-30, 0)), { thr: 0, steer: -1 / 3, mx: -0.5, my: 0 });
  assert.deepEqual(plain(read(120, 0)), { thr: 0, steer: 1, mx: 1, my: 0 });
  // 10 px along each axis is under DEAD on each, but 14.1 px along the diagonal still is too: no walking.
  assert.deepEqual(plain(read(10, 10)), { thr: 0, steer: 0, mx: 0, my: 0 });
  // 12 px along each axis is 17 px along the diagonal: the worker walks, the truck neither steers nor drives.
  assert.deepEqual(plain(read(12, 12)), { thr: 0, steer: 0, mx: 0.2, my: 0.2 });
});

test('the pad drives what player 1 keys drive and nothing else', () => {
  const w = world(false), I = w.TR.Input;
  const held = { thr: 1, steer: 0.5, mx: 0.6, my: -0.8, brake: true, action: true, reset: true, horn: true };
  Object.assign(I.pad, held);
  const mine = Object.assign({}, NONE, held);
  assert.deepEqual(plain(I.player(0)), mine);
  assert.deepEqual(plain(I.keys(w.TR.KEYS)), mine, 'a solo or online truck takes both key maps, the pad with them');
  assert.deepEqual(plain(I.player(1)), NONE, 'player 2 on the same machine is not driven by the pad');
  w.down('KeyA');
  w.down('KeyS');
  const keys = I.player(0);
  assert.deepEqual([keys.thr, keys.steer, keys.mx, keys.my], [-1, -1, -1, 1], 'a held key wins over the pad');
});

test('a pad press is seen for one frame and a held pad lets go when the round stops', () => {
  const w = world(true), pad = w.TR.Input.pad, p = w.G.players[0];
  Object.assign(pad, { action: true, reset: true, horn: true, brake: true });
  const resets = p.resets;
  w.step();
  assert.equal(p.resets, resets + 1, 'the press reached the truck');
  assert.ok(p.hornCd > 0, 'the horn press reached the truck');
  assert.deepEqual([pad.action, pad.reset, pad.horn], [false, false, false]);
  assert.equal(pad.brake, true, 'a held brake stays held while the round runs');
  w.step();
  assert.equal(p.resets, resets + 1, 'one press recovers once');
  w.G.pause();
  w.step();
  assert.equal(pad.brake, false, 'pausing lets go of the brake');
});

test('the HUD leaves the key hints out for the player the pads drive', () => {
  const w = world(false);
  const hints = () => ['W A S D: sür', 'Ok tuşları: sür'].map((s) => w.log.some((l) => l.includes(s)));
  w.step();
  assert.deepEqual(hints(), [true, true]);
  w.TR.Touch.on = true;
  w.step();
  assert.deepEqual(hints(), [false, true]);
});

// An iPhone 13 held sideways, as the touch e2e drives it.
const PHONE = { width: 750, height: 342 };

test('on a split screen only the map of the player the pads drive turns into the phone map', () => {
  const w = world(false, PHONE), TR = w.TR, G = w.G, [a, b] = G.players;
  w.step();
  const desk = plain(TR.HUD.navRect(G.viewport(1), b, G));
  TR.Touch.on = true;
  TR.Settings.set({ navOpen: false });
  w.step();
  assert.equal(TR.HUD.navRect(G.viewport(0), a, G).open, false, 'the folded map of the pads\' player is open');
  assert.deepEqual(plain(TR.HUD.navRect(G.viewport(1), b, G)), desk, 'the other player\'s map changed with the pads');
});

test('on a phone the map is see-through and shorter, and a tap folds it into a chip and back', () => {
  const w = world(true, PHONE), TR = w.TR, G = w.G, p = G.players[0], vp = G.viewport(0);
  const chip = () => w.log.some((l) => l.includes('fillText("Harita %'));
  const seeThrough = () => w.log.some((l) => /\.globalAlpha=0\.\d/.test(l));
  // The saves a frame leaves unrestored on the context that drew the see-through map.
  const unrestored = () => {
    const id = w.log.find((l) => /\.globalAlpha=0\.\d/.test(l)).split('.')[0];
    return w.log.filter((l) => l === id + '.save()').length - w.log.filter((l) => l === id + '.restore()').length;
  };
  const tapAt = (r) => TR.HUD.tapNav(r.x + r.w / 2, r.y + r.h / 2);
  w.step();
  const desk = TR.HUD.navRect(vp, p, G);
  assert.equal(seeThrough(), false, 'the desktop map is see-through');
  assert.equal(tapAt(desk), false, 'a click on the desktop map is taken from the mouse stick');

  TR.Touch.on = true;
  w.step();
  const open = TR.HUD.navRect(vp, p, G);
  assert.ok(seeThrough(), 'the phone map is not see-through');
  assert.equal(unrestored(), 0, 'the phone map leaves a canvas save unrestored');
  assert.ok(open.open && open.h < desk.h, 'the phone map is no shorter: ' + open.h + ' vs ' + desk.h);
  assert.equal(TR.HUD.tapNav(open.x - 20, open.y + open.h / 2), false, 'a finger beside the map took the map');
  assert.equal(TR.Settings.get().navOpen, true);

  assert.equal(tapAt(open), true);
  w.step();
  assert.equal(TR.Settings.get().navOpen, false);
  assert.ok(chip(), 'the folded map draws no chip');
  assert.equal(seeThrough(), false, 'the folded map still draws the see-through map');
  const folded = TR.HUD.navRect(vp, p, G);
  assert.ok(folded.h < open.h / 2, 'the chip is no smaller than the map');

  assert.equal(tapAt(folded), true);
  w.step();
  assert.equal(TR.Settings.get().navOpen, true);
  assert.equal(chip(), false, 'the unfolded map still draws the chip');
  assert.ok(seeThrough());
});

test('a folded phone map signs a fork just before it, only there, and a tap on the sign opens the map', () => {
  const w = world(true, PHONE), TR = w.TR, G = w.G, p = G.players[0], vp = G.viewport(0), SIGN = TR.NAV.SIGN;
  const segs = G.map.segs, fork = segs.findIndex((sg) => sg.out.length > 1);
  const join = segs.findIndex((sg) => sg.out.length === 1 && sg.road.length > SIGN.AT);
  assert.ok(fork >= 0 && join >= 0 && segs[fork].road.length > SIGN.AT + 200, 'the map has no fork or no join to come up to');
  const signed = () => w.log.some((l) => l.includes('fillText("Yol ayrımı"'));
  // Where the frame drew the text that starts with s.
  const drawnAt = (s) => {
    const m = /fillText\("[^"]*",([-\d.]+),([-\d.]+)\)/.exec(w.log.find((l) => l.includes('fillText(' + JSON.stringify(s).slice(0, -1))));
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  const at = (k, s) => {
    const q = segs[k].road.lanePos(s, TR.ROAD.LANE / 2);
    p.truck.place(q.x, q.y, q.h);
    p.truck.v = 0;
    Object.assign(p, { seg: k, s, d: TR.ROAD.LANE / 2, hint: -1 });
    w.step();
    assert.equal(p.seg, k);
  };
  const before = segs[fork].road.length - SIGN.AT;
  TR.Touch.on = true;
  at(fork, before + 100);
  assert.equal(signed(), false, 'the open map signs the fork');
  TR.Settings.set({ navOpen: false });
  at(fork, before - 100);
  assert.equal(signed(), false, 'the fork is signed before it is near');
  at(join, segs[join].road.length - 100);
  assert.equal(signed(), false, 'a road that only joins another is signed as a fork');
  at(fork, before + 100);
  assert.ok(signed(), 'the fork is not signed just before it');
  const r = TR.HUD.navRect(vp, p, G), label = drawnAt('Harita %'), sign = drawnAt('Yol ayrımı');
  assert.ok(label.y > r.y && label.y < r.y + TR.NAV.CHIP.h, 'the progress is not on the chip\'s first line');
  assert.ok(sign.x > r.x && sign.x < r.x + r.w && sign.y > r.y + TR.NAV.CHIP.h && sign.y < r.y + r.h, 'the sign is not on a line of its own in the chip');
  // 13px over 12px text, drawn middle-aligned: closer than half of each overlaps.
  assert.ok(sign.y - label.y >= 13, 'the sign runs into the progress: ' + label.y + ' and ' + sign.y);
  assert.equal(TR.HUD.tapNav(sign.x, sign.y), true, 'a tap on the sign is taken by the stick');
  assert.equal(TR.Settings.get().navOpen, true, 'a tap on the sign leaves the map folded');
});
