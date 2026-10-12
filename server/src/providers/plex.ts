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

  /** Plex Web link straight to an item (opened full screen in the kiosk browser). */
  async itemUrl(id: string): Promise<string> {
    if (!this.machineId) this.machineId = (await this.api('/identity')).MediaContainer.machineIdentifier;
    const base = this.cfg.webUrl ?? `${this.cfg.url}/web/index.html`;
    return `${base}#!/server/${this.machineId}/details?key=${encodeURIComponent(`/library/metadata/${id}`)}`;
  }
}

export const DEMO_ON_DECK: OnDeckItem[] = [
  { id: 'demo-1', title: 'The Expanse', subtitle: 'S3 · E7 · Delta-V', progress: 0.42 },
  { id: 'demo-2', title: 'Bluey', subtitle: 'S2 · E14 · Sleepytime', progress: 0.1 },
  { id: 'demo-3', title: 'Dune: Part Two', subtitle: '2024', progress: 0.67 },
  { id: 'demo-4', title: 'Severance', subtitle: 'S2 · E3 · Who Is Alive?', progress: 0.25 },
];
