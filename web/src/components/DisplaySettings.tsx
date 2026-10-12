import { useEffect, useState } from 'react';
import { post, useApi, useServerEvents } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Button, Chip, Modal } from './Layout';

interface Mode {
  width: number;
  height: number;
  refresh: number;
  preferred: boolean;
  current: boolean;
}

interface DisplayStatus {
  available: boolean;
  error?: string;
  outputs: Array<{ name: string; description: string; enabled: boolean; modes: Mode[] }>;
  pending: { revertAt: number } | null;
}

const RES_NAMES: Record<string, string> = { '3840x2160': '4K', '2560x1440': '1440p', '1920x1080': '1080p', '1280x720': '720p' };
const resKey = (m: { width: number; height: number }) => `${m.width}x${m.height}`;
const resLabel = (m: { width: number; height: number }) => RES_NAMES[resKey(m)] ?? `${m.width}×${m.height}`;
const hz = (r: number) => `${Math.round(r * 100) / 100} Hz`;

/** Settings → Display: resolution and refresh rate, with a "keep or go back" countdown. */
export function DisplaySettings() {
  const hearth = useHearth();
  const { data, reload, setData } = useApi<DisplayStatus>('/api/display');
  const [confirmUntil, setConfirmUntil] = useState<number | null>(null);
  useServerEvents((e) => {
    if (e.type !== 'display') return;
    setConfirmUntil(null);
    hearth.toast('Display setting undone');
    void reload();
  });

  const out = data?.outputs.find((o) => o.enabled && o.modes.length) ?? null;
  if (!data || hearth.isKid) return null;
  if (!data.available || !out) {
    return (
      <section className="settings-group">
        <h2>Display</h2>
        <p className="modal-sub">{data.error ?? 'No screen found.'}</p>
      </section>
    );
  }

  const current = out.modes.find((m) => m.current);
  const resolutions = [...new Map(out.modes.map((m) => [resKey(m), m])).values()].sort((a, b) => b.width * b.height - a.width * a.height);
  const rates = out.modes.filter((m) => current && resKey(m) === resKey(current)).sort((a, b) => b.refresh - a.refresh);

  const apply = async (m: Mode) => {
    const res = await post<DisplayStatus & { ok: boolean; error?: string }>('/api/display/mode', { output: out.name, width: m.width, height: m.height, refresh: m.refresh });
    if (!res.ok) return hearth.toast(res.error ?? 'Couldn’t change the display', 'error');
    setData(res);
    if (res.pending) setConfirmUntil(res.pending.revertAt);
  };
  const pickResolution = (r: Mode) => {
    const same = out.modes.filter((m) => resKey(m) === resKey(r));
    // Keep the refresh rate if this resolution has it; otherwise the closest to 60 Hz.
    const keep = same.find((m) => current && Math.abs(m.refresh - current.refresh) < 0.01);
    const best = keep ?? [...same].sort((a, b) => Math.abs(a.refresh - 60) - Math.abs(b.refresh - 60))[0];
    void apply(best);
  };

  return (
    <section className="settings-group">
      <h2>Display</h2>
      <div className="sound-label">Resolution</div>
      <div className="chips" data-nav-group>
        {resolutions.map((r) => (
          <Chip key={resKey(r)} active={current ? resKey(r) === resKey(current) : false} onClick={() => pickResolution(r)}>
            {resLabel(r)}
            {out.modes.some((m) => m.preferred && resKey(m) === resKey(r)) ? ' ★' : ''}
          </Chip>
        ))}
        <Chip active={false} onClick={() => void post('/api/display/auto', { output: out.name }).then(() => reload())}>
          TV default
        </Chip>
      </div>
      {rates.length > 1 ? (
        <>
          <div className="sound-label">Refresh rate</div>
          <div className="chips" data-nav-group>
            {rates.map((m) => (
              <Chip key={m.refresh} active={m.current} onClick={() => void apply(m)}>
                {hz(m.refresh)}
              </Chip>
            ))}
          </div>
        </>
      ) : null}
      <p className="modal-sub">
        {out.description} · ★ is what the TV recommends. Use 60 Hz for the menus and games; 24 Hz suits films if your TV
        doesn’t match the frame rate itself.
      </p>
      <p className="modal-sub">
        <b>HDR:</b> not available with this display setup yet. 4K works, but HDR films play in SDR (tone-mapped).
      </p>
      {confirmUntil ? (
        <KeepDialog
          until={confirmUntil}
          onKeep={() => void post('/api/display/keep').then(() => { setConfirmUntil(null); void reload(); })}
          onRevert={() => void post('/api/display/revert').then(() => setConfirmUntil(null))}
        />
      ) : null}
    </section>
  );
}

function KeepDialog({ until, onKeep, onRevert }: { until: number; onKeep: () => void; onRevert: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <Modal title="Keep this display setting?" onClose={onRevert}>
      <p className="modal-text">Going back to the previous setting in <strong>{left}</strong> seconds.</p>
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" autoFocus onClick={onKeep}>Keep</Button>
        <Button onClick={onRevert}>Go back</Button>
      </div>
    </Modal>
  );
}
