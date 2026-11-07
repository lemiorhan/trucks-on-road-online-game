// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './harness.mjs';

const FRAME_MS = 1000 / 60;
const plain = (v) => JSON.parse(JSON.stringify(v));
const NONE = { thr: 0, steer: 0, mx: 0, my: 0, action: false, reset: false, brake: false, horn: false, left: false, right: false };

function world(solo) {
  const clock = { t: 1000 };
  const w = makeWorld('touch', { clock });
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
