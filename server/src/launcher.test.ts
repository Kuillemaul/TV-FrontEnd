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
