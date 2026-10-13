import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArrWatcher, groupImports } from './providers/arrwatch.js';

test('Radarr imports: one item per film, with poster', () => {
  const items = groupImports('radarr', [
    { eventType: 'grabbed', movie: { id: 1, title: 'Dune' } },
    { eventType: 'downloadFolderImported', movieId: 1, movie: { id: 1, title: 'Dune: Part Two', year: 2024, tmdbId: 693134, images: [{ coverType: 'poster', remoteUrl: 'https://img/p.jpg' }] } },
    { eventType: 'downloadFolderImported', movieId: 1, movie: { id: 1, title: 'Dune: Part Two', year: 2024 } },
  ]);
  assert.deepEqual(items, [{ kind: 'movie', title: 'Dune: Part Two', year: 2024, poster: 'https://img/p.jpg', tmdbId: 693134 }]);
});

test('Sonarr imports: grouped per show season', () => {
  const ep = (id: number, n: number, title = '') => ({ eventType: 'downloadFolderImported', series: { id: 7, title: 'Severance', year: 2022, tvdbId: 371980 }, episode: { id, seasonNumber: 2, episodeNumber: n, title } });
  assert.deepEqual(groupImports('sonarr', [ep(13, 3, 'Who Is Alive?')]).map((i) => [i.subtitle, i.season, i.episode]), [['S2 · E3 · Who Is Alive?', 2, 3]]);
  const pack = groupImports('sonarr', [ep(15, 5), ep(12, 2), ep(15, 5), ep(14, 4)]);
  assert.equal(pack.length, 1);
  assert.equal(pack[0].subtitle, 'Season 2 · 3 new episodes');
  assert.equal(pack[0].episode, 2); // plays from the first new one
});

test('Lidarr imports: one per album', () => {
  const r = { eventType: 'trackFileImported', albumId: 4, artist: { artistName: 'Daft Punk' }, album: { id: 4, title: 'Discovery' } };
  assert.deepEqual(groupImports('lidarr', [r, r]).map((i) => [i.kind, i.title, i.subtitle]), [['music', 'Daft Punk', 'Discovery']]);
});

test('only-requested mode filters by Seerr ids', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const body = String(url).includes(':7878')
      ? [
          { eventType: 'downloadFolderImported', movie: { id: 1, title: 'Asked For', tmdbId: 11 } },
          { eventType: 'downloadFolderImported', movie: { id: 2, title: 'Not Asked', tmdbId: 22 } },
        ]
      : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const got: string[] = [];
    const w = new ArrWatcher(
      { radarr: { url: 'http://x:7878', apiKey: 'k' }, sonarr: { url: 'http://x:8989', apiKey: 'k' } },
      'requested',
      (i) => got.push(i.title),
      { warn: () => undefined },
      async () => new Set(['tmdb:11']),
    );
    await w.poll();
    assert.deepEqual(got, ['Asked For']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
