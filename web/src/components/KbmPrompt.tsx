import { useApi, type KbmStatus } from '../lib/api';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

/** Shown before launching a game that needs a keyboard and mouse. Live-detects connected devices. */
export function KbmPrompt({ title, onLaunch, onCancel }: { title: string; onLaunch: () => void; onCancel: () => void }) {
  const { data } = useApi<KbmStatus>('/api/system/input', 1500);
  const ready = Boolean(data?.keyboard && data?.mouse);

  return (
    <Modal title="Get your keyboard & mouse ready" onClose={onCancel}>
      <p className="modal-text">
        <strong>{title}</strong> needs a keyboard and mouse. Grab them before you launch, your controller won't be enough here.
      </p>
      <div className="kbm-devices">
        <Device icon="keyboard" label="Keyboard" name={data?.keyboard} />
        <Device icon="mouse" label="Mouse" name={data?.mouse} />
      </div>
      <div className="modal-actions">
        <Button variant="primary" icon="play" onClick={onLaunch} autoFocus>
          {ready ? "I'm ready, launch" : 'Launch anyway'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Modal>
  );
}

function Device({ icon, label, name }: { icon: string; label: string; name?: string | null }) {
  return (
    <div className={`kbm-device ${name ? 'kbm-ok' : ''}`}>
      <Icon name={icon} size="2.4em" />
      <div>
        <div className="kbm-label">{label}</div>
        <div className="kbm-state">{name ? <><Icon name="check" size="1em" /> {name}</> : 'Not detected'}</div>
      </div>
    </div>
  );
}
