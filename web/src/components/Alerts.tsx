import { useEffect, useRef, useState } from 'react';
import { get, post, type Alert } from '../lib/api';
import { focusElement, onScopedBack } from '../nav/spatial';
import { Icon } from './Icon';

/** Live camera: MJPEG stream when Home Assistant is connected, snapshot refresh as a fallback. */
export function CameraView({ entity }: { entity: string }) {
  const [mode, setMode] = useState<'stream' | 'snapshot' | 'none'>('stream');
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (mode !== 'snapshot') return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mode]);
  if (mode === 'none') {
    return (
      <div className="camera-empty">
        <Icon name="camera" size="3em" />
      </div>
    );
  }
  const src = mode === 'stream' ? `/api/camera/${entity}/stream` : `/api/ha/camera/${entity}?t=${tick}`;
  return <img className="camera-live" src={src} alt="" onError={() => setMode(mode === 'stream' ? 'snapshot' : 'none')} />;
}

function chime(kind: Alert['kind']): void {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'doorbell' ? [659, 523] : kind === 'warning' ? [440, 440] : [784];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = ctx.currentTime + i * 0.45;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
    setTimeout(() => void ctx.close(), 2000);
  } catch {
    /* no audio */
  }
}

/** Run a pop-up's button ("Watch"): the server finds it in Plex and plays it. */
async function runAction(alert: Alert): Promise<string | null> {
  const res = await post('/api/alerts/action', { alertId: alert.id });
  return res.ok ? null : (res.error ?? 'That didn’t work');
}

/** The pop-up itself: a corner card with optional live camera, poster and buttons. */
export function AlertCard({ alert, large, onDone }: { alert: Alert; large?: boolean; onDone?: () => void }) {
  const [error, setError] = useState('');
  return (
    <div className={`alert-card alert-${alert.kind} ${alert.camera ? 'with-camera' : ''} ${alert.image ? 'with-image' : ''} ${large ? 'large' : ''}`}>
      {alert.camera ? <CameraView entity={alert.camera} /> : null}
      <div className="alert-text">
        {alert.image ? (
          <img className="alert-poster" src={alert.image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        ) : (
          <span className="alert-icon">{alert.kind === 'doorbell' ? '🔔' : alert.kind === 'warning' ? '⚠️' : '✓'}</span>
        )}
        <div className="alert-body">
          <div className="alert-title">{alert.title}</div>
          {alert.message ? <div className="alert-message">{alert.message}</div> : null}
          {alert.action ? (
            <div className="alert-actions">
              <button
                className="btn btn-primary alert-go"
                data-nav
                onClick={() => void runAction(alert).then((err) => (err ? setError(err) : onDone?.()))}
              >
                <Icon name="play" size="1.1em" /> <span>{alert.action.label}</span>
              </button>
              <button className="btn" data-nav onClick={() => onDone?.()}>
                Not now
              </button>
            </div>
          ) : null}
          {error ? <div className="alert-error">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Stack of alerts in the shell; each disappears after its time. */
export function AlertStack({ alerts, onExpire }: { alerts: Alert[]; onExpire: (id: string) => void }) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const a of alerts) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      chime(a.kind);
      setTimeout(() => onExpire(a.id), a.seconds * 1000);
    }
  }, [alerts, onExpire]);
  // A pop-up with a button ("Watch") takes the remote's focus while it's up; Back or "Not now"
  // dismisses it and focus goes back where it was.
  const stack = useRef<HTMLDivElement>(null);
  const actionable = alerts.find((a) => a.action);
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!actionable) return;
    before.current = document.activeElement as HTMLElement | null;
    const btn = stack.current?.querySelector<HTMLElement>('.alert-go');
    if (btn) focusElement(btn);
    const off = onScopedBack(() => stack.current, () => onExpire(actionable.id));
    return () => {
      off();
      if (before.current?.isConnected) focusElement(before.current);
    };
  }, [actionable?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!alerts.length) return null;
  return (
    <div className="alert-stack" ref={stack} data-nav-scope={actionable ? true : undefined}>
      {alerts.map((a) => (
        <AlertCard key={a.id} alert={a} onDone={() => onExpire(a.id)} />
      ))}
    </div>
  );
}

/**
 * Stand-alone page (/alert?id=…) the server opens in its own window when an alert
 * arrives while Plex, a game or Live TV is on screen.
 */
export function AlertPage() {
  const [alert, setAlert] = useState<Alert | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('id');
    if (id) get<Alert>(`/api/alerts/${id}`).then((a) => {
      setAlert(a);
      chime(a.kind);
    }).catch(() => {});
  }, []);
  // Over another app this window has the keyboard: Enter presses the focused button, Back
  // (or B) closes it, left/right (or the D-pad) move between the buttons.
  useEffect(() => {
    if (!alert?.action) return;
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.alert-card button')];
    buttons()[0]?.focus();
    const close = () => void post('/api/alerts/dismiss');
    const move = (d: number) => {
      const b = buttons();
      const i = b.indexOf(document.activeElement as HTMLButtonElement);
      b[(i + d + b.length) % b.length]?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['Escape', 'Backspace', 'BrowserBack'].includes(e.key)) close();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
    };
    window.addEventListener('keydown', onKey);
    let frame = 0;
    let prev: boolean[] = [];
    const poll = () => {
      const pad = navigator.getGamepads().find(Boolean);
      const now = pad ? pad.buttons.map((b) => b.pressed) : [];
      const edge = (i: number) => now[i] && !prev[i];
      if (edge(0)) (document.activeElement as HTMLButtonElement | null)?.click();
      if (edge(1)) close();
      if (edge(14) || edge(12)) move(-1);
      if (edge(15) || edge(13)) move(1);
      prev = now;
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
    };
  }, [alert]);
  return (
    <div className="alert-page">
      {alert ? <AlertCard alert={alert} large onDone={() => void post('/api/alerts/dismiss')} /> : null}
    </div>
  );
}
