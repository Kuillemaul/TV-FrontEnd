import { useEffect, useState } from 'react';
import { post, useApi } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

interface BtDevice {
  mac: string;
  name: string;
  icon: string;
  paired: boolean;
  connected: boolean;
  trusted: boolean;
  battery: number | null;
}

interface BtStatus {
  available: boolean;
  error?: string;
  powered: boolean;
  discovering: boolean;
  devices: BtDevice[];
}

const iconFor = (d: BtDevice) =>
  d.icon.startsWith('input-gaming') ? 'gamepad' : d.icon.startsWith('audio') ? 'volumeUp' : d.icon.startsWith('input-keyboard') ? 'keyboard' : d.icon.startsWith('input-mouse') || d.icon.startsWith('input-tablet') ? 'mouse' : 'bluetooth';

const realName = (d: BtDevice) => d.name !== d.mac && !/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(d.name);

/** Settings → Bluetooth: paired devices, and pairing new ones with the remote. */
export function BluetoothSettings() {
  const hearth = useHearth();
  const { data, reload } = useApi<BtStatus>('/api/bluetooth', 5000);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (what: 'connect' | 'disconnect' | 'forget', d: BtDevice) => {
    setBusy(d.mac);
    const res = await post(`/api/bluetooth/${what}`, { mac: d.mac });
    setBusy(null);
    if (!res.ok) hearth.toast(res.error ?? 'That didn’t work', 'error');
    else if (what === 'connect') hearth.toast(`${d.name} connected`);
    void reload();
  };

  if (!data) return null;
  const paired = data.devices.filter((d) => d.paired);
  return (
    <section className="settings-group">
      <h2>Bluetooth</h2>
      {!data.available ? (
        <p className="modal-sub">{data.error}</p>
      ) : (
        <>
          <div className="bt-list">
            {paired.map((d) => (
              <div key={d.mac} className="bt-row" data-nav-group>
                <Icon name={iconFor(d)} size="1.6em" />
                <div className="bt-text">
                  <div className="bt-name">{d.name}</div>
                  <div className="bt-sub">
                    <span className={`dot ${d.connected ? 'dot-on' : ''}`} /> {d.connected ? 'Connected' : 'Not connected'}
                    {d.battery !== null ? ` · ${d.battery}% battery` : ''}
                  </div>
                </div>
                {d.connected ? (
                  <Button onClick={() => void act('disconnect', d)} disabled={busy === d.mac}>Disconnect</Button>
                ) : (
                  <Button onClick={() => void act('connect', d)} disabled={busy === d.mac}>{busy === d.mac ? 'Connecting…' : 'Connect'}</Button>
                )}
                {!hearth.isKid ? (
                  <Button variant="ghost" icon="trash" onClick={() => void act('forget', d)} disabled={busy === d.mac}>
                    Forget
                  </Button>
                ) : null}
              </div>
            ))}
            {!paired.length ? <p className="modal-sub">Nothing paired yet.</p> : null}
          </div>
          <div className="settings-row" data-nav-group>
            {!hearth.isKid ? (
              <Button icon="bluetooth" onClick={() => setAdding(true)}>
                Add a device
              </Button>
            ) : null}
            {!data.powered && !hearth.isKid ? (
              <Button variant="ghost" onClick={() => void post('/api/bluetooth/power', { on: true }).then(() => reload())}>
                Turn Bluetooth on
              </Button>
            ) : null}
          </div>
        </>
      )}
      {adding ? (
        <AddDevice
          onClose={() => {
            setAdding(false);
            void post('/api/bluetooth/scan', { on: false });
            void reload();
          }}
        />
      ) : null}
    </section>
  );
}

function AddDevice({ onClose }: { onClose: () => void }) {
  const hearth = useHearth();
  const { data, reload } = useApi<BtStatus>('/api/bluetooth', 2000);
  const [pairing, setPairing] = useState<BtDevice | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void post('/api/bluetooth/scan', { on: true });
    // Keep looking while the panel is open.
    const t = setInterval(() => void post('/api/bluetooth/scan', { on: true }), 40_000);
    return () => clearInterval(t);
  }, []);

  const pair = async (d: BtDevice) => {
    setPairing(d);
    setError('');
    const res = await post('/api/bluetooth/pair', { mac: d.mac });
    setPairing(null);
    if (!res.ok) return setError(`${d.name}: ${res.error ?? 'pairing failed'}`);
    setDone(d.name);
    hearth.toast(`${d.name} paired`);
    void reload();
  };

  const found = (data?.devices ?? []).filter((d) => !d.paired && realName(d));
  return (
    <Modal title="Add a Bluetooth device" onClose={onClose} wide>
      <p className="modal-sub">
        Put the device in pairing mode. <b>Xbox controller:</b> hold the small pair button until the logo flashes fast.{' '}
        <b>PlayStation:</b> hold Create (or Share) and the PS button until the light flashes. <b>Headphones/speakers:</b>{' '}
        usually hold the power or Bluetooth button.
      </p>
      <div className="bt-found" data-nav-group>
        {found.map((d) => (
          <button key={d.mac} className="bt-found-item" data-nav onClick={() => void pair(d)} disabled={Boolean(pairing)}>
            <Icon name={iconFor(d)} size="1.6em" />
            <span>{d.name}</span>
            <small>{pairing?.mac === d.mac ? 'Pairing…' : 'Pair'}</small>
          </button>
        ))}
        {!found.length ? (
          <div className="bt-searching">
            <span className="cover-dots">
              <span />
              <span />
              <span />
            </span>
            Looking for devices…
          </div>
        ) : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {done ? <p className="modal-sub bt-done">✓ {done} is paired and connected. It will reconnect by itself from now on.</p> : null}
      <div className="modal-actions">
        <Button onClick={onClose} autoFocus={!found.length}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
