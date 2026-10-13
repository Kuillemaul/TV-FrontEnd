import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './bus.js';
import { expand, loadConfig, resolveConfigPath, type AppTile } from './config.js';
import { HotkeyWatcher, kbmStatus } from './input.js';
import { ControllerKeys, KEY_NAMES, wantsControllerKeys } from './padkeys.js';
import type { IntentCatalog, UiAction } from './intents.js';
import { Launcher } from './launcher.js';
import { DemoHome } from './providers/demohome.js';
import { GameService } from './providers/games.js';
import { HomeAssistant, type HaEntity } from './providers/homeassistant.js';
import { LabMonitor } from './providers/lab.js';
import { DemoTvProvider, NoTvProvider, TvheadendProvider, type Channel, type LiveTvProvider } from './providers/livetv.js';
import { PermissionError, ProfileStore, type Profile } from './profiles.js';
import { AlertService, type Alert } from './alerts.js';
import { SceneAutomation } from './automations.js';
import { PlexClient } from './providers/plex.js';
import { cookieToken, isLoopback, lanAddress, RemotePairing } from './remote.js';
import { registerExtras } from './routes/extras.js';
import { RequestsClient } from './providers/seerr.js';
import { SleepTimer, sayMinutes } from './sleep.js';
import { score } from './intents.js';
import { registerAdminApi, startAdminServer } from './routes/admin.js';
import { installElevation, isElevated } from './elevate.js';
import { ScreenTime } from './screentime.js';
import { StateStore } from './state.js';
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
const tv: LiveTvProvider = config.livetv.tvheadend
  ? new TvheadendProvider(config.livetv.tvheadend)
  : config.demo
    ? new DemoTvProvider()
    : new NoTvProvider();
const games = new GameService(config.gaming, launcher, bus, state, join(config.stateDir, 'games-cache.json'));
games.allowDemo = config.demo;
games.uiBase = `http://127.0.0.1:${config.server.port}`;
const lab = new LabMonitor(config.lab);
const ha = config.homeassistant ? new HomeAssistant(config.homeassistant, bus, log, config.lab.sensors) : undefined;
const demoHome = ha || !config.demo ? undefined : new DemoHome(bus);

const hotkeys = new HotkeyWatcher(
  config.homeKeys,
  () => {
    void launcher.stop();
    bus.emit({ type: 'home' });
  },
  log,
);

let channelCache: { at: number; channels: Channel[] } | null = null;
async function channels(): Promise<Channel[]> {
  if (channelCache && Date.now() - channelCache.at < 5 * 60_000) return channelCache.channels;
  channelCache = { at: Date.now(), channels: await tv.channels() };
  return channelCache.channels;
}

const profiles = new ProfileStore(config.stateDir);
const screenTime = new ScreenTime(config.stateDir);
const plex = config.plex ? new PlexClient(config.plex) : undefined;
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
const padKeys = new ControllerKeys((code) => {
  launcher.run(expand(config.remote.keyCommand, { code, key: KEY_NAMES[code] ?? '' })).catch((err) => log.warn(`controller keys: ${(err as Error).message}`));
}, log);
launcher.onSession((event, s) => {
  const tile = event === 'start' ? config.apps.find((a) => `app:${a.id}` === s.id) : undefined;
  if (tile && wantsControllerKeys(tile)) padKeys.start();
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
    ...profiles.customApps.map((c) => ({ id: c.id, name: c.name, color: c.color, launch: { type: 'web' as const, url: c.url } })),
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
  channels: profiles.active.liveTv ? await channels().catch(() => []) : [],
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
  demo: { tv: tv.demo, homeassistant: Boolean(demoHome), games: games.demo },
  setup: { tv: Boolean(config.livetv.tvheadend) || tv.demo, homeassistant: Boolean(ha || demoHome), games: config.gaming.hosts.length > 0 || games.demo },
  session: launcher.session,
  configPath: resolveConfigPath(),
  features: {
    plex: Boolean(plex),
    tvInputs: config.tv.inputs.length,
    wakeWordAvailable: Boolean(ha),
    labActions: config.lab.actions.length,
    requests: Boolean(config.requests.seerr),
    downloads: Boolean(config.requests.radarr || config.requests.sonarr || config.requests.lidarr),
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
  await launcher.stop();
  return { ok: true };
});

/* ---------------- apps ---------------- */

const publicApp = ({ id, name, color, logo, launch }: AppTile) => ({ id, name, color, logo, kind: launch.type, custom: id.startsWith('custom-') });

// ?all=1 lists every app (for the editors); otherwise the active profile's curated, ordered list.
app.get<{ Querystring: { all?: string } }>('/api/apps', async (req) => (req.query.all === '1' ? allApps() : visibleApps()).map(publicApp));

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
  const [chs, programmes] = await Promise.all([channels(), tv.guide(from, Date.now() + hours * 3600_000)]);
  return { demo: tv.demo, lastChannel: state.lastChannel, channels: chs, programmes };
});

app.post<{ Body: { channelId: string } }>('/api/tv/watch', async (req) => {
  try {
    if (!profiles.active.liveTv) throw new PermissionError('Live TV is off for this profile');
    assertCanStart();
    const chs = await channels();
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
      command: expand(config.livetv.player, { playlist, index }),
    });
    return { ok: true };
  } catch (err) {
    return fail(err);
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

app.post<{ Params: { hostId: string; gameId: string }; Body: { title?: string; art?: string; players?: number } }>(
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
  sensors: entities(ha ? config.lab.sensors : (demoHome?.labSensors ?? [])),
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
app.post<{ Body: { name: string; url: string; color?: string } }>('/api/custom-apps', async (req) =>
  mutate(() => profiles.addCustomApp(req.body)),
);
app.delete<{ Params: { id: string } }>('/api/custom-apps/:id', async (req) => mutate(() => profiles.removeCustomApp(req.params.id)));

registerExtras(app, {
  config, bus, state, launcher, games, profiles, screenTime, alerts, plex, pairing, ha, demoHome, lab, requests, sleep, showCamera,
  callService, fail, isKid,
});

/* ---------------- voice ---------------- */

app.post<{ Body: { text: string } }>('/api/voice/text', async (req) => voice.process(req.body.text));
app.get('/ws/voice', { websocket: true }, (socket) => voice.handle(socket));

/* ---------------- UI ---------------- */

registerAdminApi(app, { config, configPath: resolveConfigPath(), bus, log });

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
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
    hotkeys.stop();
    lab.stop();
    launcher.closeOverlay();
    await launcher.stop();
    await app.close();
    process.exit(0);
  });
}
