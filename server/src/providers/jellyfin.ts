import { mediaBrowserAuth } from '../connect.js';
import { thumbUrl, type FindQuery, type MediaLibrary, type OnDeckItem, type SearchItem } from './library.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Jellyfin (and Emby: same API) for Home's Continue watching and Recently added, search, and
 * playing things on the TV. Playing goes through the server's remote control: start the Jellyfin
 * app (signed in once), then ask the server to have that session play the item.
 */
export class JellyfinClient implements MediaLibrary {
  readonly appId: string;
  readonly name: string;
  private serverId?: string;

  constructor(
    private readonly cfg: { kind: 'jellyfin' | 'emby'; url: string; token: string; userId: string },
  ) {
    this.appId = cfg.kind;
    this.name = cfg.kind === 'emby' ? 'Emby' : 'Jellyfin';
  }

  get kind() {
    return this.cfg.kind;
  }

  private headers() {
    return { 'X-Emby-Token': this.cfg.token, Authorization: mediaBrowserAuth(this.cfg.token), Accept: 'application/json' };
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.cfg.url}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${this.name} ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  private get user() {
    return `/Users/${this.cfg.userId}`;
  }

  /** Landscape artwork: the show's backdrop for episodes, else the item's own. */
  private art(m: any): string | undefined {
    if (m.Type === 'Episode' || m.Type === 'Season') {
      if (m.ParentBackdropItemId && m.ParentBackdropImageTags?.length) return thumbUrl(`/Items/${m.ParentBackdropItemId}/Images/Backdrop/0?maxWidth=640`);
      if (m.SeriesId) return thumbUrl(`/Items/${m.SeriesId}/Images/Backdrop/0?maxWidth=640`);
    }
    if (m.BackdropImageTags?.length) return thumbUrl(`/Items/${m.Id}/Images/Backdrop/0?maxWidth=640`);
    if (m.ImageTags?.Thumb) return thumbUrl(`/Items/${m.Id}/Images/Thumb?maxWidth=640`);
    if (m.ImageTags?.Primary) return thumbUrl(`/Items/${m.Id}/Images/Primary?maxWidth=640`);
    return undefined;
  }

  private card(m: any, progress = 0): OnDeckItem {
    const episode = m.Type === 'Episode';
    return {
      id: String(m.Id),
      title: episode ? (m.SeriesName ?? m.Name) : m.Type === 'Season' ? (m.SeriesName ?? m.Name) : m.Name,
      subtitle: episode ? `S${m.ParentIndexNumber ?? '?'} · E${m.IndexNumber ?? '?'} · ${m.Name}` : m.Type === 'Season' ? m.Name : m.Type === 'Series' ? 'New episodes' : String(m.ProductionYear ?? ''),
      thumb: this.art(m),
      progress,
    };
  }

  private static readonly FIELDS = 'Fields=ProductionYear,ParentId,SeriesId&EnableImageTypes=Primary,Backdrop,Thumb&ImageTypeLimit=1';

  /** Resume where you left off, then the next episode of shows you're watching. */
  async onDeck(): Promise<OnDeckItem[]> {
    const [resume, nextUp] = await Promise.all([
      this.api(`${this.user}/Items/Resume?Limit=12&MediaTypes=Video&${JellyfinClient.FIELDS}`),
      this.api(`/Shows/NextUp?UserId=${this.cfg.userId}&Limit=12&${JellyfinClient.FIELDS}`).catch(() => ({ Items: [] })),
    ]);
    const out: OnDeckItem[] = [];
    const shows = new Set<string>();
    for (const m of resume?.Items ?? []) {
      if (m.SeriesId) shows.add(m.SeriesId);
      out.push(this.card(m, (m.UserData?.PlayedPercentage ?? 0) / 100));
    }
    for (const m of nextUp?.Items ?? []) {
      if (m.SeriesId && shows.has(m.SeriesId)) continue;
      shows.add(m.SeriesId);
      out.push(this.card(m));
    }
    return out.slice(0, 16);
  }

  async recentlyAdded(): Promise<OnDeckItem[]> {
    const items: any[] = (await this.api(`${this.user}/Items/Latest?Limit=24&IncludeItemTypes=Movie,Episode&GroupItems=true&${JellyfinClient.FIELDS}`)) ?? [];
    return items.slice(0, 16).map((m) => this.card(m));
  }

  async search(query: string): Promise<SearchItem[]> {
    const q = new URLSearchParams({ searchTerm: query, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Episode', Limit: '18' });
    const data = await this.api(`${this.user}/Items?${q}&${JellyfinClient.FIELDS}`);
    return (data?.Items ?? []).map((m: any) => {
      const type = m.Type === 'Movie' ? 'movie' : m.Type === 'Series' ? 'show' : 'episode';
      return {
        id: String(m.Id),
        type,
        title: type === 'episode' ? `${m.SeriesName ?? ''}: ${m.Name}` : m.Name,
        year: m.ProductionYear,
        subtitle: type === 'episode' ? `S${m.ParentIndexNumber} · E${m.IndexNumber}` : undefined,
        thumb: m.ImageTags?.Primary ? thumbUrl(`/Items/${m.Id}/Images/Primary?maxWidth=400`) : this.art(m),
      } satisfies SearchItem;
    });
  }

  async find(q: FindQuery): Promise<string | null> {
    const params = new URLSearchParams({ searchTerm: q.title, Recursive: 'true', IncludeItemTypes: q.mediaType === 'movie' ? 'Movie' : 'Series', Limit: '10', Fields: 'ProductionYear' });
    const items: any[] = (await this.api(`${this.user}/Items?${params}`))?.Items ?? [];
    const hit =
      items.find((m) => norm(m.Name) === norm(q.title) && (!q.year || !m.ProductionYear || Math.abs(m.ProductionYear - q.year) <= 1)) ??
      items.find((m) => norm(m.Name) === norm(q.title));
    if (!hit) return null;
    if (q.mediaType === 'movie' || q.season === undefined) return String(hit.Id);
    const eps: any[] = (await this.api(`/Shows/${hit.Id}/Episodes?UserId=${this.cfg.userId}&Season=${q.season}`))?.Items ?? [];
    const ep = eps.find((e) => e.IndexNumber === q.episode);
    // A newly imported episode can take a scan to appear; until then it's "not there yet".
    return ep ? String(ep.Id) : null;
  }

  async playable(id: string): Promise<string> {
    const item = await this.api(`${this.user}/Items/${id}`);
    if (item?.Type !== 'Series' && item?.Type !== 'Season') return id;
    const seriesId = item.Type === 'Series' ? item.Id : item.SeriesId;
    const next = (await this.api(`/Shows/NextUp?UserId=${this.cfg.userId}&SeriesId=${seriesId}&Limit=1`).catch(() => null))?.Items?.[0];
    if (next) return String(next.Id);
    const first = (await this.api(`/Shows/${seriesId}/Episodes?UserId=${this.cfg.userId}${item.Type === 'Season' ? `&SeasonId=${item.Id}` : ''}&Limit=1`))?.Items?.[0];
    return first ? String(first.Id) : id;
  }

  thumb(path: string): Promise<Response> {
    if (!/^\/Items\/[\w-]+\/Images\//.test(path)) return Promise.resolve(new Response(null, { status: 404 }));
    return fetch(`${this.cfg.url}${path}`, { headers: this.headers() });
  }

  async itemUrl(id: string): Promise<string> {
    if (!this.serverId) this.serverId = (await this.api('/System/Info/Public'))?.Id;
    return this.cfg.kind === 'emby'
      ? `${this.cfg.url}/web/index.html#!/item?id=${id}&serverId=${this.serverId}`
      : `${this.cfg.url}/web/index.html#/details?id=${id}&serverId=${this.serverId}`;
  }

  async playOnPlayer(id: string, isThisTv: (address: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const item = await this.api(`${this.user}/Items/${id}`);
    if (!item) throw new Error(`That’s no longer on the ${this.name} server`);
    const deadline = Date.now() + timeoutMs;
    let session: any;
    while (!session && Date.now() < deadline) {
      const sessions: any[] = (await this.api(`/Sessions?ControllableByUserId=${this.cfg.userId}`).catch(() => [])) ?? [];
      const players = sessions.filter((s) => s.SupportsRemoteControl !== false && /media player|theater|desktop|kodi|web/i.test(`${s.Client} ${s.DeviceName}`));
      const ip = (s: any) => String(s.RemoteEndPoint ?? '').replace(/^::ffff:/, '').replace(/:\d+$/, '');
      session = players.find((s) => isThisTv(ip(s))) ?? (players.length === 1 ? players[0] : undefined);
      if (!session) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!session) throw new Error(`The ${this.name} app didn’t connect to the server (sign in to it once on the TV)`);
    const start = item.UserData?.PlaybackPositionTicks ?? 0;
    await this.api(`/Sessions/${session.Id}/Playing?PlayCommand=PlayNow&ItemIds=${id}&StartPositionTicks=${start}`, { method: 'POST' });
    return String(item.SeriesName ?? item.Name ?? 'it');
  }
}

