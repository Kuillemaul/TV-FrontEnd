import { useCallback, useEffect, useRef, useState } from 'react';

export type PageId = 'home' | 'tv' | 'apps' | 'games' | 'requests' | 'smarthome' | 'lab' | 'settings' | 'search' | 'morning';

export interface Info {
  name: string;
  /** Changes every time the server starts (used to notice a restart). */
  bootId?: string;
  /** The network editor's port, when it's on. */
  admin?: { port: number; url: string } | null;
  clock24h: boolean;
  demo: { tv: boolean; homeassistant: boolean; games: boolean };
  /** Sections configured in config.yaml (or showing demo data). */
  setup: { tv: boolean; homeassistant: boolean; games: boolean };
  /** Untouched example entries in config.yaml that Hearth skipped. */
  ignoredExamples: string[];
  session: Session | null;
  configPath: string;
  features: { plex: boolean; tvInputs: number; wakeWordAvailable: boolean; labActions: number; requests: boolean; downloads: boolean; morning?: { start: string; end: string } | null; doorbellCamera?: string | null };
  screensaver: { idleMinutes: number; pickerAfterMinutes: number };
}

export interface Limits {
  dailyMinutes: number | null;
  bedtime: string | null;
  wakeTime: string | null;
}

export interface ScreenTimeStatus {
  profileId: string;
  usedMinutes: number;
  limitMinutes: number | null;
  remainingMinutes: number | null;
  bedtime: string | null;
  wakeTime: string | null;
  blocked: 'limit' | 'bedtime' | null;
}

export interface Alert {
  id: string;
  kind: 'doorbell' | 'info' | 'warning';
  title: string;
  message?: string;
  camera?: string;
  image?: string;
  action?: { label: string; kind: 'watch' | 'sleep-extend' | 'pip'; title?: string; entity?: string };
  seconds: number;
  at: number;
}

export interface TvSettings {
  /** Soft sounds when moving around and choosing things. */
  uiSounds: boolean;
  scenes: boolean;
  wakeWord: boolean;
  alertsOverApps: boolean;
  autoUpdate: boolean;
}

export interface OnDeckItem {
  id: string;
  title: string;
  subtitle: string;
  thumb?: string;
  progress: number;
}

export interface WatchlistItem {
  title: string;
  year?: number;
  mediaType: 'movie' | 'tv';
  thumb?: string;
}

export interface BrowseSource {
  hostId: string;
  hostName: string;
  online: boolean;
  pc: number;
  platforms: Array<{ name: string; count: number }>;
}

export interface GameDetails extends Game {
  description: string;
  year: number | null;
  genres: string[];
  libraryPlaytimeMinutes: number | null;
  hearthPlaytimeMinutes: number;
  screenshots: string[];
}

export interface Session {
  id: string;
  title: string;
  startedAt: number;
}

export type TileStyle = 'aurora' | 'waves' | 'rays' | 'grid' | 'stars' | 'bars' | 'stripes' | 'glow' | 'plain';

/** A designed tile: drawn live, so it's sharp at any size and animates when focused. */
export interface TileDesign {
  style: TileStyle;
  /** Background, accent. */
  colors: [string, string];
  text?: string;
  textColor?: string;
  textStyle?: 'bold' | 'light' | 'caps';
  icon?: string;
}

export interface AppTile {
  id: string;
  name: string;
  color?: string;
  logo?: string;
  kind: 'command' | 'web';
  custom?: boolean;
  /** Custom look from the network editor. */
  art?: { type: 'design'; design: TileDesign } | { type: 'image'; url: string };
}

export interface ThemeChoice {
  background: string;
  palette: string;
  font: string;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  kind: 'admin' | 'kid';
  hasPin: boolean;
  /** Ordered app ids; null = every app. */
  apps: string[] | null;
  /** "<hostId>:<gameId>" keys; null = every game. */
  games: string[] | null;
  liveTv: boolean;
  /** Live TV channel ids hidden for this profile. */
  hiddenChannels?: string[];
  theme: ThemeChoice;
  limits?: Limits;
  pins?: Pin[];
}

/** Something pinned to Home (per profile). */
export type Pin =
  | { kind: 'app'; id: string }
  | { kind: 'game'; hostId: string; gameId: string; title: string; art?: string }
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'entity'; id: string; name?: string };

export const pinKey = (p: Pin) => (p.kind === 'game' ? `game:${p.hostId}:${p.gameId}` : `${p.kind}:${p.id}`);

export interface ProfilesState {
  activeId: string;
  profiles: Profile[];
  customApps: Array<{ id: string; name: string; url: string; color: string }>;
}

export type MutationResult = Partial<ProfilesState> & { ok: boolean; error?: string; permission?: boolean };

export const gameKey = (g: { hostId: string; id: string }) => `${g.hostId}:${g.id}`;

export interface Channel {
  id: string;
  number: number;
  name: string;
  icon?: string;
  hd?: boolean;
  radio?: boolean;
  /** The HD channel showing the same programmes. */
  duplicateOf?: string;
}

export interface Programme {
  id: string;
  channelId: string;
  title: string;
  subtitle?: string;
  description?: string;
  start: number;
  end: number;
}

export interface Guide {
  demo: boolean;
  lastChannel?: string;
  channels: Channel[];
  programmes: Programme[];
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

export interface Game {
  id: string;
  hostId: string;
  hostName: string;
  title: string;
  platform: string;
  source: 'steam' | 'rom' | 'custom' | 'launchbox' | 'playnite';
  store?: string;
  art?: string;
  controller: 'full' | 'partial' | 'none' | 'unknown';
  requiresKbm: boolean;
  rating: 'E' | 'E10' | 'T' | 'M' | null;
  favorite: boolean;
  installed: boolean;
}

export interface GameHost {
  id: string;
  name: string;
  online: boolean;
  canWake: boolean;
  games: number;
  uptime: number | null;
  playing: string | null;
  wakeEstimate: number | null;
  /** Someone is using the PC (or it's streaming to another device): grey its games out, ask before streaming. */
  busy: HostBusy | null;
}

export interface HostBusy {
  reason: string;
  idleSeconds: number | null;
}

/** "Someone is using Gaming PC · 2 min ago" */
export function busyText(b: HostBusy): string {
  if (b.idleSeconds == null) return b.reason;
  const min = Math.floor(b.idleSeconds / 60);
  return `${b.reason} · ${min < 1 ? 'just now' : `${min} min ago`}`;
}

export interface RecentGame {
  hostId: string;
  gameId: string;
  title: string;
  art?: string;
  playedAt: number;
}

export interface GameLibrary {
  demo: boolean;
  hosts: GameHost[];
  games: Game[];
  recent: RecentGame[];
}

export interface HaEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; unit_of_measurement?: string };
}

export interface Dashboard {
  demo: boolean;
  setup: boolean;
  connected: boolean;
  hasLovelace: boolean;
  sections: Array<{ title: string; entities: HaEntity[] }>;
  favorites: HaEntity[];
  weather: HaEntity | null;
}

export interface LabService {
  name: string;
  url: string;
  open: boolean;
  up: boolean | null;
  latencyMs: number | null;
}

export interface LabStatus {
  demo: boolean;
  services: LabService[];
  sensors: HaEntity[];
}

export interface AudioOutput {
  id: string;
  card: string;
  label: string;
  available: boolean;
  layouts: Array<{ channels: number; label: string; profile: string }>;
}

export interface AudioStatus {
  available: boolean;
  error?: string;
  outputs: AudioOutput[];
  current: { outputId: string; channels: number } | null;
  sink: { name: string; description: string; channels: string[]; volume: number; muted: boolean } | null;
}

export interface MediaResult {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  poster?: string;
  backdrop?: string;
  overview: string;
  status: 'none' | 'requested' | 'processing' | 'partial' | 'available' | 'blocked';
  requestedBy?: string;
  approval?: 'pending' | 'approved' | 'declined';
  trailer?: string;
}

export interface DownloadItem {
  id: string;
  kind: 'radarr' | 'sonarr' | 'lidarr';
  title: string;
  subtitle: string;
  progress: number;
  timeLeft: string | null;
  status: string;
}

export interface KbmStatus {
  keyboard: string | null;
  mouse: string | null;
  gamepads: string[];
}

export type UiAction =
  | { type: 'navigate'; page: PageId }
  | { type: 'launch-app'; id: string; name: string }
  | { type: 'launch-game'; hostId: string; gameId: string; title: string; requiresKbm: boolean }
  | { type: 'watch-channel'; id: string; name: string }
  | { type: 'tv-power'; on: boolean }
  | { type: 'tv-input'; id: string; name: string }
  | { type: 'stop' }
  | { type: 'request-search'; query: string }
  | { type: 'request-open'; media: { id: number; mediaType: 'movie' | 'tv'; title: string; year: number | null } }
  | { type: 'downloads' }
  | { type: 'pin-focused' }
  | { type: 'sleep-timer'; minutes: number }
  | { type: 'camera'; entity: string | null; name?: string }
  | { type: 'search'; query: string };

export type ServerEvent =
  | { type: 'session'; session: Session | null }
  | { type: 'home' }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'game-status'; hostId: string; gameId: string; stage: 'waking' | 'launching' | 'streaming' | 'ended' | 'error'; message: string }
  | { type: 'ha-state'; entity: HaEntity }
  | { type: 'ha-connection'; connected: boolean }
  | { type: 'profiles' }
  | { type: 'alert'; alert: Alert }
  | { type: 'timesup'; reason: 'limit' | 'bedtime' }
  | { type: 'screentime' }
  | { type: 'remote'; cmd: string; text?: string }
  | { type: 'settings' }
  | { type: 'games' }
  | { type: 'apps' }
  | { type: 'display' }
  | { type: 'sleep'; endsAt: number | null }
  | { type: 'pip'; entity: string | null; name?: string }
  | { type: 'action'; action: UiAction }
  | { type: 'pair'; hostId: string; stage: 'waking' | 'pairing' | 'auto-pin' | 'paired' | 'failed'; message: string };

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function post<T = { ok: boolean; error?: string }>(path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

/** Fetch JSON, optionally re-fetching on an interval. */
export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      setData(await get<T>(pathRef.current));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!refreshMs) return;
    const t = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(t);
  }, [path, refreshMs, reload]);

  return { data, error, reload, setData };
}

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;

let bootId: string | null = null;

function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  // After Hearth restarts (e.g. config saved in the network editor), reload to pick everything up.
  ws.onopen = () => {
    void get<{ bootId?: string }>('/api/info')
      .then((info) => {
        if (bootId && info.bootId && info.bootId !== bootId) location.reload();
        bootId = info.bootId ?? bootId;
      })
      .catch(() => undefined);
  };
  ws.onmessage = (m) => {
    const event = JSON.parse(m.data) as ServerEvent;
    for (const l of listeners) l(event);
  };
  ws.onclose = () => {
    socket = null;
    setTimeout(connect, 2000);
  };
}

/** Subscribe to server push events (connection is shared). */
export function useServerEvents(fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!socket) connect();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function formatTime(ms: number, h24: boolean): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !h24 });
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

let lastHosts: GameHost[] | null = null;

/** The gaming PCs (awake? someone using them?), re-checked every 15 seconds. Starts from the last answer, so a
 *  dialog opened from the Games page knows straight away. */
export function useGameHosts(): GameHost[] | null {
  const [hosts, setHosts] = useState(lastHosts);
  useEffect(() => {
    let alive = true;
    const load = () =>
      get<{ hosts: GameHost[] }>('/api/games/hosts')
        .then((r) => {
          lastHosts = r.hosts;
          if (alive) setHosts(r.hosts);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return hosts;
}
