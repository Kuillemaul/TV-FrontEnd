import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAD_KEYS, PadTranslator, wantsControllerKeys, wantsPointer } from './padkeys.js';

const EV_KEY = 1;
const EV_ABS = 3;

test('buttons, d-pad hat and sticks become key presses', () => {
  const keys: number[] = [];
  const pad = new PadTranslator((k) => keys.push(k));
  pad.handle(EV_KEY, 0x130, 1); // A down
  pad.handle(EV_KEY, 0x130, 0); // A up: no second press
  pad.handle(EV_KEY, 0x131, 1); // B
  pad.handle(EV_ABS, 0x11, 1); // hat down
  pad.handle(EV_ABS, 0x11, 0);
  pad.handle(EV_ABS, 0, -30000); // Xbox-style stick left
  pad.handle(EV_ABS, 0, -200); // back to centre
  pad.handle(EV_KEY, 0x223, 1); // d-pad button right
  pad.handle(EV_KEY, 0x223, 0);
  pad.stop();
  assert.deepEqual(keys, [PAD_KEYS.enter, PAD_KEYS.esc, PAD_KEYS.down, PAD_KEYS.left, PAD_KEYS.right]);
});

test('0–255 sticks (PlayStation-style) are centred at 128', () => {
  const keys: number[] = [];
  const pad = new PadTranslator((k) => keys.push(k));
  pad.handle(EV_ABS, 1, 128); // resting
  pad.handle(EV_ABS, 1, 0); // pushed up
  pad.handle(EV_ABS, 1, 130);
  pad.stop();
  assert.deepEqual(keys, [PAD_KEYS.up]);
});

test('held direction repeats', async () => {
  const keys: number[] = [];
  const pad = new PadTranslator((k) => keys.push(k));
  pad.handle(EV_ABS, 0x10, 1);
  await new Promise((r) => setTimeout(r, 560));
  pad.stop();
  assert.ok(keys.length >= 2 && keys.every((k) => k === PAD_KEYS.right));
});

test('Moonlight keeps its own controller support', () => {
  assert.equal(wantsControllerKeys({ id: 'plex', name: 'Plex', launch: { type: 'command', command: ['flatpak', 'run', 'tv.plex.PlexHTPC'] } }), true);
  assert.equal(wantsControllerKeys({ id: 'yt', name: 'YouTube', launch: { type: 'web', url: 'https://www.youtube.com/tv' } }), true);
  assert.equal(wantsControllerKeys({ id: 'm', name: 'Moonlight', launch: { type: 'command', command: ['flatpak', 'run', 'com.moonlight_stream.Moonlight'] } }), false);
  assert.equal(wantsControllerKeys({ id: 'j', name: 'Jellyfin', controllerKeys: false, launch: { type: 'web', url: 'x' } }), false);
});

test('pointer mode: the stick moves the pointer, A clicks, the d-pad still sends arrows', async () => {
  const keys: number[] = [];
  const moves: Array<[number, number]> = [];
  let clicks = 0;
  const pad = new PadTranslator((k) => keys.push(k), { move: (dx, dy) => moves.push([dx, dy]), click: () => clicks++ });
  pad.handle(EV_ABS, 0, 32767); // stick full right
  await new Promise((r) => setTimeout(r, 120));
  pad.handle(EV_ABS, 0, 0); // let go
  const count = moves.length;
  await new Promise((r) => setTimeout(r, 80));
  pad.handle(EV_KEY, 0x130, 1); // A
  pad.handle(EV_KEY, 0x223, 1); // d-pad right
  pad.handle(EV_KEY, 0x223, 0);
  pad.stop();
  assert.ok(count >= 2 && moves.every(([dx, dy]) => dx > 0 && dy === 0), JSON.stringify(moves));
  assert.equal(moves.length, count, 'stops moving when the stick is released');
  assert.equal(clicks, 1);
  assert.deepEqual(keys, [PAD_KEYS.right]);
});

test('mouse-made websites get the pointer; TV web apps and native apps keep arrow keys', () => {
  assert.equal(wantsPointer({ id: 'prime', name: 'Prime', launch: { type: 'web', url: 'https://www.primevideo.com' } }), true);
  assert.equal(wantsPointer({ id: 'yt', name: 'YouTube', launch: { type: 'web', url: 'https://www.youtube.com/tv', userAgent: 'TV' } }), false);
  assert.equal(wantsPointer({ id: 'plex', name: 'Plex', launch: { type: 'command', command: ['flatpak', 'run', 'tv.plex.PlexHTPC'] } }), false);
  assert.equal(wantsPointer({ id: 'n', name: 'Netflix', controllerPointer: false, launch: { type: 'web', url: 'https://www.netflix.com' } }), false);
});
