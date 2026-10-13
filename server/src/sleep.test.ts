import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { SleepTimer, sayMinutes } from './sleep.js';

test('warns a minute before, then sleeps; extend and cancel work', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const events: string[] = [];
    const t = new SleepTimer({ warn: () => events.push('warn'), sleep: async () => void events.push('sleep'), changed: (e) => events.push(e ? 'set' : 'clear') });
    t.set(10);
    assert.equal(t.remainingMinutes, 10);
    mock.timers.tick(9 * 60_000);
    assert.deepEqual(events, ['set', 'warn']);
    t.extend(30); // "Keep watching (+30 min)"
    assert.equal(t.remainingMinutes, 31);
    mock.timers.tick(31 * 60_000);
    assert.deepEqual(events, ['set', 'warn', 'set', 'warn', 'clear', 'sleep']);
    t.set(5);
    t.set(0);
    mock.timers.tick(10 * 60_000);
    assert.equal(events.filter((e) => e === 'sleep').length, 1);
    assert.equal(sayMinutes(90), '1 hour 30 minutes');
  } finally {
    mock.timers.reset();
  }
});
