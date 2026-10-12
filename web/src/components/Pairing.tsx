import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { post, useApi, useServerEvents, type GameLibrary, type ServerEvent } from '../lib/api';
import { Button, Modal } from './Layout';

type PairEvent = Extract<ServerEvent, { type: 'pair' }>;

function usePairStatus(hostId: string | null) {
  const [status, setStatus] = useState<PairEvent | null>(null);
  useServerEvents((e) => e.type === 'pair' && e.hostId === hostId && setStatus(e));
  return status;
}

function PinPanel({ name, pin, webUi, status }: { name: string; pin: string; webUi: string; status: PairEvent | null }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    QRCode.toDataURL(webUi, { margin: 1, width: 360, color: { dark: '#0b0d12', light: '#ffffff' } }).then(setQr, () => setQr(''));
  }, [webUi]);
  const done = status?.stage === 'paired';
  const failed = status?.stage === 'failed';
  return (
    <div className="pair">
      <div className="pair-text">
        <div className="pair-label">Pairing with {name}</div>
        <div className={`pair-pin ${done ? 'ok' : ''}`}>{done ? '✓' : pin}</div>
        <ol className="pair-steps">
          <li>On {name}, open Apollo’s web page and go to <b>PIN</b>. Scan the code with your phone, or open <code>{webUi.replace('/pin', '')}</code>.</li>
          <li>Type <b>{pin}</b>, give it a name like “TV”, and press <b>Send</b>.</li>
        </ol>
        <div className={`pair-status ${failed ? 'bad' : done ? 'good' : ''}`}>
          {status?.message ?? 'Starting Moonlight…'}
        </div>
      </div>
      {qr ? <img className="pair-qr" src={qr} alt="" /> : null}
    </div>
  );
}

/** Settings → Gaming PCs: pair Moonlight with each PC, or open Moonlight itself. */
export function GamingPcsSettings() {
  const { data } = useApi<GameLibrary>('/api/games');
  const [pairing, setPairing] = useState<{ hostId: string; name: string; pin: string; webUi: string } | null>(null);
  const status = usePairStatus(pairing?.hostId ?? null);
  const [error, setError] = useState('');
  if (!data || data.demo || data.hosts.length === 0) return null;

  const pair = async (hostId: string, name: string) => {
    setError('');
    const res = await post<{ ok: boolean; error?: string; pin?: string; webUi?: string }>(`/api/games/${encodeURIComponent(hostId)}/pair`);
    if (res.ok && res.pin && res.webUi) setPairing({ hostId, name, pin: res.pin, webUi: res.webUi });
    else setError(res.error ?? 'Couldn’t start pairing');
  };

  return (
    <section className="settings-group">
      <h2>Gaming PCs</h2>
      <p className="modal-sub">Pair once per PC so games can stream to this TV. Moonlight opens, and you enter a PIN on the PC.</p>
      <div className="settings-row" data-nav-group>
        {data.hosts.map((h) => (
          <Button key={h.id} icon="gamepad" onClick={() => void pair(h.id, h.name)}>
            Pair {h.name}
          </Button>
        ))}
        <Button icon="external" variant="ghost" onClick={() => void post('/api/moonlight/open')}>
          Open Moonlight
        </Button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {pairing ? (
        <Modal title="Pair Moonlight" onClose={() => setPairing(null)} wide>
          <PinPanel name={pairing.name} pin={pairing.pin} webUi={pairing.webUi} status={status} />
          <div className="modal-actions">
            <Button onClick={() => setPairing(null)} autoFocus>
              {status?.stage === 'paired' ? 'Done' : 'Close'}
            </Button>
            {status?.stage !== 'paired' ? (
              <Button variant="ghost" onClick={() => void post('/api/moonlight/cancel').then(() => setPairing(null))}>
                Cancel pairing
              </Button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

/**
 * /pair: shown above Moonlight's pairing window (it covers the Hearth screen), so the PIN, the QR
 * code and progress stay visible. Back cancels.
 */
export function PairPage() {
  const q = new URLSearchParams(location.search);
  const hostId = q.get('host');
  const status = usePairStatus(hostId);
  useEffect(() => {
    const cancel = () => void post('/api/moonlight/cancel');
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') && cancel();
    window.addEventListener('keydown', onKey);
    let frame = 0;
    const poll = () => {
      if (navigator.getGamepads().some((g) => g?.buttons[1]?.pressed)) return cancel();
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className="pair-page">
      <PinPanel name={q.get('name') ?? 'your PC'} pin={q.get('pin') ?? ''} webUi={q.get('webUi') ?? ''} status={status} />
      <div className="pair-hint">Press Back to cancel</div>
    </div>
  );
}
