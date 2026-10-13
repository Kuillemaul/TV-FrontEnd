import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlexClient } from './providers/plex.js';

const routes: Record<string, unknown> = {
  '/library/recentlyAdded': {
    MediaContainer: {
      Metadata: [
        { type: 'movie', ratingKey: 1, title: 'Wicked', year: 2024, art: '/art/1' },
        { type: 'season', ratingKey: 20, parentTitle: 'Severance', title: 'Season 2', index: 2, parentThumb: '/t/20' },
        { type: 'album', ratingKey: 30, title: 'Discovery' },
        { type: 'episode', ratingKey: 41, grandparentTitle: 'Bluey', parentIndex: 3, index: 5, title: 'Cricket' },
      ],
    },
  },
  'discover.provider.plex.tv': {
    MediaContainer: {
      Metadata: [
        { type: 'movie', title: 'Dune: Part Three', year: 2026, thumb: 'https://metadata-static.plex.tv/x.jpg' },
        { type: 'show', title: 'The Expanse', year: 2015 },
        { type: 'episode', title: 'skip me' },
      ],
    },
  },
  '/hubs/search': { MediaContainer: { Hub: [{ type: 'show', Metadata: [{ title: 'Severance', year: 2022, ratingKey: 7 }] }, { type: 'movie', Metadata: [{ title: 'Dune', year: 2021, ratingKey: 9 }] }] } },
  '/library/metadata/20/allLeaves': { MediaContainer: { Metadata: [{ ratingKey: 201, viewCount: 1 }, { ratingKey: 202 }] } },
  '/library/metadata/20': { MediaContainer: { Metadata: [{ type: 'season' }] } },
  '/library/metadata/7/allLeaves': { MediaContainer: { Metadata: [{ ratingKey: 71, parentIndex: 1, index: 1 }, { ratingKey: 72, parentIndex: 2, index: 3 }] } },
};

test('recently added, watchlist, find and playable', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => u.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
  try {
    const plex = new PlexClient({ url: 'http://pms:32400', token: 't' });
    const recent = await plex.recentlyAdded();
    assert.deepEqual(recent.map((r) => [r.id, r.title, r.subtitle]), [
      ['1', 'Wicked', '2024'],
      ['20', 'Severance', 'Season 2'],
      ['41', 'Bluey', 'S3 · E5 · Cricket'],
    ]);
    assert.match(recent[0].thumb ?? '', /^\/api\/plex\/thumb\?path=/);
    const wl = await plex.watchlist();
    assert.deepEqual(wl, [
      { title: 'Dune: Part Three', year: 2026, mediaType: 'movie', thumb: 'https://metadata-static.plex.tv/x.jpg' },
      { title: 'The Expanse', year: 2015, mediaType: 'tv', thumb: undefined },
    ]);
    assert.equal(await plex.find({ title: 'Dune', year: 2021, mediaType: 'movie' }), '9');
    assert.equal(await plex.find({ title: 'Severance', mediaType: 'tv', season: 2, episode: 3 }), '72');
    assert.equal(await plex.find({ title: 'Not There', mediaType: 'movie' }), null);
    assert.equal(await plex.playable('20'), '202'); // next unwatched episode of the season
  } finally {
    globalThis.fetch = real;
  }
});
