import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus, ForegroundSession } from './bus.js';
import { expand, type HearthConfig, type LaunchSpec } from './config.js';

interface Running extends ForegroundSession {
  proc: ChildProcess;
  onExit?: () => void;
}

export type SessionListener = (event: 'start' | 'stop', session: ForegroundSession) => void;

/**
 * Owns the single "foreground" app (Plex, a browser app, mpv, Moonlight…).
 * The Hearth shell stays running underneath; when the foreground app exits the
 * compositor shows the shell again and the UI is told to refocus.
 */
export class Launcher {
  private current: Running | null = null;
  private listeners = new Set<SessionListener>();
  private overlayProc: ChildProcess | null = null;

  constructor(
    private readonly config: HearthConfig,
    private readonly bus: EventBus,
    private readonly log: { info: (m: string) => void; error: (m: string) => void },
  ) {}

  /** Called when a foreground app starts or exits (scenes, screen time…). */
  onSession(fn: SessionListener): void {
    this.listeners.add(fn);
  }

  private notify(event: 'start' | 'stop', s: ForegroundSession): void {
    for (const fn of this.listeners) {
      try {
        fn(event, s);
      } catch (err) {
        this.log.error(`session listener: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Show a page above whatever is on screen (doorbell, alerts) for a few seconds, without
   * touching the foreground app. Under cage it covers the screen, then the app returns.
   */
  showOverlay(url: string, seconds: number): void {
    this.closeOverlay();
    const { argv } = this.commandFor('overlay', { type: 'web', url });
    try {
      const proc = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
      proc.on('error', (err) => this.log.error(`overlay: ${err.message}`));
      this.overlayProc = proc;
      setTimeout(() => {
        if (this.overlayProc === proc) this.closeOverlay();
      }, seconds * 1000);
    } catch (err) {
      this.log.error(`overlay: ${(err as Error).message}`);
    }
  }

  closeOverlay(): void {
    if (this.overlayProc?.pid) killGroup(this.overlayProc.pid, 'SIGTERM');
    this.overlayProc = null;
  }

  get session(): ForegroundSession | null {
    if (!this.current) return null;
    const { id, title, startedAt } = this.current;
    return { id, title, startedAt };
  }

  /** Build the argv for a launch spec (exported for tests). */
  commandFor(id: string, spec: LaunchSpec): { argv: string[]; env?: Record<string, string> } {
    if (spec.type === 'command') return { argv: spec.command, env: spec.env };
    const profile = join(this.config.stateDir, 'browser', id.replace(/[^\w.-]/g, '_'));
    mkdirSync(profile, { recursive: true });
    const argv = expand(this.config.browser, { url: spec.url, profile });
    if (spec.userAgent) argv.splice(1, 0, `--user-agent=${spec.userAgent}`);
    return { argv };
  }

  async launch(id: string, title: string, spec: LaunchSpec, onExit?: () => void): Promise<void> {
    if (this.current) await this.stop();
    const { argv, env } = this.commandFor(id, spec);
    this.log.info(`launch ${id}: ${argv.join(' ')}`);

    const proc = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      detached: true, // own process group so stop() can take children with it
    });

    await new Promise<void>((resolveSpawn, reject) => {
      proc.once('spawn', resolveSpawn);
      proc.once('error', (err) => reject(new Error(`Could not start ${title}: ${err.message}`)));
    });

    const running: Running = { id, title, startedAt: Date.now(), proc, onExit };
    this.current = running;
    this.bus.emit({ type: 'session', session: this.session });
    this.notify('start', this.session!);

    proc.once('exit', (code) => {
      this.log.info(`${id} exited (${code})`);
      if (this.current === running) {
        this.current = null;
        this.bus.emit({ type: 'session', session: null });
      }
      running.onExit?.();
      this.notify('stop', { id: running.id, title: running.title, startedAt: running.startedAt });
    });
  }

  /** Close the foreground app (SIGTERM, then SIGKILL after 4s). */
  async stop(): Promise<void> {
    const running = this.current;
    if (!running?.proc.pid) return;
    const pid = running.proc.pid;
    const exited = new Promise<void>((r) => running.proc.once('exit', () => r()));
    killGroup(pid, 'SIGTERM');
    const timer = setTimeout(() => killGroup(pid, 'SIGKILL'), 4000);
    await exited;
    clearTimeout(timer);
  }

  /** Run a short-lived system command (volume, power…) and wait for it. */
  run(argv: string[]): Promise<void> {
    return new Promise((resolveRun, reject) => {
      const p = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
      p.once('error', reject);
      p.once('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${argv[0]} exited ${code}`))));
    });
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
