/**
 * Battery cameras (Eufy doorbells, eufyCams) only stream when asked. While anything on the TV shows a
 * camera, keep its live stream running through Home Assistant; stop it shortly after the last viewer
 * leaves so the battery isn't drained.
 *
 * Uses the Eufy Security integration's services when Home Assistant has them, or the services named
 * in config.yaml (homeassistant.cameraStream: { start: domain.service, stop: domain.service }).
 */

export interface StreamServices {
  start: string;
  stop?: string;
}

interface HaLike {
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void>;
  fetch(path: string): Promise<Response>;
}

const EUFY: StreamServices = { start: 'eufy_security.start_p2p_livestream', stop: 'eufy_security.stop_p2p_livestream' };

export class CameraStreams {
  private viewers = new Map<string, number>();
  private stopTimers = new Map<string, NodeJS.Timeout>();
  private services: { at: number; value: StreamServices | null } | null = null;

  constructor(
    private readonly ha: HaLike | undefined,
    private readonly configured: StreamServices | undefined,
    private readonly log: { warn: (m: string) => void },
    private readonly stopAfterMs = 20_000,
  ) {}

  /** Which services start/stop a stream: config.yaml, else Eufy's if Home Assistant has them. */
  private async resolve(): Promise<StreamServices | null> {
    if (this.configured) return this.configured;
    if (!this.ha) return null;
    if (this.services && Date.now() - this.services.at < 10 * 60_000) return this.services.value;
    let value: StreamServices | null = null;
    try {
      const res = await this.ha.fetch('/api/services');
      const domains = (await res.json()) as Array<{ domain: string; services: Record<string, unknown> }>;
      const eufy = domains.find((d) => d.domain === 'eufy_security');
      if (eufy && 'start_p2p_livestream' in eufy.services) value = EUFY;
    } catch {
      /* Home Assistant not reachable; try again later */
    }
    this.services = { at: Date.now(), value };
    return value;
  }

  private async call(service: string, entity: string): Promise<void> {
    const [domain, name] = service.split('.');
    await this.ha!.callService(domain, name, { entity_id: entity });
  }

  /** A viewer opened this camera. Resolves true if a stream was (already) started. */
  async open(entity: string): Promise<boolean> {
    const pending = this.stopTimers.get(entity);
    if (pending) {
      clearTimeout(pending);
      this.stopTimers.delete(entity);
    }
    const count = (this.viewers.get(entity) ?? 0) + 1;
    this.viewers.set(entity, count);
    const svc = await this.resolve();
    if (!svc) return false;
    if (count === 1 && !pending) {
      await this.call(svc.start, entity).catch((err) => this.log.warn(`camera ${entity}: couldn't start the stream: ${(err as Error).message}`));
    }
    return true;
  }

  /** A viewer closed it; stop the stream once nobody has watched for a little while. */
  close(entity: string): void {
    const count = Math.max(0, (this.viewers.get(entity) ?? 1) - 1);
    this.viewers.set(entity, count);
    if (count > 0) return;
    const timer = setTimeout(() => {
      this.stopTimers.delete(entity);
      if ((this.viewers.get(entity) ?? 0) > 0) return;
      void this.resolve().then((svc) => {
        if (svc?.stop) void this.call(svc.stop, entity).catch(() => undefined);
      });
    }, this.stopAfterMs);
    timer.unref();
    this.stopTimers.set(entity, timer);
  }
}
