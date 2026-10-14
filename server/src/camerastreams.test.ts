import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { CameraStreams } from './camerastreams.js';

function fakeHa(domains: Array<{ domain: string; services: Record<string, unknown> }>) {
  const calls: string[] = [];
  return {
    calls,
    async callService(domain: string, service: string, data: Record<string, unknown>) {
      calls.push(`${domain}.${service} ${data.entity_id}`);
    },
    async fetch() {
      return new Response(JSON.stringify(domains));
    },
  };
}
const log = { warn: () => undefined };

test('Eufy: starts once for several viewers, stops after the last leaves', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ha = fakeHa([{ domain: 'eufy_security', services: { start_p2p_livestream: {}, stop_p2p_livestream: {} } }]);
    const streams = new CameraStreams(ha, undefined, log, 20_000);
    assert.equal(await streams.open('camera.doorbell'), true);
    assert.equal(await streams.open('camera.doorbell'), true);
    assert.deepEqual(ha.calls, ['eufy_security.start_p2p_livestream camera.doorbell']);
    streams.close('camera.doorbell');
    streams.close('camera.doorbell');
    mock.timers.tick(19_000);
    // Reopened before the stop: no restart, no stop.
    await streams.open('camera.doorbell');
    mock.timers.tick(5_000);
    assert.deepEqual(ha.calls, ['eufy_security.start_p2p_livestream camera.doorbell']);
    streams.close('camera.doorbell');
    mock.timers.tick(20_000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ha.calls, ['eufy_security.start_p2p_livestream camera.doorbell', 'eufy_security.stop_p2p_livestream camera.doorbell']);
  } finally {
    mock.timers.reset();
  }
});

test('no Eufy integration and nothing configured: leaves cameras alone', async () => {
  const ha = fakeHa([{ domain: 'light', services: { turn_on: {} } }]);
  const streams = new CameraStreams(ha, undefined, log);
  assert.equal(await streams.open('camera.garage'), false);
  assert.deepEqual(ha.calls, []);
});

test('services from config.yaml win', async () => {
  const ha = fakeHa([]);
  const streams = new CameraStreams(ha, { start: 'camera.turn_on' }, log);
  assert.equal(await streams.open('camera.porch'), true);
  assert.deepEqual(ha.calls, ['camera.turn_on camera.porch']);
});
