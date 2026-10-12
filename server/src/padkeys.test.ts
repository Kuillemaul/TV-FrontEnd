import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAD_KEYS, PadTranslator, wantsControllerKeys } from './padkeys.js';

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
