import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './bus.js';
import { expand, loadConfig, resolveConfigPath, type AppTile } from './config.js';
import { HotkeyWatcher, kbmStatus } from './input.js';
import { ControllerKeys, KEY_NAMES, wantsControllerKeys, wantsPointer } from './padkeys.js';
import type { IntentCatalog, UiAction } from './intents.js';
import { Launcher } from './launcher.js';
import { DemoHome } from './providers/demohome.js';
import { GameService } from './providers/games.js';
import { HomeAssistant, type HaEntity } from './providers/homeassistant.js';
import { LabMonitor } from './providers/lab.js';
import { DemoTvProvider, findDuplicates, NoTvProvider, TvheadendProvider, type Channel, type LiveTvProvider } from './providers/livetv.js';
import { PermissionError, ProfileStore, type Profile } from './profiles.js';
import { AlertService, type Alert } from './alerts.js';
import { SceneAutomation } from './automations.js';
import { PlexClient } from './providers/plex.js';
import { JellyfinClient } from './providers/jellyfin.js';
import type { MediaLibrary } from './providers/library.js';
import { PlexLiveTvProvider } from './providers/plexlive.js';
import { cookieToken, isLoopback, lanAddress, RemotePairing } from './remote.js';
import { registerExtras } from './routes/extras.js';
import { RequestsClient } from './providers/seerr.js';
import { SleepTimer, sayMinutes } from './sleep.js';
import { score } from './intents.js';
import { registerAdminApi, startAdminServer } from './routes/admin.js';
import { registerLabEdit } from './routes/labedit.js';
import { registerSetup } from './routes/setup.js';
import { AppInstaller } from './appinstall.js';
import { ImmichClient } from './providers/immich.js';
import { ImmichGovernor } from './immichpause.js';
import { installElevation, isElevated } from './elevate.js';
import { ScreenTime } from './screentime.js';
import { StateStore } from './state.js';
import { TileArtStore } from './tileart.js';
import { matchScore, searchGuide } from './search.js';
import { activityOf, HassBridge, slug } from './hassbridge.js';
import { buildMorning } from './morning.js';
import { hardExit } from './exit.js';
import { VoiceService } from './voice.js';

const config = loadConfig();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
installElevation(app);
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
  error: (m: string) => app.log.error(m),
};

const bus = new EventBus();
const state = new StateStore(config.stateDir);
const launcher = new Launcher(config, bus, log);
// Sample data only when previewing without a config file; otherwise unset sections are just empty.
const plexLive = !config.livetv.tvheadend && config.livetv.plex && config.plex ? new PlexLiveTvProvider(config.plex, `http://127.0.0.1:${config.server.port}`) : null;
const tv: LiveTvProvider = config.livetv.tvheadend
  ? new TvheadendProvider(config.livetv.tvheadend)
  : plexLive
    ? plexLive
  : config.demo
    ? new DemoTvProvider()
    : new NoTvProvider();
const games = new GameService(config.gaming, launcher, bus, state, join(config.stateDir, 'games-cache.json'));
games.allowDemo = config.demo;
games.uiBase = `http://127.0.0.1:${config.server.port}`;
games.log = (m) => log.info(m);
const lab = new LabMonitor(config.lab);
const ha = config.homeassistant ? new HomeAssistant(config.homeassistant, bus, log, config.lab.sensors) : undefined;
const demoHome = ha || !config.demo ? undefined : new DemoHome(bus);

const hotkeys = new HotkeyWatcher(
  config.homeKeys,
  () => {
    void games.stopCovered();
    bus.emit({ type: 'home' });
  },
  log,
);

let channelCache: { at: number; channels: Channel[] } | null = null;
/** Names given to channels in the network editor (channel id → name). */
const channelNamesFile = join(config.stateDir, 'channel-names.json');
let channelNames: Record<string, string> = {};
try {
  channelNames = JSON.parse(readFileSync(channelNamesFile, 'utf8'));
} catch {
  /* none yet */
}

async function channels(): Promise<Channel[]> {
  if (channelCache && Date.now() - channelCache.at < 5 * 60_000) return channelCache.channels;
  const list = (await tv.channels()).map((c) => (channelNames[c.id] ? { ...c, name: channelNames[c.id] } : c));
  channelCache = { at: Date.now(), channels: list };
  return channelCache.channels;
}

const profiles = new ProfileStore(config.stateDir);
/** The channels the profile on screen hasn't hidden. */
async function visibleChannels(): Promise<Channel[]> {
  const hidden = new Set(profiles.active.hiddenChannels ?? []);
  const all = await channels();
  return hidden.size ? all.filter((c) => !hidden.has(c.id)) : all;
}
const tileArt = new TileArtStore(join(config.stateDir, 'tiles'));
const screenTime = new ScreenTime(config.stateDir);
const plex = config.plex ? new PlexClient(config.plex) : undefined;
/** The media server Home, Search and "ready to watch" use: Plex if linked, else Jellyfin/Emby. */
const library: MediaLibrary | undefined = plex ?? (config.mediaServer ? new JellyfinClient(config.mediaServer) : undefined);
const pairing = new RemotePairing(state);

/** Call a Home Assistant service ("scene.turn_on") — or the demo home when HA isn't set up. */
async function callService(service: string, data: Record<string, unknown> = {}): Promise<void> {
  const [domain, name] = service.split('.');
  if (ha) await ha.callService(domain, name, data);
  else demoHome?.callService(domain, name, data);
}

const scenes = new SceneAutomation(config.scenes, (c) => callService(c.service, c.data), () => state.settings.scenes, log);
launcher.onSession((event, s) => scenes.handle(event, s));

// Controllers type arrow/Enter/Esc keys into keyboard-only apps (Plex HTPC, YouTube TV…).
const padKeyWarn = (err: unknown) => log.warn(`controller keys: ${(err as Error).message}`);
const padKeys = new ControllerKeys(
  (code) => {
    launcher.run(expand(config.remote.keyCommand, { code, key: KEY_NAMES[code] ?? '' })).catch(padKeyWarn);
  },
  log,
  // Pointer mode for websites made for a mouse (Prime Video…): stick moves the pointer, A clicks.
  {
    move: (dx, dy) => void launcher.run(expand(config.remote.pointerMoveCommand, { dx, dy })).catch(padKeyWarn),
    click: () => void launcher.run(config.remote.clickCommand).catch(padKeyWarn),
  },
);
launcher.onSession((event, s) => {
  const tile = event === 'start' ? config.apps.find((a) => `app:${a.id}` === s.id) : undefined;
  if (tile && wantsControllerKeys(tile)) padKeys.start(wantsPointer(tile));
  else padKeys.stop();
});

const alerts = new AlertService(config.alerts, (alert: Alert) => {
  bus.emit({ type: 'alert', alert });
  // Over Plex, a game or Live TV the shell isn't visible, so pop a window above it.
  if (launcher.session && state.settings.alertsOverApps) {
    launcher.showOverlay(`http://127.0.0.1:${config.server.port}/alert?id=${alert.id}`, alert.seconds);
  }
});
ha?.onStateChange((e, old) => alerts.onState(e, old));
lab.onChange = (svc) => alerts.onLabChange(svc.name, Boolean(svc.up));

/** Kid profiles: refuse to start anything once today's time is used up, or at bedtime. */
function assertCanStart(): void {
  const st = screenTime.status(profiles.active);
  if (st.blocked === 'limit') throw new PermissionError('Screen time is used up for today');
  if (st.blocked === 'bedtime') throw new PermissionError('It’s bedtime. See you in the morning!');
}

// Count screen time while something is playing; stop it when time runs out.
let lastTick = Date.now();
let warned = '';
setInterval(() => {
  const now = Date.now();
  const p = profiles.active;
  if (launcher.session && p.kind === 'kid') {
    screenTime.addUsage(p.id, (now - lastTick) / 60_000);
    const st = screenTime.status(p);
    if (st.blocked) {
      void launcher.stop();
      bus.emit({ type: 'timesup', reason: st.blocked });
    } else if (st.remainingMinutes !== null && st.remainingMinutes <= 5 && warned !== `${p.id}:${new Date().toDateString()}`) {
      warned = `${p.id}:${new Date().toDateString()}`;
      alerts.raise({ kind: 'warning', title: `${st.remainingMinutes} minutes left`, message: 'Time to find a good place to stop.', seconds: 10 });
    }
    bus.emit({ type: 'screentime' });
  }
  lastTick = now;
}, 30_000);

/** Apps from config, web apps added from the TV, and other HDMI inputs (switched over CEC). */
function allApps(): AppTile[] {
  return [
    ...config.apps,
    ...profiles.customApps.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      launch: c.flatpak ? { type: 'command' as const, command: ['flatpak', 'run', c.flatpak] } : { type: 'web' as const, url: c.url ?? 'about:blank' },
    })),
    ...config.tv.inputs.map((i) => ({
      id: `input-${i.id}`,
      name: i.name,
      color: i.color ?? '#30343f',
      launch: { type: 'command' as const, command: expand(config.tv.commands.input, { addr: i.physAddr }) },
    })),
  ];
}

/** What the active profile may see, in its order. */
const visibleApps = () => ProfileStore.orderApps(profiles.active, allApps());
const visibleGames = async (force = false) => {
  const p = profiles.active;
  return (await games.games(force)).filter((g) => ProfileStore.allowsGame(p, g.hostId, g.id));
};
// The network editor acts as a parent whatever profile is on screen.
const isKid = () => !isElevated() && profiles.active.kind === 'kid';
const bootId = Date.now().toString(36);

const catalog = async (): Promise<IntentCatalog> => ({
  apps: visibleApps().map((a) => ({ id: a.id, name: a.name })),
  games: await visibleGames().catch(() => []),
  channels: profiles.active.liveTv ? await visibleChannels().catch(() => []) : [],
  inputs: visibleApps()
    .filter((a) => a.id.startsWith('input-'))
    .map((a) => ({ id: a.id, name: a.name })),
  cameras: ha ? ha.cameras() : (demoHome?.cameras() ?? []),
  doorbellCamera: config.alerts.doorbell?.camera,
});
const requests = new RequestsClient(config.requests);

const sleep = new SleepTimer({
  warn: () =>
    alerts.raise({
      kind: 'info',
      title: 'Going to sleep in a minute',
      message: 'The sleep timer is nearly up.',
      seconds: 55,
      action: { label: 'Keep watching (+30 min)', kind: 'sleep-extend', minutes: 30 },
    }),
  sleep: async () => {
    log.info('sleep timer: closing the app, switching the TV off and sleeping');
    await launcher.stop().catch(() => undefined);
    await launcher.run(config.tv.commands.off).catch(() => undefined);
    await launcher.run(config.system.suspend).catch((err) => log.warn(`sleep timer: ${(err as Error).message}`));
  },
  changed: (endsAt) => bus.emit({ type: 'sleep', endsAt }),
});

/** Camera in a corner over Hearth; over Plex, a game or Live TV it has to take the whole screen. */
const showCamera = (entity: string | null, name?: string) => {
  if (entity && launcher.session) {
    const q = new URLSearchParams({ entity, ...(name ? { name } : {}) });
    launcher.showOverlay(`http://127.0.0.1:${config.server.port}/camera?${q}`, 90);
    return;
  }
  if (!entity) launcher.closeOverlay();
  bus.emit({ type: 'pip', entity, name });
};

/** Voice commands the server answers itself (Seerr lookups, downloads, sleep timer, cameras). */
async function resolveVoice(action: UiAction): Promise<{ action?: UiAction; speech: string } | null> {
  switch (action.type) {
    case 'request-search': {
      if (isKid()) return { speech: 'Ask a parent to request that.' };
      if (!requests.hasSeerr) return { speech: 'Requests need Seerr. Add it under requests in the config.' };
      const results = await requests.search(action.query).catch(() => []);
      const top = [...results].sort((a, b) => score(action.query, b.title) - score(action.query, a.title))[0];
      if (!top) return { speech: `I couldn't find ${action.query}.` };
      const name = `${top.title}${top.year ? ` (${top.year})` : ''}`;
      const ref = { id: top.id, mediaType: top.mediaType, title: top.title, year: top.year };
      if (top.status === 'available') return { action: { type: 'request-open', media: ref }, speech: `${name} is already in your library.` };
      if (top.status !== 'none') return { action: { type: 'request-open', media: ref }, speech: `${name} has already been requested.` };
      return { action: { type: 'request-open', media: ref }, speech: `Found ${name}. Press OK to request it.` };
    }
    case 'downloads': {
      if (!requests.hasDownloads) return { speech: 'Add Radarr or Sonarr to the config to see downloads.' };
      const { items } = await requests.downloads();
      if (!items.length) return { action: { type: 'navigate', page: 'requests' }, speech: 'Nothing is downloading right now.' };
      const top = items
        .slice(0, 3)
        .map((d) => `${d.title} is ${Math.round(d.progress * 100)} percent done`)
        .join(', ');
      const more = items.length > 3 ? `, and ${items.length - 3} more` : '';
      return { action: { type: 'navigate', page: 'requests' }, speech: `${items.length} downloading. ${top}${more}.` };
    }
    case 'sleep-timer': {
      if (action.minutes === -1) {
        const left = sleep.remainingMinutes;
        return { speech: left === null ? 'There’s no sleep timer.' : `The TV goes to sleep in ${sayMinutes(left)}.` };
      }
      sleep.set(action.minutes);
      return { speech: action.minutes ? `OK, the TV will go to sleep in ${sayMinutes(action.minutes)}.` : 'Sleep timer cancelled.' };
    }
    case 'camera': {
      if (isKid()) return { speech: 'Ask a parent to show the cameras.' };
      showCamera(action.entity, action.name);
      return { speech: action.entity ? `Showing ${action.name ?? 'the camera'}.` : 'Camera hidden.' };
    }
    case 'pin-focused':
      return { action, speech: '' };
    default:
      return null;
  }
}

// Kid profiles get TV commands only, never Home Assistant.
const voice = new VoiceService(ha, catalog, () => !isKid(), resolveVoice);

const fail = (err: unknown) => {
  const message = (err as Error).message;
  if (err instanceof PermissionError) return { ok: false, error: message, permission: true };
  bus.toast(message, 'error');
  return { ok: false, error: message };
};

await app.register(fastifyWebsocket);

// Only the TV itself (localhost) and paired phone remotes may use Hearth.
const PUBLIC_PATHS = [/^\/remote/, /^\/assets\//, /^\/api\/remote\/pair$/, /^\/favicon/, /^\/$/];
app.addHook('onRequest', async (req, reply) => {
  if (isLoopback(req.ip)) return;
  if (pairing.valid(cookieToken(req.headers.cookie))) return;
  const path = req.url.split('?')[0];
  if (PUBLIC_PATHS.some((re) => re.test(path))) return;
  return reply.code(401).send({ error: 'Pair this device first: open /remote and enter the code shown on the TV.' });
});

/* ---------------- shell ---------------- */

app.get('/api/info', async () => ({
  name: config.ui.name,
  bootId,
  admin: config.admin.enabled ? { port: config.admin.port, url: `http://${lanAddress() ?? 'this-tv'}:${config.admin.port}` } : null,
  clock24h: config.ui.clock24h,
  /** First-run setup is showing (TV and phone). */
  setupActive: setup.active(),
  /** Pages switched off in setup (top bar). */
  hide: config.ui.hide,
  demo: { tv: tv.demo, homeassistant: Boolean(demoHome), games: games.demo },
  setup: { tv: Boolean(config.livetv.tvheadend || plexLive) || tv.demo, homeassistant: Boolean(ha || demoHome), games: config.gaming.hosts.length > 0 || games.demo },
  session: launcher.session,
  configPath: resolveConfigPath(),
  features: {
    plex: Boolean(plex),
    mediaServer: config.mediaServer?.kind ?? null,
    /** Your media server for Home rows and search: which kind, and the app tile that plays from it. */
    library: library ? { kind: library.kind, appId: library.appId, name: library.name } : null,
    tvInputs: config.tv.inputs.length,
    wakeWordAvailable: Boolean(ha),
    labActions: config.lab.actions.length,
    requests: Boolean(config.requests.seerr),
    morning: ha && config.morning.enabled ? { start: config.morning.start, end: config.morning.end } : null,
    downloads: Boolean(config.requests.radarr || config.requests.sonarr || config.requests.lidarr),
    doorbellCamera: config.alerts.doorbell?.camera ?? (demoHome ? 'camera.front_porch' : null),
  },
  screensaver: config.screensaver,
  ignoredExamples: config.ignoredExamples,
}));

app.get('/ws', { websocket: true }, (socket) => {
  bus.add(socket);
  socket.send(JSON.stringify({ type: 'session', session: launcher.session }));
  if (ha) socket.send(JSON.stringify({ type: 'ha-connection', connected: ha.connected }));
});

app.post('/api/session/stop', async () => {
  await games.stopCovered();
  return { ok: true };
});

/* ---------------- apps ---------------- */

const publicApp = ({ id, name, color, logo, launch }: AppTile) => {
  const art = tileArt.get(id);
  return {
    id,
    name,
    color,
    logo,
    kind: launch.type,
    custom: id.startsWith('custom-'),
    art: art?.type === 'image' ? { type: 'image' as const, url: `/tiles/${art.file}` } : art,
  };
};

// ?all=1 lists every app (for the editors); otherwise the active profile's curated, ordered list.
app.get<{ Querystring: { all?: string } }>('/api/apps', async (req) => (req.query.all === '1' ? allApps() : visibleApps()).map(publicApp));

// Tile looks, set from the network editor (/api/admin/* is editor-only).
const tileReply = (fn: () => void) => {
  try {
    fn();
    bus.emit({ type: 'apps' });
    return { ok: true, apps: allApps().map(publicApp) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};
app.put<{ Params: { id: string }; Body: { design: unknown } }>('/api/admin/tiles/:id', async (req) =>
  tileReply(() => tileArt.setDesign(req.params.id, req.body?.design)),
);
app.post<{ Params: { id: string }; Body: { data: string } }>('/api/admin/tiles/:id/image', { bodyLimit: 12 * 1024 * 1024 }, async (req) =>
  tileReply(() => tileArt.setImage(req.params.id, String(req.body?.data ?? ''))),
);
app.delete<{ Params: { id: string } }>('/api/admin/tiles/:id', async (req) => tileReply(() => tileArt.reset(req.params.id)));
app.get<{ Params: { file: string } }>('/tiles/:file', async (req, reply) => {
  const f = tileArt.file(req.params.file);
  if (!f) return reply.code(404).send();
  const { readFileSync } = await import('node:fs');
  return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(f.type).send(readFileSync(f.path));
});

app.post<{ Params: { id: string } }>('/api/apps/:id/launch', async (req) => {
  const tile = visibleApps().find((a) => a.id === req.params.id);
  if (!tile) return fail(new Error(`Unknown app ${req.params.id}`));
  try {
    if (tile.id.startsWith('input-') && tile.launch.type === 'command') {
      // Switching the TV to another HDMI device: a one-shot CEC command, not a foreground app.
      await launcher.run(tile.launch.command);
      return { ok: true };
    }
    assertCanStart();
    await launcher.launch(`app:${tile.id}`, tile.name, tile.launch);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

/* ---------------- live tv ---------------- */

app.get<{ Querystring: { hours?: string } }>('/api/tv/guide', async (req) => {
  const hours = Math.min(Number(req.query.hours ?? 4), 24);
  const from = Date.now() - 60 * 60_000;
  const [chs, all] = await Promise.all([visibleChannels(), tv.guide(from, Date.now() + hours * 3600_000)]);
  const shown = new Set(chs.map((c) => c.id));
  return { demo: tv.demo, lastChannel: state.lastChannel, channels: chs, programmes: all.filter((p) => shown.has(p.channelId)) };
});

/* ---------------- morning screen ---------------- */

app.get('/api/morning', async () => {
  if (!ha || !config.morning.enabled) return { enabled: false };
  // The news button: a configured channel/app, else an "ABC News"-style channel if there is one.
  let news: { kind: 'channel'; id: string; name: string } | { kind: 'app'; id: string; name: string } | null = null;
  const want = config.morning.news;
  if (want?.app) {
    const a = visibleApps().find((x) => x.id === want.app);
    if (a) news = { kind: 'app', id: a.id, name: a.name };
  } else if (profiles.active.liveTv) {
    const chs = await visibleChannels().catch(() => [] as Channel[]);
    const n = want?.channel !== undefined ? Number.parseFloat(want.channel) : NaN;
    const c =
      (Number.isFinite(n) ? chs.find((x) => x.number === n) : undefined) ??
      (want?.channel ? chs.find((x) => matchScore(x.name, want.channel!) >= 3) : chs.find((x) => /\bnews\b/i.test(x.name) && !x.radio));
    if (c) news = { kind: 'channel', id: c.id, name: c.name };
  }
  const data = await buildMorning(ha, config.morning, config.homeassistant?.weather, news);
  if (data.errors.length) log.warn(`morning: ${data.errors.join('; ')}`);
  return { enabled: true, name: profiles.active.name, ...data };
});

/* ---------------- search everything ---------------- */

/** One search across the Plex library, the Live TV guide, Seerr, games and apps. Slow sources are skipped. */
app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q.length < 2) return { q, library: [], tv: [], requests: [], games: [], apps: [] };
  const within = <T>(p: Promise<T>, fallback: T, ms = 6000) =>
    Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  const kid = isKid();
  const libraryAllowed = Boolean(library) && visibleApps().some((a) => a.id === library!.appId);
  const [libraryHits, tvHits, requestHits, gameList] = await Promise.all([
    library && libraryAllowed ? within(library.search(q), []) : Promise.resolve([]),
    profiles.active.liveTv
      ? within(
          (async () => {
            const chs = await visibleChannels();
            const programmes = await tv.guide(Date.now(), Date.now() + 48 * 3600_000);
            const dupes = findDuplicates(chs, programmes);
            const marked = chs.map((c) => (dupes.has(c.id) ? { ...c, duplicateOf: dupes.get(c.id) } : c));
            return searchGuide(q, marked, programmes, Date.now());
          })(),
          [],
          8000,
        )
      : Promise.resolve([]),
    requests.hasSeerr && !kid ? within(requests.search(q), []) : Promise.resolve([]),
    within(visibleGames(), []),
  ]);
  const games = gameList
    .map((g) => ({ g, score: matchScore(g.title, q) }))
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.g);
  const apps = visibleApps()
    .filter((a) => matchScore(a.name, q))
    .map(publicApp);
  return {
    q,
    library: libraryHits,
    tv: tvHits.map((h) => ({ ...h.programme, channelName: h.channel.name, channelNumber: h.channel.number, hd: h.channel.hd, live: h.live })),
    requests: requestHits.filter((r) => r.status !== 'available').slice(0, 12),
    games,
    apps,
  };
});

// Every channel (for choosing which ones a profile sees), with which SD ones simulcast an HD one.
app.get('/api/tv/channels', async () => {
  const all = await channels().catch(() => [] as Channel[]);
  const programmes = await tv.guide(Date.now(), Date.now() + 6 * 3600_000).catch(() => []);
  const dupes = findDuplicates(all, programmes);
  return { channels: all.map((c) => (dupes.has(c.id) ? { ...c, duplicateOf: dupes.get(c.id) } : c)), names: channelNames };
});

// Rename channels (network editor). An empty name puts the original back.
app.put<{ Body: { names: Record<string, string> } }>('/api/admin/tv/channel-names', async (req) => {
  const next: Record<string, string> = {};
  for (const [id, name] of Object.entries(req.body?.names ?? {})) {
    const n = String(name ?? '').trim().slice(0, 40);
    if (n && id.length <= 120) next[id] = n;
  }
  channelNames = next;
  writeFileSync(channelNamesFile, JSON.stringify(next, null, 2));
  channelCache = null;
  return { ok: true };
});

app.post<{ Body: { channelId: string } }>('/api/tv/watch', async (req) => {
  try {
    if (!profiles.active.liveTv) throw new PermissionError('Live TV is off for this profile');
    assertCanStart();
    const chs = await visibleChannels();
    if (!chs.length) throw new Error('No channels to show. Choose some on the Live TV page.');
    const index = Math.max(0, chs.findIndex((c) => c.id === req.body.channelId));
    // A playlist of every channel lets CH+/CH- (PgUp/PgDn) zap inside mpv.
    const playlist = join(config.stateDir, 'channels.m3u');
    writeFileSync(
      playlist,
      '#EXTM3U\n' + chs.map((c) => `#EXTINF:-1,${c.number} ${c.name}\n${tv.streamUrl(c.id)}`).join('\n') + '\n',
    );
    state.setLastChannel(chs[index].id);
    await launcher.launch('livetv', `Live TV – ${chs[index].name}`, {
      type: 'command',
      command: [
        ...expand(config.livetv.player, { playlist, index }),
        ...(plexLive?.playerArgs() ?? []),
        // What the player saw (stream errors, key presses) for troubleshooting.
        ...(config.livetv.player[0] === 'mpv' ? [`--log-file=${join(config.stateDir, 'mpv-livetv.log')}`] : []),
      ],
    });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

// Plex Live TV: mpv's playlist points here; tune the channel on the Plex server, then hand over its stream.
app.get<{ Params: { id: string } }>('/api/tv/plex/stream/:id', async (req, reply) => {
  if (!plexLive || !isLoopback(req.ip)) return reply.code(404).send();
  try {
    state.setLastChannel(req.params.id);
    return reply.redirect(await plexLive.tune(req.params.id));
  } catch (err) {
    log.warn(`plex live tv: ${(err as Error).message}`);
    return reply.code(502).send();
  }
});

app.get('/api/tv/recordings', async () => ({ demo: tv.demo, recordings: await tv.recordings() }));

app.post<{ Body: { programmeId: string; series?: boolean } }>('/api/tv/record', async (req) => {
  try {
    if (req.body.series) await tv.recordSeries(req.body.programmeId);
    else await tv.record(req.body.programmeId);
    bus.toast(req.body.series ? 'Every episode will be recorded' : 'Recording scheduled');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

app.post<{ Params: { id: string } }>('/api/tv/recordings/:id/play', async (req) => {
  try {
    assertCanStart();
    await launcher.launch('recording', 'Recording', {
      type: 'command',
      command: expand(config.livetv.recordingPlayer, { url: tv.recordingUrl(req.params.id) }),
    });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

app.delete<{ Params: { id: string } }>('/api/tv/recordings/:id', async (req) => {
  try {
    await tv.deleteRecording(req.params.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

app.get<{ Querystring: { path: string } }>('/api/tv/icon', async (req, reply) => {
  if (!tv.fetchIcon) return reply.code(404).send();
  const res = await tv.fetchIcon(req.query.path);
  reply.header('Cache-Control', 'public, max-age=86400').type(res.headers.get('content-type') ?? 'image/png');
  return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
});

/* ---------------- games ---------------- */

app.get<{ Querystring: { refresh?: string; all?: string } }>('/api/games', async (req) => {
  const force = req.query.refresh === '1';
  const list = req.query.all === '1' ? await games.games(force) : await visibleGames(force);
  const p = profiles.active;
  const recent = state.recentGames.filter((r) => ProfileStore.allowsGame(p, r.hostId, r.gameId));
  return { demo: games.demo, hosts: await games.hosts(), games: list, recent };
});

// The TV interface reports its own crashes here, so they show up in journalctl.
app.post<{ Body: { message?: string; stack?: string; path?: string } }>('/api/client-error', async (req) => {
  const b = req.body ?? {};
  log.warn(`UI error on ${String(b.path ?? '?').slice(0, 60)}: ${String(b.message ?? '').slice(0, 500)}\n${String(b.stack ?? '').slice(0, 2000)}`);
  return { ok: true };
});

// Cheap to poll: which PCs are awake and whether someone is using them.
app.get('/api/games/hosts', async () => ({ hosts: await games.hosts() }));

app.post<{ Params: { hostId: string; gameId: string }; Body: { title?: string; art?: string; players?: number; force?: boolean } }>(
  '/api/games/:hostId/:gameId/launch',
  async (req) => {
    if (!ProfileStore.allowsGame(profiles.active, req.params.hostId, req.params.gameId)) {
      return fail(new PermissionError('That game isn’t on this profile'));
    }
    try {
      assertCanStart();
    } catch (err) {
      bus.emit({ type: 'game-status', hostId: req.params.hostId, gameId: req.params.gameId, stage: 'error', message: (err as Error).message });
      return fail(err);
    }
    // Someone's at the PC (or streaming from it elsewhere): don't take over their screen unless asked to.
    if (!req.body?.force) {
      const busy = await games.busy(req.params.hostId).catch(() => null);
      if (busy) return { ok: false, busy: busy.reason, idleSeconds: busy.idleSeconds };
    }
    // Launch runs in the background; progress is pushed as game-status events.
    games.launch(req.params.hostId, req.params.gameId, req.body ?? {}).catch((err) => log.warn(`game launch: ${err.message}`));
    return { ok: true };
  },
);

app.get<{ Params: { hostId: string; gameId: string } }>('/api/games/:hostId/art/:gameId', async (req, reply) => {
  try {
    const res = await games.art(req.params.hostId, req.params.gameId);
    // A day, so a cover changed in Playnite/LaunchBox shows up on the TV by tomorrow at the latest.
    reply.header('Cache-Control', 'public, max-age=86400').type(res.headers.get('content-type') ?? 'image/jpeg');
    return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
  } catch {
    return reply.code(404).send();
  }
});

/* ---------------- home assistant ---------------- */

function entities(ids: string[]): HaEntity[] {
  // Leave out entities Home Assistant doesn't have, rather than showing "unavailable" cards.
  return ha ? ha.entities(ids.filter((id) => ha.known(id))) : (demoHome?.entities(ids) ?? []);
}

app.get('/api/ha/dashboard', async () => {
  const sections = ha?.cfg.dashboard ?? demoHome?.dashboard ?? [];
  return {
    demo: Boolean(demoHome),
    setup: Boolean(ha || demoHome),
    connected: ha ? ha.connected : Boolean(demoHome),
    hasLovelace: Boolean(ha?.cfg.lovelacePath),
    sections: sections.map((s) => ({
      title: s.title,
      entities: s.cards.flatMap((c) => {
        const id = typeof c === 'string' ? c : c.entity;
        const e = entities([id])[0];
        if (!e) return [];
        const name = typeof c === 'string' ? undefined : c.name;
        return [name ? { ...e, attributes: { ...e.attributes, friendly_name: name } } : e];
      }),
    })).filter((s) => s.entities.length > 0),
    favorites: entities(ha?.cfg.favorites ?? demoHome?.favorites ?? []),
    weather: (ha?.cfg.weather ?? demoHome?.weather) ? (entities([ha?.cfg.weather ?? demoHome!.weather])[0] ?? null) : null,
  };
});

app.post<{ Body: { domain: string; service: string; data: Record<string, unknown> } }>('/api/ha/service', async (req) => {
  const { domain, service, data } = req.body;
  try {
    if (isKid()) throw new PermissionError('Ask a parent to change that');
    if (ha) await ha.callService(domain, service, data);
    else if (demoHome) demoHome.callService(domain, service, data);
    else throw new Error('Home Assistant isn’t set up yet');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

app.get<{ Params: { entity: string } }>('/api/ha/camera/:entity', async (req, reply) => {
  if (!ha) return reply.code(404).send();
  const res = await ha.fetch(`/api/camera_proxy/${encodeURIComponent(req.params.entity)}`);
  reply.header('Cache-Control', 'no-store').type(res.headers.get('content-type') ?? 'image/jpeg');
  return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
});

// Album art for the now-playing strip, through Hearth so the HA token never reaches the browser.
app.get<{ Params: { entity: string } }>('/api/ha/media-art/:entity', async (req, reply) => {
  if (!ha || !/^media_player\.[a-z0-9_]+$/.test(req.params.entity)) return reply.code(404).send();
  const res = await ha.fetch(`/api/media_player_proxy/${encodeURIComponent(req.params.entity)}`);
  reply.header('Cache-Control', 'no-store').type(res.headers.get('content-type') ?? 'image/jpeg');
  return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
});

// Only TTS audio is proxied; the HA token never reaches the browser.
app.get<{ Querystring: { path: string } }>('/api/ha/proxy', async (req, reply) => {
  if (!ha || !req.query.path?.startsWith('/api/tts_proxy/')) return reply.code(404).send();
  const res = await ha.fetch(req.query.path);
  reply.type(res.headers.get('content-type') ?? 'audio/mpeg');
  return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
});

app.post('/api/ha/open-dashboard', async () => {
  if (!ha?.cfg.lovelacePath) return fail(new Error('No lovelacePath configured'));
  try {
    await launcher.launch('ha-dashboard', 'Home Assistant', { type: 'web', url: `${ha.cfg.url}${ha.cfg.lovelacePath}?kiosk` });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

/* ---------------- home lab ---------------- */

app.get('/api/lab', async () => ({
  demo: config.demo && config.lab.services.length === 0,
  services: config.lab.services.length ? lab.services : config.demo ? DEMO_SERVICES : [],
  sensors: entities(ha || config.lab.sensors.length ? config.lab.sensors : (demoHome?.labSensors ?? [])),
}));

app.post<{ Body: { index: number } }>('/api/lab/open', async (req) => {
  const svc = config.lab.services[req.body.index];
  if (!svc) return fail(new Error('Unknown service'));
  try {
    await launcher.launch(`lab:${svc.name}`, svc.name, { type: 'web', url: svc.url });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

const DEMO_SERVICES = [
  ['Proxmox', 'https://pve.lan:8006', 12],
  ['TrueNAS', 'https://nas.lan', 8],
  ['Plex Media Server', 'http://plex.lan:32400', 4],
  ['Home Assistant', 'http://homeassistant.local:8123', 6],
  ['Pi-hole', 'http://pihole.lan/admin', 3],
  ['Uptime Kuma', 'http://kuma.lan:3001', null],
].map(([name, url, latencyMs]) => ({ name, url, open: false, up: latencyMs !== null, latencyMs, checkedAt: Date.now() }));

/* ---------------- system ---------------- */

app.get('/api/system/input', async () => kbmStatus());

type SystemAction = keyof typeof config.system;
app.post<{ Params: { action: SystemAction } }>('/api/system/:action', async (req) => {
  const argv = config.system[req.params.action];
  if (!argv) return fail(new Error(`Unknown action ${req.params.action}`));
  try {
    if (isKid() && !['volumeUp', 'volumeDown', 'mute'].includes(req.params.action)) throw new PermissionError('Ask a parent to do that');
    await launcher.run(argv);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

/* ---------------- profiles & themes ---------------- */

const profilesView = () => ({
  activeId: profiles.active.id,
  profiles: profiles.all.map(ProfileStore.toPublic),
  customApps: profiles.customApps,
});

/** Run a profile mutation, broadcast the change, and report errors without throwing. */
async function mutate(fn: () => unknown) {
  try {
    fn();
    bus.emit({ type: 'profiles' });
    return { ok: true, ...profilesView() };
  } catch (err) {
    return fail(err);
  }
}

app.get('/api/profiles', async () => profilesView());
app.post<{ Body: { id: string; pin?: string } }>('/api/profiles/active', async (req) =>
  mutate(() => profiles.setActive(req.body.id, req.body.pin)),
);
app.post<{ Body: { name: string; kind: Profile['kind']; color?: string } }>('/api/profiles', async (req) =>
  mutate(() => profiles.create(req.body)),
);
app.put<{ Params: { id: string }; Body: Parameters<ProfileStore['update']>[1] }>('/api/profiles/:id', async (req) =>
  mutate(() => profiles.update(req.params.id, req.body)),
);
app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => mutate(() => profiles.remove(req.params.id)));
app.post<{ Body: { pin: unknown } }>('/api/pins', async (req) => mutate(() => profiles.togglePin(req.body.pin)));
app.post<{ Body: { key: string; delta: number } }>('/api/pins/move', async (req) => mutate(() => profiles.movePin(String(req.body.key), Number(req.body.delta))));
app.get<{ Querystring: { ids?: string } }>('/api/ha/entities', async (req) => (isKid() ? [] : entities((req.query.ids ?? '').split(',').filter(Boolean))));
/** Installed Flatpak programs that aren't app tiles yet, to add from the TV or phone. */
app.get('/api/apps/installed', async () => {
  const out = await new Promise<string>((resolve) =>
    execFile('flatpak', ['list', '--app', '--columns=application,name'], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout)),
  );
  const used = new Set(allApps().flatMap((a) => (a.launch.type === 'command' ? a.launch.command : [])));
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([id]) => id && /\./.test(id) && !used.has(id))
    .map(([id, name]) => ({ id, name: name?.trim() || id }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

app.post<{ Body: { name: string; url?: string; flatpak?: string; color?: string } }>('/api/custom-apps', async (req) =>
  mutate(() => profiles.addCustomApp(req.body)),
);
app.delete<{ Params: { id: string } }>('/api/custom-apps/:id', async (req) => mutate(() => profiles.removeCustomApp(req.params.id)));

registerExtras(app, {
  config, bus, state, launcher, games, profiles, screenTime, alerts, plex, library, pairing, ha, demoHome, lab, requests, sleep, showCamera,
  callService, fail, isKid,
});

/* ---------------- voice ---------------- */

app.post<{ Body: { text: string } }>('/api/voice/text', async (req) => voice.process(req.body.text));
app.get('/ws/voice', { websocket: true }, (socket) => voice.handle(socket));

/* ---------------- UI ---------------- */

registerAdminApi(app, { config, configPath: resolveConfigPath(), bus, log });
registerLabEdit(app, { config, configPath: resolveConfigPath(), bus, lab, ha, demoHome, log, fail, isKid });
const installer = new AppInstaller(config.stateDir, bus);

// Immich: keep its heavy jobs paused while something plays (or someone uses its machine-learning PC).
const immich = config.immich ? new ImmichClient(config.immich) : undefined;
const immichGovernor = immich
  ? new ImmichGovernor(immich, {
      log,
      pcBusy: config.immich?.mlHost && config.gaming.hosts.some((h) => h.id === config.immich!.mlHost)
        ? async () => (await games.busy(config.immich!.mlHost!).catch(() => null))?.reason ?? null
        : undefined,
    })
  : undefined;
if (immichGovernor) {
  launcher.onSession((event, s) => immichGovernor.session(event === 'start', s.title));
  immichGovernor.start();
}
app.get('/api/immich/status', async () => ({ linked: Boolean(immich), paused: immichGovernor?.isPaused ?? false, reason: immichGovernor?.reason ?? '' }));
const setup = registerSetup(app, { config, configPath: resolveConfigPath(), bus, installer, log, fail, isKid });

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

/* ---------------- Home Assistant ⇄ Hearth ---------------- */

const PAGES_FROM_HA = ['home', 'tv', 'apps', 'games', 'requests', 'smarthome', 'lab', 'settings', 'search', 'morning'];
const hassBridge = ha
  ? new HassBridge(
      ha,
      config.homeassistant?.tvId ?? slug(config.ui.name),
      config.ui.name,
      () => {
        const session = launcher.session;
        const channel = session?.id === 'livetv' ? channelCache?.channels.find((c) => c.id === state.lastChannel) : undefined;
        return {
          activity: activityOf(session, {
            channel: channel ? `${channel.number} ${channel.name}` : undefined,
            appName: (id) => allApps().find((a) => a.id === id)?.name,
          }),
          profile: { name: profiles.active.name, kind: profiles.active.kind },
          sleepEndsAt: sleep.ends,
        };
      },
      async (cmd) => {
        const inject = async (url: string, payload?: object) => {
          const res = await app.inject({ method: 'POST', url, payload: payload ?? {}, remoteAddress: '127.0.0.1' });
          const body = res.json() as { ok?: boolean; error?: string };
          if (body.ok === false) throw new Error(body.error ?? `${url} failed`);
        };
        switch (cmd.command) {
          case 'notify':
            alerts.raise({ kind: 'info', title: cmd.title, message: cmd.message, image: cmd.image, camera: cmd.camera, seconds: cmd.seconds });
            return;
          case 'camera':
            return showCamera(cmd.entity, cmd.name);
          case 'open_app': {
            const list = allApps();
            const hit =
              list.find((a) => a.id === cmd.app) ??
              list.map((a) => ({ a, s: matchScore(a.name, cmd.app) })).filter((x) => x.s).sort((x, y) => y.s - x.s)[0]?.a;
            if (!hit) throw new Error(`no app called ${cmd.app}`);
            return inject(`/api/apps/${encodeURIComponent(hit.id)}/launch`);
          }
          case 'channel': {
            const chs = await visibleChannels();
            const n = Number.parseFloat(cmd.channel);
            const hit =
              (Number.isFinite(n) ? chs.find((c) => c.number === n) : undefined) ??
              chs.map((c) => ({ c, s: matchScore(c.name, cmd.channel) })).filter((x) => x.s).sort((x, y) => y.s - x.s || Number(Boolean(y.c.hd)) - Number(Boolean(x.c.hd)))[0]?.c;
            if (!hit) throw new Error(`no channel ${cmd.channel}`);
            return inject('/api/tv/watch', { channelId: hit.id });
          }
          case 'home':
            await games.stopCovered();
            bus.emit({ type: 'home' });
            return;
          case 'stop':
            return games.stopCovered();
          case 'sleep_timer':
            sleep.set(cmd.minutes);
            return;
          case 'tv':
            return inject(`/api/tv-control/${cmd.on ? 'on' : 'off'}`);
          case 'page':
            if (!PAGES_FROM_HA.includes(cmd.page)) throw new Error(`no page ${cmd.page}`);
            if (launcher.session) await launcher.stop();
            bus.emit({ type: 'action', action: { type: 'navigate', page: cmd.page } });
            return;
          case 'search':
            if (launcher.session) await launcher.stop();
            bus.emit({ type: 'action', action: { type: 'search', query: cmd.query } });
            return;
          case 'morning':
            if (launcher.session) await launcher.stop();
            bus.emit({ type: 'action', action: { type: 'navigate', page: 'morning' } });
            return;
        }
      },
      log,
    )
  : undefined;
if (hassBridge) {
  launcher.onSession(() => hassBridge.publishSoon());
  bus.observe((e) => {
    if (e.type === 'profiles' || e.type === 'sleep' || e.type === 'session') hassBridge.publishSoon();
  });
  log.info(`Home Assistant: publishing sensor.hearth_${hassBridge.tvId}_* and listening for hearth_command events`);
}

ha?.start();
lab.start();
hotkeys.start();

await app.listen({ port: config.server.port, host: config.server.host });
if (config.ignoredExamples.length) log.info(`Skipped untouched example entries from config.yaml: ${config.ignoredExamples.join(', ')}`);
await startAdminServer(app, { config, configPath: resolveConfigPath(), bus, log }, webDist).catch((err) =>
  log.warn(`network editor: ${(err as Error).message}`),
);
log.info(`Hearth ready on http://${config.server.host}:${config.server.port}${config.demo ? ' (demo mode)' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // Never let a stuck clean-up keep the TV waiting on a restart.
    setTimeout(hardExit, 5000).unref();
    hotkeys.stop();
    lab.stop();
    launcher.closeOverlay();
    await launcher.stop();
    await app.close().catch(() => undefined);
    hardExit();
  });
}
