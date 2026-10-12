import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isKeyboard, isMouse, kbmStatus, parseDevices } from './input.js';

// /proc/bus/input/devices format: a keyboard+touchpad combo, a controller, an IR remote receiver.
const SAMPLE = `I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech K400 Plus"
P: Phys=usb-0000:00:14.0-2/input2:1
H: Handlers=sysrq kbd leds mouse0 event5
B: EV=12001f
B: KEY=3f 3007f 0 0 0 0 483ffff 17aad367 1e000000000000 1f0000 0 1f0001 1fffffffffffffff fffffffffffffffe
B: REL=1943

I: Bus=0003 Vendor=045e Product=0b12 Version=0509
N: Name="Microsoft Xbox Controller"
H: Handlers=event7 js0
B: EV=20000b
B: KEY=7cdb000000000000 0 0 0 0 0 0 0 0 0 0 0 0
B: ABS=3003f

I: Bus=0003 Vendor=20a0 Product=0001 Version=0101
N: Name="flirc.tv flirc"
H: Handlers=sysrq kbd leds event3
B: EV=120013
B: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe
`;

test('detects keyboard + mouse combo and ignores controllers', () => {
  const devices = parseDevices(SAMPLE);
  assert.equal(devices.length, 3);
  const [k400, pad, flirc] = devices;
  assert.ok(isKeyboard(k400) && isMouse(k400));
  assert.ok(!isKeyboard(pad) && !isMouse(pad));
  assert.ok(isKeyboard(flirc) && !isMouse(flirc));
  assert.deepEqual(kbmStatus(devices), { keyboard: 'Logitech K400 Plus', mouse: 'Logitech K400 Plus' });
});

test('reports nothing when only a controller is plugged in', () => {
  const pad = parseDevices(SAMPLE).filter((d) => d.name.includes('Xbox'));
  assert.deepEqual(kbmStatus(pad), { keyboard: null, mouse: null });
});
