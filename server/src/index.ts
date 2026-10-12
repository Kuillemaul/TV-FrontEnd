import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './bus.js';
import { expand, loadConfig, resolveConfigPath, type AppTile } from './config.js';
import { HotkeyWatcher, kbmStatus } from './input.js';
import type { IntentCatalog } from './intents.js';
import { Launcher } from './launcher.js';
import { DemoHome } from './providers/demohome.js';
import { GameService } from './providers/games.js';
import { HomeAssistant, type HaEntity } from './providers/homeassistant.js';
import { LabMonitor } from './providers/lab.js';
import { DemoTvProvider, TvheadendProvider, type Channel, type LiveTvProvider } from './providers/livetv.js';
import { PermissionError, ProfileStore, type Profile } from './profiles.js';
import { StateStore } from './state.js';
import { VoiceService } from './voice.js';

const config = loadConfig();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
  error: (m: string) => app.log.error(m),
};

const bus = new EventBus();
const state = new StateStore(config.stateDir);
const launcher = new Launcher(config, bus, log);
const tv: LiveTvProvider = config.livetv.tvheadend ? new TvheadendProvider(config.livetv.tvheadend) : new DemoTvProvider();
const games = new GameService(config.gaming, launcher, bus, state);
const lab = new LabMonitor(config.lab);
const ha = config.homeassistant ? new HomeAssistant(config.homeassistant, bus, log, config.lab.sensors) : undefined;
const demoHome = ha ? undefined : new DemoHome(bus);

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

/** Apps from config plus web apps added from the TV. */
function allApps(): AppTile[] {
  return [
    ...config.apps,
    ...profiles.customApps.map((c) => ({ id: c.id, name: c.name, color: c.color, launch: { type: 'web' as const, url: c.url } })),
  ];
}

/** What the active profile may see, in its order. */
const visibleApps = () => ProfileStore.orderApps(profiles.active, allApps());
const visibleGames = async (force = false) => {
  const p = profiles.active;
  return (await games.games(force)).filter((g) => ProfileStore.allowsGame(p, g.hostId, g.id));
};
const isKid = () => profiles.active.kind === 'kid';

const catalog = async (): Promise<IntentCatalog> => ({
  apps: visibleApps().map((a) => ({ id: a.id, name: a.name })),
  games: await visibleGames().catch(() => []),
  channels: profiles.active.liveTv ? await channels().catch(() => []) : [],
});
// Kid profiles get TV commands only, never Home Assistant.
const voice = new VoiceService(ha, catalog, () => !isKid());

const fail = (err: unknown) => {
  const message = (err as Error).message;
  if (err instanceof PermissionError) return { ok: false, error: message, permission: true };
  bus.toast(message, 'error');
  return { ok: false, error: message };
};

await app.register(fastifyWebsocket);

/* ---------------- shell ---------------- */

app.get('/api/info', async () => ({
  name: config.ui.name,
  clock24h: config.ui.clock24h,
  demo: { tv: tv.demo, homeassistant: !ha, games: games.demo },
  session: launcher.session,
  configPath: resolveConfigPath(),
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

app.post<{ Body: { programmeId: string } }>('/api/tv/record', async (req) => {
  try {
    await tv.record(req.body.programmeId);
    bus.toast('Recording scheduled');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
});

app.post<{ Params: { id: string } }>('/api/tv/recordings/:id/play', async (req) => {
  try {
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

app.post<{ Params: { hostId: string; gameId: string } }>('/api/games/:hostId/:gameId/launch', async (req) => {
  if (!ProfileStore.allowsGame(profiles.active, req.params.hostId, req.params.gameId)) {
    return fail(new PermissionError('That game isn’t on this profile'));
  }
  // Launch runs in the background; progress is pushed as game-status events.
  games.launch(req.params.hostId, req.params.gameId).catch((err) => log.warn(`game launch: ${err.message}`));
  return { ok: true };
});

app.get<{ Params: { hostId: string; gameId: string } }>('/api/games/:hostId/art/:gameId', async (req, reply) => {
  try {
    const res = await games.art(req.params.hostId, req.params.gameId);
    reply.header('Cache-Control', 'public, max-age=604800').type(res.headers.get('content-type') ?? 'image/jpeg');
    return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
  } catch {
    return reply.code(404).send();
  }
});

/* ---------------- home assistant ---------------- */

function entities(ids: string[]): HaEntity[] {
  return ha ? ha.entities(ids) : demoHome!.entities(ids);
}

app.get('/api/ha/dashboard', async () => {
  const sections = ha?.cfg.dashboard ?? demoHome!.dashboard;
  return {
    demo: !ha,
    connected: ha ? ha.connected : true,
    hasLovelace: Boolean(ha?.cfg.lovelacePath),
    sections: sections.map((s) => ({
      title: s.title,
      entities: s.cards.map((c) => {
        const id = typeof c === 'string' ? c : c.entity;
        const e = entities([id])[0];
        const name = typeof c === 'string' ? undefined : c.name;
        return name ? { ...e, attributes: { ...e.attributes, friendly_name: name } } : e;
      }),
    })),
    favorites: entities(ha?.cfg.favorites ?? demoHome!.favorites),
    weather: (ha?.cfg.weather ?? demoHome?.weather) ? entities([ha?.cfg.weather ?? demoHome!.weather])[0] : null,
  };
});

app.post<{ Body: { domain: string; service: string; data: Record<string, unknown> } }>('/api/ha/service', async (req) => {
  const { domain, service, data } = req.body;
  try {
    if (isKid()) throw new PermissionError('Ask a parent to change that');
    if (ha) await ha.callService(domain, service, data);
    else demoHome!.callService(domain, service, data);
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
  demo: config.lab.services.length === 0,
  services: config.lab.services.length ? lab.services : DEMO_SERVICES,
  sensors: entities(ha ? config.lab.sensors : demoHome!.labSensors),
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
app.post<{ Body: { name: string; url: string; color?: string } }>('/api/custom-apps', async (req) =>
  mutate(() => profiles.addCustomApp(req.body)),
);
app.delete<{ Params: { id: string } }>('/api/custom-apps/:id', async (req) => mutate(() => profiles.removeCustomApp(req.params.id)));

/* ---------------- voice ---------------- */

app.post<{ Body: { text: string } }>('/api/voice/text', async (req) => voice.process(req.body.text));
app.get('/ws/voice', { websocket: true }, (socket) => voice.handle(socket));

/* ---------------- UI ---------------- */

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
log.info(`Hearth ready on http://${config.server.host}:${config.server.port}${config.demo ? ' (demo mode)' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    hotkeys.stop();
    lab.stop();
    await launcher.stop();
    await app.close();
    process.exit(0);
  });
}
