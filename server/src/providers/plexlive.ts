/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Channel, LiveTvProvider, Programme, Recording } from './livetv.js';

/**
 * Live TV through a Plex DVR (a tuner on the Plex server). Channels and the guide come from Plex's
 * EPG provider; watching tunes the channel on the Plex server and plays its HLS stream in mpv.
 */

export const PLEX_CLIENT_ID = 'hearth-tv';

/** "ABC (Australian Broadcasting Corporation)" → "ABC". */
export const shortChannelName = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, '').trim() || title;

/** Plex grid entries → programmes (one per airing; a show can air on several channels). */
export function gridToProgrammes(metadata: any[]): Programme[] {
  const out: Programme[] = [];
  for (const m of metadata ?? []) {
    const episode = m.type === 'episode';
    const show = episode ? (m.grandparentTitle ?? m.title) : m.title;
    const subtitle = episode && m.title && m.title !== show ? m.title : undefined;
    for (const media of m.Media ?? []) {
      if (!media.channelIdentifier || !media.beginsAt || !media.endsAt) continue;
      out.push({
        id: `${media.channelIdentifier}|${media.beginsAt}`,
        channelId: media.channelIdentifier,
        title: show ?? 'Unknown',
        subtitle,
        description: m.summary,
        start: Number(media.beginsAt) * 1000,
        end: Number(media.endsAt) * 1000,
      });
    }
  }
  return out;
}

/** The HLS address in a /tune answer (MediaSubscription → MediaGrabOperation → Metadata → Media → Part). */
export function tunedStreamKey(answer: unknown): { key: string; operation?: string } | null {
  const text = JSON.stringify(answer ?? {});
  const key = /"(\/livetv\/sessions\/[^"]+?\.m3u8[^"]*)"/.exec(text)?.[1];
  if (!key) return null;
  const operation = /"(\/media\/grabbers\/operations\/[^"]+)"/.exec(text)?.[1];
  return { key, operation };
}

export class PlexLiveTvProvider implements LiveTvProvider {
  readonly demo = false;
  private dvr: { key: string; epg: string } | null = null;
  private channelCache: { at: number; list: Channel[] } | null = null;
  private guideCache: { at: number; from: number; to: number; list: Programme[] } | null = null;
  private lastOperation: string | undefined;

  constructor(
    private readonly plex: { url: string; token: string },
    /** Hearth's own address, for the per-channel addresses mpv's playlist uses. */
    private readonly selfBase: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Plex-Token': this.plex.token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
      'X-Plex-Product': 'Hearth',
      'X-Plex-Device-Name': 'Hearth',
      'X-Plex-Platform': 'Linux',
    };
  }

  private async api(path: string, method = 'GET'): Promise<any> {
    const res = await fetch(`${this.plex.url}${path}`, { method, headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Plex Live TV ${path.split('?')[0]}: HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  private async findDvr(): Promise<{ key: string; epg: string }> {
    if (this.dvr) return this.dvr;
    const data = await this.api('/livetv/dvrs');
    const d = data.MediaContainer?.Dvr?.[0];
    if (!d?.key || !d.epgIdentifier) throw new Error('No Live TV & DVR set up on the Plex server');
    this.dvr = { key: String(d.key), epg: String(d.epgIdentifier) };
    return this.dvr;
  }

  async channels(): Promise<Channel[]> {
    if (this.channelCache && Date.now() - this.channelCache.at < 10 * 60_000) return this.channelCache.list;
    const { epg } = await this.findDvr();
    const data = await this.api(`/${epg}/lineups/dvr/channels`);
    const list = (data.MediaContainer?.Channel ?? [])
      .map((c: any) => ({ id: String(c.id), number: Number.parseFloat(c.vcn) || 0, name: shortChannelName(String(c.title ?? c.callSign ?? c.vcn)), icon: c.thumb }))
      .sort((a: Channel, b: Channel) => a.number - b.number);
    this.channelCache = { at: Date.now(), list };
    return list;
  }

  async guide(from: number, to: number): Promise<Programme[]> {
    const c = this.guideCache;
    if (c && Date.now() - c.at < 2 * 60_000 && c.from <= from && c.to >= to) return c.list.filter((p) => p.end > from && p.start < to);
    const { epg } = await this.findDvr();
    const s = Math.floor(from / 1000);
    const e = Math.ceil(to / 1000);
    // Plex filters: ">>=" / "<<=" (tested against a real server; a fully encoded ">=" is rejected).
    const data = await this.api(`/${epg}/grid?type=1%2C4&endsAt%3E%3E=${s}&beginsAt%3C%3C=${e}`);
    const list = gridToProgrammes(data.MediaContainer?.Metadata ?? []);
    this.guideCache = { at: Date.now(), from, to, list };
    return list;
  }

  /** mpv opens this local address; Hearth tunes the channel and redirects to the Plex stream. */
  streamUrl(channelId: string): string {
    return `${this.selfBase}/api/tv/plex/stream/${encodeURIComponent(channelId)}`;
  }

  /** Extra mpv arguments: the stream's segments need the Plex token too. */
  playerArgs(): string[] {
    return [`--http-header-fields=X-Plex-Token: ${this.plex.token},X-Plex-Client-Identifier: ${PLEX_CLIENT_ID}`];
  }

  /** Tune a channel on the Plex server; returns the stream address once it's ready to play. */
  async tune(channelId: string): Promise<string> {
    const { key } = await this.findDvr();
    // Free the tuner from the previous channel first (single-tuner setups would refuse otherwise).
    // Only ever our own live grab (its id ends with Hearth's client id), never a recording.
    if (this.lastOperation?.endsWith(`-${PLEX_CLIENT_ID}`)) await this.api(this.lastOperation, 'DELETE').catch(() => undefined);
    const answer = await this.api(`/livetv/dvrs/${key}/channels/${encodeURIComponent(channelId)}/tune`, 'POST');
    const tuned = tunedStreamKey(answer);
    if (!tuned) throw new Error('Plex didn’t start the channel (is a tuner free?)');
    this.lastOperation = tuned.operation;
    const url = `${this.plex.url}${tuned.key}${tuned.key.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(this.plex.token)}`;
    // The playlist appears a moment after tuning; wait for it so mpv doesn't give up.
    for (let i = 0; i < 20; i++) {
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (res?.ok && (await res.text()).includes('#EXTM3U')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return url;
  }

  async recordings(): Promise<Recording[]> {
    return [];
  }
  recordingUrl(): string {
    throw new Error('Plex keeps the recordings: find them in Plex (and Recently added on Home)');
  }
  async record(): Promise<void> {
    throw new Error('Set up recordings in the Plex app for now');
  }
  async recordSeries(): Promise<void> {
    throw new Error('Set up recordings in the Plex app for now');
  }
  async deleteRecording(): Promise<void> {}
}
