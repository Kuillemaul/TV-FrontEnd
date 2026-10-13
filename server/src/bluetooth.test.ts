import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BluetoothControl, hasRealName, parseInfo } from './bluetooth.js';

test('parses bluetoothctl info, including battery and colour codes', () => {
  const d = parseInfo(
    'AA:BB:CC:DD:EE:01',
    'Device AA:BB:CC:DD:EE:01 (public)\n\tName: Xbox Wireless Controller\n\tAlias: Xbox Wireless Controller\n\tIcon: input-gaming\n\tPaired: yes\n\tTrusted: yes\n\tConnected: \x1b[0;92myes\x1b[0m\n\tBattery Percentage: 0x55 (85)\n',
  );
  assert.deepEqual(d, { mac: 'AA:BB:CC:DD:EE:01', name: 'Xbox Wireless Controller', icon: 'input-gaming', paired: true, connected: true, trusted: true, battery: 85 });
  assert.equal(hasRealName({ ...d, name: 'AA-BB-CC-DD-EE-01' }), false);
});

test('scan, pair, connect, disconnect, forget against a stand-in bluetoothctl', async () => {
  const fixtures = fileURLToPath(new URL('../test-fixtures', import.meta.url));
  process.env.PATH = `${fixtures}:${process.env.PATH}`;
  process.env.FAKE_BT_STATE = join(mkdtempSync(join(tmpdir(), 'hearth-bt-')), 'bt.json');
  const bt = new BluetoothControl();

  let s = await bt.status();
  assert.equal(s.available, true);
  assert.deepEqual(s.devices.map((d) => [d.name, d.paired]), [['Living Room Soundbar', true]]);

  await bt.scan(true);
  await new Promise((r) => setTimeout(r, 1200));
  s = await bt.status();
  const pad = s.devices.find((d) => d.icon === 'input-gaming')!;
  assert.equal(pad.paired, false);
  assert.equal(s.devices.filter(hasRealName).length, 2); // the nameless beacon is hidden from "add a device"

  await bt.pair(pad.mac);
  s = await bt.status();
  assert.deepEqual(
    s.devices.filter((d) => d.paired).map((d) => [d.name, d.connected, d.trusted]),
    [['Xbox Wireless Controller', true, true], ['Living Room Soundbar', false, false]],
  );

  await bt.connect('11:22:33:44:55:66');
  await bt.disconnect(pad.mac);
  await bt.forget(pad.mac);
  s = await bt.status();
  assert.deepEqual(s.devices.filter((d) => d.paired).map((d) => [d.name, d.connected]), [['Living Room Soundbar', true]]);
  await assert.rejects(bt.pair('nope'));
  bt.close();
});
