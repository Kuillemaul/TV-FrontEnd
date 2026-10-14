import type { Channel, Programme } from './providers/livetv.js';

/** Search helpers shared by /api/search: forgiving matching and ranking. */

export const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** 0 = no match; higher is better (exact > starts with > whole word > anywhere). */
export function matchScore(text: string | undefined, query: string): number {
  if (!text) return 0;
  const t = normalise(text);
  const q = normalise(query);
  if (!q) return 0;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (` ${t} `.includes(` ${q} `)) return 2;
  return t.includes(q) ? 1 : 0;
}

export interface TvHit {
  programme: Programme;
  channel: Channel;
  live: boolean;
}

/** Upcoming (and on-now) guide entries matching the query, best and soonest first, one per airing. */
export function searchGuide(query: string, channels: Channel[], programmes: Programme[], now: number, limit = 16): TvHit[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const hits: Array<TvHit & { score: number }> = [];
  for (const p of programmes) {
    if (p.end <= now) continue;
    const channel = byId.get(p.channelId);
    if (!channel) continue;
    const score = Math.max(matchScore(p.title, query) * 2, matchScore(p.subtitle, query));
    if (score) hits.push({ programme: p, channel, live: p.start <= now, score });
  }
  hits.sort((a, b) => b.score - a.score || a.programme.start - b.programme.start || a.channel.number - b.channel.number);
  // An SD copy airing the same thing as its HD channel adds nothing.
  const seen = new Set<string>();
  const out: TvHit[] = [];
  for (const h of hits) {
    const key = `${normalise(h.programme.title)}|${h.programme.start}|${h.channel.duplicateOf ? 'dup' : h.channel.id}`;
    if (h.channel.duplicateOf || seen.has(key)) continue;
    seen.add(key);
    out.push({ programme: h.programme, channel: h.channel, live: h.live });
    if (out.length >= limit) break;
  }
  return out;
}
