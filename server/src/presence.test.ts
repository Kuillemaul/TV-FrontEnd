import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostBusy } from './presence.js';

const now = 1_000_000_000;
const base = { name: 'Gaming PC', ours: false, now, idleMinutes: 5 };
const at = (idleSeconds: number, extra = {}) => ({ presence: { idleSeconds, locked: false, foreground: null, ...extra } });

test('recent input means someone is at the PC', () => {
  assert.deepEqual(hostBusy({ ...base, health: at(30) }), { reason: 'Someone is using Gaming PC', idleSeconds: 30 });
  assert.equal(hostBusy({ ...base, health: at(10 * 60) }), null);
});

test('a fullscreen game is named, and still counts for a while without input', () => {
  const game = { foreground: { title: 'ELDEN RING™', exe: 'eldenring.exe', fullscreen: true } };
  assert.equal(hostBusy({ ...base, health: at(20, game) })?.reason, 'Someone is playing ELDEN RING™ on Gaming PC');
  assert.equal(hostBusy({ ...base, health: at(20 * 60, game) })?.reason, 'ELDEN RING™ is open on Gaming PC');
  assert.equal(hostBusy({ ...base, health: at(45 * 60, game) }), null);
});

test('locked, asleep, unknown or turned off is not busy', () => {
  assert.equal(hostBusy({ ...base, health: at(5, { locked: true }) }), null);
  assert.equal(hostBusy({ ...base, health: null }), null);
  assert.equal(hostBusy({ ...base, health: {} }), null);
  assert.equal(hostBusy({ ...base, health: { presence: { idleSeconds: null } } }), null);
  assert.equal(hostBusy({ ...base, idleMinutes: 0, health: at(5) }), null);
});

test("Hearth's own stream, and input from it, don't count", () => {
  assert.equal(hostBusy({ ...base, ours: true, health: at(1) }), null);
  // Stream ended 2 min ago; last input 2 min ago was the stream's.
  assert.equal(hostBusy({ ...base, oursEndedAt: now - 120_000, health: at(120) }), null);
  // Someone touched the PC after the stream ended.
  assert.ok(hostBusy({ ...base, oursEndedAt: now - 120_000, health: at(30) }));
});

test('another stream from the PC (a phone, a laptop) is busy, but not our lingering one', () => {
  assert.equal(hostBusy({ ...base, health: { streamDisplay: true } })?.reason, 'Gaming PC is streaming to another device');
  assert.equal(hostBusy({ ...base, oursEndedAt: now - 10_000, health: { streamDisplay: true } }), null);
});
