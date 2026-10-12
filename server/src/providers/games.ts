import type { EventBus, GameStage } from '../bus.js';
import { expand, type GameHostConfig, type GamingConfig } from '../config.js';
import type { Launcher } from '../launcher.js';
import type { StateStore } from '../state.js';
import { wake } from '../wol.js';

/** A game as reported by a Hearth PC agent. */
export interface AgentGame {
  id: string;
  title: string;
  platform: string;
  source: 'steam' | 'rom' | 'custom';
  /** Public artwork URL, or true if the agent serves art at /art/<id>. */
  art?: string | boolean;
  controller?: 'full' | 'partial' | 'none' | 'unknown';
  requiresKbm?: boolean;
}

export interface Game {
  id: string;
  hostId: string;
  hostName: string;
  title: string;
  platform: string;
  source: AgentGame['source'];
  art?: string;
  controller: NonNullable<AgentGame['controller']>;
  requiresKbm: boolean;
}

export interface HostStatus {
  id: string;
  name: string;
  online: boolean;
  canWake: boolean;
  games: number;
  error?: string;
}

const CACHE_MS = 5 * 60 * 1000;

export class GameService {
  private cache = new Map<string, { at: number; games: Game[] }>();
  private launching = false;

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

  private async online(h: GameHostConfig): Promise<boolean> {
    try {
      return (await this.agent(h, '/health', undefined, 2000)).ok;
    } catch {
      return false;
    }
  }

  async hosts(): Promise<HostStatus[]> {
    if (this.demo) {
      return [
        { id: 'gaming-pc', name: 'Gaming PC', online: true, canWake: true, games: DEMO_GAMES.filter((g) => g.hostId === 'gaming-pc').length },
        { id: 'emulator-pc', name: 'Emulator PC', online: false, canWake: true, games: DEMO_GAMES.filter((g) => g.hostId === 'emulator-pc').length },
      ];
    }
    return Promise.all(
      this.cfg.hosts.map(async (h) => ({
        id: h.id,
        name: h.name,
        online: await this.online(h),
        canWake: Boolean(h.mac),
        games: this.cache.get(h.id)?.games.length ?? 0,
      })),
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

  private async fetchHost(h: GameHostConfig, force: boolean): Promise<Game[]> {
    const cached = this.cache.get(h.id);
    if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.games;
    try {
      const res = await this.agent(h, '/games', undefined, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as AgentGame[];
      const games = list.map<Game>((g) => ({
        id: g.id,
        hostId: h.id,
        hostName: h.name,
        title: g.title,
        platform: g.platform,
        source: g.source,
        art: g.art === true ? `/api/games/${h.id}/art/${encodeURIComponent(g.id)}` : g.art || undefined,
        controller: g.controller ?? 'unknown',
        requiresKbm: this.kbm(h, g),
      }));
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

  async art(hostId: string, gameId: string): Promise<Response> {
    return this.agent(this.host(hostId), `/art/${encodeURIComponent(gameId)}`, undefined, 10000);
  }

  private status(hostId: string, gameId: string, stage: GameStage, message: string): void {
    this.bus.emit({ type: 'game-status', hostId, gameId, stage, message });
  }

  /** Wake the host if needed, start the game there, then stream it with Moonlight. */
  async launch(hostId: string, gameId: string): Promise<void> {
    if (this.demo) {
      this.status(hostId, gameId, 'error', 'Demo mode – add a gaming host and PC agent to config.yaml');
      return;
    }
    if (this.launching) throw new Error('A game is already starting');
    this.launching = true;
    const h = this.host(hostId);
    const game = (await this.fetchHost(h, false)).find((g) => g.id === gameId);
    const title = game?.title ?? gameId;

    try {
      if (!(await this.online(h))) {
        if (!h.mac) throw new Error(`${h.name} is offline and has no MAC address for Wake-on-LAN`);
        this.status(hostId, gameId, 'waking', `Waking ${h.name}…`);
        await wake(h.mac);
        const deadline = Date.now() + 120_000;
        while (!(await this.online(h))) {
          if (Date.now() > deadline) throw new Error(`${h.name} did not wake up within 2 minutes`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      this.status(hostId, gameId, 'launching', `Starting ${title} on ${h.name}…`);
      const res = await this.agent(h, '/launch', { method: 'POST', body: JSON.stringify({ id: gameId }) }, 30000);
      if (!res.ok) throw new Error(`${h.name} could not start ${title}: ${await res.text()}`);

      this.status(hostId, gameId, 'streaming', `Streaming ${title}`);
      this.state.addRecentGame({ hostId, gameId, title, art: game?.art });
      await this.launcher.launch(
        `game:${hostId}:${gameId}`,
        title,
        { type: 'command', command: expand(this.cfg.moonlight, { host: h.moonlightHost, app: h.moonlightApp }) },
        () => {
          this.status(hostId, gameId, 'ended', `${title} closed`);
          if (h.quitOnExit) this.agent(h, '/stop', { method: 'POST', body: '{}' }).catch(() => {});
        },
      );
    } catch (err) {
      this.status(hostId, gameId, 'error', (err as Error).message);
      throw err;
    } finally {
      this.launching = false;
    }
  }
}

const steamArt = (appid: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;

const DEMO_GAMES: Game[] = [
  ['Elden Ring', 1245620, 'full'],
  ['Cyberpunk 2077', 1091500, 'full'],
  ['Baldur’s Gate 3', 1086940, 'full'],
  ['Hades II', 1145350, 'full'],
  ['Factorio', 427520, 'partial'],
  ['Civilization VI', 289070, 'none'],
  ['Counter-Strike 2', 730, 'none'],
  ['Forza Horizon 5', 1551360, 'full'],
  ['Stardew Valley', 413150, 'full'],
  ['RimWorld', 294100, 'none'],
].map<Game>(([title, appid, controller]) => ({
  id: `steam-${appid}`,
  hostId: 'gaming-pc',
  hostName: 'Gaming PC',
  title: title as string,
  platform: 'PC',
  source: 'steam' as const,
  art: steamArt(appid as number),
  controller: controller as Game['controller'],
  requiresKbm: controller === 'none',
})).concat(
  [
    ['Super Metroid', 'SNES'],
    ['The Legend of Zelda: Ocarina of Time', 'N64'],
    ['Sonic the Hedgehog 2', 'Genesis'],
    ['Metroid Prime', 'GameCube'],
    ['Castlevania: Symphony of the Night', 'PlayStation'],
    ['Pokémon Emerald', 'Game Boy Advance'],
  ].map<Game>(([title, platform]) => ({
    id: `rom-${title}`,
    hostId: 'emulator-pc',
    hostName: 'Emulator PC',
    title,
    platform,
    source: 'rom' as const,
    controller: 'full' as const,
    requiresKbm: false,
  })),
);
