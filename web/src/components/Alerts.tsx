import { useEffect, useRef, useState } from 'react';
import { get, type Alert } from '../lib/api';
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

/** The pop-up itself: a corner card with optional live camera. */
export function AlertCard({ alert, large }: { alert: Alert; large?: boolean }) {
  return (
    <div className={`alert-card alert-${alert.kind} ${alert.camera ? 'with-camera' : ''} ${large ? 'large' : ''}`}>
      {alert.camera ? <CameraView entity={alert.camera} /> : null}
      <div className="alert-text">
        <span className="alert-icon">{alert.kind === 'doorbell' ? '🔔' : alert.kind === 'warning' ? '⚠️' : '✓'}</span>
        <div>
          <div className="alert-title">{alert.title}</div>
          {alert.message ? <div className="alert-message">{alert.message}</div> : null}
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
  if (!alerts.length) return null;
  return (
    <div className="alert-stack">
      {alerts.map((a) => (
        <AlertCard key={a.id} alert={a} />
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
  return <div className="alert-page">{alert ? <AlertCard alert={alert} large /> : null}</div>;
}
