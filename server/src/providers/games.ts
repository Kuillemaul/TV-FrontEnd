import type { EventBus, GameStage } from '../bus.js';
import { expand, type GameHostConfig, type GamingConfig } from '../config.js';
import type { Launcher } from '../launcher.js';
import type { StateStore } from '../state.js';
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
}

const CACHE_MS = 5 * 60 * 1000;

export class GameService {
  private cache = new Map<string, { at: number; games: Game[] }>();
  private launching = false;
  private demoAwake = new Set(['gaming-pc']);

  constructor(
    private readonly cfg: GamingConfig,
    private readonly launcher: Launcher,
    private readonly bus: EventBus,
    private readonly state: StateStore,
  ) {}

  get demo(): boolean {
    return this.cfg.hosts.length === 0;
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

  private async health(h: GameHostConfig): Promise<AgentHealth | null> {
    try {
      const res = await this.agent(h, '/health', undefined, 2000);
      return res.ok ? ((await res.json()) as AgentHealth) : null;
    } catch {
      return null;
    }
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
      }));
    }
    return Promise.all(
      this.cfg.hosts.map(async (h) => {
        const health = await this.health(h);
        return {
          id: h.id,
          name: h.name,
          online: health !== null,
          canWake: Boolean(h.mac),
          games: this.cache.get(h.id)?.games.length ?? 0,
          uptime: health?.uptime ?? null,
          playing: health?.playing ?? null,
          wakeEstimate: this.state.wakeEstimate(h.id),
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

  private async fetchHost(h: GameHostConfig, force: boolean): Promise<Game[]> {
    const cached = this.cache.get(h.id);
    if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.games;
    try {
      const res = await this.agent(h, '/games', undefined, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const games = ((await res.json()) as AgentGame[]).map((g) => this.toGame(h, g));
      this.cache.set(h.id, { at: Date.now(), games });
      return games;
    } catch {
      // Host asleep/offline: keep showing the last known library.
      return cached?.games ?? [];
    }
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
  private watchForGameExit(h: GameHostConfig, sessionId: string): void {
    if (!h.endStreamOnGameExit) return;
    const timer = setInterval(async () => {
      if (this.launcher.session?.id !== sessionId) return clearInterval(timer);
      const health = await this.health(h);
      if (health?.gameRunning === false && this.launcher.session?.id === sessionId) {
        clearInterval(timer);
        this.bus.toast(`${health.playing ?? 'The game'} closed on ${h.name}`);
        await this.launcher.stop();
      }
    }, 4000);
  }

  /* ---------------- launching ---------------- */

  private status(hostId: string, gameId: string, stage: GameStage, message: string): void {
    this.bus.emit({ type: 'game-status', hostId, gameId, stage, message });
  }

  /** Wake the host if needed, start the game there, then stream it with Moonlight. */
  async launch(hostId: string, gameId: string, meta: { title?: string; art?: string } = {}): Promise<void> {
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

    try {
      if (!(await this.online(h))) {
        await this.wakeAndWait(h, () => this.status(hostId, gameId, 'waking', `Waking ${h.name}…`));
      }

      const moonlight = { type: 'command' as const, command: expand(this.cfg.moonlight, { host: h.moonlightHost, app: h.moonlightApp }) };
      const started = Date.now();
      let failed = false;
      const onStreamEnd = () => {
        this.state.addPlaytime(`${hostId}:${gameId}`, (Date.now() - started) / 60_000);
        if (!failed) this.status(hostId, gameId, 'ended', `${title} closed`);
        if (h.quitOnExit) this.agent(h, '/stop', { method: 'POST', body: '{}' }).catch(() => {});
      };
      const startGame = async (waitForDisplay: boolean) => {
        const res = await this.agent(
          h,
          '/launch',
          { method: 'POST', body: JSON.stringify({ id: gameId, waitForDisplay }) },
          waitForDisplay ? 75_000 : 30_000,
        );
        if (!res.ok) throw new Error(`${h.name} could not start ${title}: ${await res.text()}`);
      };

      if (h.virtualDisplay) {
        // Apollo: connect first so the virtual monitor exists (and the real ones switch off),
        // then the agent waits for it and starts the game on it.
        this.status(hostId, gameId, 'launching', `Connecting to ${h.name}…`);
        await this.launcher.launch(`game:${hostId}:${gameId}`, title, moonlight, onStreamEnd);
        try {
          await startGame(true);
        } catch (err) {
          failed = true;
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
