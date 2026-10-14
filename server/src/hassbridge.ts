/**
 * Hearth ⇄ Home Assistant. Home Assistant is the brain, Hearth is the screen:
 *
 *  - Hearth publishes what the TV is doing as entities:
 *      sensor.hearth_<tv>_activity     home / plex / live_tv / recording / game / app
 *      sensor.hearth_<tv>_profile      who's watching
 *      sensor.hearth_<tv>_sleep_timer  when the sleep timer ends (timestamp)
 *  - Home Assistant automations drive the TV by firing a `hearth_command` event, e.g.
 *      event: hearth_command
 *      event_data: { command: camera, entity: camera.front_door }
 */

export interface SessionLike {
  id: string;
  title: string;
  startedAt: number;
}

export interface Activity {
  state: 'home' | 'plex' | 'live_tv' | 'recording' | 'game' | 'app';
  attributes: Record<string, unknown>;
}

/** What the TV is doing, from the foreground session. */
export function activityOf(session: SessionLike | null, extra: { channel?: string; appName?: (id: string) => string | undefined } = {}): Activity {
  if (!session) return { state: 'home', attributes: { title: 'Home' } };
  const base = { title: session.title, source: session.id, started: new Date(session.startedAt).toISOString() };
  if (session.id === 'app:plex') return { state: 'plex', attributes: { ...base, app: 'Plex' } };
  if (session.id === 'livetv') return { state: 'live_tv', attributes: { ...base, ...(extra.channel ? { channel: extra.channel } : {}) } };
  if (session.id === 'recording') return { state: 'recording', attributes: base };
  if (session.id.startsWith('game:')) return { state: 'game', attributes: { ...base, game: session.title } };
  const appId = session.id.replace(/^app:/, '');
  return { state: 'app', attributes: { ...base, app: extra.appName?.(appId) ?? session.title, app_id: appId } };
}

/** A command from Home Assistant, checked. */
export type HearthCommand =
  | { command: 'notify'; title: string; message?: string; image?: string; camera?: string; seconds: number }
  | { command: 'camera'; entity: string | null; name?: string }
  | { command: 'open_app'; app: string }
  | { command: 'channel'; channel: string }
  | { command: 'home' }
  | { command: 'stop' }
  | { command: 'sleep_timer'; minutes: number }
  | { command: 'tv'; on: boolean }
  | { command: 'page'; page: string }
  | { command: 'search'; query: string }
  | { command: 'morning' };

const str = (v: unknown, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

/** Validate a hearth_command event's data. Returns null for things meant for another TV, or throws on nonsense. */
export function parseCommand(data: Record<string, unknown>, tvId: string): HearthCommand | null {
  const target = str(data.tv);
  if (target && target !== tvId && target !== 'all') return null;
  const command = str(data.command).toLowerCase();
  switch (command) {
    case 'notify':
    case 'alert': {
      const title = str(data.title) || str(data.message);
      if (!title) throw new Error('notify needs a title or message');
      const seconds = Math.min(Math.max(Number(data.seconds ?? 12) || 12, 3), 600);
      const camera = str(data.camera);
      return {
        command: 'notify',
        title,
        message: data.title ? str(data.message, 500) || undefined : undefined,
        image: str(data.image, 1000) || undefined,
        camera: /^camera\.[a-z0-9_]+$/.test(camera) ? camera : undefined,
        seconds,
      };
    }
    case 'camera':
    case 'show_camera': {
      const entity = str(data.entity);
      if (!/^camera\.[a-z0-9_]+$/.test(entity)) throw new Error('camera needs entity: camera.something');
      return { command: 'camera', entity, name: str(data.name) || undefined };
    }
    case 'hide_camera':
      return { command: 'camera', entity: null };
    case 'open_app':
    case 'app':
      if (!str(data.app)) throw new Error('open_app needs app (an id like plex, or a name)');
      return { command: 'open_app', app: str(data.app) };
    case 'channel':
    case 'watch_channel':
      if (!str(data.channel)) throw new Error('channel needs channel (a number or a name)');
      return { command: 'channel', channel: str(data.channel) };
    case 'home':
      return { command: 'home' };
    case 'stop':
      return { command: 'stop' };
    case 'sleep_timer': {
      const minutes = Number(data.minutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) throw new Error('sleep_timer needs minutes (0 to cancel)');
      return { command: 'sleep_timer', minutes: Math.round(minutes) };
    }
    case 'tv_on':
      return { command: 'tv', on: true };
    case 'tv_off':
      return { command: 'tv', on: false };
    case 'page':
    case 'navigate':
      if (!str(data.page)) throw new Error('page needs page (home, tv, apps, games, …)');
      return { command: 'page', page: str(data.page) };
    case 'search':
      if (!str(data.query)) throw new Error('search needs query');
      return { command: 'search', query: str(data.query, 80) };
    case 'morning':
      return { command: 'morning' };
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'tv';

interface HaLike {
  setState(entityId: string, state: string, attributes: Record<string, unknown>): Promise<void>;
  whenReady(fn: () => void): void;
  onEvent(eventType: string, fn: (data: any) => void): void;
  connected: boolean;
}

export class HassBridge {
  private timer?: NodeJS.Timeout;
  private last = new Map<string, string>();

  constructor(
    private readonly ha: HaLike,
    readonly tvId: string,
    private readonly tvName: string,
    private readonly read: () => { activity: Activity; profile: { name: string; kind: string }; sleepEndsAt: number | null },
    private readonly run: (cmd: HearthCommand) => Promise<void>,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    ha.onEvent('hearth_command', (data) => void this.handle(data));
    ha.whenReady(() => {
      this.last.clear();
      this.publishSoon(0);
    });
    // Home Assistant forgets REST-set states when it restarts; refresh now and then.
    setInterval(() => {
      this.last.clear();
      this.publishSoon(0);
    }, 10 * 60_000).unref();
  }

  /** Something changed (session, profile, sleep timer): publish shortly. */
  publishSoon(delay = 300): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.publish(), delay);
  }

  private async put(id: string, state: string, attributes: Record<string, unknown>): Promise<void> {
    const key = JSON.stringify([state, attributes]);
    if (this.last.get(id) === key) return;
    await this.ha.setState(id, state, attributes);
    this.last.set(id, key);
  }

  async publish(): Promise<void> {
    if (!this.ha.connected) return;
    const { activity, profile, sleepEndsAt } = this.read();
    const p = `hearth_${this.tvId}`;
    try {
      await this.put(`sensor.${p}_activity`, activity.state, {
        ...activity.attributes,
        friendly_name: `${this.tvName} TV activity`,
        icon: activity.state === 'game' ? 'mdi:controller' : activity.state === 'home' ? 'mdi:television-classic' : 'mdi:television-play',
      });
      await this.put(`sensor.${p}_profile`, profile.name, { kind: profile.kind, friendly_name: `${this.tvName} TV profile`, icon: 'mdi:account' });
      await this.put(`sensor.${p}_sleep_timer`, sleepEndsAt ? new Date(sleepEndsAt).toISOString() : 'unknown', {
        device_class: 'timestamp',
        friendly_name: `${this.tvName} TV sleep timer`,
        icon: 'mdi:timer-sand',
      });
    } catch (err) {
      this.log.warn(`home assistant: couldn't publish TV state: ${(err as Error).message}`);
    }
  }

  private async handle(data: Record<string, unknown>): Promise<void> {
    try {
      const cmd = parseCommand(data ?? {}, this.tvId);
      if (!cmd) return;
      this.log.info(`home assistant: ${cmd.command}`);
      await this.run(cmd);
    } catch (err) {
      this.log.warn(`home assistant hearth_command: ${(err as Error).message}`);
    }
  }
}
