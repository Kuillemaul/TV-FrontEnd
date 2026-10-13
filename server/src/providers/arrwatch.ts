/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestsConfig, ServiceConfig } from './seerr.js';

/**
 * "Ready to watch": asks Radarr / Sonarr / Lidarr once a minute what they imported since the last
 * check, and turns that into one pop-up per film, show season or album.
 */

export interface ReadyItem {
  kind: 'movie' | 'tv' | 'music';
  title: string;
  year?: number;
  /** "S2 · E3 · Woe's Hollow", "8 new episodes", album name… */
  subtitle?: string;
  season?: number;
  episode?: number;
  poster?: string;
  tmdbId?: number;
  tvdbId?: number;
}

const poster = (images: any[] | undefined) => {
  const img = (images ?? []).find((i) => i.coverType === 'poster');
  return img?.remoteUrl ?? img?.url;
};

/** Turn history records into ready items, one per film / show-season / album. */
export function groupImports(kind: 'radarr' | 'sonarr' | 'lidarr', records: any[]): ReadyItem[] {
  if (kind === 'radarr') {
    const seen = new Set<number>();
    return records
      .filter((r) => r.eventType === 'downloadFolderImported' && r.movie)
      .filter((r) => !seen.has(r.movieId ?? r.movie.id) && seen.add(r.movieId ?? r.movie.id))
      .map((r) => ({ kind: 'movie', title: r.movie.title, year: r.movie.year, poster: poster(r.movie.images), tmdbId: r.movie.tmdbId }));
  }
  if (kind === 'sonarr') {
    const groups = new Map<string, any[]>();
    for (const r of records) {
      if (r.eventType !== 'downloadFolderImported' || !r.series || !r.episode) continue;
      const key = `${r.series.id}:${r.episode.seasonNumber}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].map((list) => {
      const eps = [...new Map(list.map((r) => [r.episode.id, r.episode])).values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
      const s = list[0].series;
      const first = eps[0];
      return {
        kind: 'tv',
        title: s.title,
        year: s.year,
        season: first.seasonNumber,
        episode: first.episodeNumber,
        subtitle:
          eps.length === 1
            ? `S${first.seasonNumber} · E${first.episodeNumber}${first.title ? ` · ${first.title}` : ''}`
            : `Season ${first.seasonNumber} · ${eps.length} new episodes`,
        poster: poster(s.images),
        tmdbId: s.tmdbId,
        tvdbId: s.tvdbId,
      } satisfies ReadyItem;
    });
  }
  const seen = new Set<number>();
  return records
    .filter((r) => (r.eventType === 'downloadImported' || r.eventType === 'trackFileImported') && r.album && r.artist)
    .filter((r) => !seen.has(r.albumId ?? r.album.id) && seen.add(r.albumId ?? r.album.id))
    .map((r) => ({ kind: 'music', title: r.artist.artistName, subtitle: r.album.title, poster: poster(r.album.images) }));
}

const PATHS = {
  radarr: '/api/v3/history/since?includeMovie=true&date=',
  sonarr: '/api/v3/history/since?includeSeries=true&includeEpisode=true&date=',
  lidarr: '/api/v1/history/since?includeArtist=true&includeAlbum=true&date=',
} as const;

export class ArrWatcher {
  private since = new Date();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cfg: RequestsConfig,
    private readonly mode: 'all' | 'requested' | 'off',
    private readonly onReady: (item: ReadyItem) => void,
    private readonly log: { warn: (m: string) => void },
    /** For mode "requested": TMDB/TVDB ids of things asked for in Seerr. */
    private readonly requestedIds?: () => Promise<Set<string>>,
  ) {}

  start(): void {
    if (this.mode === 'off' || !(this.cfg.radarr || this.cfg.sonarr || this.cfg.lidarr)) return;
    this.timer = setInterval(() => void this.poll(), 60_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    const from = this.since;
    this.since = new Date();
    const items: ReadyItem[] = [];
    for (const kind of ['radarr', 'sonarr', 'lidarr'] as const) {
      const svc: ServiceConfig | undefined = this.cfg[kind];
      if (!svc) continue;
      try {
        const res = await fetch(`${svc.url}${PATHS[kind]}${encodeURIComponent(from.toISOString())}`, {
          headers: { 'X-Api-Key': svc.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        items.push(...groupImports(kind, Array.isArray(data) ? data : (data.records ?? [])));
      } catch (err) {
        this.log.warn(`ready-to-watch: ${kind}: ${(err as Error).message}`);
      }
    }
    let wanted: Set<string> | null = null;
    if (this.mode === 'requested' && this.requestedIds) wanted = await this.requestedIds().catch(() => null);
    for (const item of items) {
      if (wanted && item.kind !== 'music' && !wanted.has(`tmdb:${item.tmdbId}`) && !wanted.has(`tvdb:${item.tvdbId}`)) continue;
      this.onReady(item);
    }
  }
}
