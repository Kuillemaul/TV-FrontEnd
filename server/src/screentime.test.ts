import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Profile } from './profiles.js';
import { inBedtime, ScreenTime } from './screentime.js';

const kid: Profile = {
  id: 'leo',
  name: 'Leo',
  color: '#fc0',
  kind: 'kid',
  apps: [],
  games: [],
  liveTv: false,
  theme: { background: 'candy', palette: 'sunny', font: 'fredoka' },
  limits: { dailyMinutes: 60, bedtime: '20:00', wakeTime: '07:00' },
};

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);

test('bedtime window wraps past midnight', () => {
  assert.ok(inBedtime(at(21), '20:00', '07:00'));
  assert.ok(inBedtime(at(3), '20:00', '07:00'));
  assert.ok(!inBedtime(at(12), '20:00', '07:00'));
  assert.ok(inBedtime(at(14), '13:00', '15:00'));
  assert.ok(!inBedtime(at(16), '13:00', '15:00'));
  assert.ok(!inBedtime(at(21), null, null));
});

test('daily limit counts down and bonus extends it', () => {
  const st = new ScreenTime(mkdtempSync(join(tmpdir(), 'hearth-st-')));
  st.addUsage('leo', 45, at(10));
  assert.equal(st.status(kid, at(10)).remainingMinutes, 15);
  st.addUsage('leo', 20, at(11));
  assert.equal(st.status(kid, at(11)).blocked, 'limit');
  st.addBonus('leo', 15, at(11));
  const s = st.status(kid, at(11));
  assert.deepEqual([s.blocked, s.remainingMinutes, s.limitMinutes], [null, 10, 75]);
  // A new day starts fresh.
  assert.equal(st.status(kid, new Date(2026, 9, 13, 10)).remainingMinutes, 60);
});

test('bedtime blocks, and parents never have limits', () => {
  const st = new ScreenTime(mkdtempSync(join(tmpdir(), 'hearth-st-')));
  assert.equal(st.status(kid, at(20, 30)).blocked, 'bedtime');
  const parent: Profile = { ...kid, id: 'me', kind: 'admin' };
  st.addUsage('me', 500, at(10));
  assert.equal(st.status(parent, at(22)).blocked, null);
  assert.equal(st.status(parent, at(22)).limitMinutes, null);
});
