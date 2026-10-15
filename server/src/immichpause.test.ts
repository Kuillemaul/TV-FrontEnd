import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { ImmichGovernor } from './immichpause.js';

const quiet = { info: () => undefined, warn: () => undefined };

test('pauses Immich while something plays, resumes a while after', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const calls: boolean[] = [];
    const g = new ImmichGovernor({ setPaused: async (p) => void calls.push(p) }, { log: quiet, resumeAfterMs: 1000 });
    g.start();
    assert.deepEqual(calls, [false], 'starts resumed (in case Hearth stopped while paused)');

    g.session(true, 'Elden Ring');
    assert.deepEqual(calls, [false, true]);
    assert.ok(g.isPaused);
    g.session(true, 'Elden Ring');
    assert.equal(calls.length, 2, 'not paused twice');

    g.session(false);
    mock.timers.tick(500);
    g.session(true, 'Live TV'); // back to watching before the resume: stays paused
    mock.timers.tick(2000);
    assert.deepEqual(calls, [false, true]);

    g.session(false);
    mock.timers.tick(1000);
    assert.deepEqual(calls, [false, true, false]);
    assert.ok(!g.isPaused);
  } finally {
    mock.timers.reset();
  }
});

test('also pauses while someone uses the machine-learning PC', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const calls: boolean[] = [];
    let busy: string | null = 'Someone is playing on Emulator PC';
    const g = new ImmichGovernor({ setPaused: async (p) => void calls.push(p) }, { log: quiet, pcBusy: async () => busy, pollMs: 100, resumeAfterMs: 100 });
    g.start();
    mock.timers.tick(100);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [false, true]);
    busy = null;
    mock.timers.tick(100);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(100);
    assert.deepEqual(calls, [false, true, false]);
    g.stop();
  } finally {
    mock.timers.reset();
  }
});
