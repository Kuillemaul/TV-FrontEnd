import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus, ForegroundSession } from './bus.js';
import { expand, type HearthConfig, type LaunchSpec } from './config.js';

interface Running extends ForegroundSession {
  proc: ChildProcess;
  onExit?: () => void;
}

/**
 * Owns the single "foreground" app (Plex, a browser app, mpv, Moonlight…).
 * The Hearth shell stays running underneath; when the foreground app exits the
 * compositor shows the shell again and the UI is told to refocus.
 */
export class Launcher {
  private current: Running | null = null;

  constructor(
    private readonly config: HearthConfig,
    private readonly bus: EventBus,
    private readonly log: { info: (m: string) => void; error: (m: string) => void },
  ) {}

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

    proc.once('exit', (code) => {
      this.log.info(`${id} exited (${code})`);
      if (this.current === running) {
        this.current = null;
        this.bus.emit({ type: 'session', session: null });
      }
      running.onExit?.();
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
