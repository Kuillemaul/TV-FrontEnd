import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { editConfigList } from './configedit.js';

const TEXT = `# my TV
ui:
  name: Living Room # the name on screen

lab:
  # servers to watch
  services:
    - name: Proxmox
      url: https://pve.lan:8006
  sensors: [sensor.cpu]
`;

test('adds, replaces and removes list items, keeping comments', () => {
  let text = editConfigList(TEXT, ['lab', 'services'], { op: 'add', item: { name: 'NAS', url: 'http://nas.lan' } });
  assert.match(text, /# my TV/);
  assert.match(text, /# servers to watch/);
  assert.match(text, /# the name on screen/);
  assert.deepEqual(parse(text).lab.services.map((s: any) => s.name), ['Proxmox', 'NAS']);

  text = editConfigList(text, ['lab', 'services'], { op: 'replace', old: { name: 'Proxmox', url: 'https://pve.lan:8006' }, item: { name: 'PVE', url: 'https://pve.lan:8006', open: true } });
  assert.deepEqual(parse(text).lab.services[0], { name: 'PVE', url: 'https://pve.lan:8006', open: true });

  text = editConfigList(text, ['lab', 'sensors'], { op: 'add', item: 'sensor.disk' });
  text = editConfigList(text, ['lab', 'sensors'], { op: 'remove', old: 'sensor.cpu' });
  assert.deepEqual(parse(text).lab.sensors, ['sensor.disk']);
});

test('creates missing sections, even in an empty file or under an empty key', () => {
  assert.deepEqual(parse(editConfigList('', ['lab', 'actions'], { op: 'add', item: { name: 'Go' } })), { lab: { actions: [{ name: 'Go' }] } });
  assert.deepEqual(parse(editConfigList('lab:\n', ['lab', 'sensors'], { op: 'add', item: 'sensor.x' })), { lab: { sensors: ['sensor.x'] } });
});

test('refuses to change an item that is no longer there', () => {
  assert.throws(() => editConfigList(TEXT, ['lab', 'services'], { op: 'remove', old: { name: 'Gone', url: 'x' } }), /isn’t in config.yaml/);
  assert.throws(() => editConfigList('lab: [oops', ['lab', 'services'], { op: 'add', item: {} }), /error to fix first/);
});
