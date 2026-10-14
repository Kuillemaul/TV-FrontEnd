import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeChannel, gridToProgrammes, scheduledToRecordings, shortChannelName, subscriptionQuery, tunedStreamKey } from './providers/plexlive.js';
import { findDuplicates } from './providers/livetv.js';

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

test('describeChannel: known Freeview codes, HD and radio flags, fallback names', () => {
  assert.deepEqual(describeChannel({ vcn: '020', title: 'ABC (Australian Broadcasting Corporation)', callSign: 'AHVCANZ', isHd: true }), { name: 'ABC TV HD', hd: true, radio: false });
  assert.deepEqual(describeChannel({ vcn: '028', title: 'ABC (Australian Broadcasting Corporation)', callSign: 'JJJMANZ' }), { name: 'triple j', hd: false, radio: true });
  assert.deepEqual(describeChannel({ vcn: '092', title: 'Nine Network (Australia)', callSign: '9GMMANZ' }), { name: 'Nine 92', hd: false, radio: false });
  assert.deepEqual(describeChannel({ vcn: '016', title: 'Independent', callSign: 'YOUVIC' }), { name: 'Channel 16', hd: false, radio: false });
});

test('findDuplicates pairs an SD channel with the HD one showing the same programmes', () => {
  const ch = [
    { id: 'abc', number: 2, name: 'ABC TV' },
    { id: 'abchd', number: 20, name: 'ABC TV HD', hd: true },
    { id: 'kids', number: 22, name: 'ABC Kids' },
  ];
  const p = (channelId: string, title: string, min: number) => ({ id: `${channelId}${min}`, channelId, title, start: min * 60_000, end: (min + 30) * 60_000 });
  const programmes = [p('abc', 'News', 0), p('abc', 'Gruen', 30), p('abchd', 'News', 0), p('abchd', 'Gruen', 30), p('kids', 'Bluey', 0), p('kids', 'Peppa', 30)];
  assert.deepEqual([...findDuplicates(ch, programmes)], [['abc', 'abchd']]);
});

test('subscriptionQuery: single airing vs series, with each setting default', () => {
  const template = {
    MediaContainer: {
      SubscriptionTemplate: [
        {
          MediaSubscription: [
            {
              type: 4,
              targetLibrarySectionID: 2,
              targetSectionLocationID: 3,
              parameters: 'hints%5Bguid%5D=plex%3A%2F%2Fepisode%2F1&params%5BlibraryType%5D=2',
              Setting: [{ id: 'startOffsetMinutes', default: '0' }, { id: 'oneShot', value: 'true', default: 'false' }],
            },
            { type: 2, targetLibrarySectionID: 2, parameters: 'hints%5Bguid%5D=plex%3A%2F%2Fshow%2F9', Setting: [] },
          ],
        },
      ],
    },
  };
  const one = new URLSearchParams(subscriptionQuery(template, false)!);
  assert.equal(one.get('type'), '4');
  assert.equal(one.get('hints[guid]'), 'plex://episode/1');
  assert.equal(one.get('targetSectionLocationID'), '3');
  assert.equal(one.get('prefs[startOffsetMinutes]'), '0');
  assert.equal(one.get('prefs[oneShot]'), 'true');
  assert.equal(one.get('includeGrabs'), '1');
  const all = new URLSearchParams(subscriptionQuery(template, true)!);
  assert.equal(all.get('type'), '2');
  assert.equal(all.get('hints[guid]'), 'plex://show/9');
  assert.equal(subscriptionQuery({ MediaContainer: {} }, false), null);
});

test('scheduledToRecordings maps Plex grab operations', () => {
  const list = scheduledToRecordings(
    {
      MediaContainer: {
        MediaGrabOperation: [
          {
            mediaSubscriptionID: 7,
            status: 'scheduled',
            Metadata: { type: 'episode', title: 'Ep 3', grandparentTitle: 'Gruen', Media: [{ beginsAt: 100, endsAt: 200, channelIdentifier: 'abc', channelTitle: '002 AVICANZ (ABC (Australian Broadcasting Corporation))' }] },
          },
          { mediaSubscriptionID: 8, status: 'inprogress', Metadata: { type: 'movie', title: 'Dune', Media: [{ beginsAt: 50, endsAt: 500, channelTitle: '030 SMELANZ (SBS (Special Broadcasting Service))' }] } },
        ],
      },
    },
    new Map([['abc', 'ABC TV']]),
  );
  assert.deepEqual(
    list.map((r) => [r.id, r.title, r.channelName, r.status, r.start]),
    [
      ['7', 'Gruen: Ep 3', 'ABC TV', 'scheduled', 100000],
      ['8', 'Dune', 'SBS', 'recording', 50000],
    ],
  );
});
