import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RecentGame {
  hostId: string;
  gameId: string;
  title: string;
  art?: string;
  playedAt: number;
}

interface PersistedState {
  recentGames: RecentGame[];
  lastChannel?: string;
  /** Minutes Hearth has streamed each game, keyed "<hostId>:<gameId>". */
  playtime: Record<string, number>;
  /** Recent wake-up durations (seconds) per gaming PC. */
  wakeTimes: Record<string, number[]>;
  /** TV-wide switches set from Settings. */
  settings: { scenes: boolean; wakeWord: boolean; alertsOverApps: boolean };
  /** Phone remotes that have been paired (token → label). */
  remoteTokens: Record<string, { label: string; pairedAt: number }>;
}

/** Small JSON store for things the UI should remember across restarts. */
export class StateStore {
  private data: PersistedState = {
    recentGames: [],
    playtime: {},
    wakeTimes: {},
    settings: { scenes: true, wakeWord: false, alertsOverApps: true },
    remoteTokens: {},
  };
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...saved.settings } };
    } catch {
      /* first run */
    }
  }

  get recentGames(): RecentGame[] {
    return this.data.recentGames;
  }

  get lastChannel(): string | undefined {
    return this.data.lastChannel;
  }

  addRecentGame(game: Omit<RecentGame, 'playedAt'>): void {
    const rest = this.data.recentGames.filter((g) => !(g.hostId === game.hostId && g.gameId === game.gameId));
    this.data.recentGames = [{ ...game, playedAt: Date.now() }, ...rest].slice(0, 12);
    this.save();
  }

  get settings(): PersistedState['settings'] {
    return this.data.settings;
  }

  updateSettings(patch: Partial<PersistedState['settings']>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  playtime(key: string): number {
    return Math.round(this.data.playtime[key] ?? 0);
  }

  addPlaytime(key: string, minutes: number): void {
    this.data.playtime[key] = (this.data.playtime[key] ?? 0) + minutes;
    this.save();
  }

  recordWake(hostId: string, seconds: number): void {
    this.data.wakeTimes[hostId] = [...(this.data.wakeTimes[hostId] ?? []), Math.round(seconds)].slice(-5);
    this.save();
  }

  /** Average of the last few wake-ups, in seconds. */
  wakeEstimate(hostId: string): number | null {
    const t = this.data.wakeTimes[hostId];
    return t?.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null;
  }

  get remoteTokens(): PersistedState['remoteTokens'] {
    return this.data.remoteTokens;
  }

  addRemoteToken(token: string, label: string): void {
    this.data.remoteTokens[token] = { label, pairedAt: Date.now() };
    this.save();
  }

  clearRemoteTokens(): void {
    this.data.remoteTokens = {};
    this.save();
  }

  setLastChannel(id: string): void {
    this.data.lastChannel = id;
    this.save();
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
