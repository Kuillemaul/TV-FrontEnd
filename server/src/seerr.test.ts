import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.js';
import { mediaStatus, toDownload, toMedia } from './providers/seerr.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Seerr search results: films, shows, no people', () => {
  const film = toMedia({ id: 693134, mediaType: 'movie', title: 'Dune: Part Two', releaseDate: '2024-02-27', posterPath: '/p.jpg', overview: 'x', mediaInfo: { status: 5 } });
  assert.deepEqual(film, {
    id: 693134,
    mediaType: 'movie',
    title: 'Dune: Part Two',
    year: 2024,
    poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
    backdrop: undefined,
    overview: 'x',
    status: 'available',
  });
  const show = toMedia({ id: 1, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-18' });
  assert.equal(show?.title, 'Severance');
  assert.equal(show?.status, 'none');
  assert.equal(toMedia({ id: 2, mediaType: 'person', name: 'Someone' }), null);
  // Discover lists don't always say the type.
  assert.equal(toMedia({ id: 3, name: 'Bluey' }, 'tv')?.mediaType, 'tv');
  assert.deepEqual([2, 3, 4, 6, undefined].map(mediaStatus), ['requested', 'processing', 'partial', 'blocked', 'none']);
});

test('*arr queue records', () => {
  const ep = toDownload('sonarr', {
    id: 9,
    size: 1000,
    sizeleft: 250,
    timeleft: '00:04:12',
    trackedDownloadState: 'downloading',
    series: { title: 'The Expanse' },
    episode: { seasonNumber: 3, episodeNumber: 7, title: 'Delta-V' },
  });
  assert.deepEqual(ep, { id: 'sonarr-9', kind: 'sonarr', title: 'The Expanse', subtitle: 'S3 · E7 · Delta-V', progress: 0.75, timeLeft: '04:12', status: 'downloading' });
  assert.equal(toDownload('radarr', { id: 1, size: 0, movie: { title: 'Dune', year: 2021 } }).progress, 0);
  assert.equal(toDownload('lidarr', { id: 2, artist: { artistName: 'Daft Punk' }, album: { title: 'Discovery' } }).subtitle, 'Discovery');
});

test('requests config: login page URL, placeholder keys skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-req-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(
    file,
    `requests:
  seerr: { url: "http://192.168.50.252:5055/login", apiKey: abc }
  radarr: { url: "http://192.168.50.252:7878/", apiKey: def }
  sonarr: { url: "http://192.168.50.252:8989", apiKey: "PASTE_SONARR_API_KEY" }
`,
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.requests.seerr?.url, 'http://192.168.50.252:5055');
  assert.equal(cfg.requests.radarr?.url, 'http://192.168.50.252:7878');
  assert.equal(cfg.requests.sonarr, undefined);
});
