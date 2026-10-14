import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { EventBus, ForegroundSession } from './bus.js';
import { expand, type HearthConfig, type LaunchSpec } from './config.js';

interface Running extends ForegroundSession {
  proc: ChildProcess;
  onExit?: (code: number | null) => void;
  /** Set for `flatpak run <app>`: the app lives in Flatpak's sandbox and needs `flatpak kill` too. */
  flatpak: string | null;
  /** Game streams: what Moonlight has printed so far (the tail), and who's waiting for a line. */
  output?: { text: string; waiters: Array<{ re: RegExp; done: (hit: boolean) => void }> };
}

/** The app id in a `flatpak run [--options] <app.id> [args]` command, else null. */
export function flatpakAppId(argv: string[]): string | null {
  if (!/(^|\/)flatpak$/.test(argv[0] ?? '') || argv[1] !== 'run') return null;
  return argv.slice(2).find((a) => !a.startsWith('-')) ?? null;
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

  async launch(id: string, title: string, spec: LaunchSpec, onExit?: (code: number | null) => void): Promise<void> {
    if (this.current) await this.stop();
    const { argv, env } = this.commandFor(id, spec);
    this.log.info(`launch ${id}: ${argv.join(' ')}`);

    // Game streams: Moonlight's output goes to moonlight.log (state folder) and is watched, so Hearth can
    // tell when the stream window starts drawing (waitForOutput).
    const watchOutput = id.startsWith('game:');
    let logFile: WriteStream | undefined;
    if (watchOutput) {
      try {
        mkdirSync(this.config.stateDir, { recursive: true });
        logFile = createWriteStream(join(this.config.stateDir, 'moonlight.log'));
        logFile.on('error', () => undefined);
      } catch {
        logFile = undefined;
      }
    }
    const proc = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: watchOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      detached: true, // own process group so stop() can take children with it
    });

    await new Promise<void>((resolveSpawn, reject) => {
      proc.once('spawn', resolveSpawn);
      proc.once('error', (err) => reject(new Error(`Could not start ${title}: ${err.message}`)));
    });

    const running: Running = { id, title, startedAt: Date.now(), proc, onExit, flatpak: flatpakAppId(argv) };
    if (watchOutput) {
      const output: NonNullable<Running['output']> = { text: '', waiters: [] };
      running.output = output;
      const onData = (chunk: Buffer) => {
        logFile?.write(chunk);
        output.text = (output.text + chunk.toString()).slice(-32_768);
        for (const w of [...output.waiters]) {
          if (w.re.test(output.text)) {
            output.waiters.splice(output.waiters.indexOf(w), 1);
            w.done(true);
          }
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('exit', () => {
        logFile?.end();
        for (const w of output.waiters.splice(0)) w.done(false);
      });
    }
    this.current = running;
    this.bus.emit({ type: 'session', session: this.session });
    this.notify('start', this.session!);

    proc.once('exit', (code) => {
      this.log.info(`${id} exited (${code})`);
      // An app that fails within seconds usually isn't installed (or crashed): say so instead of showing nothing.
      if (typeof code === 'number' && code !== 0 && Date.now() - running.startedAt < 8000 && !watchOutput) this.explainFailure(running, code);
      if (this.current === running) {
        this.current = null;
        this.bus.emit({ type: 'session', session: null });
      }
      running.onExit?.(code);
      this.notify('stop', { id: running.id, title: running.title, startedAt: running.startedAt });
    });
  }

  private explainFailure(running: Running, code: number): void {
    const generic = `${running.title} closed straight away (error ${code}).`;
    if (!running.flatpak) return this.bus.toast(generic, 'error');
    execFile('flatpak', ['info', running.flatpak], { timeout: 5000 }, (err) =>
      this.bus.toast(err ? `${running.title} isn’t installed on this TV. Install it from Settings → Connections or Apps → Edit apps.` : generic, 'error'),
    );
  }

  /**
   * Resolve true once the current session's app prints something matching `re` (game streams only), false
   * on timeout, exit or for other sessions.
   */
  waitForOutput(sessionId: string, re: RegExp, timeoutMs: number): Promise<boolean> {
    const output = this.current?.id === sessionId ? this.current.output : undefined;
    if (!output) return Promise.resolve(false);
    if (re.test(output.text)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        re,
        done: (hit: boolean) => {
          clearTimeout(timer);
          resolve(hit);
        },
      };
      const timer = setTimeout(() => {
        output.waiters.splice(output.waiters.indexOf(waiter), 1);
        resolve(false);
      }, timeoutMs);
      output.waiters.push(waiter);
    });
  }

  /** Close the foreground app (SIGTERM, then SIGKILL after 4s). */
  async stop(): Promise<void> {
    const running = this.current;
    if (!running?.proc.pid) return;
    const pid = running.proc.pid;
    const exited = new Promise<void>((r) => running.proc.once('exit', () => r()));
    // A Flatpak app (Plex HTPC, Moonlight…) runs in its own sandbox: signalling the `flatpak run`
    // wrapper can leave the app itself on screen. Ask Flatpak to close it as well.
    if (running.flatpak) this.flatpakKill(running.flatpak);
    // A game stream has nothing to save, and Moonlight shows its own window while it shuts down politely:
    // end it at once. Everything else gets the chance to close cleanly first.
    killGroup(pid, running.id.startsWith('game:') ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => {
      killGroup(pid, 'SIGKILL');
      if (running.flatpak) this.flatpakKill(running.flatpak);
    }, 4000);
    await exited;
    clearTimeout(timer);
  }

  private flatpakKill(app: string): void {
    const p = spawn('flatpak', ['kill', app], { stdio: 'ignore' });
    p.on('error', (err) => this.log.error(`flatpak kill ${app}: ${err.message}`));
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
