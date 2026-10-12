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

  constructor(private readonly cfg: LabConfig) {
    this.status = cfg.services.map((s) => ({ name: s.name, url: s.url, open: Boolean(s.open), up: null, latencyMs: null, checkedAt: null }));
  }

  start(intervalMs = 30_000): void {
    if (this.cfg.services.length === 0) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
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
        this.status[i] = {
          ...this.status[i],
          up,
          latencyMs: up ? Math.round(performance.now() - started) : null,
          checkedAt: Date.now(),
        };
      }),
    );
  }
}
