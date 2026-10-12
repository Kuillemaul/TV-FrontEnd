import { useEffect, useMemo, useState } from 'react';
import { formatTime, useApi, type Dashboard } from '../lib/api';
import { useNow } from '../pages/Home';

/** Each photo pans and zooms its own way (Ken Burns), picked from its index so it's stable. */
const KEN_BURNS = [
  { origin: '20% 30%', from: 1.02, to: 1.16 },
  { origin: '80% 25%', from: 1.16, to: 1.03 },
  { origin: '50% 80%', from: 1.03, to: 1.14 },
  { origin: '15% 75%', from: 1.14, to: 1.02 },
  { origin: '85% 70%', from: 1.02, to: 1.15 },
];

/** Corners the clock moves between, so nothing sits still on the TV long enough to burn in. */
const SPOTS = ['spot-bl', 'spot-br', 'spot-tr', 'spot-tl'];
const MOVE_EVERY_MS = 60_000;

/**
 * Photo slideshow (from the screensaver folder on the TV) with the clock and weather; without
 * photos, a slowly moving aurora with drifting light. The clock glides between corners. Any input
 * dismisses it.
 */
export function Screensaver({ clock24h, onWake }: { clock24h: boolean; onWake: () => void }) {
  const { data } = useApi<{ photos: string[] }>('/api/screensaver');
  const dash = useApi<Dashboard>('/api/ha/dashboard');
  const now = useNow(10_000);
  const [i, setI] = useState(0);
  const photos = data?.photos ?? [];
  const [spot, setSpot] = useState(0);
  const [moving, setMoving] = useState(false);
  // Fade the clock out, move it to the next corner, fade it back in.
  useEffect(() => {
    let fade: ReturnType<typeof setTimeout>;
    const t = setInterval(() => {
      setMoving(true);
      fade = setTimeout(() => {
        setSpot((x) => (x + 1) % SPOTS.length);
        setMoving(false);
      }, 1200);
    }, MOVE_EVERY_MS);
    return () => {
      clearInterval(t);
      clearTimeout(fade);
    };
  }, []);
  const motes = useMemo(
    () =>
      Array.from({ length: 28 }, (_, n) => ({
        left: `${(n * 37) % 100}%`,
        size: `${0.25 + ((n * 7) % 5) * 0.18}rem`,
        duration: `${26 + ((n * 11) % 24)}s`,
        delay: `-${(n * 13) % 40}s`,
        opacity: 0.25 + ((n * 3) % 5) * 0.12,
      })),
    [],
  );

  useEffect(() => {
    if (photos.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % photos.length), 12_000);
    return () => clearInterval(t);
  }, [photos.length]);

  useEffect(() => {
    // Capture phase, so the key that wakes the screen doesn't also act on the page.
    const wake = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      onWake();
    };
    const events = ['keydown', 'mousedown', 'wheel', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, wake, true);
    let moved = 0;
    const onMove = () => ++moved > 8 && onWake();
    window.addEventListener('mousemove', onMove);
    const pad = setInterval(() => {
      if (navigator.getGamepads().some((g) => g?.buttons.some((b) => b.pressed))) onWake();
    }, 200);
    return () => {
      for (const ev of events) window.removeEventListener(ev, wake, true);
      window.removeEventListener('mousemove', onMove);
      clearInterval(pad);
    };
  }, [onWake]);

  const weather = dash.data?.weather;
  return (
    <div className="saver">
      {photos.length ? (
        photos.map((p, n) => {
          const kb = KEN_BURNS[n % KEN_BURNS.length];
          return (
            <img
              key={p}
              src={p}
              alt=""
              className={`saver-photo ${n === i ? 'shown' : ''}`}
              style={{ transformOrigin: kb.origin, '--kb-from': kb.from, '--kb-to': kb.to } as React.CSSProperties}
            />
          );
        })
      ) : (
        <div className="saver-aurora">
          <span className="aurora-blob a1" />
          <span className="aurora-blob a2" />
          <span className="aurora-blob a3" />
          <span className="aurora-blob a4" />
          {motes.map((m, n) => (
            <span
              key={n}
              className="saver-mote"
              style={{ left: m.left, width: m.size, height: m.size, animationDuration: m.duration, animationDelay: m.delay, opacity: m.opacity }}
            />
          ))}
        </div>
      )}
      <div className="saver-vignette" />
      <div className={`saver-info ${SPOTS[spot]} ${moving ? 'moving' : ''}`}>
        <div className="saver-time">{formatTime(now, clock24h)}</div>
        <div className="saver-date">
          {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          {weather ? ` · ${String(weather.attributes.temperature ?? '')}${String(weather.attributes.temperature_unit ?? '°')} ${weather.state.replace('partlycloudy', 'partly cloudy')}` : ''}
        </div>
      </div>
    </div>
  );
}
