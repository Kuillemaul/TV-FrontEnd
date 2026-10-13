import { randomUUID } from 'node:crypto';
import type { AlertsConfig } from './config.js';
import type { HaEntity } from './providers/homeassistant.js';

export interface Alert {
  id: string;
  kind: 'doorbell' | 'info' | 'warning';
  title: string;
  message?: string;
  /** camera.* entity to show live */
  camera?: string;
  /** Poster/picture shown in the pop-up. */
  image?: string;
  /** A button on the pop-up ("Watch" a newly downloaded film in Plex). */
  action?: AlertAction;
  seconds: number;
  at: number;
}

export type AlertAction =
  /** Play a newly downloaded film/episode in Plex. */
  | { label: string; kind: 'watch'; title: string; year?: number; mediaType: 'movie' | 'tv'; season?: number; episode?: number }
  /** Sleep-timer warning: add more time. */
  | { label: string; kind: 'sleep-extend'; minutes: number }
  /** Doorbell: keep the camera up in a corner. */
  | { label: string; kind: 'pip'; entity: string };

const DOORBELL_ON = new Set(['on', 'ringing', 'pressed', 'detected']);

/**
 * Turns Home Assistant state changes (and lab outages) into on-screen alerts:
 * the doorbell with its camera, "the washer is done", "garage door opened"…
 */
export class AlertService {
  private recent: Alert[] = [];

  constructor(
    private readonly cfg: AlertsConfig,
    private readonly deliver: (alert: Alert) => void,
  ) {}

  get(id: string): Alert | undefined {
    return this.recent.find((a) => a.id === id);
  }

  get history(): Alert[] {
    return this.recent;
  }

  raise(input: Omit<Alert, 'id' | 'at'>): Alert {
    const alert: Alert = { ...input, id: randomUUID().slice(0, 8), at: Date.now() };
    this.recent = [alert, ...this.recent].slice(0, 20);
    this.deliver(alert);
    return alert;
  }

  /** Feed every Home Assistant state change through here. */
  onState(entity: HaEntity, old: HaEntity | null): void {
    if (old && old.state === entity.state && !entity.entity_id.startsWith('event.')) return;
    const bell = this.cfg.doorbell;
    if (bell && entity.entity_id === bell.entity) {
      // binary_sensor goes "on"; event.* entities change their timestamp state on every press.
      const rang = entity.entity_id.startsWith('event.') ? old !== null && old.state !== entity.state : DOORBELL_ON.has(entity.state);
      if (rang && entity.state !== 'unavailable') {
        this.raise({
          kind: 'doorbell',
          title: 'Someone’s at the door',
          camera: bell.camera,
          seconds: bell.seconds,
          action: bell.camera ? { label: 'Keep camera up', kind: 'pip', entity: bell.camera } : undefined,
        });
      }
      return;
    }
    for (const rule of this.cfg.rules) {
      if (rule.entity !== entity.entity_id) continue;
      if (rule.to !== undefined && entity.state !== rule.to) continue;
      if (rule.from !== undefined && old?.state !== rule.from) continue;
      if (!old) continue; // ignore the initial state on connect
      this.raise({ kind: 'info', title: rule.title, message: rule.message, camera: rule.camera, seconds: rule.seconds ?? 12 });
    }
  }

  onLabChange(name: string, up: boolean): void {
    if (!this.cfg.labDown) return;
    this.raise(
      up
        ? { kind: 'info', title: `${name} is back up`, seconds: 8 }
        : { kind: 'warning', title: `${name} is down`, message: 'Hearth can’t reach it. Check the Lab page.', seconds: 15 },
    );
  }
}
