import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanDesign, TileArtStore } from './tileart.js';

test('cleanDesign keeps good fields and rejects bad ones', () => {
  assert.deepEqual(cleanDesign({ style: 'waves', colors: ['#FF0000', '#00ff00'], text: '  Hi  ', textStyle: 'caps', icon: '🎬', extra: 1 }), {
    style: 'waves',
    colors: ['#ff0000', '#00ff00'],
    text: 'Hi',
    textStyle: 'caps',
    icon: '🎬',
  });
  assert.throws(() => cleanDesign({ style: 'nope', colors: ['#000000', '#ffffff'] }), /style/);
  assert.throws(() => cleanDesign({ style: 'grid', colors: ['red', '#ffffff'] }), /colours/);
  assert.equal(cleanDesign({ style: 'grid', colors: ['#000000', '#ffffff'], text: 'x'.repeat(80) }).text?.length, 30);
});

test('TileArtStore saves designs and pictures, and reset removes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'));
  const store = new TileArtStore(dir);
  store.setDesign('netflix', { style: 'glow', colors: ['#000000', '#e50914'] });
  assert.equal(new TileArtStore(dir).get('netflix')?.type, 'design');

  const png = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`;
  const art = store.setImage('plex', png);
  assert.equal(art.type, 'image');
  const file = art.type === 'image' ? art.file : '';
  assert.ok(store.file(file));
  assert.equal(store.file('../tiles.json'), null);
  assert.throws(() => store.setImage('../x', png), /Unknown app/);
  assert.throws(() => store.setImage('plex', 'data:image/svg+xml;base64,AAAA'), /JPG/);

  store.reset('plex');
  assert.equal(store.get('plex'), undefined);
  assert.ok(!existsSync(join(dir, file)));
  assert.deepEqual(readdirSync(dir), ['tiles.json']);
});
