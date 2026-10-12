import { useState } from 'react';
import { post, useApi, type GameLibrary } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

const uptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

/** Which gaming PCs are on, what they're running, and wake/sleep/restart/shut down. */
export function PcsPanel({ onClose }: { onClose: () => void }) {
  const { isKid } = useHearth();
  const { data, reload } = useApi<GameLibrary>('/api/games', 5000);
  const [confirm, setConfirm] = useState<{ hostId: string; name: string; action: 'sleep' | 'restart' | 'shutdown' } | null>(null);

  const power = async (hostId: string, action: string) => {
    await post(`/api/games/${encodeURIComponent(hostId)}/power`, { action });
    setTimeout(() => void reload(), 1500);
  };

  return (
    <Modal title="Gaming PCs" onClose={onClose} wide>
      <div className="pcs">
        {data?.hosts.map((h, i) => (
          <div className="pc-row" key={h.id} data-nav-group>
            <span className={`dot ${h.online ? 'dot-on' : 'dot-off'}`} />
            <div className="pc-text">
              <div className="pc-name">{h.name}</div>
              <div className="pc-sub">
                {h.online
                  ? `On${h.uptime ? ` for ${uptime(h.uptime)}` : ''}${h.playing ? ` · running ${h.playing}` : ''}`
                  : `Asleep or off${h.canWake && h.wakeEstimate ? ` · wakes in about ${h.wakeEstimate}s` : ''}`}
              </div>
            </div>
            {!h.online ? (
              <Button icon="power" variant="primary" disabled={!h.canWake} onClick={() => void power(h.id, 'wake')} autoFocus={i === 0}>
                Wake
              </Button>
            ) : !isKid ? (
              <>
                <Button icon="moon" onClick={() => setConfirm({ hostId: h.id, name: h.name, action: 'sleep' })} autoFocus={i === 0}>
                  Sleep
                </Button>
                <Button icon="refresh" onClick={() => setConfirm({ hostId: h.id, name: h.name, action: 'restart' })}>
                  Restart
                </Button>
                <Button icon="power" variant="danger" onClick={() => setConfirm({ hostId: h.id, name: h.name, action: 'shutdown' })}>
                  Shut down
                </Button>
              </>
            ) : null}
          </div>
        ))}
      </div>
      <p className="modal-sub">
        <Icon name="gamepad" size="1em" /> Picking a game wakes its PC automatically.
      </p>
      <div className="modal-actions">
        <Button onClick={onClose}>Close</Button>
      </div>
      {confirm ? (
        <Modal title={`${confirm.action === 'shutdown' ? 'Shut down' : confirm.action === 'restart' ? 'Restart' : 'Sleep'} ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="modal-text">Anything running on it will close.</p>
          <div className="modal-actions">
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                void power(confirm.hostId, confirm.action);
                setConfirm(null);
              }}
            >
              Yes
            </Button>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}
