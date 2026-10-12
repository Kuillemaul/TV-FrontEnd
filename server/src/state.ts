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
}

/** Small JSON store for things the UI should remember across restarts. */
export class StateStore {
  private data: PersistedState = { recentGames: [] };
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    try {
      this.data = { ...this.data, ...JSON.parse(readFileSync(this.file, 'utf8')) };
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

  setLastChannel(id: string): void {
    this.data.lastChannel = id;
    this.save();
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
