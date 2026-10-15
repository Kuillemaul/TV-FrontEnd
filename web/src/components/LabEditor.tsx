import { useState } from 'react';
import { useApi } from '../lib/api';
import { useHearth } from '../lib/hearth';
import {
  ACTION_DOMAINS,
  ACTION_SERVICES,
  describeAction,
  saveLabItem,
  type HaPick,
  type LabActionItem,
  type LabConfigView,
  type LabKind,
  type LabServiceItem,
} from '../lib/labitems';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';
import { FindServers } from '../setup/FindServers';

type Editing =
  | { kind: 'services'; index?: number; item?: LabServiceItem }
  | { kind: 'sensors' }
  | { kind: 'actions'; index?: number; item?: LabActionItem };

/**
 * Add, change and remove what the Home Lab page shows, from the sofa: services (websites to watch),
 * Home Assistant sensors, and one-button actions. Saved into config.yaml for you.
 */
export function LabEditor({ onClose }: { onClose: () => void }) {
  const hearth = useHearth();
  const { data, setData, reload } = useApi<LabConfigView>('/api/lab/config');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [finding, setFinding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const sensors = useApi<HaPick[]>(data?.homeassistant ? '/api/ha/pick?domains=sensor,binary_sensor' : null);
  const sensorName = (id: string) => sensors.data?.find((s) => s.id === id)?.name ?? id;

  const save = async (kind: LabKind, index: number | undefined, item: unknown, done: string) => {
    const res = await saveLabItem(kind, index, item);
    if (!res.ok) {
      hearth.toast(res.error ?? 'Couldn’t save that', 'error');
      return false;
    }
    if (data) setData({ ...data, services: res.services ?? data.services, sensors: res.sensors ?? data.sensors, actions: res.actions ?? data.actions });
    hearth.toast(done);
    return true;
  };

  // Remove asks once: the first press turns the button into "Remove?".
  const RemoveButton = ({ id, label, onRemove }: { id: string; label: string; onRemove: () => void }) => (
    <button
      className={`order-btn order-hide ${confirm === id ? 'danger' : ''}`}
      data-nav
      aria-label={`Remove ${label}`}
      onClick={() => (confirm === id ? (setConfirm(null), onRemove()) : setConfirm(id))}
      onBlur={() => setConfirm((c) => (c === id ? null : c))}
    >
      {confirm === id ? 'Remove?' : <Icon name="trash" size="1.1em" />}
    </button>
  );

  if (!data) return null;
  return (
    <Modal title="Edit home lab" onClose={onClose} wide>
      <p className="modal-sub">Changes show on the Lab page straight away. They’re saved in config.yaml for you.</p>

      <h3 className="order-heading">Services · websites to keep an eye on</h3>
      <div className="order-list">
        {data.services.map((s, i) => (
          <div className="order-row" key={`${s.name}${i}`} data-nav-group>
            <span className="order-name">
              {s.name}
              <span className="order-detail">{s.url.replace(/^https?:\/\//, '')}</span>
            </span>
            <button className="order-btn" data-nav onClick={() => setEditing({ kind: 'services', index: i, item: s })}>
              Edit
            </button>
            <RemoveButton id={`s${i}`} label={s.name} onRemove={() => void save('services', i, null, `Removed ${s.name}`)} />
          </div>
        ))}
      </div>

      <h3 className="order-heading">Sensors · numbers from Home Assistant</h3>
      <div className="order-list">
        {data.sensors.map((id, i) => (
          <div className="order-row" key={id} data-nav-group>
            <span className="order-name">
              {sensorName(id)}
              <span className="order-detail">{id}</span>
            </span>
            <RemoveButton id={`n${i}`} label={sensorName(id)} onRemove={() => void save('sensors', i, null, `Removed ${sensorName(id)}`)} />
          </div>
        ))}
      </div>

      <h3 className="order-heading">Actions · one-button jobs (restart a server…)</h3>
      <div className="order-list">
        {data.actions.map((a, i) => (
          <div className="order-row" key={`${a.name}${i}`} data-nav-group>
            <span className="order-name">
              {a.name}
              <span className="order-detail">{describeAction(a)}</span>
            </span>
            <button className="order-btn" data-nav onClick={() => setEditing({ kind: 'actions', index: i, item: a })}>
              Edit
            </button>
            <RemoveButton id={`a${i}`} label={a.name} onRemove={() => void save('actions', i, null, `Removed ${a.name}`)} />
          </div>
        ))}
      </div>

      <div className="modal-actions" data-nav-group>
        <Button icon="search" onClick={() => setFinding(true)} autoFocus>
          Find services
        </Button>
        <Button icon="plus" onClick={() => setEditing({ kind: 'services' })}>
          Add service
        </Button>
        <Button icon="plus" onClick={() => setEditing({ kind: 'sensors' })}>
          Add sensor
        </Button>
        <Button icon="plus" onClick={() => setEditing({ kind: 'actions' })}>
          Add action
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>

      {finding ? (
        <Modal title="Find services on your servers" onClose={() => (setFinding(false), void reload())} wide>
          <FindServers mode="lab" reload={() => void reload()} intro={<p className="modal-sub">Type your servers’ addresses (or scan the network); add what turns up to the Lab page.</p>} />
          <div className="modal-actions">
            <Button variant="primary" onClick={() => (setFinding(false), void reload())}>
              Done
            </Button>
          </div>
        </Modal>
      ) : null}

      {editing?.kind === 'services' ? (
        <ServiceForm
          item={editing.item}
          onClose={() => setEditing(null)}
          onSave={async (item) => {
            if (await save('services', editing.index, item, editing.item ? `Saved ${item.name}` : `Added ${item.name}`)) setEditing(null);
          }}
        />
      ) : null}
      {editing?.kind === 'sensors' ? (
        <SensorPicker
          options={(sensors.data ?? []).filter((s) => !data.sensors.includes(s.id))}
          homeassistant={data.homeassistant}
          onClose={() => setEditing(null)}
          onPick={async (id, label) => {
            if (await save('sensors', undefined, id, `Added ${label}`)) setEditing(null);
          }}
        />
      ) : null}
      {editing?.kind === 'actions' ? (
        <ActionForm
          item={editing.item}
          homeassistant={data.homeassistant}
          onClose={() => setEditing(null)}
          onSave={async (item) => {
            if (await save('actions', editing.index, item, editing.item ? `Saved ${item.name}` : `Added ${item.name}`)) setEditing(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

function ServiceForm({ item, onSave, onClose }: { item?: LabServiceItem; onSave: (item: LabServiceItem) => void; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [url, setUrl] = useState(item?.url ?? 'http://');
  const [open, setOpen] = useState(item?.open ?? true);
  const [check, setCheck] = useState(item?.check ?? '');
  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add a service'} onClose={onClose}>
      <p className="modal-sub">A server or web page on your network. Hearth checks every 30 s that it answers.</p>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input data-nav data-nav-default value={name} onChange={(e) => setName(e.target.value)} placeholder="Proxmox" />
        </label>
        <label className="field">
          <span>Address</span>
          <input data-nav value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://192.168.1.10:8006" />
        </label>
        <button className="editor-card" data-nav onClick={() => setOpen(!open)}>
          <span className="editor-card-text">
            <span className="editor-card-title">Open it on the TV</span>
            <span className="editor-card-detail">Selecting the tile opens the page full screen</span>
          </span>
          <span className={`toggle ${open ? 'on' : ''}`} />
        </button>
        <label className="field">
          <span>Check a different address (optional)</span>
          <input data-nav value={check} onChange={(e) => setCheck(e.target.value)} placeholder="Leave empty to check the address above" />
        </label>
      </div>
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" icon="check" onClick={() => onSave({ name, url, open, check: check.trim() || undefined })}>
          Save
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

/** Pick from Home Assistant's entities, narrowed by typing; any entity id can also be typed in full. */
function EntityList({ options, onPick, empty }: { options: HaPick[]; onPick: (p: HaPick) => void; empty: string }) {
  const [filter, setFilter] = useState('');
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = options.filter((o) => words.every((w) => `${o.name} ${o.id}`.toLowerCase().includes(w)));
  const typed = /^[a-z_]+\.[a-z0-9_]+$/.test(filter.trim()) && !options.some((o) => o.id === filter.trim());
  return (
    <>
      <label className="field">
        <span>Search</span>
        <input data-nav data-nav-default value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="cpu, disk, ups…" />
      </label>
      <div className="pick-list" data-nav-group>
        {typed ? (
          <button className="chip" data-nav onClick={() => onPick({ id: filter.trim(), name: filter.trim(), state: '' })}>
            + Use {filter.trim()}
          </button>
        ) : null}
        {matches.slice(0, 40).map((o) => (
          <button key={o.id} className="chip pick-item" data-nav onClick={() => onPick(o)}>
            <span>{o.name}</span>
            <span className="pick-value">
              {o.state}
              {o.unit ? ` ${o.unit}` : ''}
            </span>
          </button>
        ))}
        {matches.length === 0 && !typed ? <div className="empty">{empty}</div> : null}
        {matches.length > 40 ? <div className="modal-sub">{matches.length - 40} more: type to narrow it down</div> : null}
      </div>
    </>
  );
}

function SensorPicker({ options, homeassistant, onPick, onClose }: { options: HaPick[]; homeassistant: boolean; onPick: (id: string, label: string) => void; onClose: () => void }) {
  return (
    <Modal title="Add a sensor" onClose={onClose} wide>
      <p className="modal-sub">CPU, disk space, UPS load, internet speed… any Home Assistant sensor, with a 24-hour graph.</p>
      {homeassistant ? (
        <EntityList options={options} onPick={(p) => onPick(p.id, p.name)} empty="Nothing matches. Type a full entity id (like sensor.nas_disk) to use it anyway." />
      ) : (
        <div className="empty">Link Home Assistant first (Settings → Connections) to show its sensors here.</div>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

function ActionForm({ item, homeassistant, onSave, onClose }: { item?: LabActionItem; homeassistant: boolean; onSave: (item: LabActionItem) => void; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [type, setType] = useState<'ha' | 'http'>(item?.http || !homeassistant ? 'http' : 'ha');
  const [entity, setEntity] = useState(item?.ha?.data?.entity_id ? String(item.ha.data.entity_id) : '');
  const [service, setService] = useState(item?.ha?.service ?? '');
  const [url, setUrl] = useState(item?.http?.url ?? 'http://');
  const [method, setMethod] = useState(item?.http?.method ?? 'POST');
  const [picking, setPicking] = useState(false);
  const options = useApi<HaPick[]>(homeassistant ? `/api/ha/pick?domains=${ACTION_DOMAINS}` : null);
  const picked = options.data?.find((o) => o.id === entity);

  const submit = () =>
    onSave(type === 'ha' ? { name, ha: { service, data: { entity_id: entity } } } : { name, http: { url, method } });

  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add an action'} onClose={onClose}>
      <p className="modal-sub">A button on the Lab page. It asks for your PIN before it runs.</p>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input data-nav data-nav-default value={name} onChange={(e) => setName(e.target.value)} placeholder="Restart Plex" />
        </label>
        <div className="field">
          <span>What it does</span>
          <div className="settings-row" data-nav-group>
            {homeassistant ? (
              <button className={`chip ${type === 'ha' ? 'chip-active' : ''}`} data-nav onClick={() => setType('ha')}>
                Home Assistant button or script
              </button>
            ) : null}
            <button className={`chip ${type === 'http' ? 'chip-active' : ''}`} data-nav onClick={() => setType('http')}>
              Call a web address (webhook)
            </button>
          </div>
        </div>
        {type === 'ha' ? (
          <button className="editor-card" data-nav onClick={() => setPicking(true)}>
            <span className="editor-card-text">
              <span className="editor-card-title">{picked?.name ?? (entity || 'Choose…')}</span>
              <span className="editor-card-detail">{entity ? `${service} → ${entity}` : 'A button, script, scene, switch or automation'}</span>
            </span>
            <Icon name="right" size="1.2em" />
          </button>
        ) : (
          <>
            <label className="field">
              <span>Web address</span>
              <input data-nav value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://portainer.lan:9000/api/webhooks/…" />
            </label>
            <div className="settings-row" data-nav-group>
              {['POST', 'GET', 'PUT'].map((m) => (
                <button key={m} className={`chip ${method === m ? 'chip-active' : ''}`} data-nav onClick={() => setMethod(m)}>
                  {m}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" icon="check" onClick={submit}>
          Save
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
      {picking ? (
        <Modal title="Choose what to run" onClose={() => setPicking(false)} wide>
          <EntityList
            options={options.data ?? []}
            empty="Nothing matches."
            onPick={(p) => {
              const domain = p.id.split('.')[0];
              setEntity(p.id);
              setService(ACTION_SERVICES[domain] ?? `${domain}.turn_on`);
              if (!name) setName(p.name);
              setPicking(false);
            }}
          />
        </Modal>
      ) : null}
    </Modal>
  );
}
