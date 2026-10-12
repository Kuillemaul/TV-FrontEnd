import { useCallback, useEffect, useRef, useState } from 'react';

export type PageId = 'home' | 'tv' | 'apps' | 'games' | 'smarthome' | 'lab' | 'settings';

export interface Info {
  name: string;
  clock24h: boolean;
  demo: { tv: boolean; homeassistant: boolean; games: boolean };
  session: Session | null;
  configPath: string;
}

export interface Session {
  id: string;
  title: string;
  startedAt: number;
}

export interface AppTile {
  id: string;
  name: string;
  color?: string;
  logo?: string;
  kind: 'command' | 'web';
  custom?: boolean;
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
  theme: ThemeChoice;
}

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
}

export interface GameHost {
  id: string;
  name: string;
  online: boolean;
  canWake: boolean;
  games: number;
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

export interface KbmStatus {
  keyboard: string | null;
  mouse: string | null;
}

export type UiAction =
  | { type: 'navigate'; page: PageId }
  | { type: 'launch-app'; id: string; name: string }
  | { type: 'launch-game'; hostId: string; gameId: string; title: string; requiresKbm: boolean }
  | { type: 'watch-channel'; id: string; name: string }
  | { type: 'stop' };

export type ServerEvent =
  | { type: 'session'; session: Session | null }
  | { type: 'home' }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'game-status'; hostId: string; gameId: string; stage: 'waking' | 'launching' | 'streaming' | 'ended' | 'error'; message: string }
  | { type: 'ha-state'; entity: HaEntity }
  | { type: 'ha-connection'; connected: boolean }
  | { type: 'profiles' };

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

function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
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
