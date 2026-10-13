import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridToProgrammes, shortChannelName, tunedStreamKey } from './providers/plexlive.js';

test('shortChannelName drops the bracketed long name', () => {
  assert.equal(shortChannelName('ABC (Australian Broadcasting Corporation)'), 'ABC');
  assert.equal(shortChannelName('Network Ten (Australia)'), 'Network Ten');
  assert.equal(shortChannelName('7mate'), '7mate');
});

test('gridToProgrammes: one programme per airing, show title first', () => {
  const list = gridToProgrammes([
    {
      type: 'episode',
      title: 'Dum Diddy Dum Diddy Doo',
      grandparentTitle: 'Two and a Half Men',
      summary: 'Charlie…',
      Media: [{ channelIdentifier: 'ch-a', beginsAt: 100, endsAt: 1900 }, { channelIdentifier: 'ch-b', beginsAt: 200, endsAt: 2000 }],
    },
    { type: 'movie', title: 'Dune', Media: [{ channelIdentifier: 'ch-c', beginsAt: 300, endsAt: 7500 }] },
    { type: 'episode', title: 'No airing', Media: [{}] },
  ]);
  assert.deepEqual(list, [
    { id: 'ch-a|100', channelId: 'ch-a', title: 'Two and a Half Men', subtitle: 'Dum Diddy Dum Diddy Doo', description: 'Charlie…', start: 100000, end: 1900000 },
    { id: 'ch-b|200', channelId: 'ch-b', title: 'Two and a Half Men', subtitle: 'Dum Diddy Dum Diddy Doo', description: 'Charlie…', start: 200000, end: 2000000 },
    { id: 'ch-c|300', channelId: 'ch-c', title: 'Dune', subtitle: undefined, description: undefined, start: 300000, end: 7500000 },
  ]);
});

test('tunedStreamKey finds the HLS address and the grab operation', () => {
  const answer = {
    MediaContainer: {
      MediaSubscription: [
        {
          MediaGrabOperation: [
            {
              key: '/media/grabbers/operations/x-y-hearth-tv',
              Metadata: { Media: [{ Part: [{ key: '/livetv/sessions/d311/hearth-tv/index.m3u8?offset=-1.000000' }] }] },
            },
          ],
        },
      ],
    },
  };
  assert.deepEqual(tunedStreamKey(answer), { key: '/livetv/sessions/d311/hearth-tv/index.m3u8?offset=-1.000000', operation: '/media/grabbers/operations/x-y-hearth-tv' });
  assert.equal(tunedStreamKey({ MediaContainer: {} }), null);
});
