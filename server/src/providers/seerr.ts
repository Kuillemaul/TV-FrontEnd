/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Seerr (Overseerr / Jellyseerr) for finding and requesting films and shows, plus the download
 * queues of Radarr, Sonarr and Lidarr so the TV can show what's on its way.
 */

export interface ServiceConfig {
  url: string;
  apiKey: string;
}

export interface RequestsConfig {
  seerr?: ServiceConfig;
  radarr?: ServiceConfig;
  sonarr?: ServiceConfig;
  lidarr?: ServiceConfig;
}

export type MediaStatus = 'none' | 'requested' | 'processing' | 'partial' | 'available' | 'blocked';

export interface MediaResult {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  poster?: string;
  backdrop?: string;
  overview: string;
  status: MediaStatus;
}

export interface RecentRequest extends MediaResult {
  requestedBy: string;
  requestedAt: number;
  /** Seerr's approval: pending (waiting for an admin), approved, declined. */
  approval: 'pending' | 'approved' | 'declined';
}

export interface DownloadItem {
  id: string;
  kind: 'radarr' | 'sonarr' | 'lidarr';
  title: string;
  subtitle: string;
  /** 0..1 */
  progress: number;
  timeLeft: string | null;
  status: string;
}

const TMDB_IMG = 'https://image.tmdb.org/t/p';

/** Seerr's media status numbers → words. */
export function mediaStatus(n: number | undefined): MediaStatus {
  switch (n) {
    case 2:
      return 'requested';
    case 3:
      return 'processing';
    case 4:
      return 'partial';
    case 5:
      return 'available';
    case 6:
      return 'blocked';
    default:
      return 'none';
  }
}

/** A Seerr search/discover/details item → MediaResult (people and other types are dropped). */
export function toMedia(r: any, fallbackType?: 'movie' | 'tv'): MediaResult | null {
  const mediaType = r?.mediaType ?? fallbackType;
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  const date = mediaType === 'movie' ? r.releaseDate : r.firstAirDate;
  return {
    id: Number(r.id),
    mediaType,
    title: String((mediaType === 'movie' ? r.title : r.name) ?? r.title ?? r.name ?? 'Untitled'),
    year: date ? Number(String(date).slice(0, 4)) || null : null,
    poster: r.posterPath ? `${TMDB_IMG}/w342${r.posterPath}` : undefined,
    backdrop: r.backdropPath ? `${TMDB_IMG}/w1280${r.backdropPath}` : undefined,
    overview: String(r.overview ?? ''),
    status: mediaStatus(r.mediaInfo?.status),
  };
}

/** One *arr queue record → DownloadItem. */
export function toDownload(kind: DownloadItem['kind'], r: any): DownloadItem {
  const size = Number(r.size ?? 0);
  const left = Number(r.sizeleft ?? 0);
  let title = String(r.title ?? '');
  let subtitle = '';
  if (kind === 'radarr' && r.movie) {
    title = r.movie.title;
    subtitle = r.movie.year ? String(r.movie.year) : '';
  } else if (kind === 'sonarr' && r.series) {
    title = r.series.title;
    const e = r.episode;
    subtitle = e ? `S${e.seasonNumber} · E${e.episodeNumber}${e.title ? ` · ${e.title}` : ''}` : '';
  } else if (kind === 'lidarr' && r.artist) {
    title = r.artist.artistName;
    subtitle = r.album?.title ?? '';
  }
  return {
    id: `${kind}-${r.id}`,
    kind,
    title,
    subtitle,
    progress: size > 0 ? Math.max(0, Math.min(1, 1 - left / size)) : 0,
    timeLeft: r.timeleft ? String(r.timeleft).replace(/^00:/, '').replace(/\.\d+$/, '') : null,
    status: String(r.trackedDownloadState ?? r.status ?? ''),
  };
}

export class RequestsClient {
  private titles = new Map<string, MediaResult>();

  constructor(private readonly cfg: RequestsConfig) {}

  get hasSeerr(): boolean {
    return Boolean(this.cfg.seerr);
  }

  get hasDownloads(): boolean {
    return Boolean(this.cfg.radarr || this.cfg.sonarr || this.cfg.lidarr);
  }

  private async call(svc: ServiceConfig, path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${svc.url}${path}`, {
      ...init,
      headers: { 'X-Api-Key': svc.apiKey, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error(`can’t reach ${svc.url}`);
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body;
      try {
        message = JSON.parse(body).message ?? body;
      } catch {
        /* plain text */
      }
      throw new Error(`${res.status === 401 || res.status === 403 ? 'Check the API key: ' : ''}${message || `HTTP ${res.status}`}`);
    }
    return res.status === 204 ? null : res.json();
  }

  private seerr(path: string, init?: RequestInit): Promise<any> {
    if (!this.cfg.seerr) throw new Error('Seerr isn’t set up');
    return this.call(this.cfg.seerr, `/api/v1${path}`, init);
  }

  async search(query: string): Promise<MediaResult[]> {
    // encodeURIComponent (not URLSearchParams): Seerr rejects "+" for spaces.
    const data = await this.seerr(`/search?query=${encodeURIComponent(query)}&page=1`);
    return (data.results ?? []).map((r: any) => toMedia(r)).filter(Boolean) as MediaResult[];
  }

  /** A browse row: trending, popular films, popular shows, upcoming films. */
  async discover(kind: 'trending' | 'movies' | 'tv' | 'upcoming'): Promise<MediaResult[]> {
    const path = { trending: '/discover/trending', movies: '/discover/movies', tv: '/discover/tv', upcoming: '/discover/movies/upcoming' }[kind];
    const type = kind === 'tv' ? 'tv' : kind === 'trending' ? undefined : 'movie';
    const data = await this.seerr(`${path}?page=1`);
    return (data.results ?? []).map((r: any) => toMedia(r, type)).filter(Boolean) as MediaResult[];
  }

  async details(mediaType: 'movie' | 'tv', id: number): Promise<MediaResult> {
    const key = `${mediaType}:${id}`;
    const data = await this.seerr(`/${mediaType}/${id}`);
    const media = toMedia(data, mediaType)!;
    this.titles.set(key, media);
    return media;
  }

  /** Ask for a film, or every season of a show. */
  async request(mediaType: 'movie' | 'tv', id: number): Promise<void> {
    await this.seerr('/request', {
      method: 'POST',
      body: JSON.stringify(mediaType === 'tv' ? { mediaType, mediaId: id, seasons: 'all' } : { mediaType, mediaId: id }),
    });
    this.titles.delete(`${mediaType}:${id}`);
  }

  async recent(): Promise<RecentRequest[]> {
    const data = await this.seerr('/request?take=20&skip=0&sort=added&filter=all');
    const out: RecentRequest[] = [];
    for (const r of data.results ?? []) {
      const type = r.media?.mediaType ?? r.type;
      const tmdb = Number(r.media?.tmdbId);
      if ((type !== 'movie' && type !== 'tv') || !tmdb) continue;
      const media = this.titles.get(`${type}:${tmdb}`) ?? (await this.details(type, tmdb).catch(() => null));
      if (!media) continue;
      out.push({
        ...media,
        status: mediaStatus(r.media?.status),
        requestedBy: String(r.requestedBy?.displayName ?? r.requestedBy?.username ?? ''),
        requestedAt: Date.parse(r.createdAt) || 0,
        approval: r.status === 3 ? 'declined' : r.status === 1 ? 'pending' : 'approved',
      });
    }
    return out;
  }

  /** Everything downloading in Radarr, Sonarr and Lidarr. Services that fail are skipped. */
  async downloads(): Promise<{ items: DownloadItem[]; errors: string[] }> {
    const jobs: Array<[DownloadItem['kind'], ServiceConfig | undefined, string]> = [
      ['radarr', this.cfg.radarr, '/api/v3/queue?page=1&pageSize=50&includeMovie=true'],
      ['sonarr', this.cfg.sonarr, '/api/v3/queue?page=1&pageSize=50&includeSeries=true&includeEpisode=true'],
      ['lidarr', this.cfg.lidarr, '/api/v1/queue?page=1&pageSize=50&includeArtist=true&includeAlbum=true'],
    ];
    const items: DownloadItem[] = [];
    const errors: string[] = [];
    await Promise.all(
      jobs.map(async ([kind, svc, path]) => {
        if (!svc) return;
        try {
          const data = await this.call(svc, path);
          for (const r of data.records ?? []) items.push(toDownload(kind, r));
        } catch (err) {
          errors.push(`${kind[0].toUpperCase()}${kind.slice(1)}: ${(err as Error).message}`);
        }
      }),
    );
    items.sort((a, b) => b.progress - a.progress);
    return { items, errors };
  }
}
