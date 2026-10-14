import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatpakAppId } from './launcher.js';

test('finds the app id in flatpak run commands', () => {
  assert.equal(flatpakAppId(['flatpak', 'run', 'tv.plex.PlexHTPC']), 'tv.plex.PlexHTPC');
  assert.equal(flatpakAppId(['/usr/bin/flatpak', 'run', '--branch=stable', 'com.moonlight_stream.Moonlight', 'stream', 'pc', 'Desktop']), 'com.moonlight_stream.Moonlight');
  assert.equal(flatpakAppId(['flatpak', 'run', 'com.github.iwalton3.jellyfin-media-player', '--tv']), 'com.github.iwalton3.jellyfin-media-player');
  assert.equal(flatpakAppId(['mpv', 'http://x']), null);
  assert.equal(flatpakAppId(['flatpak', 'list']), null);
});

test('game streams: waits for a line of output, and logs it', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Launcher } = await import('./launcher.js');
  const stateDir = mkdtempSync(join(tmpdir(), 'hearth-'));
  const bus = { emit: () => undefined } as never;
  const quiet = { info: () => undefined, error: () => undefined };
  const launcher = new Launcher({ stateDir, browser: [] } as never, bus, quiet);
  await launcher.launch('game:pc:1', 'Test', { type: 'command', command: ['sh', '-c', 'sleep 0.2; echo "FFmpeg: Decoded frame with POC 0/0" >&2; sleep 5'] });
  assert.equal(await launcher.waitForOutput('game:pc:1', /Decoded frame/, 3000), true);
  assert.equal(await launcher.waitForOutput('game:pc:1', /never printed/, 200), false);
  await launcher.stop();
  assert.match(readFileSync(join(stateDir, 'moonlight.log'), 'utf8'), /Decoded frame/);
});
