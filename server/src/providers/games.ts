import { readFileSync, writeFileSync } from 'node:fs';
import type { EventBus, GameStage } from '../bus.js';
import { expand, type GameHostConfig, type GamingConfig } from '../config.js';
import type { Launcher } from '../launcher.js';
import type { StateStore } from '../state.js';
import { hostBusy, type HostBusy, type Presence } from '../presence.js';
import { wake } from '../wol.js';

export type Rating = 'E' | 'E10' | 'T' | 'M';

/** A game as reported by a Hearth PC agent. */
export interface AgentGame {
  id: string;
  title: string;
  platform: string;
  source: 'steam' | 'rom' | 'custom' | 'launchbox' | 'playnite';
  /** Store/library a Playnite game comes from (Epic, Xbox, GOG…). */
  store?: string;
  /** Public artwork URL, or true if the agent serves art at /art/<id>. */
  art?: string | boolean;
  controller?: 'full' | 'partial' | 'none' | 'unknown';
  requiresKbm?: boolean;
  rating?: Rating | null;
  favorite?: boolean;
  installed?: boolean;
}

export interface Game {
  id: string;
  hostId: string;
  hostName: string;
  title: string;
  platform: string;
  source: AgentGame['source'];
  store?: string;
  art?: string;
  controller: NonNullable<AgentGame['controller']>;
  requiresKbm: boolean;
  rating: Rating | null;
  favorite: boolean;
  installed: boolean;
}

export interface GameDetails extends Game {
  description: string;
  year: number | null;
  genres: string[];
  /** From Playnite/LaunchBox, when they track it. */
  libraryPlaytimeMinutes: number | null;
  /** Time streamed through Hearth. */
  hearthPlaytimeMinutes: number;
  screenshots: string[];
}

export interface HostStatus {
  id: string;
  name: string;
  online: boolean;
  canWake: boolean;
  games: number;
  /** Seconds the PC has been on. */
  uptime: number | null;
  /** Game the agent is running right now. */
  playing: string | null;
  /** Typical wake-up time in seconds (learned). */
  wakeEstimate: number | null;
  /** Someone is using the PC (or streaming from it to another device); Hearth asks before streaming. */
  busy: HostBusy | null;
}

export interface BrowseSources {
  hostId: string;
  hostName: string;
  online: boolean;
  /** Games in the full PC library (Playnite: installed and not). */
  pc: number;
  /** LaunchBox platforms with game counts. */
  platforms: Array<{ name: string; count: number }>;
}

export type PowerAction = 'wake' | 'sleep' | 'restart' | 'shutdown';

interface AgentHealth {
  uptime?: number;
  playing?: string | null;
  /** true while the game runs, false once it exited, null/absent when the agent can't tell. */
  gameRunning?: boolean | null;
  /** Apollo's virtual display exists (the stream is connected); null when the agent can't tell. */
  streamDisplay?: boolean | null;
  /** Who's at the PC (idle time, locked, window in front). Older agents don't send it. */
  presence?: Presence | null;
  /** The PC's own loading cover is still up: the game's window hasn't appeared yet. Older agents don't send it. */
  covering?: boolean;
}

// When Moonlight's stream window is up (moonlight-qt + moonlight-common-c log lines).
// Moonlight tests its decoder in its first seconds (the same FFmpeg lines as the real stream), so wait for
// the connection's last stage instead: "Starting input stream..." then "done". The stream window opens
// right after it.
/** Moonlight's interface window is up (its first lines after loading the QML interface). */
const MOONLIGHT_WINDOW = /Qt UI screen is at|SDL found matching display|Found "ModeSeven/;
const STREAM_CONNECTED = /Starting input stream[^\n]*\n[^\n]*done/i;
/** Then its renderer starts drawing: EGLRenderer on Intel/VAAPI (the decoder test doesn't print it). */
const STREAM_RENDERING = /EGLRenderer|PlVkRenderer/;

/** How often to ask a PC whether its library changed (a cheap "no changes" answer when it hasn't). */
const RECHECK_MS = 60 * 1000;
const HEALTH_MS = 5 * 1000;

interface CachedLibrary {
  /** When we last asked the agent (success or not). */
  at: number;
  /** Agent's version tag for this library; unchanged → it answers 304 with no body. */
  etag?: string;
  raw: AgentGame[];
  games: Game[];
}

export class GameService {
  private cache = new Map<string, CachedLibrary>();
  private inflight = new Map<string, Promise<void>>();
  private healthCache = new Map<string, { at: number; value: AgentHealth | null; pending?: Promise<AgentHealth | null> }>();
  private launching = false;
  /** When Hearth's last stream from each PC ended, so input from it isn't mistaken for someone at the PC. */
  private streamEnded = new Map<string, number>();
  /** Set while a game is being closed behind Hearth's cover (the cover stays until the PC has let go). */
  private closing: Promise<void> | null = null;
  private ending: Promise<void> | null = null;
  private lastArt = new Map<string, string | undefined>();
  private demoAwake = new Set(['gaming-pc']);

  constructor(
    private readonly cfg: GamingConfig,
    private readonly launcher: Launcher,
    private readonly bus: EventBus,
    private readonly state: StateStore,
    /** Libraries are kept on disk so the list shows instantly after a reboot, even with the PCs asleep. */
    private readonly cacheFile?: string,
  ) {
    if (!cacheFile) return;
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, { etag?: string; raw: AgentGame[] }>;
      for (const h of cfg.hosts) {
        const entry = saved[h.id];
        if (entry?.raw) this.cache.set(h.id, { at: 0, etag: entry.etag, raw: entry.raw, games: entry.raw.map((g) => this.toGame(h, g)) });
      }
    } catch {
      /* first run */
    }
  }

  private saveCache(): void {
    if (!this.cacheFile) return;
    const out = Object.fromEntries([...this.cache].map(([id, c]) => [id, { etag: c.etag, raw: c.raw }]));
    try {
      writeFileSync(this.cacheFile, JSON.stringify(out));
    } catch {
      /* not fatal */
    }
  }

  /** Sample games only when previewing without a config file (config.demo). */
  allowDemo = false;
  /** Where the loading screen page is served (set by the server), e.g. http://127.0.0.1:8787 */
  uiBase = '';
  /** Set by the server: notes for the log (how a game session ended…). */
  log?: (message: string) => void;

  get demo(): boolean {
    return this.allowDemo && this.cfg.hosts.length === 0;
  }

  private host(id: string): GameHostConfig {
    const h = this.cfg.hosts.find((x) => x.id === id);
    if (!h) throw new Error(`Unknown game host "${id}"`);
    return h;
  }

  private agent(h: GameHostConfig, path: string, init?: RequestInit, timeout = 5000): Promise<Response> {
    return fetch(`${h.agent}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeout),
    });
  }

  private async health(h: GameHostConfig, maxAgeMs = 0): Promise<AgentHealth | null> {
    const cached = this.healthCache.get(h.id);
    if (cached && Date.now() - cached.at <= maxAgeMs) return cached.value;
    if (cached?.pending) return cached.pending;
    const pending = (async () => {
      try {
        const res = await this.agent(h, '/health', undefined, 2000);
        return res.ok ? ((await res.json()) as AgentHealth) : null;
      } catch {
        return null;
      }
    })();
    this.healthCache.set(h.id, { at: cached?.at ?? 0, value: cached?.value ?? null, pending });
    const value = await pending;
    this.healthCache.set(h.id, { at: Date.now(), value });
    return value;
  }

  private busyFrom(h: GameHostConfig, health: AgentHealth | null): HostBusy | null {
    const ours = Boolean(this.launcher.session?.id.startsWith(`game:${h.id}:`) || this.launcher.session?.id === `pair:${h.id}`);
    return hostBusy({ name: h.name, health, ours, oursEndedAt: this.streamEnded.get(h.id), now: Date.now(), idleMinutes: h.busyIdleMinutes });
  }

  /** Is someone using this PC right now? Asks it fresh (asleep or unreachable: not busy). */
  async busy(hostId: string): Promise<HostBusy | null> {
    if (this.demo) return null;
    const h = this.host(hostId);
    return this.busyFrom(h, await this.health(h));
  }

  private async online(h: GameHostConfig): Promise<boolean> {
    return (await this.health(h)) !== null;
  }

  async hosts(): Promise<HostStatus[]> {
    if (this.demo) {
      return DEMO_HOSTS.map(([id, name]) => ({
        id,
        name,
        online: this.demoAwake.has(id),
        canWake: true,
        games: DEMO_GAMES.filter((g) => g.hostId === id).length,
        uptime: this.demoAwake.has(id) ? 3 * 3600 + 1240 : null,
        playing: null,
        wakeEstimate: this.state.wakeEstimate(id) ?? 25,
        busy: null,
      }));
    }
    return Promise.all(
      this.cfg.hosts.map(async (h) => {
        const health = await this.health(h, HEALTH_MS);
        return {
          id: h.id,
          name: h.name,
          online: health !== null,
          canWake: Boolean(h.mac),
          games: this.cache.get(h.id)?.games.length ?? 0,
          uptime: health?.uptime ?? null,
          playing: health?.playing ?? null,
          wakeEstimate: this.state.wakeEstimate(h.id),
          busy: this.busyFrom(h, health),
        };
      }),
    );
  }

  private kbm(h: GameHostConfig, g: AgentGame): boolean {
    const o = this.cfg.kbmOverrides;
    const byId = o[`${h.id}:${g.id}`];
    if (byId !== undefined) return byId;
    if (o[g.title] !== undefined) return o[g.title];
    if (g.requiresKbm !== undefined) return g.requiresKbm;
    return g.controller === 'none';
  }

  private toGame(h: GameHostConfig, g: AgentGame): Game {
    return {
      id: g.id,
      hostId: h.id,
      hostName: h.name,
      title: g.title,
      platform: g.platform,
      source: g.source,
      store: g.store || undefined,
      art: g.art === true ? `/api/games/${h.id}/art/${encodeURIComponent(g.id)}` : g.art || undefined,
      controller: g.controller ?? 'unknown',
      requiresKbm: this.kbm(h, g),
      rating: g.rating ?? null,
      favorite: g.favorite ?? true,
      installed: g.installed ?? true,
    };
  }

  /** Ask the agent for its library, sending our version tag so an unchanged library costs nothing. */
  private revalidate(h: GameHostConfig): Promise<void> {
    const running = this.inflight.get(h.id);
    if (running) return running;
    const job = (async () => {
      const cached = this.cache.get(h.id);
      try {
        const res = await this.agent(h, '/games', { headers: cached?.etag ? { 'If-None-Match': cached.etag } : {} }, 10000);
        if (res.status === 304 && cached) {
          cached.at = Date.now();
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as AgentGame[];
        this.cache.set(h.id, { at: Date.now(), etag: res.headers.get('etag') ?? undefined, raw, games: raw.map((g) => this.toGame(h, g)) });
        this.saveCache();
        if (cached) this.bus.emit({ type: 'games' });
      } catch {
        // Asleep/offline: keep the last known library and try again later.
        if (cached) cached.at = Date.now();
        else this.cache.set(h.id, { at: Date.now(), raw: [], games: [] });
      } finally {
        this.inflight.delete(h.id);
      }
    })();
    this.inflight.set(h.id, job);
    return job;
  }

  /**
   * The library we already have, straight away. Checks the PC for changes in the background
   * (at most once a minute, or now when forced); the UI is told if anything changed.
   */
  private async fetchHost(h: GameHostConfig, force: boolean): Promise<Game[]> {
    const cached = this.cache.get(h.id);
    if (!cached) {
      await this.revalidate(h);
      return this.cache.get(h.id)?.games ?? [];
    }
    if (force) await this.revalidate(h);
    else if (Date.now() - cached.at > RECHECK_MS) void this.revalidate(h);
    return this.cache.get(h.id)!.games;
  }

  async games(force = false): Promise<Game[]> {
    if (this.demo) return DEMO_GAMES;
    const all = await Promise.all(this.cfg.hosts.map((h) => this.fetchHost(h, force)));
    return all.flat().sort((a, b) => a.title.localeCompare(b.title));
  }

  /* ---------------- browse (whole libraries) ---------------- */

  async browseSources(): Promise<BrowseSources[]> {
    if (this.demo) {
      return [
        { hostId: 'gaming-pc', hostName: 'Gaming PC', online: true, pc: DEMO_PC_LIBRARY.length, platforms: [] },
        {
          hostId: 'emulator-pc',
          hostName: 'Emulator PC',
          online: true,
          pc: 0,
          platforms: Object.entries(DEMO_PLATFORMS).map(([name, titles]) => ({ name, count: titles.length * 12 })),
        },
      ];
    }
    return Promise.all(
      this.cfg.hosts.map(async (h) => {
        try {
          const res = await this.agent(h, '/browse/sources', undefined, 20000);
          const body = res.ok ? ((await res.json()) as { pc: number; platforms: BrowseSources['platforms'] }) : { pc: 0, platforms: [] };
          return { hostId: h.id, hostName: h.name, online: true, ...body };
        } catch {
          return { hostId: h.id, hostName: h.name, online: false, pc: 0, platforms: [] };
        }
      }),
    );
  }

  async browse(
    hostId: string,
    q: { source: 'pc' | 'platform'; platform?: string; search?: string; offset?: number; limit?: number },
  ): Promise<{ total: number; games: Game[] }> {
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 120;
    if (this.demo) {
      const all = q.source === 'pc' ? DEMO_PC_LIBRARY : demoPlatform(q.platform ?? '');
      const hits = q.search ? all.filter((g) => g.title.toLowerCase().includes(q.search!.toLowerCase())) : all;
      return { total: hits.length, games: hits.slice(offset, offset + limit) };
    }
    const h = this.host(hostId);
    const params = new URLSearchParams({ source: q.source, platform: q.platform ?? '', q: q.search ?? '', offset: String(offset), limit: String(limit) });
    const res = await this.agent(h, `/browse?${params}`, undefined, 30000);
    if (!res.ok) throw new Error(`${h.name}: ${await res.text()}`);
    const body = (await res.json()) as { total: number; games: AgentGame[] };
    return { total: body.total, games: body.games.map((g) => this.toGame(h, g)) };
  }

  async details(hostId: string, gameId: string): Promise<GameDetails> {
    const played = this.state.playtime(`${hostId}:${gameId}`);
    if (this.demo) {
      const g = [...DEMO_GAMES, ...DEMO_PC_LIBRARY].find((x) => x.id === gameId) ?? demoFind(gameId);
      if (!g) throw new Error('Unknown game');
      const appid = g.id.startsWith('steam-') ? g.id.slice(6) : null;
      return {
        ...g,
        description: DEMO_BLURBS[g.title] ?? 'A demo game. Connect the Hearth PC agent to see real descriptions, screenshots and play time.',
        year: 2016 + (g.title.length % 8),
        genres: g.platform === 'PC' ? ['Action', 'Adventure'] : ['Platformer'],
        libraryPlaytimeMinutes: (g.title.length * 97) % 3000,
        hearthPlaytimeMinutes: played,
        screenshots: appid ? [`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/page_bg_generated_v6b.jpg`] : [],
      };
    }
    const h = this.host(hostId);
    const res = await this.agent(h, `/details/${encodeURIComponent(gameId)}`, undefined, 15000);
    if (!res.ok) throw new Error(`${h.name}: ${await res.text()}`);
    const d = (await res.json()) as AgentGame & { description?: string; year?: number; genres?: string[]; playtimeMinutes?: number; screenshots?: string[] };
    return {
      ...this.toGame(h, d),
      description: d.description ?? '',
      year: d.year ?? null,
      genres: d.genres ?? [],
      libraryPlaytimeMinutes: d.playtimeMinutes ?? null,
      hearthPlaytimeMinutes: played,
      // Local images on the PC are proxied; store screenshots are public URLs.
      screenshots: (d.screenshots ?? []).map((s) => {
        const local = s.match(/^\/shot\/(.+)\/(\d+)$/);
        return local ? `/api/games/${h.id}/shot/${encodeURIComponent(local[1])}/${local[2]}` : s;
      }),
    };
  }

  async art(hostId: string, gameId: string): Promise<Response> {
    return this.agent(this.host(hostId), `/art/${encodeURIComponent(gameId)}`, undefined, 10000);
  }

  async shot(hostId: string, gameId: string, n: number): Promise<Response> {
    return this.agent(this.host(hostId), `/shot/${encodeURIComponent(gameId)}/${n}`, undefined, 10000);
  }

  /* ---------------- Moonlight pairing ---------------- */

  /** The Moonlight command without its "stream {host} {app}" part, for "pair" and opening Moonlight itself. */
  moonlightBase(): string[] {
    const i = this.cfg.moonlight.indexOf('stream');
    return i > 0 ? this.cfg.moonlight.slice(0, i) : this.cfg.moonlight.filter((a) => !/\{(host|app)\}/.test(a));
  }

  /**
   * Pair Moonlight on this TV with a PC: wake it if needed, run `moonlight pair <host> --pin`,
   * and ask the PC's agent to type the PIN into Apollo/Sunshine when it has the login for it.
   * Progress goes out as "pair" events; resolves with the PIN as soon as pairing has started.
   */
  pair(hostId: string, hooks: { onStarted?: () => void; onDone?: (ok: boolean) => void } = {}): { pin: string; host: string; webUi: string } {
    const h = this.host(hostId);
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const emit = (stage: 'waking' | 'pairing' | 'auto-pin' | 'paired' | 'failed', message: string) =>
      this.bus.emit({ type: 'pair', hostId, stage, message });
    void (async () => {
      try {
        if (!(await this.online(h))) await this.wakeAndWait(h, () => emit('waking', `Waking ${h.name}…`));
        emit('pairing', `Enter ${pin} on ${h.name}`);
        const command = [...this.moonlightBase(), 'pair', h.moonlightHost, '--pin', pin];
        await this.launcher.launch(`pair:${hostId}`, `Pair ${h.name}`, { type: 'command', command }, (code) => {
          const ok = code === 0;
          emit(ok ? 'paired' : 'failed', ok ? `Paired with ${h.name}` : `Pairing with ${h.name} didn’t finish`);
          hooks.onDone?.(ok);
        });
        hooks.onStarted?.();
        // Give Moonlight a moment to start the handshake, then let the agent enter the PIN if it can.
        await new Promise((r) => setTimeout(r, 2500));
        const res = await this.agent(h, '/pair', { method: 'POST', body: JSON.stringify({ pin, name: 'Hearth TV' }) }, 10000);
        const r = res.ok ? ((await res.json()) as { ok: boolean }) : { ok: false };
        if (r.ok) emit('auto-pin', `${h.name} accepted the PIN`);
      } catch (err) {
        if (this.launcher.session?.id === `pair:${hostId}`) return; // auto-PIN failed; manual entry still works
        emit('failed', (err as Error).message);
        hooks.onDone?.(false);
      }
    })();
    return { pin, host: h.name, webUi: `https://${h.moonlightHost}:47990/pin` };
  }

  /* ---------------- power ---------------- */

  private async wakeAndWait(h: GameHostConfig, onWaking?: () => void): Promise<void> {
    if (!h.mac) throw new Error(`${h.name} is offline and has no MAC address for Wake-on-LAN`);
    onWaking?.();
    const started = Date.now();
    await wake(h.mac);
    const deadline = started + 120_000;
    while (!(await this.online(h))) {
      if (Date.now() > deadline) throw new Error(`${h.name} did not wake up within 2 minutes`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    this.state.recordWake(h.id, (Date.now() - started) / 1000);
  }

  async power(hostId: string, action: PowerAction): Promise<void> {
    if (this.demo) {
      if (action === 'wake') this.demoAwake.add(hostId);
      else this.demoAwake.delete(hostId);
      this.bus.toast(`Demo: ${hostId} → ${action}`);
      return;
    }
    const h = this.host(hostId);
    if (action === 'wake') {
      if (await this.online(h)) return;
      // Runs in the background; the PCs panel refreshes to show it coming up.
      this.wakeAndWait(h).then(
        () => this.bus.toast(`${h.name} is awake`),
        (err) => this.bus.toast((err as Error).message, 'error'),
      );
      return;
    }
    const res = await this.agent(h, '/power', { method: 'POST', body: JSON.stringify({ action }) });
    if (!res.ok) throw new Error(`${h.name}: ${await res.text()}`);
  }

  /**
   * Quit from inside the game (RetroArch "Quit", "Exit to desktop"…) and the stream would
   * otherwise stay on the PC's desktop. Poll the agent; when it says the game has exited,
   * end the stream so the TV comes straight back to Hearth.
   */
  /**
   * Stop the game on the PC and end the stream session there. With Apollo that removes the
   * virtual display, so your real monitors switch back on. Moonlight's "quit" asks the host to end
   * the app over the paired connection; the agent also asks Apollo directly when it has the login.
   */
  private async endSession(h: GameHostConfig): Promise<void> {
    let ended = false;
    if (h.quitOnExit || h.endSessionOnExit) {
      // Ending the Apollo session can take a few seconds on the PC (login, then close).
      const res = await this.agent(h, '/stop', { method: 'POST', body: JSON.stringify({ endSession: h.endSessionOnExit }) }, 15_000).catch(() => null);
      ended = Boolean(res?.ok && ((await res.json().catch(() => ({}))) as { sessionEnded?: boolean }).sessionEnded);
    }
    // Moonlight's quit pops up its own "quitting" window on the TV, so it's only the fallback for
    // when the agent couldn't end the session itself (no Apollo login in agent.json).
    if (h.endSessionOnExit && !ended) {
      this.log?.(`${h.name}: the PC couldn't end the Apollo session itself (add the Apollo login to agent.json); using Moonlight's quit, which shows its window`);
      await this.launcher.run([...this.moonlightBase(), 'quit', h.moonlightHost]).catch(() => undefined);
    } else if (ended) this.log?.(`${h.name}: the PC ended the Apollo session`);
  }

  /**
   * Show a Hearth loading screen above the stream while the game starts, so you don't watch the
   * PC's desktop. It goes up once the stream window is showing and comes down a few seconds after
   * the agent sees the game running (or on Back).
   */
  private async coverWhileLoading(
    h: GameHostConfig,
    sessionId: string,
    info: { hostId: string; gameId: string; title: string; art?: string },
    gameStarted: Promise<void>,
  ): Promise<void> {
    if (!h.loadingScreen || !this.uiBase) return;
    const ours = () => this.launcher.session?.id === sessionId;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const q = new URLSearchParams({ host: info.hostId, game: info.gameId, title: info.title, ...(info.art ? { art: info.art } : {}) });
    const cover = () => this.launcher.showOverlay(`${this.uiBase}/launching?${q}`, 180);
    // The newest window is the one on screen. Cover Moonlight's own "Connecting…" window as soon as it's up,
    // then again once the stream window opens on top of that.
    if (h.virtualDisplay) {
      // Moonlight's own window appears as its interface loads ("Qt UI screen is at…", about 1 s in): cover it
      // then, rather than after a guess that can land before the window and end up underneath it.
      const shown = await this.launcher.waitForOutput(sessionId, MOONLIGHT_WINDOW, 4000);
      if (!shown) await sleep(300);
      if (!ours()) return;
      cover();
    }
    // Moonlight's stream window opens when the video starts decoding, seconds after the PC's virtual display
    // appears: watch Moonlight's own output for that, then cover the new window straight away.
    const drawing = await this.launcher.waitForOutput(sessionId, STREAM_CONNECTED, 40_000);
    if (drawing) await this.launcher.waitForOutput(sessionId, STREAM_RENDERING, 2500);
    if (!drawing) {
      // No output to go on (another Moonlight build): fall back to the PC's virtual display, then a margin.
      const deadline = Date.now() + 25_000;
      let display: boolean | null | undefined = h.virtualDisplay ? false : null;
      while (h.virtualDisplay && display === false && Date.now() < deadline && ours()) {
        display = (await this.health(h))?.streamDisplay;
        if (display === false) await sleep(400);
      }
      await sleep(display ? 3000 : 2500);
    } else await sleep(150);
    if (!ours()) return;
    cover();

    try {
      await gameStarted;
    } catch {
      return; // launch() closes it and reports the error
    }
    // Stay up until the game's window is showing on the PC (the agent's own cover has gone), so the PC's
    // desktop and its "Starting…" screen never show. Older agents: wait for the process, then a fixed time.
    const until = Date.now() + 120_000;
    let state = await this.health(h);
    while (Date.now() < until && ours() && (state?.covering === true || (state?.covering === undefined && state?.gameRunning === false))) {
      await sleep(700);
      state = await this.health(h);
    }
    const knowsWindow = state?.covering === false;
    await sleep(knowsWindow ? 1200 : state?.gameRunning ? h.revealSeconds * 1000 : 10_000);
    if (ours()) this.launcher.closeOverlay();
  }

  private watchForGameExit(h: GameHostConfig, sessionId: string): void {
    if (!h.endStreamOnGameExit) return;
    const timer = setInterval(async () => {
      if (this.launcher.session?.id !== sessionId) return clearInterval(timer);
      const health = await this.health(h);
      if (health?.gameRunning === false && this.launcher.session?.id === sessionId) {
        clearInterval(timer);
        this.bus.toast(`${health.playing ?? 'The game'} closed on ${h.name}`);
        await this.stopCovered();
      }
    }, 1500);
  }

  /* ---------------- launching ---------------- */

  private status(hostId: string, gameId: string, stage: GameStage, message: string): void {
    this.bus.emit({ type: 'game-status', hostId, gameId, stage, message });
  }

  /**
   * Leave a game without flashing Moonlight or the PC's desktop: put Hearth's cover up first (it's the
   * newest window, so it's on top), close the stream underneath, wait for the PC to end the session,
   * then take the cover down onto Hearth. Anything that isn't a game just stops.
   */
  async stopCovered(): Promise<void> {
    const s = this.launcher.session;
    const m = s ? /^game:([^:]+):(.+)$/.exec(s.id) : null;
    const h = m ? this.cfg.hosts.find((x) => x.id === m[1]) : undefined;
    if (this.closing) return this.closing;
    if (!s || !m || !h || !h.loadingScreen || !this.uiBase) return this.launcher.stop();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const art = this.lastArt.get(s.id);
    const q = new URLSearchParams({ host: m[1], game: m[2], title: s.title, closing: '1', ...(art ? { art } : {}) });
    this.closing = (async () => {
      this.launcher.showOverlay(`${this.uiBase}/launching?${q}`, 30);
      await sleep(1300); // the cover window needs a moment to appear
      await this.launcher.stop();
      await Promise.race([this.ending ?? Promise.resolve(), sleep(8000)]);
      await sleep(600);
      this.launcher.closeOverlay();
    })();
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }

  /** Wake the host if needed, start the game there, then stream it with Moonlight. */
  async launch(hostId: string, gameId: string, meta: { title?: string; art?: string; players?: number } = {}): Promise<void> {
    if (this.demo) {
      this.status(hostId, gameId, 'error', 'Demo mode – add a gaming host and PC agent to config.yaml');
      return;
    }
    if (this.launching) throw new Error('A game is already starting');
    this.launching = true;
    const h = this.host(hostId);
    const game = (await this.fetchHost(h, false)).find((g) => g.id === gameId);
    const title = game?.title ?? meta.title ?? gameId;
    const art = game?.art ?? meta.art;
    this.lastArt.set(`game:${hostId}:${gameId}`, art);

    try {
      if (!(await this.online(h))) {
        await this.wakeAndWait(h, () => this.status(hostId, gameId, 'waking', `Waking ${h.name}…`));
      }

      const moonlight = { type: 'command' as const, command: expand(this.cfg.moonlight, { host: h.moonlightHost, app: h.moonlightApp }) };
      const started = Date.now();
      let failed = false;
      const onStreamEnd = () => {
        this.streamEnded.set(hostId, Date.now());
        this.state.addPlaytime(`${hostId}:${gameId}`, (Date.now() - started) / 60_000);
        if (!failed) this.status(hostId, gameId, 'ended', `${title} closed`);
        // Closing behind the cover: stopCovered() takes the cover down once the PC has let go.
        if (!this.closing) this.launcher.closeOverlay();
        this.ending = this.endSession(h).catch(() => undefined);
      };
      const startGame = async (waitForDisplay: boolean) => {
        const res = await this.agent(
          h,
          '/launch',
          // players: how many controllers are on the TV, so the agent can set up emulators (Eden…) for them.
          // cover: the PC shows a loading screen (on the stream) until the game's window appears.
          { method: 'POST', body: JSON.stringify({ id: gameId, waitForDisplay, players: meta.players, cover: h.loadingScreen }) },
          waitForDisplay ? 75_000 : 30_000,
        );
        if (!res.ok) throw new Error(`${h.name} could not start ${title}: ${await res.text()}`);
      };

      if (h.virtualDisplay) {
        // Apollo: connect first so the virtual monitor exists (and the real ones switch off),
        // then the agent waits for it and starts the game on it.
        this.status(hostId, gameId, 'launching', `Connecting to ${h.name}…`);
        await this.launcher.launch(`game:${hostId}:${gameId}`, title, moonlight, onStreamEnd);
        const gameStarting = startGame(true);
        void this.coverWhileLoading(h, `game:${hostId}:${gameId}`, { hostId, gameId, title, art }, gameStarting);
        try {
          await gameStarting;
        } catch (err) {
          failed = true;
          this.launcher.closeOverlay();
          await this.launcher.stop();
          throw err;
        }
        this.status(hostId, gameId, 'streaming', `Streaming ${title}`);
        this.state.addRecentGame({ hostId, gameId, title, art });
        this.watchForGameExit(h, `game:${hostId}:${gameId}`);
      } else {
        this.status(hostId, gameId, 'launching', `Starting ${title} on ${h.name}…`);
        await startGame(false);
        this.status(hostId, gameId, 'streaming', `Streaming ${title}`);
        this.state.addRecentGame({ hostId, gameId, title, art });
        await this.launcher.launch(`game:${hostId}:${gameId}`, title, moonlight, onStreamEnd);
        void this.coverWhileLoading(h, `game:${hostId}:${gameId}`, { hostId, gameId, title, art }, Promise.resolve());
        this.watchForGameExit(h, `game:${hostId}:${gameId}`);
      }
    } catch (err) {
      this.status(hostId, gameId, 'error', (err as Error).message);
      throw err;
    } finally {
      this.launching = false;
    }
  }
}

/* ---------------- demo data ---------------- */

const DEMO_HOSTS: Array<[string, string]> = [
  ['gaming-pc', 'Gaming PC'],
  ['emulator-pc', 'Emulator PC'],
];

const steamArt = (appid: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;

const steamGame = (title: string, appid: number, controller: Game['controller'], rating: Rating, extra: Partial<Game> = {}): Game => ({
  id: `steam-${appid}`,
  hostId: 'gaming-pc',
  hostName: 'Gaming PC',
  title,
  platform: 'PC',
  source: 'steam',
  art: steamArt(appid),
  controller,
  requiresKbm: controller === 'none',
  rating,
  favorite: true,
  installed: true,
  ...extra,
});

const DEMO_GAMES: Game[] = [
  steamGame('Elden Ring', 1245620, 'full', 'M'),
  steamGame('Cyberpunk 2077', 1091500, 'full', 'M'),
  steamGame('Baldur’s Gate 3', 1086940, 'full', 'M'),
  steamGame('Hades II', 1145350, 'full', 'T'),
  steamGame('Factorio', 427520, 'partial', 'E'),
  steamGame('Civilization VI', 289070, 'none', 'E10'),
  steamGame('Counter-Strike 2', 730, 'none', 'M'),
  steamGame('Forza Horizon 5', 1551360, 'full', 'E'),
  steamGame('Stardew Valley', 413150, 'full', 'E10'),
  steamGame('RimWorld', 294100, 'none', 'T'),
].concat(
  (
    [
      ['Super Metroid', 'SNES', 'E'],
      ['The Legend of Zelda: Ocarina of Time', 'N64', 'E'],
      ['Sonic the Hedgehog 2', 'Genesis', 'E'],
      ['Metroid Prime', 'GameCube', 'T'],
      ['Castlevania: Symphony of the Night', 'PlayStation', 'T'],
      ['Pokémon Emerald', 'Game Boy Advance', 'E'],
    ] as Array<[string, string, Rating]>
  ).map(([title, platform, rating]) => ({
    id: `rom-${title}`,
    hostId: 'emulator-pc',
    hostName: 'Emulator PC',
    title,
    platform,
    source: 'rom' as const,
    controller: 'full' as const,
    requiresKbm: false,
    rating,
    favorite: true,
    installed: true,
  })),
);

/** The "whole library" on the demo gaming PC: favourites plus unfavourited and uninstalled games. */
const DEMO_PC_LIBRARY: Game[] = [
  ...DEMO_GAMES.filter((g) => g.hostId === 'gaming-pc'),
  steamGame('Portal 2', 620, 'full', 'E10', { favorite: false }),
  steamGame('Hollow Knight', 367520, 'full', 'E10', { favorite: false }),
  steamGame('Celeste', 504230, 'full', 'E10', { favorite: false, installed: false }),
  steamGame('Terraria', 105600, 'full', 'T', { favorite: false }),
  steamGame('Rocket League', 252950, 'full', 'E', { favorite: false, installed: false, store: 'Epic', source: 'playnite' }),
  steamGame('Halo Infinite', 1240440, 'full', 'T', { favorite: false, installed: false, store: 'Xbox', source: 'playnite' }),
  steamGame('Minecraft Dungeons', 1672970, 'full', 'E10', { favorite: false, store: 'Xbox', source: 'playnite' }),
  steamGame('Cities: Skylines', 255710, 'none', 'E', { favorite: false, installed: false }),
].sort((a, b) => a.title.localeCompare(b.title));

const DEMO_PLATFORMS: Record<string, string[]> = {
  'Super Nintendo Entertainment System': ['Super Mario World', 'Chrono Trigger', 'Donkey Kong Country', 'Super Metroid', 'EarthBound', 'Kirby Super Star', 'F-Zero', 'Star Fox'],
  'Nintendo 64': ['Super Mario 64', 'GoldenEye 007', 'Mario Kart 64', 'Banjo-Kazooie', 'Star Fox 64', 'Paper Mario'],
  'Sega Genesis': ['Sonic the Hedgehog', 'Streets of Rage 2', 'Gunstar Heroes', 'Phantasy Star IV', 'Ecco the Dolphin'],
  'Sony Playstation': ['Final Fantasy VII', 'Crash Bandicoot', 'Spyro the Dragon', 'Metal Gear Solid', 'Tekken 3', 'Gran Turismo'],
};

/** Big, believable platform lists for demo browsing: each title plus regional/rev variants. */
function demoPlatform(name: string): Game[] {
  const titles = DEMO_PLATFORMS[name] ?? [];
  const variants = ['', ' (USA)', ' (Europe)', ' (Japan)', ' (Rev 1)', ' (Beta)', ' (Proto)', ' (Hack)', ' DX', ' Deluxe', ' Remix', ' II'];
  return titles
    .flatMap((t) => variants.map((v) => `${t}${v}`))
    .sort()
    .map((title, i) => ({
      id: `lb-demo-${name.slice(0, 4)}-${i}`,
      hostId: 'emulator-pc',
      hostName: 'Emulator PC',
      title,
      platform: name,
      source: 'launchbox' as const,
      controller: 'full' as const,
      requiresKbm: false,
      rating: i % 5 === 0 ? 'T' : 'E',
      favorite: i % 9 === 0,
      installed: true,
    }));
}

function demoFind(id: string): Game | undefined {
  for (const name of Object.keys(DEMO_PLATFORMS)) {
    const hit = demoPlatform(name).find((g) => g.id === id);
    if (hit) return hit;
  }
  return undefined;
}

const DEMO_BLURBS: Record<string, string> = {
  'Elden Ring': 'Rise, Tarnished, and be guided by grace to brandish the power of the Elden Ring and become an Elden Lord in the Lands Between.',
  'Stardew Valley': 'You’ve inherited your grandfather’s old farm plot in Stardew Valley. Armed with hand-me-down tools and a few coins, you set out to begin your new life.',
  'Civilization VI': 'Build an empire to stand the test of time. Expand across the map, advance your culture and compete against history’s greatest leaders.',
  'Super Metroid': 'Samus Aran returns to planet Zebes to recover the stolen Metroid larva in this landmark of exploration and atmosphere.',
};
