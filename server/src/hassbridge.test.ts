import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityOf, HassBridge, parseCommand, slug, type HearthCommand } from './hassbridge.js';

test('activityOf names what the TV is doing', () => {
  assert.equal(activityOf(null).state, 'home');
  assert.equal(activityOf({ id: 'app:plex', title: 'Plex', startedAt: 0 }).state, 'plex');
  assert.deepEqual(activityOf({ id: 'livetv', title: 'Live TV – ABC', startedAt: 0 }, { channel: '20 ABC TV HD' }).attributes.channel, '20 ABC TV HD');
  assert.equal(activityOf({ id: 'game:pc:123', title: 'Hades', startedAt: 0 }).state, 'game');
  const app = activityOf({ id: 'app:youtube', title: 'YouTube', startedAt: 0 }, { appName: () => 'YouTube' });
  assert.deepEqual([app.state, app.attributes.app, app.attributes.app_id], ['app', 'YouTube', 'youtube']);
});

test('parseCommand checks commands and targets', () => {
  assert.deepEqual(parseCommand({ command: 'camera', entity: 'camera.front_door' }, 'living_room'), { command: 'camera', entity: 'camera.front_door', name: undefined });
  assert.deepEqual(parseCommand({ command: 'notify', message: 'Washer done' }, 'living_room'), {
    command: 'notify', title: 'Washer done', message: undefined, image: undefined, camera: undefined, seconds: 12,
  });
  assert.deepEqual(parseCommand({ command: 'sleep_timer', minutes: '30' }, 'x'), { command: 'sleep_timer', minutes: 30 });
  assert.deepEqual(parseCommand({ command: 'channel', channel: 20 }, 'x'), { command: 'channel', channel: '20' });
  assert.equal(parseCommand({ command: 'home', tv: 'bedroom' }, 'living_room'), null);
  assert.deepEqual(parseCommand({ command: 'home', tv: 'all' }, 'living_room'), { command: 'home' });
  assert.throws(() => parseCommand({ command: 'camera', entity: 'light.x' }, 'x'), /camera/);
  assert.throws(() => parseCommand({ command: 'explode' }, 'x'), /unknown/);
  assert.equal(slug('Living Room'), 'living_room');
});

test('HassBridge publishes entities and runs hearth_command events', async () => {
  const states: Record<string, { state: string; attributes: Record<string, unknown> }> = {};
  const events = new Map<string, (d: any) => void>();
  let ready = () => undefined as void;
  const ha = {
    connected: true,
    async setState(id: string, state: string, attributes: Record<string, unknown>) {
      states[id] = { state, attributes };
    },
    whenReady(fn: () => void) {
      ready = fn;
    },
    onEvent(type: string, fn: (d: any) => void) {
      events.set(type, fn);
    },
  };
  const ran: HearthCommand[] = [];
  const log = { info: () => undefined, warn: () => undefined };
  const bridge = new HassBridge(
    ha,
    'living_room',
    'Living Room',
    () => ({ activity: activityOf({ id: 'app:plex', title: 'Plex', startedAt: 0 }), profile: { name: 'Me', kind: 'admin' }, sleepEndsAt: null }),
    async (cmd) => {
      ran.push(cmd);
    },
    log,
  );
  ready();
  await bridge.publish();
  assert.equal(states['sensor.hearth_living_room_activity'].state, 'plex');
  assert.equal(states['sensor.hearth_living_room_profile'].state, 'Me');
  assert.equal(states['sensor.hearth_living_room_sleep_timer'].state, 'unknown');
  events.get('hearth_command')!({ command: 'open_app', app: 'netflix' });
  events.get('hearth_command')!({ command: 'bogus' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [{ command: 'open_app', app: 'netflix' }]);
});
