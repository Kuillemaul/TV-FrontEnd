import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchIntent, parseDuration, type IntentCatalog } from './intents.js';

const catalog: IntentCatalog = {
  apps: [
    { id: 'netflix', name: 'Netflix' },
    { id: 'plex', name: 'Plex' },
    { id: 'youtube', name: 'YouTube' },
  ],
  games: [
    { id: 'steam-1245620', hostId: 'main', title: 'Elden Ring', requiresKbm: false },
    { id: 'steam-289070', hostId: 'main', title: 'Sid Meier’s Civilization VI', requiresKbm: true },
    { id: 'rom-sm', hostId: 'emu', title: 'Super Metroid', requiresKbm: false },
  ],
  channels: [
    { id: 'c4', number: 4, name: 'NBC' },
    { id: 'c7', number: 7, name: 'ABC' },
  ],
};

test('opens apps', () => {
  assert.deepEqual(matchIntent('Open Netflix', catalog)?.action, { type: 'launch-app', id: 'netflix', name: 'Netflix' });
  assert.equal(matchIntent('launch plex please', catalog)?.action.type, 'launch-app');
});

test('plays games and flags keyboard/mouse', () => {
  const elden = matchIntent('play elden ring', catalog);
  assert.equal(elden?.action.type, 'launch-game');
  const civ = matchIntent('Play Civilization 6', catalog);
  assert.ok(civ && civ.action.type === 'launch-game' && civ.action.requiresKbm);
  assert.match(civ!.speech, /keyboard and mouse/);
  assert.equal(matchIntent('play super metroid on the emulator', catalog)?.action.type, 'launch-game');
});

test('tunes channels by number, word and name', () => {
  assert.deepEqual(matchIntent('watch channel 4', catalog)?.action, { type: 'watch-channel', id: 'c4', name: 'NBC' });
  assert.equal((matchIntent('tune to channel seven', catalog)?.action as { id: string }).id, 'c7');
  assert.equal((matchIntent('put on ABC', catalog)?.action as { id: string }).id, 'c7');
});

test('navigates', () => {
  assert.deepEqual(matchIntent('show me the home lab', catalog)?.action, { type: 'navigate', page: 'lab' });
  assert.deepEqual(matchIntent('go home', catalog)?.action, { type: 'navigate', page: 'home' });
  assert.deepEqual(matchIntent('open the guide', catalog)?.action, { type: 'navigate', page: 'tv' });
});

test('leaves home automation to Home Assistant', () => {
  assert.equal(matchIntent('turn on the kitchen lights', catalog), null);
  assert.equal(matchIntent('what is the temperature outside', catalog), null);
  assert.equal(matchIntent('set the thermostat to 70', catalog), null);
});

test('stop closes the foreground app', () => {
  assert.deepEqual(matchIntent('stop', catalog)?.action, { type: 'stop' });
});

test('tv power and inputs', () => {
  const withInputs = { ...catalog, inputs: [{ id: 'xbox', name: 'Xbox' }, { id: 'appletv', name: 'Apple TV' }] };
  assert.deepEqual(matchIntent('turn off the tv', withInputs)?.action, { type: 'tv-power', on: false });
  assert.deepEqual(matchIntent('turn the TV on', withInputs)?.action, { type: 'tv-power', on: true });
  assert.deepEqual(matchIntent('switch to the xbox', withInputs)?.action, { type: 'tv-input', id: 'xbox', name: 'Xbox' });
  assert.equal(matchIntent('switch to channel 4', withInputs)?.action.type, 'watch-channel');
});

test('sleep timer phrases and durations', () => {
  const minutes = (s: string) => {
    const a = matchIntent(s, catalog)?.action;
    return a?.type === 'sleep-timer' ? a.minutes : null;
  };
  assert.equal(minutes('sleep timer one hour'), 60);
  assert.equal(minutes('Set a sleep timer for 30 minutes'), 30);
  assert.equal(minutes('turn off in an hour and a half'), 90);
  assert.equal(minutes('turn the TV off in 45 mins'), 45);
  assert.equal(minutes('sleep timer forty five minutes'), 45);
  assert.equal(minutes('sleep timer half an hour'), 30);
  assert.equal(minutes('sleep timer 1.5 hours'), 90);
  assert.equal(minutes('sleep timer two hours and 15 minutes'), 135);
  assert.equal(minutes('cancel the sleep timer'), 0);
  assert.equal(minutes('how long is left on the sleep timer'), -1);
  assert.equal(minutes('sleep timer banana'), null);
  assert.equal(parseDuration('20'), 20);
});

test('requests, downloads, pin this', () => {
  assert.deepEqual(matchIntent('Request Dune Part Three', catalog)?.action, { type: 'request-search', query: 'dune part three' });
  assert.deepEqual(matchIntent('can you download Severance for me', catalog)?.action, { type: 'request-search', query: 'severance' });
  assert.equal(matchIntent('What’s downloading?', catalog)?.action.type, 'downloads');
  assert.equal(matchIntent('how are the downloads going', catalog)?.action.type, 'downloads');
  assert.equal(matchIntent('pin this', catalog)?.action.type, 'pin-focused');
  assert.equal(matchIntent('unpin that from the home screen', catalog), null);
  assert.equal(matchIntent('unpin that', catalog)?.action.type, 'pin-focused');
  assert.deepEqual(matchIntent('go to requests', catalog)?.action, { type: 'navigate', page: 'requests' });
});

test('cameras', () => {
  const withCams = { ...catalog, cameras: [{ id: 'camera.front_porch', name: 'Front Porch' }, { id: 'camera.garage', name: 'Garage Camera' }], doorbellCamera: 'camera.front_door' };
  assert.deepEqual(matchIntent('show the garage camera', withCams)?.action, { type: 'camera', entity: 'camera.garage', name: 'Garage Camera' });
  assert.deepEqual(matchIntent('show me the front porch camera', withCams)?.action, { type: 'camera', entity: 'camera.front_porch', name: 'Front Porch' });
  assert.equal((matchIntent('who’s at the door', withCams)?.action as { entity: string }).entity, 'camera.front_door');
  assert.deepEqual(matchIntent('hide the camera', withCams)?.action, { type: 'camera', entity: null });
});
