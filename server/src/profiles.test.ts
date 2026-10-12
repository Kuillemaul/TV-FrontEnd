import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PermissionError, ProfileStore } from './profiles.js';

const fresh = () => new ProfileStore(mkdtempSync(join(tmpdir(), 'hearth-profiles-')));

test('kid profiles start curated and empty', () => {
  const store = fresh();
  const kid = store.create({ name: 'Leo', kind: 'kid' });
  assert.deepEqual(kid.apps, []);
  assert.deepEqual(kid.games, []);
  assert.equal(kid.liveTv, false);
  const apps = [{ id: 'plex' }, { id: 'youtube' }, { id: 'netflix' }];
  store.update(kid.id, { apps: ['youtube', 'plex'], games: ['pc:steam-1'] });
  assert.deepEqual(ProfileStore.orderApps(store.all[1], apps).map((a) => a.id), ['youtube', 'plex']);
  assert.ok(ProfileStore.allowsGame(store.all[1], 'pc', 'steam-1'));
  assert.ok(!ProfileStore.allowsGame(store.all[1], 'pc', 'steam-2'));
});

test('kids cannot edit profiles but can restyle themselves', () => {
  const store = fresh();
  const kid = store.create({ name: 'Leo', kind: 'kid' });
  store.setActive(kid.id);
  assert.throws(() => store.update(kid.id, { games: null }), PermissionError);
  assert.throws(() => store.create({ name: 'x', kind: 'admin' }), PermissionError);
  assert.throws(() => store.update('main', { theme: { background: 'ocean', palette: 'mint', font: 'inter' } }), PermissionError);
  store.update(kid.id, { theme: { background: 'ocean', palette: 'mint', font: 'nunito' } });
  assert.equal(store.active.theme.font, 'nunito');
});

test('parent PIN guards switching back', () => {
  const store = fresh();
  store.update('main', { pin: '1234' });
  const kid = store.create({ name: 'Leo', kind: 'kid' });
  store.setActive(kid.id);
  assert.throws(() => store.setActive('main', '0000'), PermissionError);
  assert.throws(() => store.setActive('main'), PermissionError);
  assert.equal(store.setActive('main', '1234').id, 'main');
});

test('always keeps one parent', () => {
  const store = fresh();
  assert.throws(() => store.remove('main'));
  assert.throws(() => store.update('main', { kind: 'kid' }));
});
