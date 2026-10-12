import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cookieToken, isLoopback, RemotePairing } from './remote.js';
import { StateStore } from './state.js';

test('pairing issues a token once and burns the code after 5 misses', () => {
  const pairing = new RemotePairing(new StateStore(mkdtempSync(join(tmpdir(), 'hearth-remote-'))));
  const code = pairing.currentCode();
  const token = pairing.pair(code, 'Phone');
  assert.ok(token && pairing.valid(token));
  assert.equal(pairing.pair(code, 'Again'), null, 'codes are single-use');

  const next = pairing.currentCode();
  for (let i = 0; i < 5; i++) assert.equal(pairing.pair(next === '0000' ? '0001' : '0000', 'x'), null);
  assert.equal(pairing.pair(next, 'Phone'), null, 'code burned after 5 wrong guesses');
  assert.notEqual(pairing.currentCode(), '');
});

test('helpers', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::ffff:127.0.0.1') && !isLoopback('192.168.1.20'));
  assert.equal(cookieToken('a=1; hearth_remote=abc; b=2'), 'abc');
});
