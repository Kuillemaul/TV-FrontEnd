import { Button } from '../components/Layout';
import { Icon } from '../components/Icon';
import { formatTime, useApi } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { useNow } from './Home';

interface DayEvent {
  calendar: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
}

interface Morning {
  enabled: boolean;
  name?: string;
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
  news: { kind: 'channel' | 'app'; id: string; name: string } | null;
}

const KEY = 'hearth-morning-shown';
const today = () => new Date().toDateString();

/** Should waking the TV now show the morning screen? (In the window, once a day.) */
export function morningDue(window: { start: string; end: string } | null | undefined): boolean {
  if (!window) return false;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const a = mins(window.start);
  const b = mins(window.end);
  const inside = a <= b ? m >= a && m < b : m >= a || m < b;
  if (!inside) return false;
  try {
    return localStorage.getItem(KEY) !== today();
  } catch {
    return true;
  }
}

export function markMorningShown(): void {
  try {
    localStorage.setItem(KEY, today());
  } catch {
    /* private mode: shows again next wake, harmless */
  }
}

const WEATHER: Record<string, string> = {
  'clear-night': '🌙', cloudy: '☁️', exceptional: '⚠️', fog: '🌫️', hail: '🌨️', lightning: '🌩️', 'lightning-rainy': '⛈️',
  partlycloudy: '⛅', pouring: '🌧️', rainy: '🌦️', snowy: '❄️', 'snowy-rainy': '🌨️', sunny: '☀️', windy: '💨', 'windy-variant': '💨',
};
const CONDITION: Record<string, string> = {
  'clear-night': 'Clear', cloudy: 'Cloudy', fog: 'Foggy', hail: 'Hail', lightning: 'Storms', 'lightning-rainy': 'Storms',
  partlycloudy: 'Partly cloudy', pouring: 'Heavy rain', rainy: 'Showers', snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny', windy: 'Windy',
};
const deg = (v: number | null) => (v === null ? '–' : `${Math.round(v)}°`);

/** "Good morning": today's calendar, the weather and to-do lists from Home Assistant. */
export function MorningPage() {
  const hearth = useHearth();
  const now = useNow(30_000);
  const h24 = hearth.info?.clock24h ?? false;
  const { data } = useApi<Morning>('/api/morning', 5 * 60_000);
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = data?.name && data.name !== 'Me' ? `, ${data.name}` : '';

  const when = (e: DayEvent) => (e.allDay ? 'All day' : `${formatTime(e.start, h24)}`);
  const w = data?.weather;

  return (
    <div className="page morning">
      <header className="morning-head">
        <div>
          <h1>
            {greeting}
            {name}
          </h1>
          <div className="morning-date">
            {new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · {formatTime(now, h24)}
          </div>
        </div>
        <div className="morning-actions" data-nav-group>
          {data?.news ? (
            <Button
              icon="tv"
              autoFocus
              onClick={() => (data.news!.kind === 'channel' ? hearth.watchChannel(data.news!.id) : hearth.launchApp(data.news!.id))}
            >
              {data.news.name}
            </Button>
          ) : null}
          <Button variant={data?.news ? 'ghost' : undefined} icon="home" autoFocus={!data?.news} onClick={() => hearth.navigate('home')}>
            Home
          </Button>
        </div>
      </header>

      {/* Not available (no Home Assistant, or turned off): the server sends only { enabled: false }. */}
      {data && !data.enabled ? (
        <div className="empty">The morning screen needs Home Assistant (homeassistant: in config.yaml).</div>
      ) : (
      <div className="morning-grid">
        {w ? (
          <section className="morning-card morning-weather">
            <div className="morning-weather-now">
              <span className="morning-weather-icon">{WEATHER[w.condition] ?? '🌡️'}</span>
              <div>
                <div className="morning-temp">{deg(w.temperature)}</div>
                <div className="morning-cond">{CONDITION[w.condition] ?? w.condition}</div>
              </div>
            </div>
            <div className="morning-hilo">
              <span>High {deg(w.high)}</span>
              <span>Low {deg(w.low)}</span>
              {w.rain !== null ? <span>{Math.round(w.rain)}% rain</span> : null}
            </div>
            {w.hourly.length ? (
              <div className="morning-hours">
                {w.hourly.map((h) => (
                  <div key={h.time}>
                    <small>{new Date(h.time).toLocaleTimeString([], { hour: 'numeric', hour12: !h24 })}</small>
                    <span>{WEATHER[h.condition] ?? '·'}</span>
                    <b>{deg(h.temperature)}</b>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="morning-card morning-agenda">
          <h2>Today</h2>
          {!data ? <p className="modal-sub">Loading…</p> : null}
          {data && !data.events.length ? <p className="modal-sub">Nothing on the calendar. Enjoy the day.</p> : null}
          <ul>
            {data?.events.map((e) => (
              <li key={`${e.title}${e.start}`} className={!e.allDay && e.start <= now && e.end > now ? 'now' : ''}>
                <span className="morning-when">{when(e)}</span>
                <span className="morning-what">
                  {e.title}
                  {e.location ? <small> · {e.location}</small> : null}
                </span>
                <span className="morning-cal">{e.calendar}</span>
              </li>
            ))}
          </ul>
          {data?.tomorrow.length ? (
            <>
              <h3>Tomorrow</h3>
              <ul className="morning-tomorrow">
                {data.tomorrow.map((e) => (
                  <li key={`${e.title}${e.start}`}>
                    <span className="morning-when">{when(e)}</span>
                    <span className="morning-what">{e.title}</span>
                    <span className="morning-cal">{e.calendar}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {data?.todo.length ? (
          <section className="morning-card morning-todo">
            {data.todo.map((t) => (
              <div key={t.list}>
                <h2>
                  <Icon name="check" size="0.9em" /> {t.list}
                </h2>
                <ul>
                  {t.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
      </div>
      )}
    </div>
  );
}
