import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from './profiles.js';

export interface ScreenTimeStatus {
  profileId: string;
  usedMinutes: number;
  /** Daily allowance including today's bonus; null = unlimited. */
  limitMinutes: number | null;
  remainingMinutes: number | null;
  bedtime: string | null;
  wakeTime: string | null;
  /** Why starting something is blocked right now, or null. */
  blocked: 'limit' | 'bedtime' | null;
}

interface Data {
  /** profileId → "YYYY-MM-DD" → minutes used */
  used: Record<string, Record<string, number>>;
  /** profileId → "YYYY-MM-DD" → bonus minutes granted by a parent */
  bonus: Record<string, Record<string, number>>;
}

const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** True if `now` falls in the bedtime window (which may wrap past midnight). */
export function inBedtime(now: Date, bedtime: string | null, wakeTime: string | null): boolean {
  if (!bedtime) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(bedtime);
  const end = minutesOfDay(wakeTime ?? '07:00');
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/**
 * Daily screen-time allowance and bedtime for kid profiles. Time counts while something is
 * playing (an app, Live TV or a game), not while browsing menus.
 */
export class ScreenTime {
  private data: Data = { used: {}, bonus: {} };
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'screentime.json');
    try {
      this.data = { ...this.data, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch {
      /* first run */
    }
  }

  private save(): void {
    // Keep two weeks of history.
    const keep = new Set(Array.from({ length: 14 }, (_, i) => day(new Date(Date.now() - i * 86400_000))));
    for (const table of [this.data.used, this.data.bonus]) {
      for (const days of Object.values(table)) for (const d of Object.keys(days)) if (!keep.has(d)) delete days[d];
    }
    writeFileSync(this.file, JSON.stringify(this.data));
  }

  addUsage(profileId: string, minutes: number, now = new Date()): void {
    const days = (this.data.used[profileId] ??= {});
    days[day(now)] = (days[day(now)] ?? 0) + minutes;
    this.save();
  }

  addBonus(profileId: string, minutes: number, now = new Date()): void {
    const days = (this.data.bonus[profileId] ??= {});
    days[day(now)] = (days[day(now)] ?? 0) + minutes;
    this.save();
  }

  status(profile: Profile, now = new Date()): ScreenTimeStatus {
    const limits = profile.kind === 'kid' ? profile.limits : undefined;
    const used = this.data.used[profile.id]?.[day(now)] ?? 0;
    const bonus = this.data.bonus[profile.id]?.[day(now)] ?? 0;
    const limit = limits?.dailyMinutes != null ? limits.dailyMinutes + bonus : null;
    const remaining = limit === null ? null : Math.max(0, limit - used);
    const bed = limits ? inBedtime(now, limits.bedtime, limits.wakeTime) : false;
    return {
      profileId: profile.id,
      usedMinutes: Math.floor(used),
      limitMinutes: limit,
      remainingMinutes: remaining === null ? null : Math.floor(remaining),
      bedtime: limits?.bedtime ?? null,
      wakeTime: limits?.wakeTime ?? null,
      blocked: bed && bonus === 0 ? 'bedtime' : remaining !== null && remaining <= 0 ? 'limit' : null,
    };
  }
}
