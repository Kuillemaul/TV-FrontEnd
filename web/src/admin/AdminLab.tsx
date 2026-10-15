import { useState } from 'react';
import { post, useApi } from '../lib/api';
import { useDiscovery, type FoundService } from '../setup/FindServers';
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
import type { Notify } from './Admin';

/** Home lab services, sensors and actions, edited from a phone or laptop (saved into config.yaml). */
export function LabSection({ notify }: { notify: Notify }) {
  const { data, setData, reload: reloadLab } = useApi<LabConfigView>('/api/lab/config');
  const sensors = useApi<HaPick[]>(data?.homeassistant ? '/api/ha/pick?domains=sensor,binary_sensor' : null);
  const [service, setService] = useState<{ index?: number; item: LabServiceItem } | null>(null);
  const [action, setAction] = useState<{ index?: number; item: LabActionItem } | null>(null);

  const save = async (kind: LabKind, index: number | undefined, item: unknown, done: string) => {
    const res = await saveLabItem(kind, index, item);
    if (!res.ok) {
      notify(res.error ?? 'Couldn’t save that', true);
      return false;
    }
    if (data) setData({ ...data, services: res.services ?? data.services, sensors: res.sensors ?? data.sensors, actions: res.actions ?? data.actions });
    notify(done);
    return true;
  };
  const remove = (kind: LabKind, index: number, label: string) => {
    if (confirm(`Remove ${label}?`)) void save(kind, index, null, `Removed ${label}`);
  };
  const sensorName = (id: string) => sensors.data?.find((s) => s.id === id)?.name ?? id;

  if (!data) return null;
  return (
    <section>
      <h1>Home Lab</h1>
      <p className="ad-muted">What the TV’s Lab page shows. Changes appear on the TV straight away and are saved in config.yaml (the old version is kept in backups).</p>

      <FindCard notify={notify} onAdded={() => void reloadLab()} />

      <div className="ad-card">
        <h2>Services</h2>
        <p className="ad-muted">Servers and web pages on your network. Hearth checks every 30 seconds that each one answers.</p>
        {data.services.map((s, i) => (
          <div className="ad-kv" key={`${s.name}${i}`}>
            <div className="ad-grow">
              <b>{s.name}</b>
              <div className="ad-note">{s.url}</div>
            </div>
            <button className="ad-btn" onClick={() => setService({ index: i, item: s })}>Edit</button>
            <button className="ad-btn" onClick={() => remove('services', i, s.name)}>Remove</button>
          </div>
        ))}
        {service ? (
          <ServiceForm
            item={service.item}
            onCancel={() => setService(null)}
            onSave={async (item) => {
              if (await save('services', service.index, item, service.index === undefined ? `Added ${item.name}` : `Saved ${item.name}`)) setService(null);
            }}
          />
        ) : (
          <button className="ad-btn primary" onClick={() => setService({ item: { name: '', url: 'http://', open: true } })}>
            Add a service
          </button>
        )}
      </div>

      <div className="ad-card">
        <h2>Sensors</h2>
        <p className="ad-muted">Numbers from Home Assistant (CPU, disk, UPS load…), each with a 24-hour graph.</p>
        <div className="ad-chips">
          {data.sensors.map((id, i) => (
            <span key={id} className="ad-chip" title={id}>
              {sensorName(id)}
              <button onClick={() => remove('sensors', i, sensorName(id))} title={`Remove ${sensorName(id)}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
        {data.homeassistant ? (
          <EntitySearch
            options={(sensors.data ?? []).filter((s) => !data.sensors.includes(s.id))}
            placeholder="Search sensors to add: cpu, disk, ups…"
            onPick={(p) => void save('sensors', undefined, p.id, `Added ${p.name}`)}
          />
        ) : (
          <p className="ad-muted">Connect Home Assistant (homeassistant: in the config file) to add its sensors.</p>
        )}
      </div>

      <div className="ad-card">
        <h2>Actions</h2>
        <p className="ad-muted">One-button jobs on the Lab page, like restarting a server. They ask for the profile PIN before running.</p>
        {data.actions.map((a, i) => (
          <div className="ad-kv" key={`${a.name}${i}`}>
            <div className="ad-grow">
              <b>{a.name}</b>
              <div className="ad-note">{describeAction(a)}</div>
            </div>
            <button className="ad-btn" onClick={() => setAction({ index: i, item: a })}>Edit</button>
            <button className="ad-btn" onClick={() => remove('actions', i, a.name)}>Remove</button>
          </div>
        ))}
        {action ? (
          <ActionForm
            item={action.item}
            homeassistant={data.homeassistant}
            onCancel={() => setAction(null)}
            onSave={async (item) => {
              if (await save('actions', action.index, item, action.index === undefined ? `Added ${item.name}` : `Saved ${item.name}`)) setAction(null);
            }}
          />
        ) : (
          <button className="ad-btn primary" onClick={() => setAction({ item: { name: '' } })}>
            Add an action
          </button>
        )}
      </div>
    </section>
  );
}

function ServiceForm({ item, onSave, onCancel }: { item: LabServiceItem; onSave: (item: LabServiceItem) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: item.name, url: item.url, check: item.check ?? '', open: item.open ?? false });
  return (
    <div className="ad-editor">
      <div className="ad-grid">
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Proxmox" />
        </label>
        <label>
          Address
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://192.168.1.10:8006" inputMode="url" />
        </label>
        <label>
          Check a different address (optional)
          <input value={form.check} onChange={(e) => setForm({ ...form, check: e.target.value })} placeholder="Leave empty to check the address above" inputMode="url" />
        </label>
      </div>
      <label className="ad-check">
        <input type="checkbox" checked={form.open} onChange={(e) => setForm({ ...form, open: e.target.checked })} />
        Open it on the TV when the tile is selected
      </label>
      <div className="ad-actions">
        <button className="ad-btn primary" onClick={() => onSave({ name: form.name, url: form.url, open: form.open, check: form.check.trim() || undefined })}>
          Save
        </button>
        <button className="ad-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EntitySearch({ options, placeholder, onPick }: { options: HaPick[]; placeholder: string; onPick: (p: HaPick) => void }) {
  const [filter, setFilter] = useState('');
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length ? options.filter((o) => words.every((w) => `${o.name} ${o.id}`.toLowerCase().includes(w))).slice(0, 30) : [];
  const typed = /^[a-z_]+\.[a-z0-9_]+$/.test(filter.trim()) && !options.some((o) => o.id === filter.trim());
  const pick = (p: HaPick) => {
    setFilter('');
    onPick(p);
  };
  return (
    <>
      <input className="ad-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={placeholder} />
      {matches.length || typed ? (
        <div className="ad-chips ad-picks">
          {typed ? (
            <button className="ad-chip" onClick={() => pick({ id: filter.trim(), name: filter.trim(), state: '' })}>
              + Use {filter.trim()}
            </button>
          ) : null}
          {matches.map((o) => (
            <button key={o.id} className="ad-chip" onClick={() => pick(o)} title={o.id}>
              + {o.name}
              <span className="ad-note">
                {o.state}
                {o.unit ? ` ${o.unit}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ActionForm({ item, homeassistant, onSave, onCancel }: { item: LabActionItem; homeassistant: boolean; onSave: (item: LabActionItem) => void; onCancel: () => void }) {
  const [name, setName] = useState(item.name);
  const [type, setType] = useState<'ha' | 'http'>(item.http || !homeassistant ? 'http' : 'ha');
  const [entity, setEntity] = useState(item.ha?.data?.entity_id ? String(item.ha.data.entity_id) : '');
  const [service, setService] = useState(item.ha?.service ?? '');
  const [url, setUrl] = useState(item.http?.url ?? 'http://');
  const [method, setMethod] = useState(item.http?.method ?? 'POST');
  const options = useApi<HaPick[]>(homeassistant ? `/api/ha/pick?domains=${ACTION_DOMAINS}` : null);
  const picked = options.data?.find((o) => o.id === entity);

  return (
    <div className="ad-editor">
      <div className="ad-grid">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Restart Plex" />
        </label>
        <label>
          What it does
          <select value={type} onChange={(e) => setType(e.target.value as 'ha' | 'http')}>
            {homeassistant ? <option value="ha">Run a Home Assistant button or script</option> : null}
            <option value="http">Call a web address (webhook)</option>
          </select>
        </label>
      </div>
      {type === 'ha' ? (
        <>
          <div className="ad-note">{entity ? `Runs ${picked?.name ?? entity} (${service})` : 'Search for a button, script, scene, switch or automation:'}</div>
          <EntitySearch
            options={options.data ?? []}
            placeholder="Search: restart, backup, reboot…"
            onPick={(p) => {
              const domain = p.id.split('.')[0];
              setEntity(p.id);
              setService(ACTION_SERVICES[domain] ?? `${domain}.turn_on`);
              if (!name) setName(p.name);
            }}
          />
        </>
      ) : (
        <div className="ad-grid">
          <label>
            Web address
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://portainer.lan:9000/api/webhooks/…" inputMode="url" />
          </label>
          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>POST</option>
              <option>GET</option>
              <option>PUT</option>
            </select>
          </label>
        </div>
      )}
      <div className="ad-actions">
        <button className="ad-btn primary" onClick={() => onSave(type === 'ha' ? { name, ha: { service, data: { entity_id: entity } } } : { name, http: { url, method } })}>
          Save
        </button>
        <button className="ad-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Find what's running on your servers and add it to the Lab page. */
function FindCard({ notify, onAdded }: { notify: Notify; onAdded: () => void }) {
  const { data, reload } = useDiscovery();
  const [hosts, setHosts] = useState('');
  const start = async (network: boolean) => {
    const r = await post<{ ok: boolean; error?: string }>('/api/discover', network ? { network: true } : { hosts });
    if (!r.ok) notify(r.error ?? 'Couldn’t start looking', true);
    void reload();
  };
  const add = async (f: FoundService) => {
    const r = await post<{ ok: boolean; error?: string }>('/api/lab/config/services', { item: { name: f.name.split(' · ')[0], url: f.url, open: true } });
    if (!r.ok) notify(r.error ?? 'Couldn’t add it', true);
    else notify(`Added ${f.name}`);
    void reload();
    onAdded();
  };
  const results = data?.results ?? [];
  return (
    <div className="ad-card">
      <h2>Find services</h2>
      <p className="ad-muted">Type your servers’ addresses (or scan the whole network) to find Proxmox, Portainer, Pi-hole, the *arrs and the rest. Plex, Jellyfin, Home Assistant and co can be linked from Connections.</p>
      <div className="ad-row">
        <input className="ad-grow" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="192.168.1.10, nas.lan" />
        <button className="ad-btn primary" disabled={!hosts.trim() || data?.running} onClick={() => void start(false)}>Find</button>
        <button className="ad-btn" disabled={data?.running} onClick={() => void start(true)}>Scan network</button>
      </div>
      {data?.running ? <p className="ad-muted">Looking… {Math.round(data.progress * 100)}%</p> : null}
      {results.map((f) => (
        <div className="ad-kv" key={f.url}>
          <div className="ad-grow">
            <b>{f.name}</b>
            <div className="ad-note">{f.url}</div>
          </div>
          {f.added ? <span className="ad-note">✓ Added</span> : f.link ? <a className="ad-btn" href="/setup">Link</a> : <button className="ad-btn" onClick={() => void add(f)}>Add</button>}
        </div>
      ))}
    </div>
  );
}
