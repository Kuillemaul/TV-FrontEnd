import { formatTime, post, useApi, type Alert } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

const KIND_ICON: Record<Alert['kind'], string> = { doorbell: 'doorbell', info: 'bell', warning: 'bell' };

function when(at: number, h24: boolean): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = formatTime(at, h24);
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** Doorbell rings and alerts that already popped up and went away (since Hearth last started). */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const hearth = useHearth();
  const { data } = useApi<Alert[]>('/api/alerts', 30_000);
  const h24 = hearth.info?.clock24h ?? false;
  return (
    <Modal title="Notifications" onClose={onClose} wide>
      {!data ? (
        <p className="modal-sub">Loading…</p>
      ) : data.length === 0 ? (
        <p className="modal-sub">Nothing yet. Doorbell rings and alerts like “washer done” are listed here after they pop up.</p>
      ) : (
        <div className="notif-list">
          {data.map((a) => (
            <div className={`notif notif-${a.kind}`} key={a.id} data-nav-group>
              <div className="notif-icon">
                <Icon name={KIND_ICON[a.kind]} size="1.4em" />
              </div>
              <div className="notif-text">
                <div className="notif-title">{a.title}</div>
                {a.message ? <div className="notif-message">{a.message}</div> : null}
              </div>
              <div className="notif-time">{when(a.at, h24)}</div>
              {a.camera && !hearth.isKid ? (
                <Button
                  icon="camera"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    void post('/api/pip', { entity: a.camera, name: a.title });
                  }}
                >
                  Live camera
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions" data-nav-group>
        <Button onClick={onClose} autoFocus={!data?.length}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
