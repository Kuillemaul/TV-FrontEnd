import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelList, currentOutput, parseOutputs, profileToApply, sinkBelongsTo, testTone, type PactlCard } from './audio.js';

// The OptiPlex 5080's Intel HDA card as pactl reports it (HDMI 1 connected, 2 and 3 empty).
const yes = { available: true, sinks: 1 };
const no = { available: false, sinks: 1 };
const OPTIPLEX: PactlCard = {
  name: 'alsa_card.pci-0000_00_1f.3',
  description: 'Built-in Audio',
  active_profile: 'output:hdmi-stereo+input:analog-stereo',
  profiles: {
    off: { sinks: 0 },
    'output:analog-stereo+input:analog-stereo': yes,
    'output:hdmi-stereo+input:analog-stereo': yes,
    'output:hdmi-stereo': yes,
    'output:hdmi-surround+input:analog-stereo': yes,
    'output:hdmi-surround': yes,
    'output:hdmi-surround71': yes,
    'output:hdmi-stereo-extra1': no,
    'output:hdmi-surround-extra1': no,
    'output:hdmi-surround71-extra1': no,
    'output:hdmi-stereo-extra2': no,
    'output:analog-stereo': { available: 'yes', sinks: 1 },
    'pro-audio': yes,
  },
};

test('ports and layouts from card profiles', () => {
  const outputs = parseOutputs([OPTIPLEX]);
  const hdmi1 = outputs.find((o) => o.label === 'HDMI 1');
  assert.ok(hdmi1?.available);
  assert.deepEqual(
    hdmi1.layouts.map((l) => [l.channels, l.profile]),
    [
      [2, 'output:hdmi-stereo'],
      [6, 'output:hdmi-surround'],
      [8, 'output:hdmi-surround71'],
    ],
  );
  const hdmi2 = outputs.find((o) => o.label === 'HDMI 2');
  assert.equal(hdmi2?.available, false);
  assert.equal(hdmi2?.layouts.length, 3);
  assert.equal(outputs.find((o) => o.label === 'HDMI 3')?.layouts.length, 1);
  assert.ok(outputs.find((o) => o.label === 'Headphone / line out'));
  assert.ok(!outputs.some((o) => o.label.includes('pro-audio')));
  // Connected ports first.
  assert.equal(outputs.at(-1)?.available, false);
});

test('current output and keeping the mic input when switching', () => {
  const outputs = parseOutputs([OPTIPLEX]);
  assert.deepEqual(currentOutput(outputs, OPTIPLEX), { outputId: 'alsa_card.pci-0000_00_1f.3|hdmi', channels: 2 });
  assert.equal(profileToApply(OPTIPLEX, 'output:hdmi-surround'), 'output:hdmi-surround+input:analog-stereo');
  // No "+input" variant of 7.1 → the plain output profile.
  assert.equal(profileToApply(OPTIPLEX, 'output:hdmi-surround71'), 'output:hdmi-surround71');
});

test('bluetooth speakers become a single port', () => {
  const bt: PactlCard = { name: 'bluez_card.AA_BB', description: 'Soundbar', profiles: { off: { sinks: 0 }, 'a2dp-sink': { sinks: 1 } } };
  assert.deepEqual(parseOutputs([bt]).map((o) => [o.label, o.layouts[0].profile]), [['Soundbar', 'a2dp-sink']]);
});

test('sinks are matched to their card', () => {
  assert.ok(sinkBelongsTo({ name: 'alsa_output.pci-0000_00_1f.3.hdmi-surround' }, OPTIPLEX));
  assert.ok(sinkBelongsTo({ name: 'x', properties: { 'device.name': OPTIPLEX.name } }, OPTIPLEX));
  assert.ok(!sinkBelongsTo({ name: 'alsa_output.usb-Foo.analog-stereo' }, OPTIPLEX));
  assert.deepEqual(channelList('front-left,front-right,rear-left'), ['front-left', 'front-right', 'rear-left']);
});

test('test tone only plays on the chosen speaker', () => {
  const pcm = testTone(6, 2, false);
  let loud = new Array(6).fill(0);
  for (let i = 0; i < pcm.length; i += 2) loud[(i / 2) % 6] = Math.max(loud[(i / 2) % 6], Math.abs(pcm.readInt16LE(i)));
  assert.ok(loud[2] > 10000);
  assert.deepEqual(loud.filter((_, c) => c !== 2), [0, 0, 0, 0, 0]);
  loud = [0];
  const sub = testTone(1, 0, true);
  for (let i = 0; i < sub.length; i += 2) loud[0] = Math.max(loud[0], Math.abs(sub.readInt16LE(i)));
  assert.ok(loud[0] > 10000);
});
