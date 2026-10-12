import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlertService, type Alert } from './alerts.js';
import { matches } from './automations.js';

const e = (entity_id: string, state: string) => ({ entity_id, state, attributes: {} });

test('doorbell, rules and lab outages raise alerts', () => {
  const got: Alert[] = [];
  const svc = new AlertService(
    {
      doorbell: { entity: 'binary_sensor.doorbell', camera: 'camera.porch', seconds: 30 },
      rules: [{ entity: 'sensor.washer', from: 'running', to: 'idle', title: 'Washer is done' }],
      labDown: true,
    },
    (a) => got.push(a),
  );
  svc.onState(e('binary_sensor.doorbell', 'on'), e('binary_sensor.doorbell', 'off'));
  svc.onState(e('binary_sensor.doorbell', 'off'), e('binary_sensor.doorbell', 'on'));
  svc.onState(e('sensor.washer', 'idle'), e('sensor.washer', 'paused')); // wrong "from"
  svc.onState(e('sensor.washer', 'idle'), e('sensor.washer', 'running'));
  svc.onLabChange('Proxmox', false);
  assert.deepEqual(
    got.map((a) => [a.kind, a.title, a.camera]),
    [
      ['doorbell', 'Someone’s at the door', 'camera.porch'],
      ['info', 'Washer is done', undefined],
      ['warning', 'Proxmox is down', undefined],
    ],
  );
  assert.equal(svc.get(got[0].id)?.camera, 'camera.porch');
});

test('event entities ring on every press', () => {
  const got: Alert[] = [];
  const svc = new AlertService({ doorbell: { entity: 'event.doorbell', seconds: 30 }, rules: [], labDown: false }, (a) => got.push(a));
  svc.onState(e('event.doorbell', '2026-10-12T10:00:00Z'), e('event.doorbell', '2026-10-12T09:00:00Z'));
  svc.onState(e('event.doorbell', '2026-10-12T10:05:00Z'), e('event.doorbell', '2026-10-12T10:00:00Z'));
  assert.equal(got.length, 2);
});

test('scene rule matching', () => {
  assert.ok(matches('app:plex', ['plex']));
  assert.ok(matches('livetv', ['livetv', 'recording']));
  assert.ok(matches('game:pc:steam-1', ['game:*']));
  assert.ok(!matches('app:youtube', ['plex', 'livetv']));
  assert.ok(matches('anything', ['*']));
});
