import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMorning, inWindow, sortEvents, toDayEvent } from './morning.js';

test('toDayEvent handles timed and all-day events', () => {
  const timed = toDayEvent('Family', { summary: 'Swimming', start: { dateTime: '2026-10-14T16:00:00+11:00' }, end: { dateTime: '2026-10-14T17:00:00+11:00' }, location: 'Pool' });
  assert.deepEqual([timed?.title, timed?.allDay, timed?.location, timed?.end! - timed?.start!], ['Swimming', false, 'Pool', 3600_000]);
  const allDay = toDayEvent('Bins', { summary: 'Recycling', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } });
  assert.equal(allDay?.allDay, true);
  assert.equal(new Date(allDay!.start).getHours(), 0);
  assert.equal(toDayEvent('x', {}), null);
});

test('sortEvents: all-day first, then by time, duplicates dropped', () => {
  const e = (title: string, start: number, allDay = false) => ({ calendar: 'c', title, start, end: start + 1, allDay });
  const sorted = sortEvents([e('B', 20), e('A', 10), e('Bins', 0, true), e('a', 10)]).map((x) => x.title.toLowerCase());
  assert.deepEqual(sorted, ['bins', 'a', 'b']);
});

test('inWindow, including windows past midnight', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 14, h, m);
  assert.equal(inWindow(at(6), '05:00', '10:00'), true);
  assert.equal(inWindow(at(10), '05:00', '10:00'), false);
  assert.equal(inWindow(at(4, 59), '05:00', '10:00'), false);
  assert.equal(inWindow(at(23), '22:00', '02:00'), true);
  assert.equal(inWindow(at(1), '22:00', '02:00'), true);
});

test('buildMorning gathers today, tomorrow, weather and to-do from Home Assistant', async () => {
  const now = new Date(2026, 9, 14, 7, 30);
  const iso = (h: number, d = 14) => new Date(2026, 9, d, h).toISOString();
  const ha = {
    entityIds: (domain: string) => (domain === 'calendar' ? ['calendar.family'] : ['todo.shopping', 'todo.empty']),
    entity: (id: string) =>
      id === 'weather.home'
        ? { state: 'partlycloudy', attributes: { temperature: 14, temperature_unit: '°C' } }
        : { state: '', attributes: { friendly_name: id === 'calendar.family' ? 'Family' : id === 'todo.shopping' ? 'Shopping' : 'Empty' } },
    calendarEvents: async () => [
      { summary: 'Breakfast', start: { dateTime: iso(6) }, end: { dateTime: iso(7) } },
      { summary: 'Dentist', start: { dateTime: iso(15) }, end: { dateTime: iso(16) } },
      { summary: 'Bin night', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } },
      { summary: 'Footy', start: { dateTime: iso(10, 15) }, end: { dateTime: iso(12, 15) } },
    ],
    forecast: async (_: string, type: string) =>
      type === 'daily' ? [{ temperature: 21, templow: 9, precipitation_probability: 30 }] : [{ datetime: iso(8), temperature: 15, condition: 'sunny' }, { datetime: iso(5), temperature: 9, condition: 'clear-night' }],
    todoItems: async (id: string) => (id === 'todo.shopping' ? [{ summary: 'Milk', status: 'needs_action' }, { summary: 'Eggs', status: 'completed' }] : []),
  };
  const m = await buildMorning(ha, { enabled: true, start: '05:00', end: '10:00', calendars: [], todo: [] }, 'weather.home', null, now);
  assert.deepEqual(m.events.map((e) => e.title), ['Bin night', 'Dentist']); // breakfast is over
  assert.deepEqual(m.tomorrow.map((e) => e.title), ['Footy']);
  assert.deepEqual([m.weather?.temperature, m.weather?.high, m.weather?.low, m.weather?.rain, m.weather?.hourly.length], [14, 21, 9, 30, 1]);
  assert.deepEqual(m.todo, [{ list: 'Shopping', items: ['Milk'] }]);
  assert.deepEqual(m.errors, []);
});
