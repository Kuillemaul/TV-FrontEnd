export interface OnDeckItem {
  id: string;
  title: string;
  subtitle: string;
  /** Proxied artwork URL (the Plex token stays on the server). */
  thumb?: string;
  /** 0..1 watched, for the progress bar. */
  progress: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Plex "On Deck" (continue watching) from your Plex Media Server. */
export class PlexClient {
  private machineId?: string;
  private commandId = 0;

  constructor(private readonly cfg: { url: string; token: string; webUrl?: string }) {}

  private async api(path: string): Promise<any> {
    const res = await fetch(`${this.cfg.url}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${this.cfg.token}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Plex ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async onDeck(): Promise<OnDeckItem[]> {
    const data = await this.api('/library/onDeck');
    return (data.MediaContainer?.Metadata ?? []).slice(0, 16).map((m: any) => {
      const episode = m.type === 'episode';
      const thumb = episode ? m.grandparentThumb ?? m.thumb : m.thumb;
      return {
        id: String(m.ratingKey),
        title: episode ? m.grandparentTitle : m.title,
        subtitle: episode ? `S${m.parentIndex} · E${m.index} · ${m.title}` : String(m.year ?? ''),
        thumb: thumb ? `/api/plex/thumb?path=${encodeURIComponent(m.art ?? thumb)}` : undefined,
        progress: m.viewOffset && m.duration ? m.viewOffset / m.duration : 0,
      };
    });
  }

  thumb(path: string): Promise<Response> {
    const q = new URLSearchParams({ width: '640', height: '360', minSize: '1', upscale: '1', url: path, 'X-Plex-Token': this.cfg.token });
    return fetch(`${this.cfg.url}/photo/:/transcode?${q}`);
  }

  private async serverId(): Promise<string> {
    if (!this.machineId) this.machineId = (await this.api('/identity')).MediaContainer.machineIdentifier;
    return this.machineId!;
  }

  /**
   * Find a film, or a show's episode, in your Plex libraries by title (and year), e.g. right after
   * Radarr/Sonarr imported it. Returns the ratingKey to play, or null if Plex hasn't got it yet.
   */
  async find(q: { title: string; year?: number; mediaType: 'movie' | 'tv'; season?: number; episode?: number }): Promise<string | null> {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const data = await this.api(`/hubs/search?query=${encodeURIComponent(q.title)}&limit=10`);
    const want = q.mediaType === 'movie' ? 'movie' : 'show';
    const items: any[] = (data.MediaContainer?.Hub ?? []).filter((h: any) => h.type === want).flatMap((h: any) => h.Metadata ?? []);
    const hit =
      items.find((m) => norm(m.title) === norm(q.title) && (!q.year || !m.year || Math.abs(m.year - q.year) <= 1)) ??
      items.find((m) => norm(m.title) === norm(q.title));
    if (!hit) return null;
    if (q.mediaType === 'movie' || q.season === undefined) return String(hit.ratingKey);
    const leaves = await this.api(`/library/metadata/${hit.ratingKey}/allLeaves`);
    const ep = (leaves.MediaContainer?.Metadata ?? []).find((e: any) => e.parentIndex === q.season && e.index === q.episode);
    return String(ep?.ratingKey ?? hit.ratingKey);
  }

  /** Plex Web link straight to an item (used when the Plex tile is a web app). */
  async itemUrl(id: string): Promise<string> {
    const base = this.cfg.webUrl ?? `${this.cfg.url}/web/index.html`;
    return `${base}#!/server/${await this.serverId()}/details?key=${encodeURIComponent(`/library/metadata/${id}`)}`;
  }

  /**
   * Tell the Plex HTPC app on this TV to play an item from where you left off, the same way the
   * Plex phone app casts to it. Waits for the app to start and show up as a player on the server.
   */
  async playOnPlayer(id: string, isThisTv: (address: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const [serverId, meta] = await Promise.all([this.serverId(), this.api(`/library/metadata/${id}`)]);
    const item = meta.MediaContainer?.Metadata?.[0];
    if (!item) throw new Error('That item is no longer on the Plex server');
    const deadline = Date.now() + timeoutMs;
    let player: any;
    while (!player && Date.now() < deadline) {
      const clients: any[] = (await this.api('/clients').catch(() => null))?.MediaContainer?.Server ?? [];
      const players = clients.filter((c) => /htpc|plex for linux|media player/i.test(`${c.product} ${c.name}`) || /playback/.test(c.protocolCapabilities ?? ''));
      player = players.find((c) => isThisTv(c.address ?? c.host)) ?? (players.length === 1 ? players[0] : undefined);
      if (!player) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!player) throw new Error('Plex HTPC didn’t show up as a player (turn on “Advertise as player” in its settings)');

    const server = new URL(this.cfg.url);
    const q = new URLSearchParams({
      key: `/library/metadata/${id}`,
      offset: String(item.viewOffset ?? 0),
      machineIdentifier: serverId,
      address: server.hostname,
      port: server.port || (server.protocol === 'https:' ? '443' : '80'),
      protocol: server.protocol.replace(':', ''),
      token: this.cfg.token,
      type: 'video',
      commandID: String(++this.commandId),
    });
    const res = await fetch(`http://${player.address ?? player.host}:${player.port}/player/playback/playMedia?${q}`, {
      headers: {
        'X-Plex-Client-Identifier': 'hearth-tv',
        'X-Plex-Target-Client-Identifier': player.machineIdentifier,
        'X-Plex-Token': this.cfg.token,
        'X-Plex-Product': 'Hearth',
        'X-Plex-Device-Name': 'Hearth',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Plex HTPC refused to play it (HTTP ${res.status})`);
    return String(item.grandparentTitle ?? item.title);
  }
}

export const DEMO_ON_DECK: OnDeckItem[] = [
  { id: 'demo-1', title: 'The Expanse', subtitle: 'S3 · E7 · Delta-V', progress: 0.42 },
  { id: 'demo-2', title: 'Bluey', subtitle: 'S2 · E14 · Sleepytime', progress: 0.1 },
  { id: 'demo-3', title: 'Dune: Part Two', subtitle: '2024', progress: 0.67 },
  { id: 'demo-4', title: 'Severance', subtitle: 'S2 · E3 · Who Is Alive?', progress: 0.25 },
];
