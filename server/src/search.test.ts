import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchScore, normalise, searchGuide } from './search.js';

test('matchScore ranks exact > prefix > word > anywhere', () => {
  assert.equal(normalise('Pokémon: The Movie!'), 'pokemon the movie');
  assert.equal(matchScore('Dune', 'dune'), 4);
  assert.equal(matchScore('Dune: Part Two', 'dune'), 3);
  assert.equal(matchScore('The Dune Buggy Show', 'dune'), 2);
  assert.equal(matchScore('Dunedin Weekly', 'dune'), 3);
  assert.equal(matchScore('Sand dunes', 'dune'), 1);
  assert.equal(matchScore('Gruen', 'dune'), 0);
});

test('searchGuide: upcoming only, best then soonest, skips SD copies', () => {
  const ch = [
    { id: 'abc', number: 2, name: 'ABC TV', duplicateOf: 'abchd' },
    { id: 'abchd', number: 20, name: 'ABC TV HD', hd: true },
    { id: 'sbs', number: 3, name: 'SBS' },
  ];
  const p = (channelId: string, title: string, startMin: number, subtitle?: string) => ({
    id: `${channelId}${startMin}`, channelId, title, subtitle, start: startMin * 60_000, end: (startMin + 60) * 60_000,
  });
  const now = 100 * 60_000;
  const hits = searchGuide('gruen', ch, [
    p('abc', 'Gruen', 120), p('abchd', 'Gruen', 120), p('abchd', 'Gruen', 0), p('sbs', 'News', 90, 'Gruen special'), p('sbs', 'Gruen Nation', 300),
  ], now);
  assert.deepEqual(hits.map((h) => [h.channel.id, h.programme.title, h.live]), [
    ['abchd', 'Gruen', false],
    ['sbs', 'Gruen Nation', false],
    ['sbs', 'News', true],
  ]);
});
