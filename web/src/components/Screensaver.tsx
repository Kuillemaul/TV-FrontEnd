import { useEffect, useState } from 'react';
import { formatTime, useApi, type Dashboard } from '../lib/api';
import { useNow } from '../pages/Home';

/**
 * Photo slideshow (from the screensaver folder on the TV) with the clock and weather.
 * Falls back to a slow drifting gradient when there are no photos. Any input dismisses it.
 */
export function Screensaver({ clock24h, onWake }: { clock24h: boolean; onWake: () => void }) {
  const { data } = useApi<{ photos: string[] }>('/api/screensaver');
  const dash = useApi<Dashboard>('/api/ha/dashboard');
  const now = useNow(10_000);
  const [i, setI] = useState(0);
  const photos = data?.photos ?? [];

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
        photos.map((p, n) => <img key={p} src={p} alt="" className={`saver-photo ${n === i ? 'shown' : ''}`} />)
      ) : (
        <div className="saver-gradient" />
      )}
      <div className="saver-info">
        <div className="saver-time">{formatTime(now, clock24h)}</div>
        <div className="saver-date">
          {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          {weather ? ` · ${String(weather.attributes.temperature ?? '')}${String(weather.attributes.temperature_unit ?? '°')} ${weather.state.replace('partlycloudy', 'partly cloudy')}` : ''}
        </div>
      </div>
    </div>
  );
}
