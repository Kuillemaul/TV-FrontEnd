import type { ImmichClient } from './providers/immich.js';

/**
 * Keeps Immich's heavy jobs (thumbnails, video conversion, face recognition…) out of the way: paused
 * while anything plays on the TV (a game stream, Live TV, an app) or while someone is using the PC
 * that runs Immich's machine learning, resumed a couple of minutes after both are free.
 */
export class ImmichGovernor {
  private paused: boolean | null = null;
  private onScreen = false;
  private pcBusy = false;
  private resumeTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  reason = '';

  constructor(
    private readonly immich: Pick<ImmichClient, 'setPaused'>,
    private readonly opts: {
      /** Is someone using the machine-learning PC? (null = no such PC set). */
      pcBusy?: () => Promise<string | null>;
      log: { info: (m: string) => void; warn: (m: string) => void };
      resumeAfterMs?: number;
      pollMs?: number;
    },
  ) {}

  start(): void {
    // Hearth may have stopped while Immich was paused: start from "free".
    void this.apply(false, 'starting');
    if (this.opts.pcBusy) {
      const poll = async () => {
        const busy = await this.opts.pcBusy!().catch(() => null);
        this.pcBusy = Boolean(busy);
        this.update(busy ?? undefined);
      };
      this.pollTimer = setInterval(() => void poll(), this.opts.pollMs ?? 60_000);
      this.pollTimer.unref?.();
    }
  }

  stop(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.resumeTimer);
  }

  /** Something started or stopped playing on the TV. */
  session(active: boolean, title?: string): void {
    this.onScreen = active;
    this.update(active ? `${title ?? 'Something'} is on` : undefined);
  }

  get isPaused(): boolean {
    return this.paused === true;
  }

  private update(why?: string): void {
    const busy = this.onScreen || this.pcBusy;
    if (busy) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
      if (this.paused !== true) void this.apply(true, why ?? 'busy');
      return;
    }
    // Wait a little before resuming: going Home between episodes shouldn't kick off a burst of work.
    if (this.paused === true && !this.resumeTimer) {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = undefined;
        if (!this.onScreen && !this.pcBusy) void this.apply(false, 'free again');
      }, this.opts.resumeAfterMs ?? 120_000);
      this.resumeTimer.unref?.();
    }
  }

  private async apply(paused: boolean, why: string): Promise<void> {
    this.paused = paused;
    this.reason = paused ? why : '';
    try {
      await this.immich.setPaused(paused);
      this.opts.log.info(`immich: jobs ${paused ? 'paused' : 'resumed'} (${why})`);
    } catch (err) {
      this.opts.log.warn(`immich: couldn’t ${paused ? 'pause' : 'resume'} jobs: ${(err as Error).message}`);
    }
  }
}
