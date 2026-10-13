/**
 * Sleep timer: "turn off in an hour". A minute before, a pop-up offers to keep watching; at the
 * end the app on screen is closed, the TV is switched off (HDMI-CEC, if set up) and the PC sleeps.
 */
export class SleepTimer {
  private endsAt: number | null = null;
  private warnTimer?: NodeJS.Timeout;
  private endTimer?: NodeJS.Timeout;

  constructor(
    private readonly hooks: {
      warn: () => void;
      sleep: () => Promise<void>;
      changed: (endsAt: number | null) => void;
    },
  ) {}

  get remainingMinutes(): number | null {
    return this.endsAt ? Math.max(0, Math.ceil((this.endsAt - Date.now()) / 60_000)) : null;
  }

  get ends(): number | null {
    return this.endsAt;
  }

  /** minutes > 0 (re)starts the timer; 0 cancels it. */
  set(minutes: number): void {
    clearTimeout(this.warnTimer);
    clearTimeout(this.endTimer);
    this.endsAt = minutes > 0 ? Date.now() + minutes * 60_000 : null;
    if (this.endsAt) {
      const ms = this.endsAt - Date.now();
      if (ms > 90_000) this.warnTimer = setTimeout(() => this.hooks.warn(), ms - 60_000);
      this.endTimer = setTimeout(() => {
        this.endsAt = null;
        this.hooks.changed(null);
        void this.hooks.sleep();
      }, ms);
    }
    this.hooks.changed(this.endsAt);
  }

  extend(minutes: number): void {
    this.set((this.remainingMinutes ?? 0) + minutes);
  }
}

/** "1 hour", "1 hour 30 minutes", "45 minutes". */
export function sayMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hs = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const ms = r ? `${r} minute${r === 1 ? '' : 's'}` : '';
  return [hs, ms].filter(Boolean).join(' ') || 'less than a minute';
}
