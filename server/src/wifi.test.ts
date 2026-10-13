import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNetworks, splitTerse } from './wifi.js';

test('splitTerse handles escaped colons and backslashes', () => {
  assert.deepEqual(splitTerse(String.raw`*:My\:Net:80:WPA2`), ['*', 'My:Net', '80', 'WPA2']);
  assert.deepEqual(splitTerse(String.raw` :back\\slash:40:`), [' ', 'back\\slash', '40', '']);
});

test('parseNetworks keeps one entry per name, marks saved/in-use, strongest first', () => {
  const text = [' :Home:60:WPA2', '*:Home:72:WPA2', ' :Cafe:90:--', ' ::55:WPA2', ' :Neighbour:30:WPA1 WPA2', ' :Cafe:40:--'].join('\n');
  assert.deepEqual(parseNetworks(text, new Set(['Home'])), [
    { ssid: 'Home', signal: 72, secure: true, inUse: true, saved: true },
    { ssid: 'Cafe', signal: 90, secure: false, inUse: false, saved: false },
    { ssid: 'Neighbour', signal: 30, secure: true, inUse: false, saved: false },
  ]);
});
