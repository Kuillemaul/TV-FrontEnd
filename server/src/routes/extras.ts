import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AlertService } from '../alerts.js';
import { AudioControl } from '../audio.js';
import { BluetoothControl } from '../bluetooth.js';
import { WifiControl } from '../wifi.js';
import { CameraStreams } from '../camerastreams.js';
import { DisplayControl } from '../display.js';
import type { RequestsClient } from '../providers/seerr.js';
import type { SleepTimer } from '../sleep.js';
import { ArrWatcher } from '../providers/arrwatch.js';
import type { EventBus } from '../bus.js';
import { expand, type HearthConfig, type LabAction } from '../config.js';
import type { Launcher } from '../launcher.js';
import { PermissionError, ProfileStore } from '../profiles.js';
import type { DemoHome } from '../providers/demohome.js';
import type { GameService, PowerAction } from '../providers/games.js';
import type { HomeAssistant } from '../providers/homeassistant.js';
import { DEMO_ON_DECK, type PlexClient } from '../providers/plex.js';
import type { LabMonitor } from '../providers/lab.js';
import { isLoopback, lanAddress, REMOTE_KEYS, type RemoteCommand, type RemotePairing } from '../remote.js';
import type { ScreenTime } from '../screentime.js';
import type { StateStore } from '../state.js';

export interface ExtrasContext {
  config: HearthConfig;
  bus: EventBus;
  state: StateStore;
  launcher: Launcher;
  games: GameService;
  profiles: ProfileStore;
  screenTime: ScreenTime;
  alerts: AlertService;
  plex?: PlexClient;
  pairing: RemotePairing;
  ha?: HomeAssistant;
  demoHome?: DemoHome;
  lab: LabMonitor;
  requests: RequestsClient;
  sleep: SleepTimer;
  /** Camera picture-in-picture (or full screen over an app); null hides it. */
  showCamera: (entity: string | null, name?: string) => void;
  callService: (service: string, data?: Record<string, unknown>) => Promise<void>;
  fail: (err: unknown) => { ok: boolean; error: string };
  isKid: () => boolean;
}

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Routes for screen time, settings, alerts, TV control, Plex, lab history/actions,
 * game browsing/details/power, the screensaver and the phone remote.
 */
export function registerExtras(app: FastifyInstance, ctx: ExtrasContext): void {
  const { config, bus, state, launcher, games, profiles, screenTime, alerts, plex, pairing, ha, fail, isKid } = ctx;

  const requireParent = () => {
    if (isKid()) throw new PermissionError('Ask a parent to do that');
  };
  const run = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const result = await fn();
      return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
    } catch (err) {
      return fail(err);
    }
  };
  const relay = async (reply: import('fastify').FastifyReply, res: Response, cache = 'no-store') => {
    reply.header('Cache-Control', cache).type(res.headers.get('content-type') ?? 'application/octet-stream');
    return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
  };

  /* ---------------- screen time ---------------- */

  app.get('/api/screentime', async () => ({
    active: screenTime.status(profiles.active),
    profiles: profiles.all.filter((p) => p.kind === 'kid').map((p) => ({ ...screenTime.status(p), name: p.name, limits: p.limits ?? null })),
  }));

  // From a parent profile, or on the kid's "time's up" screen with a parent's PIN (never without one).
  app.post<{ Params: { id: string }; Body: { minutes: number; parentId?: string; pin?: string } }>('/api/screentime/:id/bonus', async (req) =>
    run(() => {
      if (isKid()) {
        const parent = profiles.all.find((p) => p.id === req.body.parentId && p.kind === 'admin');
        if (!parent?.pinHash || !profiles.checkPin(parent.id, req.body.pin)) throw new PermissionError('Wrong PIN');
      }
      screenTime.addBonus(req.params.id, Math.max(0, Math.min(240, Number(req.body.minutes) || 0)));
      bus.emit({ type: 'screentime' });
    }),
  );

  /* ---------------- TV-wide settings ---------------- */

  app.get('/api/settings', async () => state.settings);
  app.put<{ Body: Partial<StateStore['settings']> }>('/api/settings', async (req) =>
    run(() => {
      requireParent();
      const allowed = ['scenes', 'wakeWord', 'alertsOverApps', 'autoUpdate'] as const;
      state.updateSettings(Object.fromEntries(allowed.filter((k) => k in req.body).map((k) => [k, Boolean(req.body[k])])));
      bus.emit({ type: 'settings' });
      return state.settings;
    }),
  );

  /* ---------------- sound output ---------------- */

  const audio = new AudioControl();
  app.get('/api/audio', async () => audio.status());
  app.post<{ Body: { outputId: string; channels: number } }>('/api/audio/output', async (req) =>
    run(async () => {
      requireParent();
      const choice = { outputId: String(req.body.outputId), channels: Number(req.body.channels) || 2 };
      await audio.setOutput(choice.outputId, choice.channels);
      state.setAudioOutput(choice);
      return audio.status();
    }),
  );
  // The sound system can pick its own default after a reboot (e.g. 5.1 a TV can't play, so silence):
  // keep putting back what was chosen in Settings.
  const restoreAudio = () =>
    audio
      .restore(state.audioOutput)
      .then((changed) => changed && app.log.info(`sound: restored ${state.audioOutput!.outputId} (${state.audioOutput!.channels} ch)`))
      .catch((err) => app.log.warn(`sound restore: ${(err as Error).message}`));
  setTimeout(() => void restoreAudio(), 5000);
  setInterval(() => void restoreAudio(), 30_000).unref();
  app.post<{ Body: { percent: number } }>('/api/audio/volume', async (req) => run(() => audio.setVolume(Number(req.body.percent))));
  app.post<{ Body: { muted: boolean } }>('/api/audio/mute', async (req) => run(() => audio.setMute(Boolean(req.body.muted))));
  app.post<{ Body: { channel: number } }>('/api/audio/test', async (req) => run(() => audio.test(Number(req.body.channel))));

  /* ---------------- display: resolution & refresh rate ---------------- */

  const display = new DisplayControl(state, () => bus.emit({ type: 'display' }), app.log);
  // cage needs a moment after start before outputs can be reconfigured.
  setTimeout(() => void display.restore(), 4000);
  app.get('/api/display', async () => display.status());
  app.post<{ Body: { output: string; width: number; height: number; refresh: number } }>('/api/display/mode', async (req) =>
    run(async () => {
      requireParent();
      const { output, width, height, refresh } = req.body;
      await display.set({ output: String(output), width: Number(width), height: Number(height), refresh: Number(refresh) });
      return display.status();
    }),
  );
  app.post('/api/display/keep', async () => run(() => display.keep()));
  app.post('/api/display/revert', async () => run(() => display.revert()));
  app.post<{ Body: { output: string } }>('/api/display/auto', async (req) =>
    run(async () => {
      requireParent();
      await display.auto(String(req.body.output));
    }),
  );

  /* ---------------- sleep timer & camera picture-in-picture ---------------- */

  app.get('/api/sleep', async () => ({ endsAt: sleep.ends }));
  app.post<{ Body: { minutes: number } }>('/api/sleep', async (req) =>
    run(() => {
      sleep.set(Math.max(0, Math.min(12 * 60, Number(req.body.minutes) || 0)));
      return { endsAt: sleep.ends };
    }),
  );
  app.post<{ Body: { entity: string | null; name?: string } }>('/api/pip', async (req) =>
    run(() => {
      if (isKid()) throw new PermissionError('Ask a parent to show the cameras');
      const entity = req.body.entity ? String(req.body.entity) : null;
      if (entity && !/^camera\.[a-z0-9_]+$/.test(entity)) throw new Error('Not a camera');
      showCamera(entity, req.body.name);
    }),
  );

  /* ---------------- Bluetooth ---------------- */

  const bt = new BluetoothControl();
  const validMac = (m: unknown) => {
    const mac = String(m ?? '').toUpperCase();
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) throw new Error('Not a Bluetooth address');
    return mac;
  };
  app.get('/api/bluetooth', async () => bt.status());
  app.post<{ Body: { on: boolean } }>('/api/bluetooth/power', async (req) =>
    run(async () => {
      requireParent();
      await bt.power(Boolean(req.body.on));
    }),
  );
  app.post<{ Body: { on: boolean } }>('/api/bluetooth/scan', async (req) => run(() => bt.scan(req.body.on !== false)));
  app.post<{ Body: { mac: string } }>('/api/bluetooth/pair', async (req) =>
    run(async () => {
      requireParent();
      await bt.pair(validMac(req.body.mac));
    }),
  );
  app.post<{ Body: { mac: string } }>('/api/bluetooth/connect', async (req) => run(() => bt.connect(validMac(req.body.mac))));
  app.post<{ Body: { mac: string } }>('/api/bluetooth/disconnect', async (req) => run(() => bt.disconnect(validMac(req.body.mac))));
  app.post<{ Body: { mac: string } }>('/api/bluetooth/forget', async (req) =>
    run(async () => {
      requireParent();
      await bt.forget(validMac(req.body.mac));
    }),
  );

  /* ---------------- Wi-Fi ---------------- */

  const wifi = new WifiControl();
  const ssidOf = (v: unknown) => {
    const ssid = String(v ?? '');
    if (!ssid || ssid.length > 32) throw new Error('Pick a network');
    return ssid;
  };
  app.get<{ Querystring: { rescan?: string } }>('/api/wifi', async (req) => wifi.status(req.query.rescan === '1'));
  app.post<{ Body: { on: boolean } }>('/api/wifi/radio', async (req) =>
    run(async () => {
      requireParent();
      await wifi.radio(Boolean(req.body.on));
    }),
  );
  app.post<{ Body: { ssid: string; password?: string } }>('/api/wifi/connect', async (req) =>
    run(async () => {
      requireParent();
      const pw = req.body.password ? String(req.body.password) : undefined;
      if (pw !== undefined && (pw.length < 8 || pw.length > 63)) throw new Error('Wi-Fi passwords are 8 to 63 characters');
      await wifi.connect(ssidOf(req.body.ssid), pw);
    }),
  );
  app.post('/api/wifi/disconnect', async () =>
    run(async () => {
      requireParent();
      await wifi.disconnect();
    }),
  );
  app.post<{ Body: { ssid: string } }>('/api/wifi/forget', async (req) =>
    run(async () => {
      requireParent();
      await wifi.forget(ssidOf(req.body.ssid));
    }),
  );

  /* ---------------- requests (Seerr) & downloads (Radarr / Sonarr / Lidarr) ---------------- */

  const { requests, sleep, showCamera } = ctx;
  const parentsOnly = () => {
    if (isKid()) throw new PermissionError('Requests are for parents');
  };
  app.get<{ Querystring: { q?: string } }>('/api/requests/search', async (req) =>
    run(async () => {
      parentsOnly();
      const q = (req.query.q ?? '').trim();
      return { results: q ? await requests.search(q) : [] };
    }),
  );
  app.get<{ Params: { kind: 'trending' | 'movies' | 'tv' | 'upcoming' } }>('/api/requests/discover/:kind', async (req) =>
    run(async () => {
      parentsOnly();
      if (!['trending', 'movies', 'tv', 'upcoming'].includes(req.params.kind)) throw new Error('Unknown list');
      return { results: await requests.discover(req.params.kind) };
    }),
  );
  app.get('/api/requests/recent', async () =>
    run(async () => {
      parentsOnly();
      return { results: await requests.recent() };
    }),
  );
  app.get<{ Params: { type: 'movie' | 'tv'; id: string } }>('/api/requests/media/:type/:id', async (req) =>
    run(async () => {
      parentsOnly();
      if (req.params.type !== 'movie' && req.params.type !== 'tv') throw new Error('Unknown type');
      return { media: await requests.details(req.params.type, Number(req.params.id)) };
    }),
  );
  app.post<{ Body: { mediaType: 'movie' | 'tv'; id: number } }>('/api/requests', async (req) =>
    run(async () => {
      requireParent();
      const { mediaType, id } = req.body;
      if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error('Unknown type');
      await requests.request(mediaType, Number(id));
      return { media: await requests.details(mediaType, Number(id)) };
    }),
  );
  // "Open in YouTube" for a trailer that can't play inside Hearth.
  app.post<{ Body: { key: string } }>('/api/youtube/play', async (req) =>
    run(async () => {
      const key = String(req.body.key ?? '');
      if (!/^[\w-]{6,20}$/.test(key)) throw new Error('Not a YouTube video');
      const yt = config.apps.find((a) => a.id === 'youtube');
      const ua = yt?.launch.type === 'web' ? yt.launch.userAgent : undefined;
      await launcher.launch('app:youtube', 'YouTube', { type: 'web', url: `https://www.youtube.com/tv#/watch?v=${key}`, userAgent: ua });
    }),
  );
  app.get('/api/downloads', async () => (requests.hasDownloads && !isKid() ? requests.downloads() : { items: [], errors: [] }));

  /* ---------------- Moonlight ---------------- */

  // Pair with a PC. Moonlight's pairing window takes the screen; a Hearth panel above it shows the
  // PIN, a QR code for the PC's Apollo/Sunshine PIN page, and progress.
  app.post<{ Params: { hostId: string } }>('/api/games/:hostId/pair', async (req) =>
    run(async () => {
      requireParent();
      let overlay = '';
      const { pin, host, webUi } = games.pair(req.params.hostId, {
        onStarted: () => setTimeout(() => launcher.showOverlay(overlay, 180), 1200),
        onDone: () => setTimeout(() => launcher.closeOverlay(), 4000),
      });
      overlay = `http://127.0.0.1:${config.server.port}/pair?${new URLSearchParams({ host: req.params.hostId, name: host, pin, webUi })}`;
      return { pin, webUi };
    }),
  );
  app.post('/api/moonlight/open', async () =>
    run(async () => {
      requireParent();
      await launcher.launch('app:moonlight', 'Moonlight', { type: 'command', command: games.moonlightBase() });
    }),
  );
  // Back on the game loading screen: just reveal the stream.
  app.post('/api/games/loading/close', async () => run(() => launcher.closeOverlay()));
  app.post('/api/moonlight/cancel', async () =>
    run(async () => {
      launcher.closeOverlay();
      if (launcher.session?.id.startsWith('pair:')) await launcher.stop();
    }),
  );

  /* ---------------- alerts & doorbell ---------------- */

  app.get<{ Params: { id: string } }>('/api/alerts/:id', async (req, reply) => alerts.get(req.params.id) ?? reply.code(404).send());
  app.get('/api/alerts', async () => alerts.history);

  app.post<{ Body: { kind: 'doorbell' | 'info' | 'warning' | 'ready' } }>('/api/alerts/test', async (req) =>
    run(() => {
      requireParent();
      const kind = req.body.kind ?? 'doorbell';
      const camera = config.alerts.doorbell?.camera;
      if (kind === 'doorbell') alerts.raise({ kind, title: 'Someone’s at the door', camera, seconds: 20 });
      else if (kind === 'ready') {
        alerts.raise({
          kind: 'info',
          title: 'The Expanse is ready to watch',
          message: 'S1 · E1 · Dulcinea (test from Settings)',
          image: 'https://image.tmdb.org/t/p/w342/8djpxDeWpINnGhjpFXQjnBe6zbx.jpg',
          seconds: 25,
          action: { label: 'Watch', kind: 'watch', title: 'The Expanse', mediaType: 'tv', season: 1, episode: 1 },
        });
      } else if (kind === 'warning') alerts.raise({ kind, title: 'Proxmox is down', message: 'Test alert from Settings.', seconds: 10 });
      else alerts.raise({ kind, title: 'The washer is done', message: 'Test alert from Settings.', seconds: 10 });
    }),
  );

  // Live camera (MJPEG) for the doorbell pop-up, PiP and camera page, proxied so the HA token stays
  // here. Battery cameras (Eufy) get their live stream started while someone is watching.
  const cameraStreams = new CameraStreams(ha, config.homeassistant?.cameraStream, app.log);
  app.get<{ Params: { entity: string } }>('/api/camera/:entity/stream', async (req, reply) => {
    if (!ha) return reply.code(404).send();
    const entity = req.params.entity;
    if (!/^camera\.[a-z0-9_]+$/.test(entity)) return reply.code(404).send();
    const started = await cameraStreams.open(entity);
    req.raw.once('close', () => cameraStreams.close(entity));
    // Give a just-woken camera a moment, so the first frames are live rather than the last snapshot.
    if (started) await new Promise((r) => setTimeout(r, 2500));
    const res = await ha.fetch(`/api/camera_proxy_stream/${encodeURIComponent(entity)}`);
    if (!res.ok || !res.body) return reply.code(res.status).send();
    reply.header('Cache-Control', 'no-store').type(res.headers.get('content-type') ?? 'multipart/x-mixed-replace');
    const { Readable } = await import('node:stream');
    return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
  });

  /* ---------------- TV power & inputs (HDMI-CEC) ---------------- */

  app.post<{ Params: { action: 'on' | 'off' | 'hearth' }; Body: { input?: string } }>('/api/tv-control/:action', async (req) =>
    run(async () => {
      const cmds = config.tv.commands;
      if (req.params.action === 'on') await launcher.run(cmds.on);
      else if (req.params.action === 'off') await launcher.run(cmds.off);
      else await launcher.run(expand(cmds.hearth, { addr: '1.0.0.0' }));
    }),
  );

  /* ---------------- Plex: continue watching ---------------- */

  app.get('/api/plex/ondeck', async () => {
    if (!plex) return { demo: config.demo, items: config.demo ? DEMO_ON_DECK : [] };
    try {
      return { demo: false, items: await plex.onDeck() };
    } catch (err) {
      return { demo: false, items: [], error: (err as Error).message };
    }
  });

  app.get<{ Querystring: { path: string } }>('/api/plex/thumb', async (req, reply) => {
    if (!plex) return reply.code(404).send();
    return relay(reply, await plex.thumb(req.query.path), 'public, max-age=86400');
  });

  /** Open a Plex item on the TV: Plex HTPC gets told to play it; Plex Web is deep-linked. */
  const openPlexItem = async (id: string) => {
    if (!plex) throw new Error('Demo mode: add your Plex server under "plex" in config.yaml');
    const plexTile = ProfileStore.orderApps(profiles.active, config.apps).find((a) => a.id === 'plex');
    if (isKid() && !plexTile) throw new PermissionError('Plex isn’t on this profile');
    // Plex HTPC (or any app tile) can't be deep-linked: open it, then ask it to play the item.
    if (plexTile && plexTile.launch.type === 'command') {
      await launcher.launch('app:plex', plexTile.name, plexTile.launch);
      const here = new Set(['127.0.0.1', '::1', 'localhost', lanAddress()]);
      plex
        .playOnPlayer(id, (address) => here.has(address))
        .catch((err) => app.log.warn(`plex: ${(err as Error).message}. Pick it from Continue Watching in Plex instead.`));
      return;
    }
    await launcher.launch('app:plex', 'Plex', { type: 'web', url: await plex.itemUrl(id) });
  };
  app.post<{ Params: { id: string } }>('/api/plex/open/:id', async (req) =>
    run(async () => openPlexItem(plex ? await plex.playable(req.params.id).catch(() => req.params.id) : req.params.id)),
  );
  app.get('/api/plex/recent', async () => {
    if (!plex) return { items: config.demo ? DEMO_ON_DECK : [] };
    return { items: await plex.recentlyAdded().catch(() => []) };
  });
  app.get('/api/plex/watchlist', async () => {
    if (!plex) return { items: [] };
    return { items: await plex.watchlist().catch(() => []) };
  });
  // Watchlist item: play it if it's in your libraries; otherwise say so (the TV offers a request).
  app.post<{ Body: { title: string; year?: number; mediaType: 'movie' | 'tv' } }>('/api/plex/watchlist/play', async (req) =>
    run(async () => {
      if (!plex) throw new Error('Add your Plex server under "plex" in config.yaml');
      const { title, year, mediaType } = req.body;
      const id = await plex.find({ title: String(title), year: year ? Number(year) : undefined, mediaType: mediaType === 'tv' ? 'tv' : 'movie' });
      if (!id) return { inLibrary: false };
      await openPlexItem(await plex.playable(id).catch(() => id));
      return { inLibrary: true };
    }),
  );

  /* ---------------- ready to watch (Radarr / Sonarr / Lidarr imports) ---------------- */

  // The "Watch" button on a ready-to-watch pop-up: find it in Plex now (Plex may only just have
  // scanned it) and play it.
  app.post('/api/alerts/dismiss', async () => run(() => launcher.closeOverlay()));
  app.post<{ Body: { alertId: string } }>('/api/alerts/action', async (req) =>
    run(async () => {
      const action = alerts.get(String(req.body.alertId))?.action;
      if (!action) throw new Error('That pop-up has expired');
      if (action.kind === 'sleep-extend') {
        launcher.closeOverlay();
        sleep.extend(action.minutes);
        return;
      }
      if (action.kind === 'pip') {
        launcher.closeOverlay();
        showCamera(action.entity);
        return;
      }
      if (!plex) throw new Error('Add your Plex server under "plex" in config.yaml to play from here');
      launcher.closeOverlay();
      const id = await plex.find(action);
      if (!id) throw new Error(`Plex hasn’t added ${action.title} yet. Try again in a minute.`);
      await openPlexItem(id);
    }),
  );
  const watcher = new ArrWatcher(
    config.requests,
    config.requests.notify ?? 'all',
    (item) => {
      const watchable = item.kind !== 'music' && Boolean(plex);
      alerts.raise({
        kind: 'info',
        title: item.kind === 'music' ? `New music: ${item.title}` : `${item.title} is ready to watch`,
        message: item.subtitle ?? (item.year ? String(item.year) : undefined),
        image: item.poster,
        seconds: watchable ? 25 : 12,
        action: watchable
          ? { label: 'Watch', kind: 'watch', title: item.title, year: item.year, mediaType: item.kind as 'movie' | 'tv', season: item.season, episode: item.episode }
          : undefined,
      });
    },
    app.log,
    requests.hasSeerr ? () => requests.requestedIds() : undefined,
  );
  watcher.start();

  /* ---------------- lab: history & actions ---------------- */

  app.get<{ Querystring: { entity: string; hours?: string } }>('/api/lab/history', async (req) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 168);
    if (!ha) return { points: demoSeries(req.query.entity, hours) };
    try {
      return { points: await ha.history(req.query.entity, hours) };
    } catch {
      return { points: [] };
    }
  });

  app.get('/api/lab/actions', async () => {
    const actions = config.lab.actions.length ? config.lab.actions : DEMO_ACTIONS;
    return { demo: config.lab.actions.length === 0, actions: actions.map((a, i) => ({ index: i, name: a.name })) };
  });

  app.post<{ Params: { index: string }; Body: { pin?: string } }>('/api/lab/actions/:index', async (req) =>
    run(async () => {
      requireParent();
      if (!profiles.checkPin(profiles.active.id, req.body?.pin)) throw new PermissionError('Wrong PIN');
      const demo = config.lab.actions.length === 0;
      const action = (demo ? DEMO_ACTIONS : config.lab.actions)[Number(req.params.index)];
      if (!action) throw new Error('Unknown action');
      if (demo) {
        bus.toast(`Demo: “${action.name}” would run now`);
        return;
      }
      if (action.ha) await ctx.callService(action.ha.service, action.ha.data);
      if (action.http) {
        const res = await fetch(action.http.url, {
          method: action.http.method ?? 'POST',
          headers: action.http.headers,
          body: action.http.body,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`${action.name}: HTTP ${res.status}`);
      }
      bus.toast(`${action.name}: done`);
    }),
  );

  /* ---------------- games: PCs, browse, details ---------------- */

  app.post<{ Params: { hostId: string }; Body: { action: PowerAction } }>('/api/games/:hostId/power', async (req) =>
    run(async () => {
      if (req.body.action !== 'wake') requireParent();
      await games.power(req.params.hostId, req.body.action);
    }),
  );

  app.get('/api/games/browse/sources', async (_req, reply) => {
    if (isKid()) return reply.code(403).send({ error: 'Browse is for parents' });
    return games.browseSources();
  });

  app.get<{ Params: { hostId: string }; Querystring: { source: 'pc' | 'platform'; platform?: string; q?: string; offset?: string; limit?: string } }>(
    '/api/games/browse/:hostId',
    async (req, reply) => {
      if (isKid()) return reply.code(403).send({ error: 'Browse is for parents' });
      try {
        return await games.browse(req.params.hostId, {
          source: req.query.source,
          platform: req.query.platform,
          search: req.query.q,
          offset: Number(req.query.offset ?? 0),
          limit: Math.min(Number(req.query.limit ?? 120), 300),
        });
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { hostId: string; gameId: string } }>('/api/games/:hostId/details/:gameId', async (req, reply) => {
    if (!ProfileStore.allowsGame(profiles.active, req.params.hostId, req.params.gameId)) return reply.code(403).send();
    try {
      return await games.details(req.params.hostId, req.params.gameId);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { hostId: string; gameId: string; n: string } }>('/api/games/:hostId/shot/:gameId/:n', async (req, reply) => {
    try {
      return await relay(reply, await games.shot(req.params.hostId, req.params.gameId, Number(req.params.n)), 'public, max-age=86400');
    } catch {
      return reply.code(404).send();
    }
  });

  /* ---------------- screensaver ---------------- */

  const photos = (): string[] => {
    const dir = config.screensaver.photosDir;
    if (!dir || !existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => PHOTO_EXT.has(extname(f).toLowerCase()))
        .slice(0, 500);
    } catch {
      return [];
    }
  };

  app.get('/api/screensaver', async () => ({
    ...config.screensaver,
    photos: photos().map((_, i) => `/api/screensaver/photo/${i}`),
  }));

  app.get<{ Params: { n: string } }>('/api/screensaver/photo/:n', async (req, reply) => {
    const file = photos()[Number(req.params.n)];
    if (!file) return reply.code(404).send();
    const ext = extname(file).toLowerCase().slice(1);
    reply.header('Cache-Control', 'public, max-age=3600').type(`image/${ext === 'jpg' ? 'jpeg' : ext}`);
    return reply.send(readFileSync(join(config.screensaver.photosDir!, file)));
  });

  /* ---------------- phone remote ---------------- */

  app.get('/api/remote/pairing', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send();
    const host = config.server.host;
    const reachable = host === '0.0.0.0' || host === '::' || !isLoopback(host);
    const ip = lanAddress();
    return {
      code: pairing.currentCode(),
      url: ip ? `http://${ip}:${config.server.port}/remote` : null,
      reachable,
      paired: pairing.paired,
    };
  });

  app.post<{ Body: { code: string; label?: string } }>('/api/remote/pair', async (req, reply) => {
    const token = pairing.pair(String(req.body?.code ?? ''), req.body?.label ?? String(req.headers['user-agent'] ?? 'Phone'));
    if (!token) return reply.code(401).send({ ok: false, error: 'That code didn’t match. Check the TV and try again.' });
    reply.header('Set-Cookie', `hearth_remote=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
    return { ok: true };
  });

  app.delete('/api/remote/tokens', async () =>
    run(() => {
      requireParent();
      pairing.forgetAll();
    }),
  );

  app.post<{ Body: { cmd: RemoteCommand; text?: string } }>('/api/remote/cmd', async (req) =>
    run(async () => {
      const { cmd, text } = req.body;
      if (cmd === 'home') {
        await launcher.stop();
        bus.emit({ type: 'home' });
        return;
      }
      if (cmd === 'volumeUp' || cmd === 'volumeDown' || cmd === 'mute') {
        await launcher.run(config.system[cmd]);
        return;
      }
      // While Plex/a browser/Moonlight has the screen, inject real key presses into it.
      const key = REMOTE_KEYS[cmd];
      if (launcher.session && key) {
        await launcher.run(expand(config.remote.keyCommand, key));
        return;
      }
      bus.emit({ type: 'remote', cmd, text });
    }),
  );
}

/* ---------------- demo data ---------------- */

const DEMO_ACTIONS: LabAction[] = [{ name: 'Restart Plex container' }, { name: 'Reboot Pi-hole' }, { name: 'Start Minecraft server VM' }];

/** A believable daily curve so charts have something to show in demo mode. */
function demoSeries(entity: string, hours: number): Array<[number, number]> {
  const seed = [...entity].reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = entity.includes('download') ? 700 : entity.includes('disk') ? 61 : entity.includes('ups') ? 18 : 25;
  const now = Date.now();
  return Array.from({ length: 48 }, (_, i) => {
    const t = now - hours * 3600_000 + (i / 47) * hours * 3600_000;
    const wave = Math.sin((t / 3600_000 / 24) * Math.PI * 2 + seed) * 0.25 + Math.sin(i * 1.7 + seed) * 0.08;
    return [t, Math.max(0, Math.round(base * (1 + wave) * 10) / 10)] as [number, number];
  });
}
