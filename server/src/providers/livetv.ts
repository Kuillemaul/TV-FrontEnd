import type { TvheadendConfig } from '../config.js';

export interface Programme {
  id: string;
  channelId: string;
  title: string;
  subtitle?: string;
  description?: string;
  start: number; // epoch ms
  end: number;
}

export interface Channel {
  id: string;
  number: number;
  name: string;
  icon?: string;
  /** Broadcast in HD. */
  hd?: boolean;
  /** A radio station carried on the TV signal. */
  radio?: boolean;
  /** Set by Hearth: the HD channel showing the same programmes. */
  duplicateOf?: string;
}

export interface Recording {
  id: string;
  title: string;
  channelName: string;
  start: number;
  end: number;
  description?: string;
  status: 'scheduled' | 'recording' | 'completed' | 'failed';
}

export interface LiveTvProvider {
  readonly demo: boolean;
  channels(): Promise<Channel[]>;
  /** EPG events overlapping [from, to). */
  guide(from: number, to: number): Promise<Programme[]>;
  streamUrl(channelId: string): string;
  recordings(): Promise<Recording[]>;
  recordingUrl(id: string): string;
  record(programmeId: string): Promise<void>;
  /** Record every episode of the series this programme belongs to (Tvheadend autorec). */
  recordSeries(programmeId: string): Promise<void>;
  deleteRecording(id: string): Promise<void>;
  /** Proxy fetch for channel icons (Tvheadend imagecache needs auth). */
  fetchIcon?(path: string): Promise<Response>;
}

/* ------------------------------------------------------------------ */
/* Tvheadend                                                           */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
export class TvheadendProvider implements LiveTvProvider {
  readonly demo = false;
  private readonly auth?: string;

  constructor(private readonly cfg: TvheadendConfig) {
    if (cfg.username) this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64');
  }

  private async api(path: string, form?: Record<string, string>): Promise<any> {
    const res = await fetch(`${this.cfg.url}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        ...(this.auth ? { Authorization: this.auth } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Tvheadend ${path}: HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /** Base URL with credentials embedded, for external players like mpv. */
  private playerBase(): string {
    const u = new URL(this.cfg.url);
    if (this.cfg.username) {
      u.username = this.cfg.username;
      u.password = this.cfg.password ?? '';
    }
    return u.toString().replace(/\/$/, '');
  }

  async channels(): Promise<Channel[]> {
    const data = await this.api('/api/channel/grid?limit=9999&sort=number&dir=ASC');
    return (data.entries ?? [])
      .filter((c: any) => c.enabled !== false)
      .map((c: any) => ({
        id: c.uuid,
        number: Number(c.number ?? 0),
        name: c.name,
        icon: c.icon_public_url ? `/api/tv/icon?path=${encodeURIComponent(c.icon_public_url)}` : undefined,
      }))
      .sort((a: Channel, b: Channel) => a.number - b.number);
  }

  async guide(from: number, to: number): Promise<Programme[]> {
    const data = await this.api('/api/epg/events/grid?limit=20000');
    return (data.entries ?? [])
      .map((e: any) => ({
        id: String(e.eventId),
        channelId: e.channelUuid,
        title: e.title ?? 'Unknown',
        subtitle: e.subtitle,
        description: e.description ?? e.summary,
        start: e.start * 1000,
        end: e.stop * 1000,
      }))
      .filter((p: Programme) => p.end > from && p.start < to);
  }

  streamUrl(channelId: string): string {
    return `${this.playerBase()}/stream/channel/${channelId}?profile=${encodeURIComponent(this.cfg.profile)}`;
  }

  async recordings(): Promise<Recording[]> {
    const [upcoming, finished, failed] = await Promise.all([
      this.api('/api/dvr/entry/grid_upcoming?limit=500'),
      this.api('/api/dvr/entry/grid_finished?limit=500'),
      this.api('/api/dvr/entry/grid_failed?limit=100'),
    ]);
    const map = (status: Recording['status']) => (e: any): Recording => ({
      id: e.uuid,
      title: e.disp_title ?? e.title?.eng ?? 'Recording',
      channelName: e.channelname ?? '',
      start: e.start * 1000,
      end: e.stop * 1000,
      description: e.disp_description ?? e.disp_subtitle,
      status: status === 'scheduled' && e.sched_status === 'recording' ? 'recording' : status,
    });
    return [
      ...(upcoming.entries ?? []).map(map('scheduled')),
      ...(finished.entries ?? []).map(map('completed')),
      ...(failed.entries ?? []).map(map('failed')),
    ];
  }

  recordingUrl(id: string): string {
    return `${this.playerBase()}/dvrfile/${id}`;
  }

  async record(programmeId: string): Promise<void> {
    await this.api('/api/dvr/entry/create_by_event', { event_id: programmeId, config_uuid: '' });
  }

  async recordSeries(programmeId: string): Promise<void> {
    await this.api('/api/dvr/autorec/create_by_series', { event_id: programmeId, config_uuid: '' });
  }

  async deleteRecording(id: string): Promise<void> {
    await this.api('/api/idnode/delete', { uuid: id });
  }

  fetchIcon(path: string): Promise<Response> {
    const url = /^https?:/.test(path) ? path : `${this.cfg.url}/${path.replace(/^\//, '')}`;
    const sameHost = url.startsWith(this.cfg.url);
    return fetch(url, { headers: sameHost && this.auth ? { Authorization: this.auth } : {} });
  }
}

/** No tuner set up yet: an empty guide (the Live TV page explains how to add one). */
export class NoTvProvider implements LiveTvProvider {
  readonly demo = false;
  async channels(): Promise<Channel[]> {
    return [];
  }
  async guide(): Promise<Programme[]> {
    return [];
  }
  streamUrl(): string {
    throw new Error('Live TV isn’t set up yet – add a tvheadend section to config.yaml');
  }
  async recordings(): Promise<Recording[]> {
    return [];
  }
  recordingUrl(): string {
    throw new Error('Live TV isn’t set up yet');
  }
  async record(): Promise<void> {
    throw new Error('Live TV isn’t set up yet');
  }
  async recordSeries(): Promise<void> {
    throw new Error('Live TV isn’t set up yet');
  }
  async deleteRecording(): Promise<void> {}
}

/* ------------------------------------------------------------------ */
/* Demo data so the UI is fully navigable before a tuner is set up      */
/* ------------------------------------------------------------------ */

const DEMO_CHANNELS: Array<[number, string, string[]]> = [
  [2, 'CBS', ['Morning News', 'The Price Is Right', 'Local News', 'NFL Today', 'Evening News', 'Ghosts', 'Tracker']],
  [4, 'NBC', ['Today', 'Days of Our Lives', 'Local News', 'Nightly News', 'Jeopardy!', 'The Voice', 'Tonight Show']],
  [5, 'FOX', ['Good Day', 'The 9', 'Local News', 'NFL Sunday', 'The Simpsons', 'Bob’s Burgers', 'Family Guy']],
  [7, 'ABC', ['Good Morning America', 'The View', 'GMA3', 'World News', 'Wheel of Fortune', 'Grey’s Anatomy', 'Nightline']],
  [9, 'PBS', ['Sesame Street', 'Nature', 'NOVA', 'PBS NewsHour', 'Antiques Roadshow', 'Frontline', 'Masterpiece']],
  [11, 'CW', ['Paid Programming', 'Judge Judy', 'Family Feud', 'Penn & Teller', 'Walker', 'Superman & Lois', 'Seinfeld']],
];

export class DemoTvProvider implements LiveTvProvider {
  readonly demo = true;
  private scheduled = new Set<string>();

  async channels(): Promise<Channel[]> {
    return DEMO_CHANNELS.map(([number, name]) => ({ id: `demo-${number}`, number, name }));
  }

  async guide(from: number, to: number): Promise<Programme[]> {
    const slot = 30 * 60 * 1000;
    const out: Programme[] = [];
    for (const [number, , shows] of DEMO_CHANNELS) {
      let t = Math.floor(from / slot) * slot;
      let i = Math.floor(t / slot) % shows.length;
      while (t < to) {
        const len = slot * (((i + number) % 3) + 1);
        out.push({
          id: `demo-${number}-${t}`,
          channelId: `demo-${number}`,
          title: shows[i % shows.length],
          description: 'Demo listing – connect Tvheadend to see your real guide.',
          start: t,
          end: t + len,
        });
        t += len;
        i++;
      }
    }
    return out;
  }

  streamUrl(): string {
    throw new Error('Live TV is in demo mode – add a tvheadend section to config.yaml');
  }

  async recordings(): Promise<Recording[]> {
    const now = Date.now();
    return [
      { id: 'demo-rec-1', title: 'Nature', channelName: 'PBS', start: now - 86400000, end: now - 86400000 + 3600000, status: 'completed' },
      ...[...this.scheduled].map((id) => ({ id, title: 'Scheduled show', channelName: 'Demo', start: now + 3600000, end: now + 5400000, status: 'scheduled' as const })),
    ];
  }

  recordingUrl(): string {
    throw new Error('Recordings are in demo mode');
  }

  async record(programmeId: string): Promise<void> {
    this.scheduled.add(programmeId);
  }

  async recordSeries(programmeId: string): Promise<void> {
    this.scheduled.add(`${programmeId} (series)`);
  }

  async deleteRecording(id: string): Promise<void> {
    this.scheduled.delete(id);
  }
}

/**
 * SD channels that simulcast an HD one (ABC TV / ABC TV HD…): same titles at the same times for most
 * of the window. Returns sdId → hdId.
 */
export function findDuplicates(channels: Channel[], programmes: Programme[]): Map<string, string> {
  const slots = new Map<string, Set<string>>();
  for (const p of programmes) {
    const key = `${Math.round(p.start / 60_000)}|${p.title.toLowerCase()}`;
    if (!slots.has(p.channelId)) slots.set(p.channelId, new Set());
    slots.get(p.channelId)!.add(key);
  }
  const hd = channels.filter((c) => c.hd && slots.get(c.id)?.size);
  const out = new Map<string, string>();
  for (const c of channels) {
    const mine = slots.get(c.id);
    if (c.hd || c.radio || !mine || mine.size < 2) continue;
    for (const h of hd) {
      const theirs = slots.get(h.id)!;
      let same = 0;
      for (const k of mine) if (theirs.has(k)) same++;
      if (same >= 2 && same / mine.size >= 0.6) {
        out.set(c.id, h.id);
        break;
      }
    }
  }
  return out;
}
