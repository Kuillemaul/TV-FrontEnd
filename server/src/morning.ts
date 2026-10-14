/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MorningConfig } from './config.js';

/** The morning screen's data, all from Home Assistant: calendars, weather and to-do lists. */

export interface DayEvent {
  calendar: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
}

export interface MorningData {
  events: DayEvent[];
  tomorrow: DayEvent[];
  weather: {
    condition: string;
    temperature: number | null;
    unit: string;
    high: number | null;
    low: number | null;
    rain: number | null;
    hourly: Array<{ time: number; temperature: number | null; condition: string }>;
  } | null;
  todo: Array<{ list: string; items: string[] }>;
  news: { kind: 'channel'; id: string; name: string } | { kind: 'app'; id: string; name: string } | null;
  errors: string[];
}

/** Home Assistant calendar event → DayEvent (all-day events have date, timed ones dateTime). */
export function toDayEvent(calendar: string, e: any): DayEvent | null {
  const startRaw = e?.start?.dateTime ?? e?.start?.date ?? e?.start;
  const endRaw = e?.end?.dateTime ?? e?.end?.date ?? e?.end;
  if (!startRaw) return null;
  const allDay = Boolean(e?.start?.date && !e?.start?.dateTime) || /^\d{4}-\d{2}-\d{2}$/.test(String(startRaw));
  // All-day dates are local days, not UTC midnight.
  const parse = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`).getTime() : Date.parse(v));
  const start = parse(String(startRaw));
  const end = endRaw ? parse(String(endRaw)) : start;
  if (!Number.isFinite(start)) return null;
  return { calendar, title: String(e.summary ?? e.message ?? 'Event'), start, end, allDay, location: e.location || undefined };
}

/** All-day first, then by time; drop duplicates (the same event on two shared calendars). */
export function sortEvents(list: DayEvent[]): DayEvent[] {
  const seen = new Set<string>();
  return list
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
    .filter((e) => {
      const key = `${e.title.toLowerCase()}|${e.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Is "now" inside the morning window ("05:00"–"10:00", local time)? */
export function inWindow(now: Date, start: string, end: string): boolean {
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const m = now.getHours() * 60 + now.getMinutes();
  const a = mins(start);
  const b = mins(end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

interface HaLike {
  entityIds(domain: string): string[];
  entity(id: string): { state: string; attributes: Record<string, unknown> } | undefined;
  calendarEvents(id: string, start: Date, end: Date): Promise<any[]>;
  forecast(id: string, type: 'daily' | 'hourly'): Promise<any[]>;
  todoItems(id: string): Promise<Array<{ summary: string; status: string }>>;
}

const nameOf = (ha: HaLike, id: string) => String(ha.entity(id)?.attributes.friendly_name ?? id.split('.')[1].replace(/_/g, ' '));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export async function buildMorning(
  ha: HaLike,
  cfg: MorningConfig,
  weatherEntity: string | undefined,
  news: MorningData['news'],
  now = new Date(),
): Promise<MorningData> {
  const errors: string[] = [];
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const tomorrowEnd = new Date(dayStart.getTime() + 2 * 86_400_000);

  const calendars = cfg.calendars.length ? cfg.calendars : ha.entityIds('calendar');
  const lists = cfg.todo.length ? cfg.todo : ha.entityIds('todo');

  const [eventLists, weather, todo] = await Promise.all([
    Promise.all(
      calendars.map((id) =>
        ha
          .calendarEvents(id, dayStart, tomorrowEnd)
          .then((list) => list.map((e) => toDayEvent(nameOf(ha, id), e)).filter((e): e is DayEvent => Boolean(e)))
          .catch((err) => {
            errors.push(`${id}: ${(err as Error).message}`);
            return [] as DayEvent[];
          }),
      ),
    ),
    (async () => {
      if (!weatherEntity) return null;
      const w = ha.entity(weatherEntity);
      if (!w) return null;
      const [daily, hourly] = await Promise.all([
        ha.forecast(weatherEntity, 'daily').catch(() => []),
        ha.forecast(weatherEntity, 'hourly').catch(() => []),
      ]);
      const today = daily[0] ?? {};
      return {
        condition: w.state,
        temperature: num(w.attributes.temperature),
        unit: String(w.attributes.temperature_unit ?? '°'),
        high: num(today.temperature),
        low: num(today.templow),
        rain: num(today.precipitation_probability),
        hourly: hourly
          .filter((h: any) => Date.parse(h.datetime) > now.getTime())
          .slice(0, 8)
          .map((h: any) => ({ time: Date.parse(h.datetime), temperature: num(h.temperature), condition: String(h.condition ?? '') })),
      };
    })().catch((err) => {
      errors.push(`weather: ${(err as Error).message}`);
      return null;
    }),
    Promise.all(
      lists.map((id) =>
        ha
          .todoItems(id)
          .then((items) => ({ list: nameOf(ha, id), items: items.filter((i) => i.status === 'needs_action').map((i) => i.summary).slice(0, 8) }))
          .catch(() => ({ list: nameOf(ha, id), items: [] as string[] })),
      ),
    ),
  ]);

  const all = sortEvents(eventLists.flat());
  const endOf = (e: DayEvent) => (e.allDay ? e.end : Math.max(e.end, e.start));
  return {
    // Today: anything not over yet (all-day events count as today's).
    events: all.filter((e) => e.start < dayEnd.getTime() && (e.allDay || endOf(e) > now.getTime())),
    tomorrow: all.filter((e) => e.start >= dayEnd.getTime() && e.start < tomorrowEnd.getTime()).slice(0, 4),
    weather,
    todo: todo.filter((t) => t.items.length).slice(0, 3),
    news,
    errors,
  };
}
