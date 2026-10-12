import type { ForegroundSession } from './bus.js';
import type { SceneRule, ServiceCall } from './config.js';

/** Does a session id ("app:plex", "livetv", "game:pc:steam-1") match a rule pattern ("app:*", "game:*", "*")? */
export function matches(sessionId: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === '*' || p === sessionId) return true;
    if (p.endsWith('*')) return sessionId.startsWith(p.slice(0, -1));
    // "plex" is shorthand for "app:plex"
    return `app:${p}` === sessionId;
  });
}

/**
 * Scenes that follow what's on screen, e.g. dim the lights when Plex or Live TV starts and
 * bring them back when it stops. Toggled from Settings ("Movie-time lights").
 */
export class SceneAutomation {
  constructor(
    private readonly rules: SceneRule[],
    private readonly call: (c: ServiceCall) => Promise<void>,
    private readonly enabled: () => boolean,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  handle(event: 'start' | 'stop', session: ForegroundSession): void {
    if (!this.enabled()) return;
    for (const rule of this.rules) {
      const action = event === 'start' ? rule.start : rule.stop;
      if (!action || !matches(session.id, rule.match)) continue;
      this.log.info(`scene "${rule.name}" (${event} ${session.id}): ${action.service}`);
      this.call(action).catch((err) => this.log.warn(`scene "${rule.name}": ${(err as Error).message}`));
    }
  }
}
