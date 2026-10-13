import { useState } from 'react';
import { post, useApi } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
  inUse: boolean;
  saved: boolean;
}

export interface WifiStatus {
  available: boolean;
  error?: string;
  enabled: boolean;
  device: string | null;
  connected: { ssid: string; signal: number; ip: string | null } | null;
  networks: WifiNetwork[];
}

/** Four bars from a 0–100 signal. */
export function SignalBars({ signal }: { signal: number }) {
  const lit = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  return (
    <span className="wifi-bars" aria-label={`Signal ${signal}%`}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= lit ? 'on' : ''} style={{ height: `${i * 25}%` }} />
      ))}
    </span>
  );
}

/** Settings → Wi-Fi: current network, nearby networks, joining with a password. */
export function WifiSettings() {
  const hearth = useHearth();
  const { data, reload, setData } = useApi<WifiStatus>('/api/wifi', 15_000);
  const [joining, setJoining] = useState<WifiNetwork | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (path: string, body: object, what: string, done?: string) => {
    setBusy(what);
    const res = await post(path, body);
    setBusy(null);
    if (!res.ok) hearth.toast(res.error ?? 'That didn’t work', 'error');
    else if (done) hearth.toast(done);
    void reload();
  };
  const rescan = async () => {
    setBusy('scan');
    try {
      setData(await (await fetch('/api/wifi?rescan=1')).json());
    } finally {
      setBusy(null);
    }
  };
  const choose = (n: WifiNetwork) => {
    if (n.inUse) return;
    if (n.saved || !n.secure) void act('/api/wifi/connect', { ssid: n.ssid }, n.ssid, `Connected to ${n.ssid}`);
    else setJoining(n);
  };

  if (!data) return null;
  return (
    <section className="settings-group">
      <h2>Wi-Fi</h2>
      {!data.available ? (
        <p className="modal-sub">{data.error}</p>
      ) : (
        <>
          {data.connected ? (
            <p className="modal-sub">
              <span className="dot dot-on" /> Connected to <b>{data.connected.ssid}</b>
              {data.connected.ip ? ` · ${data.connected.ip}` : ''}
            </p>
          ) : (
            <p className="modal-sub">{data.enabled ? 'Not connected to Wi-Fi.' : 'Wi-Fi is off.'}</p>
          )}
          {data.enabled ? (
            <div className="bt-found wifi-list" data-nav-group>
              {data.networks.slice(0, 12).map((n) => (
                <button key={n.ssid} className={`bt-found-item ${n.inUse ? 'wifi-current' : ''}`} data-nav onClick={() => choose(n)} disabled={busy !== null && busy !== 'scan'}>
                  <SignalBars signal={n.signal} />
                  <span>{n.ssid}</span>
                  {n.secure ? <Icon name="lock" size="1em" /> : null}
                  <small>{busy === n.ssid ? 'Connecting…' : n.inUse ? 'Connected' : n.saved ? 'Saved' : 'Join'}</small>
                </button>
              ))}
              {!data.networks.length ? <div className="bt-searching">No networks found nearby.</div> : null}
            </div>
          ) : null}
          {!hearth.isKid ? (
            <div className="settings-row" data-nav-group>
              {data.enabled ? (
                <Button icon="refresh" onClick={() => void rescan()} disabled={busy === 'scan'}>
                  {busy === 'scan' ? 'Looking…' : 'Look again'}
                </Button>
              ) : null}
              {data.connected ? (
                <Button variant="ghost" onClick={() => void act('/api/wifi/disconnect', {}, 'off')}>
                  Disconnect
                </Button>
              ) : null}
              {data.networks.some((n) => n.saved) ? (
                <Button
                  variant="ghost"
                  icon="trash"
                  onClick={() => {
                    const n = data.networks.find((x) => x.inUse) ?? data.networks.find((x) => x.saved);
                    if (n) void act('/api/wifi/forget', { ssid: n.ssid }, 'forget', `Forgot ${n.ssid}`);
                  }}
                >
                  Forget {(data.networks.find((x) => x.inUse) ?? data.networks.find((x) => x.saved))?.ssid}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void act('/api/wifi/radio', { on: !data.enabled }, 'radio')}>
                {data.enabled ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on'}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {joining ? (
        <JoinNetwork
          network={joining}
          onClose={() => setJoining(null)}
          onJoined={() => {
            setJoining(null);
            void reload();
          }}
        />
      ) : null}
    </section>
  );
}

function JoinNetwork({ network, onClose, onJoined }: { network: WifiNetwork; onClose: () => void; onJoined: () => void }) {
  const hearth = useHearth();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const join = async () => {
    setBusy(true);
    setError('');
    const res = await post('/api/wifi/connect', { ssid: network.ssid, password });
    setBusy(false);
    if (!res.ok) return setError(res.error ?? 'Couldn’t connect');
    hearth.toast(`Connected to ${network.ssid}`);
    onJoined();
  };

  return (
    <Modal title={`Join ${network.ssid}`} onClose={onClose}>
      <p className="modal-sub">Type the Wi-Fi password with a keyboard, or with the phone remote's typing box.</p>
      <label className="field">
        <span>Password</span>
        <input
          data-nav
          autoFocus
          type={show ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && password.length >= 8 && void join()}
        />
      </label>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="modal-actions" data-nav-group>
        <Button onClick={() => void join()} disabled={busy || password.length < 8}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <Button variant="ghost" onClick={() => setShow(!show)}>
          {show ? 'Hide password' : 'Show password'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
