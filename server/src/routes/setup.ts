import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statfsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppInstaller, InstallJob } from '../appinstall.js';
import { addPlexLibraries, setUpHomeAssistant, setUpJellyfin } from '../autolink.js';
import type { EventBus } from '../bus.js';
import { editConfigList, setConfigValues } from '../configedit.js';
import {
  checkUrl,
  discoverMediaServers,
  mediaServerInfo,
  mediaServerLogin,
  plexClaimToken,
  plexPinCheck,
  plexPinStart,
  plexServers,
  quickConnectCheck,
  quickConnectStart,
  testArr,
  testGamingAgent,
  testHomeAssistant,
  testMediaServer,
  testPlex,
  testTvheadend,
  trimUrl,
} from '../connect.js';
import { DEFAULT_APPS, loadConfig, type AppTile, type HearthConfig } from '../config.js';
import { PermissionError } from '../profiles.js';
import { lanAddress } from '../remote.js';
import { allowedHost, scan, subnetHosts, type Found } from '../discover.js';
import { ImmichClient, pingMachineLearning, setUpImmich } from '../providers/immich.js';
import { scheduleRestart, validateConfigText, writeConfig } from './admin.js';

/**
 * The first-run setup screen (and Settings → Connections): pick what you use, link what you
 * already have or install it on this machine, choose your streaming apps. The draft lives on the
 * server so the TV and a phone show the same step. Connections are written into config.yaml as
 * they're made; finishing writes the rest and restarts Hearth with it.
 */

export type Choice = 'no' | 'link' | 'install';
export const SERVICES = ['plex', 'jellyfin', 'emby', 'kodi', 'homeassistant', 'tvheadend', 'plexdvr', 'seerr', 'downloads', 'photos', 'games', 'lab'] as const;
export type ServiceId = (typeof SERVICES)[number];
const STEPS = ['welcome', 'name', 'watch', 'extras', 'apps', 'folder', 'connect', 'done'] as const;
type Step = (typeof STEPS)[number];

/** What each service can be: linked to an existing one, installed here, or both. */
const ALLOWED: Record<ServiceId, Choice[]> = {
  plex: ['no', 'link', 'install'],
  jellyfin: ['no', 'link', 'install'],
  emby: ['no', 'link'],
  kodi: ['no', 'install'],
  homeassistant: ['no', 'link', 'install'],
  tvheadend: ['no', 'link', 'install'],
  plexdvr: ['no', 'link'],
  seerr: ['no', 'link', 'install'],
  downloads: ['no', 'link', 'install'],
  photos: ['no', 'link', 'install'],
  games: ['no', 'link'],
  lab: ['no', 'link'],
};
/** Server apps (Docker) each "install here" choice sets up. Plex waits for the Plex sign-in (its claim code). */
const DOCKER: Partial<Record<ServiceId, string[]>> = {
  jellyfin: ['jellyfin'],
  homeassistant: ['homeassistant'],
  tvheadend: ['tvheadend'],
  seerr: ['seerr'],
  downloads: ['radarr', 'sonarr', 'prowlarr', 'qbittorrent'],
  photos: ['immich'],
};
/** Programs (Flatpak) each choice needs on the TV, linked or installed. */
const FLATPAK: Partial<Record<ServiceId, string>> = { plex: 'plex-htpc', jellyfin: 'jellyfin-player', kodi: 'kodi', games: 'moonlight' };

const TV_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
/** Streaming services offered on the setup screen (web apps in the kiosk browser). */
export const WEB_APPS: AppTile[] = [
  ...DEFAULT_APPS.filter((a) => a.launch.type === 'web'),
  { id: 'appletv', name: 'Apple TV+', color: '#1d1d1f', launch: { type: 'web', url: 'https://tv.apple.com' } },
  { id: 'paramount', name: 'Paramount+', color: '#0064ff', launch: { type: 'web', url: 'https://www.paramountplus.com' } },
  { id: 'peacock', name: 'Peacock', color: '#000000', launch: { type: 'web', url: 'https://www.peacocktv.com' } },
  { id: 'hulu', name: 'Hulu', color: '#1ce783', launch: { type: 'web', url: 'https://www.hulu.com' } },
  { id: 'crunchyroll', name: 'Crunchyroll', color: '#f47521', launch: { type: 'web', url: 'https://www.crunchyroll.com' } },
  { id: 'twitch', name: 'Twitch', color: '#9146ff', launch: { type: 'web', url: 'https://www.twitch.tv', userAgent: TV_UA } },
  { id: 'ytmusic', name: 'YouTube Music', color: '#ff0000', launch: { type: 'web', url: 'https://music.youtube.com' } },
];
const DEFAULT_PICKS = ['netflix', 'youtube', 'disney', 'prime'];

/** App tiles for the media programs chosen (on the TV, not in the browser). */
function clientTiles(services: Record<ServiceId, Choice>, embyUrl?: string): AppTile[] {
  const tiles: AppTile[] = [];
  if (services.plex !== 'no') tiles.push({ id: 'plex', name: 'Plex', color: '#e5a00d', launch: { type: 'command', command: ['flatpak', 'run', 'tv.plex.PlexHTPC'] } });
  if (services.jellyfin !== 'no') {
    tiles.push({
      id: 'jellyfin',
      name: 'Jellyfin',
      color: '#7a3fd1',
      launch: { type: 'command', command: ['flatpak', 'run', 'com.github.iwalton3.jellyfin-media-player', '--tv', '--fullscreen'] },
      controllerKeys: false,
    });
  }
  if (services.emby !== 'no' && embyUrl) tiles.push({ id: 'emby', name: 'Emby', color: '#52b54b', launch: { type: 'web', url: `${embyUrl}/web/index.html` } });
  if (services.kodi !== 'no') tiles.push({ id: 'kodi', name: 'Kodi', color: '#17b2e7', launch: { type: 'command', command: ['flatpak', 'run', 'tv.kodi.Kodi'] }, controllerKeys: false });
  return tiles;
}
const CLIENT_IDS = ['plex', 'jellyfin', 'emby', 'kodi'];

export interface SetupDraft {
  step: Step;
  name: string;
  clock24h: boolean;
  services: Record<ServiceId, Choice>;
  apps: string[];
  /** Folder for movies/shows/downloads when installing media apps here. */
  media: string;
  /** Install jobs started from setup, by app. */
  jobs: Record<string, string>;
}
interface SetupFile {
  active: boolean;
  draft: SetupDraft;
  /** Plex account token from "sign in with Plex" (for picking a server, or claiming one installed here). */
  plexToken?: string;
}

const MEDIA_RE = /^\/(srv|mnt|media|home|data|storage)(\/[\w .@+-]+)*\/?$/;

export interface SetupContext {
  config: HearthConfig;
  configPath: string;
  bus: EventBus;
  installer: AppInstaller;
  log: { info: (m: string) => void; warn: (m: string) => void };
  fail: (err: unknown) => { ok: boolean; error: string };
  isKid: () => boolean;
}

export function registerSetup(app: FastifyInstance, ctx: SetupContext): { active: () => boolean } {
  const { config, configPath, bus, installer, log, fail, isKid } = ctx;
  const file = join(config.stateDir, 'setup.json');

  const blank = (): SetupDraft => ({
    step: 'welcome',
    name: config.ui.name || 'Living Room',
    clock24h: config.ui.clock24h,
    services: Object.fromEntries(SERVICES.map((s) => [s, 'no'])) as Record<ServiceId, Choice>,
    apps: [...DEFAULT_PICKS],
    media: '/srv/media',
    jobs: {},
  });

  const read = (): SetupFile | null => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const write = (s: SetupFile) => {
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2));
    bus.emit({ type: 'setup' });
  };
  // A brand-new install (no config.yaml yet) opens the setup screen.
  if (!existsSync(configPath) && !read()) write({ active: true, draft: blank() });
  const active = () => read()?.active ?? false;

  const guard = () => {
    if (isKid()) throw new PermissionError('Ask a parent to change Hearth’s setup');
  };

  /** Fresh settings from disk (config.yaml changes during setup; the running config is from boot). */
  const current = () => (existsSync(configPath) ? loadConfig(configPath) : null);

  const save = (changes: Array<[string[], unknown]>, why: string) => {
    const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const next = setConfigValues(text, changes);
    const error = validateConfigText(next, configPath);
    if (error) throw new Error(error);
    writeConfig(configPath, next);
    log.info(`config.yaml: ${why}`);
    bus.emit({ type: 'setup' });
    // Outside the setup screen, connections take effect after a quick restart (the TV reloads itself).
    if (!active()) scheduleRestart(log);
    return { ok: true, restarting: !active() };
  };

  const linked = () => {
    const c = current();
    return {
      plex: c?.plex ? { url: c.plex.url } : null,
      jellyfin: c?.mediaServer?.kind === 'jellyfin' ? { url: c.mediaServer.url } : null,
      emby: c?.mediaServer?.kind === 'emby' ? { url: c.mediaServer.url } : null,
      homeassistant: c?.homeassistant ? { url: c.homeassistant.url } : null,
      tvheadend: c?.livetv.tvheadend ? { url: c.livetv.tvheadend.url } : null,
      plexdvr: c?.livetv.plex ? {} : null,
      seerr: c?.requests.seerr ? { url: c.requests.seerr.url } : null,
      radarr: c?.requests.radarr ? { url: c.requests.radarr.url } : null,
      sonarr: c?.requests.sonarr ? { url: c.requests.sonarr.url } : null,
      games: c?.gaming.hosts.length ? { count: c.gaming.hosts.length, names: c.gaming.hosts.map((h) => h.name) } : null,
      immich: c?.immich ? { url: c.immich.url, mlHost: c.immich.mlHost ?? null } : null,
    };
  };

  /** Start the installs the choices need (once each; ones already installed are skipped). */
  const startInstalls = (s: SetupFile) => {
    if (!installer.available) return;
    const status = installer.status();
    const wanted: Array<['docker' | 'flatpak', string]> = [];
    for (const svc of SERVICES) {
      const choice = s.draft.services[svc];
      if (choice === 'install') for (const d of DOCKER[svc] ?? []) wanted.push(['docker', d]);
      if (choice !== 'no' && FLATPAK[svc]) wanted.push(['flatpak', FLATPAK[svc]!]);
    }
    for (const [kind, name] of wanted) {
      const job = s.draft.jobs[name] ? status.jobs[s.draft.jobs[name]] : undefined;
      if (status.apps[name]?.installed || (job && job.state !== 'failed')) continue;
      try {
        s.draft.jobs[name] = installer.request(kind, name, 'install', kind === 'docker' ? { media: s.draft.media } : {});
      } catch (err) {
        log.warn(`install ${name}: ${(err as Error).message}`);
      }
    }
  };

  /** Prefill from what's set up already ("Run setup again"). */
  const fromConfig = (): SetupDraft => {
    const d = blank();
    const c = current();
    if (!c) return d;
    const l = linked();
    d.name = c.ui.name;
    d.clock24h = c.ui.clock24h;
    const has = (id: string) => c.apps.some((a) => a.id === id);
    d.services.plex = l.plex || has('plex') ? 'link' : 'no';
    d.services.jellyfin = l.jellyfin || has('jellyfin') ? 'link' : 'no';
    d.services.emby = l.emby ? 'link' : 'no';
    d.services.kodi = has('kodi') ? 'install' : 'no';
    d.services.homeassistant = l.homeassistant ? 'link' : 'no';
    d.services.tvheadend = l.tvheadend ? 'link' : 'no';
    d.services.plexdvr = l.plexdvr ? 'link' : 'no';
    d.services.seerr = l.seerr ? 'link' : 'no';
    d.services.downloads = l.radarr || l.sonarr ? 'link' : 'no';
    d.services.games = l.games ? 'link' : 'no';
    d.services.photos = l.immich ? 'link' : 'no';
    d.services.lab = !c.ui.hide.includes('lab') && (c.lab.services.length || c.lab.sensors.length) ? 'link' : 'no';
    d.apps = WEB_APPS.filter((w) => has(w.id)).map((w) => w.id);
    return d;
  };

  const mounts = () => {
    const out: Array<{ path: string; freeGb: number; sizeGb: number }> = [];
    const seen = new Set<string>();
    const add = (path: string) => {
      if (seen.has(path)) return;
      try {
        const st = statfsSync(path);
        seen.add(path);
        out.push({ path, freeGb: Math.round((st.bavail * st.bsize) / 1e9), sizeGb: Math.round((st.blocks * st.bsize) / 1e9) });
      } catch {
        /* not there */
      }
    };
    add('/srv');
    try {
      for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
        const [, mount, type] = line.split(' ');
        if (mount && /^\/(mnt|media|srv|data|storage)\//.test(mount) && /^(ext[234]|xfs|btrfs|ntfs3?|exfat|vfat|fuseblk|zfs|nfs4?|cifs)$/.test(type)) add(mount.replace(/\\040/g, ' '));
      }
    } catch {
      /* not Linux */
    }
    return out;
  };

  const view = () => {
    const s = read();
    return {
      active: s?.active ?? false,
      draft: s?.draft ?? fromConfig(),
      allowed: ALLOWED,
      webApps: WEB_APPS.map((a) => ({ id: a.id, name: a.name, color: a.color })),
      catalog: installer.catalog,
      installAvailable: installer.available,
      installs: installer.status(),
      linked: linked(),
      plexSignedIn: Boolean(s?.plexToken),
      mounts: mounts(),
      /** Gaming PCs that could run Immich's face recognition. */
      gamingPcs: (current()?.gaming.hosts ?? []).map((h) => ({ id: h.id, name: h.name, host: h.moonlightHost })),
      phoneUrl: config.admin.enabled ? `http://${lanAddress() ?? 'this-tv'}:${config.admin.port}/setup` : null,
    };
  };

  const run = async (fn: () => Promise<unknown> | unknown) => {
    try {
      const out = await fn();
      return { ok: true, ...(typeof out === 'object' && out ? out : {}) };
    } catch (err) {
      return fail(err);
    }
  };

  /* ---------------- the setup screen ---------------- */

  app.get('/api/setup', async () => view());

  app.put<{ Body: Partial<SetupDraft> }>('/api/setup', async (req) =>
    run(() => {
      guard();
      const s = read() ?? { active: true, draft: fromConfig() };
      const b = req.body ?? {};
      const d = s.draft;
      if (b.name !== undefined) d.name = String(b.name).trim().slice(0, 30) || d.name;
      if (b.clock24h !== undefined) d.clock24h = Boolean(b.clock24h);
      if (b.services) {
        for (const [k, v] of Object.entries(b.services)) {
          if (!(SERVICES as readonly string[]).includes(k)) continue;
          if (!ALLOWED[k as ServiceId].includes(v as Choice)) throw new Error(`${k} can’t be “${v}”`);
          if (v === 'install' && !installer.available && k !== 'kodi') throw new Error('Installing isn’t set up on this machine');
          d.services[k as ServiceId] = v as Choice;
        }
      }
      if (b.apps) d.apps = b.apps.filter((id) => WEB_APPS.some((w) => w.id === id));
      if (b.media !== undefined) {
        const m = String(b.media).trim();
        if (!MEDIA_RE.test(m) || m.includes('..')) throw new Error('Pick a folder under /srv, /mnt, /media, /home, /data or /storage');
        d.media = m.replace(/\/$/, '');
      }
      if (b.step) {
        if (!(STEPS as readonly string[]).includes(b.step)) throw new Error('Unknown step');
        d.step = b.step;
        if (d.step === 'connect') startInstalls(s);
      }
      write(s);
      return view();
    }),
  );

  /** "Run setup again" from Settings or the network editor. */
  app.post('/api/setup/start', async () =>
    run(() => {
      guard();
      write({ active: true, draft: { ...fromConfig(), step: 'watch' } });
      return view();
    }),
  );

  app.post('/api/setup/cancel', async () =>
    run(() => {
      guard();
      if (!existsSync(configPath)) throw new Error('Finish setting up first (or choose sample data)');
      const s = read();
      if (s) write({ ...s, active: false });
    }),
  );

  /** Look around with sample data (Live TV guide, games, smart home…), set up for real later. */
  app.post('/api/setup/demo', async () =>
    run(() => {
      guard();
      const s = read() ?? { active: true, draft: blank() };
      const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      writeConfig(configPath, setConfigValues(text, [[['demo'], true], [['ui', 'name'], s.draft.name], [['server', 'host'], '0.0.0.0']]));
      write({ ...s, active: false, draft: { ...s.draft, step: 'done' } });
      scheduleRestart(log);
      return { restarting: true };
    }),
  );

  app.post('/api/setup/finish', async () =>
    run(() => {
      guard();
      const s = read();
      if (!s) throw new Error('Setup isn’t running');
      const d = s.draft;
      const c = current();
      // Keep apps that aren't on the setup screen's lists (e.g. ones added by hand).
      const existing = c?.apps ?? [];
      const keep = existing.filter((a) => !CLIENT_IDS.includes(a.id) && !WEB_APPS.some((w) => w.id === a.id));
      const apps = [...clientTiles(d.services, c?.mediaServer?.kind === 'emby' ? c.mediaServer.url : undefined), ...WEB_APPS.filter((w) => d.apps.includes(w.id)), ...keep];
      const hide = [
        d.services.tvheadend === 'no' && d.services.plexdvr === 'no' ? 'livetv' : null,
        d.services.games === 'no' ? 'games' : null,
        d.services.homeassistant === 'no' ? 'smarthome' : null,
        d.services.lab === 'no' ? 'lab' : null,
      ].filter(Boolean);
      const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const changes: Array<[string[], unknown]> = [
        [['ui', 'name'], d.name],
        [['ui', 'clock24h'], d.clock24h],
        [['ui', 'hide'], hide],
        [['apps'], apps],
        [['demo'], undefined],
      ];
      // So the phone remote and the network editor can reach this TV (both still need pairing / the home network).
      if (!c || c.server.host === '127.0.0.1') changes.push([['server', 'host'], '0.0.0.0']);
      const next = setConfigValues(text, changes);
      const error = validateConfigText(next, configPath);
      if (error) throw new Error(error);
      writeConfig(configPath, next);
      write({ active: false, draft: { ...d, step: 'done' } });
      log.info('setup finished');
      scheduleRestart(log);
      return { restarting: true };
    }),
  );

  /** Settings → Phone remote: let phones on the network reach Hearth (they still have to pair). */
  app.post('/api/setup/phone-remote', async () => run(() => (guard(), save([[['server', 'host'], '0.0.0.0']], 'phone remote turned on')))); 

  /** Settings: show or hide top-bar pages (no restart needed). */
  app.put<{ Body: { hide: string[] } }>('/api/setup/pages', async (req) =>
    run(() => {
      guard();
      const hide = (req.body.hide ?? []).filter((h) => ['livetv', 'games', 'smarthome', 'lab', 'requests'].includes(h));
      const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const next = setConfigValues(text, [[['ui', 'hide'], hide]]);
      const error = validateConfigText(next, configPath);
      if (error) throw new Error(error);
      writeConfig(configPath, next);
      config.ui.hide = hide;
      bus.emit({ type: 'setup' });
      return { hide };
    }),
  );

  /** Install (or remove) one app from Settings → Connections. */
  app.post<{ Body: { kind: 'docker' | 'flatpak'; app: string; action?: 'install' | 'remove'; media?: string } }>('/api/setup/install', async (req) =>
    run(() => {
      guard();
      const media = req.body.media ?? read()?.draft.media ?? '/srv/media';
      if (!MEDIA_RE.test(media) || media.includes('..')) throw new Error('Pick a folder under /srv, /mnt, /media, /home, /data or /storage');
      const job = installer.request(req.body.kind, req.body.app, req.body.action ?? 'install', { media });
      const s = read() ?? { active: false, draft: fromConfig() };
      s.draft.jobs[req.body.app] = job;
      write(s);
      return { job };
    }),
  );

  /* ---------------- linking: Plex ---------------- */

  app.post('/api/connect/plex/pin', async () => run(() => (guard(), plexPinStart())));

  app.get<{ Params: { id: string } }>('/api/connect/plex/pin/:id', async (req) =>
    run(async () => {
      const token = await plexPinCheck(Number(req.params.id));
      if (!token) return { signedIn: false };
      const s = read() ?? { active: false, draft: fromConfig() };
      write({ ...s, plexToken: token });
      return { signedIn: true, servers: await plexServers(token).catch(() => []) };
    }),
  );

  app.get('/api/connect/plex/servers', async () =>
    run(async () => {
      const token = read()?.plexToken;
      if (!token) throw new Error('Sign in with Plex first');
      return { servers: await plexServers(token) };
    }),
  );

  app.post<{ Body: { url: string; token?: string } }>('/api/connect/plex', async (req) =>
    run(async () => {
      guard();
      const url = checkUrl(req.body.url);
      const token = req.body.token || read()?.plexToken;
      if (!token) throw new Error('Sign in with Plex first');
      const { name } = await testPlex(url, token);
      return { name, ...save([[['plex', 'url'], url], [['plex', 'token'], token]], `linked Plex (${name})`) };
    }),
  );

  /** Install Plex Media Server here, claimed to the signed-in account, then add libraries and link it. */
  app.post('/api/connect/plex/install', async () =>
    run(async () => {
      guard();
      const s = read();
      if (!s?.plexToken) throw new Error('Sign in with Plex first');
      const claim = await plexClaimToken(s.plexToken);
      s.draft.jobs.plex = installer.request('docker', 'plex', 'install', { media: s.draft.media, claim });
      write(s);
      return { job: s.draft.jobs.plex };
    }),
  );

  /* ---------------- linking: Jellyfin / Emby ---------------- */

  app.post('/api/connect/mediaserver/discover', async () => run(async () => ({ servers: await discoverMediaServers() })));

  app.post<{ Body: { url: string } }>('/api/connect/mediaserver/info', async (req) => run(() => mediaServerInfo(checkUrl(req.body.url))));

  const saveMediaServer = (kind: 'jellyfin' | 'emby', url: string, login: { token: string; userId: string; userName: string }) =>
    save([[[kind], { url, token: login.token, userId: login.userId }]], `linked ${kind} as ${login.userName}`);

  app.post<{ Body: { url: string } }>('/api/connect/jellyfin/quick', async (req) => run(() => (guard(), quickConnectStart(checkUrl(req.body.url)))));

  app.post<{ Body: { url: string; secret: string } }>('/api/connect/jellyfin/quick/check', async (req) =>
    run(async () => {
      guard();
      const url = checkUrl(req.body.url);
      const login = await quickConnectCheck(url, String(req.body.secret));
      if (!login) return { signedIn: false };
      return { signedIn: true, user: login.userName, ...saveMediaServer('jellyfin', url, login) };
    }),
  );

  app.post<{ Params: { kind: 'jellyfin' | 'emby' }; Body: { url: string; username: string; password: string } }>('/api/connect/:kind/login', async (req) =>
    run(async () => {
      guard();
      const kind = req.params.kind;
      if (kind !== 'jellyfin' && kind !== 'emby') throw new Error('Unknown server');
      const url = checkUrl(req.body.url);
      const login = await mediaServerLogin(url, String(req.body.username ?? ''), String(req.body.password ?? ''));
      await testMediaServer(url, login.token);
      return { user: login.userName, ...saveMediaServer(kind, url, login) };
    }),
  );

  /** Jellyfin installed here: create the account and libraries, then link. */
  app.post<{ Body: { username: string; password: string } }>('/api/connect/jellyfin/create', async (req) =>
    run(async () => {
      guard();
      const username = String(req.body.username ?? '').trim();
      if (!username) throw new Error('Choose a username');
      const url = `http://127.0.0.1:${installer.catalog.docker.jellyfin.port}`;
      const login = await setUpJellyfin(url, username, String(req.body.password ?? ''));
      return { user: login.userName, ...saveMediaServer('jellyfin', url, login) };
    }),
  );

  /* ---------------- linking: the rest ---------------- */

  app.post<{ Body: { url: string; token: string } }>('/api/connect/homeassistant', async (req) =>
    run(async () => {
      guard();
      const url = checkUrl(req.body.url);
      const token = String(req.body.token ?? '').trim();
      const { name } = await testHomeAssistant(url, token);
      return { name, ...save([[['homeassistant', 'url'], url], [['homeassistant', 'token'], token]], `linked Home Assistant (${name})`) };
    }),
  );

  /** Home Assistant installed here: create the owner account and a token, then link. */
  app.post<{ Body: { name: string; username: string; password: string } }>('/api/connect/homeassistant/create', async (req) =>
    run(async () => {
      guard();
      const username = String(req.body.username ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{2,}$/.test(username)) throw new Error('Choose a username (letters and numbers)');
      if (String(req.body.password ?? '').length < 6) throw new Error('Use a password of at least 6 characters');
      const url = `http://127.0.0.1:${installer.catalog.docker.homeassistant.port}`;
      const token = await setUpHomeAssistant(url, String(req.body.name || username), username, String(req.body.password));
      return save([[['homeassistant', 'url'], url], [['homeassistant', 'token'], token]], 'linked Home Assistant (installed here)');
    }),
  );

  app.post<{ Body: { url: string; username?: string; password?: string } }>('/api/connect/tvheadend', async (req) =>
    run(async () => {
      guard();
      const url = checkUrl(req.body.url);
      const { name } = await testTvheadend(url, req.body.username || undefined, req.body.password || undefined);
      return {
        name,
        ...save(
          [
            [['livetv', 'tvheadend', 'url'], url],
            [['livetv', 'tvheadend', 'username'], req.body.username || undefined],
            [['livetv', 'tvheadend', 'password'], req.body.password || undefined],
          ],
          'linked Tvheadend',
        ),
      };
    }),
  );

  app.post<{ Body: { on: boolean } }>('/api/connect/plexdvr', async (req) =>
    run(() => {
      guard();
      if (req.body.on && !current()?.plex) throw new Error('Link Plex first');
      return save([[['livetv', 'plex'], req.body.on ? true : undefined]], `Plex DVR ${req.body.on ? 'on' : 'off'}`);
    }),
  );

  app.post<{ Body: { kind: 'seerr' | 'radarr' | 'sonarr' | 'lidarr'; url: string; apiKey: string } }>('/api/connect/arr', async (req) =>
    run(async () => {
      guard();
      const { kind } = req.body;
      const url = checkUrl(req.body.url);
      const apiKey = String(req.body.apiKey ?? '').trim();
      await testArr(kind, url, apiKey);
      return save([[['requests', kind], { url, apiKey }]], `linked ${kind}`);
    }),
  );

  /** Add a gaming PC running the Hearth agent (pc-agent/). */
  app.post<{ Body: { address: string; token: string } }>('/api/connect/games', async (req) =>
    run(async () => {
      guard();
      let address = String(req.body.address ?? '').trim();
      if (!address) throw new Error('Enter the PC’s address, like 192.168.1.50');
      if (!/^https?:\/\//.test(address)) address = `http://${address}`;
      const parsed = new URL(address);
      const agent = trimUrl(parsed.port ? parsed.origin : `${parsed.protocol}//${parsed.hostname}:47800`);
      const token = String(req.body.token ?? '').trim();
      const { name } = await testGamingAgent(agent, token);
      const c = current();
      if (c?.gaming.hosts.some((h) => h.agent === agent)) throw new Error(`${name} is already added`);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `pc${(c?.gaming.hosts.length ?? 0) + 1}`;
      const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const next = editConfigList(text, ['gaming', 'hosts'], { op: 'add', item: { id, name, agent, token, moonlightHost: parsed.hostname, moonlightApp: 'Desktop' } });
      const error = validateConfigText(next, configPath);
      if (error) throw new Error(error);
      writeConfig(configPath, next);
      bus.emit({ type: 'setup' });
      if (!active()) scheduleRestart(log);
      return { name, restarting: !active() };
    }),
  );

  /** Unlink a service (its settings leave config.yaml; nothing is uninstalled). */
  app.delete<{ Params: { service: string } }>('/api/connect/:service', async (req) =>
    run(() => {
      guard();
      const paths: Record<string, string[]> = {
        plex: ['plex'],
        jellyfin: ['jellyfin'],
        emby: ['emby'],
        homeassistant: ['homeassistant'],
        tvheadend: ['livetv', 'tvheadend'],
        plexdvr: ['livetv', 'plex'],
        seerr: ['requests', 'seerr'],
        radarr: ['requests', 'radarr'],
        sonarr: ['requests', 'sonarr'],
        immich: ['immich'],
      };
      const path = paths[req.params.service];
      if (!path) throw new Error('Unknown service');
      return save([[path, undefined]], `unlinked ${req.params.service}`);
    }),
  );

  /* ---------------- Immich (photos) ---------------- */

  const IMMICH_LOCAL_ML = 'http://immich-machine-learning:3003';

  app.post<{ Body: { url: string; apiKey: string } }>('/api/connect/immich', async (req) =>
    run(async () => {
      guard();
      const url = checkUrl(req.body.url);
      const apiKey = String(req.body.apiKey ?? '').trim();
      const { name } = await new ImmichClient({ url, apiKey }).test();
      return { name, ...save([[['immich', 'url'], url], [['immich', 'apiKey'], apiKey]], 'linked Immich') };
    }),
  );

  /** Immich installed here: create the admin account and an API key, then link. */
  app.post<{ Body: { name: string; email: string; password: string } }>('/api/connect/immich/create', async (req) =>
    run(async () => {
      guard();
      const email = String(req.body.email ?? '').trim();
      if (!/^\S+@\S+$/.test(email)) throw new Error('Immich signs in with an email address');
      if (String(req.body.password ?? '').length < 8) throw new Error('Use a password of at least 8 characters');
      const url = `http://127.0.0.1:${installer.catalog.docker.immich.port}`;
      const apiKey = await setUpImmich(url, email, String(req.body.password), String(req.body.name || email.split('@')[0]));
      return save([[['immich', 'url'], url], [['immich', 'apiKey'], apiKey]], 'linked Immich (installed here)');
    }),
  );

  /** Is Immich's machine-learning worker running on this gaming PC (pc-agent/immich-ml.ps1)? */
  app.post<{ Body: { hostId: string } }>('/api/connect/immich/ml/check', async (req) =>
    run(async () => {
      const host = current()?.gaming.hosts.find((h) => h.id === req.body.hostId);
      if (!host) throw new Error('Unknown PC');
      const url = `http://${host.moonlightHost}:3003`;
      return { url, running: await pingMachineLearning(url) };
    }),
  );

  /** Where face recognition and smart search run: a gaming PC (this TV as the fallback), or this TV. */
  app.post<{ Body: { hostId?: string | null } }>('/api/connect/immich/ml', async (req) =>
    run(async () => {
      guard();
      const c = current();
      if (!c?.immich) throw new Error('Link Immich first');
      const client = new ImmichClient(c.immich);
      const installedHere = Boolean(installer.installed('immich')?.installed) || c.immich.url.includes('127.0.0.1');
      if (!req.body.hostId) {
        if (installedHere) await client.setMachineLearning([IMMICH_LOCAL_ML]);
        return save([[['immich', 'mlHost'], undefined], [['immich', 'mlUrl'], undefined]], 'Immich machine learning on this TV');
      }
      const host = c.gaming.hosts.find((h) => h.id === req.body.hostId);
      if (!host) throw new Error('Unknown PC');
      const url = `http://${host.moonlightHost}:3003`;
      if (!(await pingMachineLearning(url))) throw new Error(`Immich’s machine learning isn’t answering on ${host.name}. Run pc-agent\\immich-ml.ps1 there first.`);
      await client.setMachineLearning(installedHere ? [url, IMMICH_LOCAL_ML] : [url]);
      return save([[['immich', 'mlHost'], host.id], [['immich', 'mlUrl'], url]], `Immich machine learning on ${host.name}`);
    }),
  );

  /* ---------------- finding servers on the network ---------------- */

  const discovery: { running: boolean; progress: number; hosts: string[]; results: Found[]; error?: string; at?: number } = { running: false, progress: 0, hosts: [], results: [] };
  const discoverView = () => {
    const c = current();
    const known = new Set<string>(
      [
        ...Object.values(linked()).map((l) => (l && 'url' in l ? (l as { url?: string }).url : undefined)),
        ...(c?.lab.services ?? config.lab.services).map((s) => s.url),
      ]
        .filter((u): u is string => Boolean(u))
        .map((u) => u.replace(/\/+$/, '')),
    );
    return { ...discovery, results: discovery.results.map((f) => ({ ...f, added: known.has(f.url) })) };
  };

  app.get('/api/discover', async () => discoverView());

  /** Scan addresses (e.g. "192.168.1.10, nas.lan") or the whole home network for servers and apps. */
  app.post<{ Body: { hosts?: string; network?: boolean } }>('/api/discover', async (req) =>
    run(() => {
      guard();
      if (discovery.running) throw new Error('Already looking. Give it a moment.');
      let hosts: string[];
      if (req.body.network) {
        const ip = lanAddress();
        if (!ip) throw new Error('This TV isn’t on a network');
        hosts = subnetHosts(ip);
      } else {
        hosts = String(req.body.hosts ?? '')
          .split(/[\s,;]+/)
          .map((h) => h.trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
          .filter(Boolean);
        if (!hosts.length) throw new Error('Type a server’s address, like 192.168.1.10');
        const bad = hosts.find((h) => !allowedHost(h));
        if (bad) throw new Error(`${bad} isn’t on your home network`);
        hosts = [...new Set(hosts)].slice(0, 16);
      }
      Object.assign(discovery, { running: true, progress: 0, hosts: req.body.network ? ['your network'] : hosts, results: [], error: undefined, at: Date.now() });
      bus.emit({ type: 'discover' });
      void scan(hosts, {
        quick: Boolean(req.body.network),
        onFound: (f) => {
          discovery.results.push(f);
          bus.emit({ type: 'discover' });
        },
        onProgress: (p) => {
          discovery.progress = p;
          bus.emit({ type: 'discover' });
        },
      })
        .then((all) => {
          discovery.results = all;
        })
        .catch((err) => {
          discovery.error = (err as Error).message;
        })
        .finally(() => {
          discovery.running = false;
          discovery.progress = 1;
          log.info(`discover: ${discovery.results.length} found on ${discovery.hosts.join(', ')}`);
          bus.emit({ type: 'discover' });
        });
      return discoverView();
    }),
  );

  /* ---------------- link apps once they're installed here ---------------- */

  const prevFinished = installer.onFinished;
  installer.onFinished = (jobId: string, job: InstallJob) => {
    prevFinished?.(jobId, job);
    if (job.state !== 'done' || job.action !== 'install') return;
    const local = (port?: number) => `http://127.0.0.1:${port}`;
    void (async () => {
      try {
        if ((job.app === 'radarr' || job.app === 'sonarr' || job.app === 'seerr') && job.apiKey) {
          save([[['requests', job.app], { url: local(job.port), apiKey: job.apiKey }]], `linked ${job.app} (installed here)`);
        } else if (job.app === 'tvheadend') {
          save([[['livetv', 'tvheadend', 'url'], local(job.port)]], 'linked Tvheadend (installed here)');
        } else if (job.app === 'plex') {
          const token = read()?.plexToken;
          if (!token) return;
          const url = local(job.port);
          await addPlexLibraries(url, token);
          save([[['plex', 'url'], url], [['plex', 'token'], token]], 'linked Plex Media Server (installed here)');
        }
      } catch (err) {
        log.warn(`linking ${job.app}: ${(err as Error).message}`);
        bus.toast(`${job.app} is installed but couldn’t be linked: ${(err as Error).message}`, 'error');
      }
    })();
  };

  // Apps that finished installing while Hearth was restarting: link them now.
  const l = linked();
  const apps = installer.status().apps;
  for (const name of ['radarr', 'sonarr', 'seerr'] as const) {
    if (apps[name]?.apiKey && !l[name]) installer.onFinished('boot', { app: name, action: 'install', state: 'done', message: '', at: Date.now(), port: apps[name].port, apiKey: apps[name].apiKey });
  }
  if (apps.tvheadend?.installed && !l.tvheadend) installer.onFinished('boot', { app: 'tvheadend', action: 'install', state: 'done', message: '', at: Date.now(), port: apps.tvheadend.port });
  installer.resume();

  return { active };
}
