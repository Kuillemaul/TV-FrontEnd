import { post } from '../lib/api';

export type Choice = 'no' | 'link' | 'install';
export type ServiceId = 'plex' | 'jellyfin' | 'emby' | 'kodi' | 'homeassistant' | 'tvheadend' | 'plexdvr' | 'seerr' | 'downloads' | 'games' | 'lab';
export type Step = 'welcome' | 'name' | 'watch' | 'extras' | 'apps' | 'folder' | 'connect' | 'done';

export interface Draft {
  step: Step;
  name: string;
  clock24h: boolean;
  services: Record<ServiceId, Choice>;
  apps: string[];
  media: string;
  jobs: Record<string, string>;
}

export interface InstallJob {
  app: string;
  action: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  message: string;
  at: number;
  port?: number;
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface CatalogApp {
  name: string;
  what?: string;
  port?: number;
  path?: string;
  media?: boolean;
  id?: string;
}

/** GET /api/setup (server/src/routes/setup.ts). */
export interface SetupView {
  active: boolean;
  draft: Draft;
  allowed: Record<ServiceId, Choice[]>;
  webApps: Array<{ id: string; name: string; color?: string }>;
  catalog: { docker: Record<string, CatalogApp>; flatpak: Record<string, CatalogApp> };
  installAvailable: boolean;
  installs: { jobs: Record<string, InstallJob>; apps: Record<string, { installed: boolean; port?: number }> };
  linked: Record<'plex' | 'jellyfin' | 'emby' | 'homeassistant' | 'tvheadend' | 'plexdvr' | 'seerr' | 'radarr' | 'sonarr', { url?: string } | null> & {
    games: { count: number; names: string[] } | null;
  };
  plexSignedIn: boolean;
  mounts: Array<{ path: string; freeGb: number; sizeGb: number }>;
  phoneUrl: string | null;
}

export type Reply<T = object> = T & { ok: boolean; error?: string; restarting?: boolean };

export const api = {
  patch: (body: Partial<Draft>) => post<Reply<SetupView>>('/api/setup', body, 'PUT'),
  call: <T = object>(path: string, body: unknown = {}, method = 'POST') => post<Reply<T>>(path, body, method),
};

/** The job for an app started from setup, if any. */
export function jobFor(view: SetupView, app: string): InstallJob | undefined {
  const id = view.draft.jobs[app];
  return id ? view.installs.jobs[id] : undefined;
}

/** The address an app installed here answers on, as seen from a phone on the network. */
export function hereUrl(view: SetupView, app: string): string {
  const meta = view.catalog.docker[app];
  const host = view.phoneUrl ? new URL(view.phoneUrl).hostname : location.hostname;
  return `http://${host}:${meta?.port ?? ''}${meta?.path ?? '/'}`;
}
