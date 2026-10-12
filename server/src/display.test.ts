import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modeArgs, parseWlrRandr } from './display.js';

const SAMPLE = `HDMI-A-1 "LG Electronics LG TV SSCR2 0x01010101 (HDMI-A-1)"
  Make: LG Electronics
  Model: LG TV SSCR2
  Serial: 0x01010101
  Physical size: 1600x900 mm
  Enabled: yes
  Modes:
    3840x2160 px, 60.000000 Hz (preferred, current)
    3840x2160 px, 59.940002 Hz
    3840x2160 px, 24.000000 Hz
    1920x1080 px, 120.000000 Hz
    1920x1080 px, 60.000000 Hz
  Position: 0,0
  Transform: normal
  Scale: 1.000000
  Adaptive Sync: disabled
DP-2 "Some Monitor"
  Enabled: no
  Modes:
    2560x1440 px, 144.000000 Hz (preferred)
`;

test('parses outputs and modes', () => {
  const [tv, dp] = parseWlrRandr(SAMPLE);
  assert.equal(tv.name, 'HDMI-A-1');
  assert.equal(tv.enabled, true);
  assert.equal(tv.modes.length, 5);
  assert.deepEqual(tv.modes[0], { width: 3840, height: 2160, refresh: 60, preferred: true, current: true });
  assert.equal(tv.modes[1].refresh, 59.940002);
  assert.equal(dp.enabled, false);
  assert.equal(dp.modes[0].preferred, true);
  assert.deepEqual(modeArgs({ output: 'HDMI-A-1', width: 1920, height: 1080, refresh: 120 }), ['--output', 'HDMI-A-1', '--mode', '1920x1080@120Hz']);
});
