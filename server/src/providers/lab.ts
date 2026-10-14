import type { LabConfig } from '../config.js';

export interface ServiceStatus {
  name: string;
  url: string;
  open: boolean;
  up: boolean | null;
  latencyMs: number | null;
  checkedAt: number | null;
}

/** Periodically health-checks homelab services listed in config. */
export class LabMonitor {
  private status: ServiceStatus[];
  private timer?: NodeJS.Timeout;

  /** Called when a service goes from up to down, or recovers. */
  onChange?: (svc: ServiceStatus, wasUp: boolean | null) => void;

  constructor(private readonly cfg: LabConfig) {
    this.status = cfg.services.map((s) => ({ name: s.name, url: s.url, open: Boolean(s.open), up: null, latencyMs: null, checkedAt: null }));
  }

  start(intervalMs = 30_000): void {
    if (this.cfg.services.length === 0 || this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The services list changed (added from the TV or phone): keep known statuses, check the rest now. */
  reload(): void {
    const old = this.status;
    this.status = this.cfg.services.map((s) => {
      const prev = old.find((o) => o.name === s.name && o.url === s.url);
      return prev ? { ...prev, open: Boolean(s.open) } : { name: s.name, url: s.url, open: Boolean(s.open), up: null, latencyMs: null, checkedAt: null };
    });
    if (this.timer) void this.checkAll();
    else this.start();
  }

  get services(): ServiceStatus[] {
    return this.status;
  }

  private async checkAll(): Promise<void> {
    await Promise.all(
      this.cfg.services.map(async (svc, i) => {
        const started = performance.now();
        let up = false;
        try {
          // Any HTTP response (even 401/403) means the service is alive.
          await fetch(svc.check ?? svc.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
          up = true;
        } catch {
          up = false;
        }
        // The list may have been edited while this check was running.
        if (this.status[i]?.name !== svc.name) return;
        const wasUp = this.status[i].up;
        this.status[i] = {
          ...this.status[i],
          up,
          latencyMs: up ? Math.round(performance.now() - started) : null,
          checkedAt: Date.now(),
        };
        if (wasUp !== null && wasUp !== up) this.onChange?.(this.status[i], wasUp);
      }),
    );
  }
}
