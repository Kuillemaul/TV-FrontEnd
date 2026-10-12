import { execFile } from 'node:child_process';
import type { DisplayMode, StateStore } from './state.js';

/**
 * Screen resolution and refresh rate, through wlr-randr (the Wayland output-management
 * protocol that cage speaks). A new mode must be confirmed within REVERT_SECONDS or it is
 * undone, so a mode the TV can't show never leaves you with a black screen.
 */

export interface Mode {
  width: number;
  height: number;
  refresh: number;
  preferred: boolean;
  current: boolean;
}

export interface Output {
  name: string;
  description: string;
  enabled: boolean;
  modes: Mode[];
}

export interface DisplayStatus {
  available: boolean;
  error?: string;
  outputs: Output[];
  /** Waiting for "Keep" on a just-applied mode. */
  pending: { previous: DisplayMode; revertAt: number } | null;
}

export const REVERT_SECONDS = 15;

/** Parse `wlr-randr` text output (the format is the same across versions). */
export function parseWlrRandr(text: string): Output[] {
  const outputs: Output[] = [];
  let cur: Output | null = null;
  let inModes = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const m = /^(\S+)\s*(?:"(.*)")?/.exec(line)!;
      cur = { name: m[1], description: m[2] ?? m[1], enabled: true, modes: [] };
      outputs.push(cur);
      inModes = false;
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    const mode = /^(\d+)x(\d+) px(?:, ([\d.]+) Hz)?(?: \((.*)\))?/.exec(t);
    if (inModes && mode) {
      const flags = mode[4] ?? '';
      cur.modes.push({ width: +mode[1], height: +mode[2], refresh: Number(mode[3] ?? 0), preferred: /preferred/.test(flags), current: /current/.test(flags) });
      continue;
    }
    inModes = /^Modes:/.test(t);
    const enabled = /^Enabled: (yes|no)/.exec(t);
    if (enabled) cur.enabled = enabled[1] === 'yes';
  }
  return outputs;
}

/** The argv that switches an output to a mode. */
export const modeArgs = (m: DisplayMode) => ['--output', m.output, '--mode', m.refresh ? `${m.width}x${m.height}@${m.refresh}Hz` : `${m.width}x${m.height}`];

function wlrRandr(args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wlr-randr', args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missing ? 'Display settings need wlr-randr: sudo apt install wlr-randr' : stderr.trim() || err.message));
    });
  });
}

export class DisplayControl {
  private pending: { previous: DisplayMode; revertAt: number; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly state: StateStore,
    private readonly onReverted: () => void,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  async status(): Promise<DisplayStatus> {
    const pending = this.pending ? { previous: this.pending.previous, revertAt: this.pending.revertAt } : null;
    try {
      return { available: true, outputs: parseWlrRandr(await wlrRandr()), pending };
    } catch (err) {
      return { available: false, error: (err as Error).message, outputs: [], pending };
    }
  }

  private async current(output: string): Promise<DisplayMode | undefined> {
    const out = parseWlrRandr(await wlrRandr()).find((o) => o.name === output);
    const m = out?.modes.find((x) => x.current);
    return m ? { output, width: m.width, height: m.height, refresh: m.refresh } : undefined;
  }

  /** Switch modes now; it reverts by itself unless keep() is called in time. */
  async set(mode: DisplayMode): Promise<void> {
    const out = parseWlrRandr(await wlrRandr()).find((o) => o.name === mode.output);
    if (!out?.modes.some((m) => m.width === mode.width && m.height === mode.height && m.refresh === mode.refresh)) {
      throw new Error('The TV doesn’t offer that mode');
    }
    const previous = this.pending?.previous ?? (await this.current(mode.output));
    await wlrRandr(modeArgs(mode));
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    if (!previous) return;
    const timer = setTimeout(() => void this.revert(), REVERT_SECONDS * 1000);
    this.pending = { previous, revertAt: Date.now() + REVERT_SECONDS * 1000, timer };
  }

  async keep(): Promise<void> {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const now = await this.current(this.pending.previous.output);
    this.pending = null;
    if (now) this.state.setDisplay(now);
  }

  async revert(): Promise<void> {
    if (!this.pending) return;
    const { previous, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    try {
      await wlrRandr(modeArgs(previous));
    } catch (err) {
      this.log.warn(`display: could not revert (${(err as Error).message})`);
    }
    this.onReverted();
  }

  /** Back to the TV's own preferred mode, and forget the saved choice. */
  async auto(output: string): Promise<void> {
    await wlrRandr(['--output', output, '--preferred']);
    this.state.setDisplay(undefined);
  }

  /** Re-apply the mode saved in Settings when Hearth starts (if the TV still offers it). */
  async restore(): Promise<void> {
    const saved = this.state.display;
    if (!saved || this.pending || process.platform !== 'linux') return;
    // If the last attempt never finished, it took the TV session down with it: use the TV's default.
    if (this.state.displayRestoring && Date.now() - this.state.displayRestoring < 120_000) {
      this.log.warn('display: the saved mode crashed the session last time; using the TV default');
      this.state.setDisplay(undefined);
      this.state.setDisplayRestoring(undefined);
      return;
    }
    this.state.setDisplayRestoring(Date.now());
    try {
      const out = parseWlrRandr(await wlrRandr()).find((o) => o.name === saved.output);
      const m = out?.modes.find((x) => x.width === saved.width && x.height === saved.height && x.refresh === saved.refresh);
      if (m && !m.current) {
        await wlrRandr(modeArgs(saved));
        this.log.info(`display: restored ${saved.width}x${saved.height}@${saved.refresh}`);
      }
    } catch (err) {
      this.log.warn(`display: ${(err as Error).message}`);
    }
    // Survived: clear the marker a little later (a crash would happen right away).
    setTimeout(() => this.state.setDisplayRestoring(undefined), 10_000);
  }
}
