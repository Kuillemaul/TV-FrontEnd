import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JellyfinClient } from './providers/jellyfin.js';

const U = '/Users/u1';
const routes: Record<string, unknown> = {
  [`${U}/Items/Resume`]: {
    Items: [
      { Id: 'm1', Type: 'Movie', Name: 'Dune', ProductionYear: 2021, BackdropImageTags: ['b'], UserData: { PlayedPercentage: 40 } },
      { Id: 'e1', Type: 'Episode', Name: 'Cricket', SeriesName: 'Bluey', SeriesId: 's1', ParentIndexNumber: 3, IndexNumber: 5, ParentBackdropItemId: 's1', ParentBackdropImageTags: ['x'], UserData: { PlayedPercentage: 10 } },
    ],
  },
  '/Shows/NextUp?UserId=u1&SeriesId=s2': { Items: [{ Id: 'e9' }] },
  '/Shows/NextUp': {
    Items: [
      { Id: 'e2', Type: 'Episode', Name: 'Dad Baby', SeriesName: 'Bluey', SeriesId: 's1', ParentIndexNumber: 3, IndexNumber: 6 },
      { Id: 'e3', Type: 'Episode', Name: 'Hello', SeriesName: 'Severance', SeriesId: 's2', ParentIndexNumber: 2, IndexNumber: 1 },
    ],
  },
  [`${U}/Items/Latest`]: [
    { Id: 'm2', Type: 'Movie', Name: 'Wicked', ProductionYear: 2024, ImageTags: { Primary: 'p' } },
    { Id: 's3', Type: 'Season', Name: 'Season 2', SeriesName: 'Severance', SeriesId: 's2' },
  ],
  [`${U}/Items/s2`]: { Id: 's2', Type: 'Series', Name: 'Severance' },
  [`${U}/Items/m1`]: { Id: 'm1', Type: 'Movie', Name: 'Dune', UserData: { PlaybackPositionTicks: 600_000_000 } },
  [`${U}/Items?searchTerm=Severance`]: { Items: [{ Id: 's2', Type: 'Series', Name: 'Severance', ProductionYear: 2022 }] },
  [`${U}/Items?searchTerm=Dune`]: { Items: [{ Id: 'm0', Type: 'Movie', Name: 'Dune', ProductionYear: 1984 }, { Id: 'm1', Type: 'Movie', Name: 'Dune', ProductionYear: 2021 }] },
  [`${U}/Items?searchTerm=Nope`]: { Items: [] },
  '/Shows/s2/Episodes?UserId=u1&Season=2': { Items: [{ Id: 'e3', IndexNumber: 1 }, { Id: 'e4', IndexNumber: 2 }] },
  '/Sessions?ControllableByUserId=u1': [
    { Id: 'phone', Client: 'Jellyfin Android', DeviceName: 'Pixel', RemoteEndPoint: '192.168.1.40' },
    { Id: 'tv', Client: 'Jellyfin Media Player', DeviceName: 'hearth', RemoteEndPoint: '::ffff:192.168.1.20:51234' },
  ],
};

function mockFetch(calls: string[]) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url).replace('http://jf:8096', '');
    calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (init?.method === 'POST' && u.startsWith('/Sessions/')) return new Response(null, { status: 204 });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => u.startsWith(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
}

test('Jellyfin: continue watching, recently added, search, find, play', async () => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = mockFetch(calls);
  try {
    const jf = new JellyfinClient({ kind: 'jellyfin', url: 'http://jf:8096', token: 't', userId: 'u1' });

    const deck = await jf.onDeck();
    // Resume first; Next Up skips Bluey (already resuming) and adds Severance.
    assert.deepEqual(deck.map((d) => d.id), ['m1', 'e1', 'e3']);
    assert.equal(deck[0].progress, 0.4);
    assert.equal(deck[1].title, 'Bluey');
    assert.equal(deck[1].subtitle, 'S3 · E5 · Cricket');
    assert.match(deck[1].thumb!, /^\/api\/library\/thumb\?path=%2FItems%2Fs1%2FImages%2FBackdrop/);

    const recent = await jf.recentlyAdded();
    assert.deepEqual(recent.map((r) => `${r.title}|${r.subtitle}`), ['Wicked|2024', 'Severance|Season 2']);

    const hits = await jf.search('Severance');
    assert.equal(hits[0].type, 'show');

    assert.equal(await jf.find({ title: 'Dune', year: 2021, mediaType: 'movie' }), 'm1');
    assert.equal(await jf.find({ title: 'Severance', mediaType: 'tv', season: 2, episode: 2 }), 'e4');
    assert.equal(await jf.find({ title: 'Severance', mediaType: 'tv', season: 2, episode: 9 }), null, 'not scanned yet');
    assert.equal(await jf.find({ title: 'Nope', mediaType: 'movie' }), null);

    assert.equal(await jf.playable('s2'), 'e9', 'a show plays its next episode');
    assert.equal(await jf.playable('m1'), 'm1');

    const title = await jf.playOnPlayer('m1', (ip) => ip === '192.168.1.20', 2000);
    assert.equal(title, 'Dune');
    assert.ok(calls.includes('POST /Sessions/tv/Playing?PlayCommand=PlayNow&ItemIds=m1&StartPositionTicks=600000000'), 'plays on the TV session, from where you left off');

    assert.equal((await jf.thumb('/System/Info')).status, 404, 'artwork paths only');
  } finally {
    globalThis.fetch = real;
  }
});
