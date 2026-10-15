import type { WebSocket } from 'ws';

/** Server → UI events, pushed over /ws to every connected shell. */
export type UiEvent =
  | { type: 'session'; session: ForegroundSession | null }
  | { type: 'home' }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'game-status'; hostId: string; gameId: string; stage: GameStage; message: string }
  | { type: 'ha-state'; entity: unknown }
  | { type: 'ha-connection'; connected: boolean }
  /** Profiles or the active profile changed; UIs reload. */
  | { type: 'profiles' }
  | { type: 'alert'; alert: unknown }
  /** Screen time ran out / bedtime (kid profiles). */
  | { type: 'timesup'; reason: 'limit' | 'bedtime' }
  | { type: 'screentime' }
  /** A button pressed on the phone remote. */
  | { type: 'remote'; cmd: string; text?: string }
  | { type: 'settings' }
  | { type: 'games' }
  /** App tiles changed look. */
  | { type: 'apps' }
  /** Home lab services, sensors or actions were added, changed or removed. */
  | { type: 'lab' }
  /** App installs (setup screen / Connections) made progress. */
  | { type: 'installs' }
  /** The first-run setup moved on (TV and phone show the same step). */
  | { type: 'setup' }
  /** A network scan (finding servers) made progress. */
  | { type: 'discover' }
  | { type: 'display' }
  | { type: 'sleep'; endsAt: number | null }
  | { type: 'pip'; entity: string | null; name?: string }
  /** Run a UI action (from Home Assistant: go to a page, search…). */
  | { type: 'action'; action: unknown }
  | { type: 'pair'; hostId: string; stage: 'waking' | 'pairing' | 'auto-pin' | 'paired' | 'failed'; message: string };

export type GameStage = 'waking' | 'launching' | 'streaming' | 'ended' | 'error';

export interface ForegroundSession {
  id: string;
  title: string;
  startedAt: number;
}

export class EventBus {
  private clients = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
  }

  private observers = new Set<(event: UiEvent) => void>();

  /** Server-side listeners (the Home Assistant bridge publishes on profile/sleep changes). */
  observe(fn: (event: UiEvent) => void): void {
    this.observers.add(fn);
  }

  emit(event: UiEvent): void {
    for (const fn of this.observers) fn(event);
    const data = JSON.stringify(event);
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(data);
    }
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.emit({ type: 'toast', level, message });
  }
}
