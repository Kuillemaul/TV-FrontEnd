import { useState } from 'react';
import { post, useApi } from '../lib/api';
import type { WifiStatus } from '../components/WifiSettings';
import type { Notify } from './Admin';

/** Editor → TV settings → Wi-Fi: join a network by typing the password on a phone or PC. */
export function WifiCard({ notify }: { notify: Notify }) {
  const wifi = useApi<WifiStatus>('/api/wifi', 15_000);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const d = wifi.data;
  const chosen = d?.networks.find((n) => n.ssid === ssid);

  const connect = async () => {
    setBusy(true);
    const res = await post('/api/wifi/connect', { ssid, password: password || undefined });
    setBusy(false);
    if (!res.ok) return notify(res.error ?? 'Couldn’t connect', true);
    notify(`The TV is on ${ssid}`);
    setPassword('');
    void wifi.reload();
  };
  const forget = async (name: string) => {
    if (!confirm(`Forget ${name}? The TV won't join it again until you enter the password.`)) return;
    const res = await post('/api/wifi/forget', { ssid: name });
    notify(res.ok ? `Forgot ${name}` : res.error ?? 'Couldn’t forget it', !res.ok);
    void wifi.reload();
  };

  return (
    <div className="ad-card">
      <h2>Wi-Fi</h2>
      {!d ? (
        <p className="ad-muted">Checking…</p>
      ) : !d.available ? (
        <p className="ad-muted">{d.error}</p>
      ) : (
        <>
          <div className="ad-kv">
            <span>Now</span>
            <b>{d.connected ? `${d.connected.ssid} (${d.connected.signal}%)${d.connected.ip ? ` · ${d.connected.ip}` : ''}` : d.enabled ? 'Not connected' : 'Wi-Fi is off'}</b>
            {d.connected ? (
              <button className="ad-link" onClick={() => void forget(d.connected!.ssid)}>
                Forget
              </button>
            ) : null}
          </div>
          {!d.enabled ? (
            <button className="ad-btn" onClick={() => void post('/api/wifi/radio', { on: true }).then(() => wifi.reload())}>
              Turn Wi-Fi on
            </button>
          ) : (
            <>
              <div className="ad-grid">
                <label>
                  Network
                  <select value={ssid} onChange={(e) => setSsid(e.target.value)}>
                    <option value="">Choose…</option>
                    {d.networks.map((n) => (
                      <option key={n.ssid} value={n.ssid}>
                        {n.ssid} · {n.signal}%{n.secure ? ' 🔒' : ''}
                        {n.inUse ? ' (connected)' : n.saved ? ' (saved)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {chosen?.secure && !chosen.saved ? (
                  <label>
                    Password
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                  </label>
                ) : null}
              </div>
              <div className="ad-actions">
                <button className="ad-btn primary" disabled={busy || !ssid || chosen?.inUse || (chosen?.secure && !chosen.saved && password.length < 8)} onClick={() => void connect()}>
                  {busy ? 'Connecting…' : 'Connect the TV'}
                </button>
                <button className="ad-btn" onClick={() => void fetch('/api/wifi?rescan=1').then(() => wifi.reload())}>
                  Look again
                </button>
              </div>
              <p className="ad-muted">
                If the TV is plugged into the router by cable, that keeps working too; Wi-Fi is used when the cable is out.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
