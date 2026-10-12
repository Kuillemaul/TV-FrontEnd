import { useState } from 'react';
import { EntityCard } from '../components/EntityCard';
import { AddProfile, Avatar } from '../components/Profiles';
import { Icon } from '../components/Icon';
import { Button, DemoBanner, Modal, PageHeader, Tile } from '../components/Layout';
import { post, useApi, useServerEvents, type AppTile, type Dashboard, type HaEntity, type LabStatus } from '../lib/api';
import { useHearth } from '../lib/hearth';

export function AppsPage() {
  const hearth = useHearth();
  const { data } = useApi<AppTile[]>('/api/apps');
  return (
    <div className="page">
      <PageHeader title="Apps">
        {!hearth.isKid ? (
          <Button icon="apps" onClick={hearth.editApps}>
            Edit apps
          </Button>
        ) : null}
      </PageHeader>
      {data && data.length === 0 ? <div className="empty">No apps on this profile yet.</div> : null}
      <div className="grid grid-apps">
        {data?.map((a, i) => (
          <Tile key={a.id} shape="app" title={a.name} color={a.color} image={a.logo} autoFocus={i === 0} onSelect={() => hearth.launchApp(a.id)} />
        ))}
      </div>
    </div>
  );
}

/** Keep a list of HA entities live as state_changed events arrive. */
function patchEntities<T extends HaEntity>(list: T[], next: HaEntity): T[] {
  return list.map((e) => (e.entity_id === next.entity_id ? ({ ...next, attributes: { ...next.attributes, friendly_name: e.attributes.friendly_name ?? next.attributes.friendly_name } } as T) : e));
}

export function SmartHomePage() {
  const { data, setData } = useApi<Dashboard>('/api/ha/dashboard');
  useServerEvents((e) => {
    if (e.type === 'ha-state' && data) {
      setData({ ...data, sections: data.sections.map((s) => ({ ...s, entities: patchEntities(s.entities, e.entity) })) });
    }
    if (e.type === 'ha-connection' && data) setData({ ...data, connected: e.connected });
  });

  return (
    <div className="page">
      <PageHeader title="Smart Home">
        {data?.hasLovelace ? (
          <Button icon="external" onClick={() => void post('/api/ha/open-dashboard')}>
            Full dashboard
          </Button>
        ) : null}
      </PageHeader>
      {data?.demo ? <DemoBanner>Demo devices. Add your Home Assistant URL and a long-lived token in config.yaml.</DemoBanner> : null}
      {data && !data.connected ? <DemoBanner>Reconnecting to Home Assistant…</DemoBanner> : null}
      {data?.sections.map((s) => (
        <section className="ha-section" key={s.title}>
          <h2>{s.title}</h2>
          <div className="grid grid-entities">
            {s.entities.map((e) => (
              <EntityCard key={e.entity_id} entity={e} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function LabPage() {
  const { data, setData } = useApi<LabStatus>('/api/lab', 15_000);
  useServerEvents((e) => {
    if (e.type === 'ha-state' && data) setData({ ...data, sensors: patchEntities(data.sensors, e.entity) });
  });

  return (
    <div className="page">
      <PageHeader title="Home Lab" />
      {data?.demo ? <DemoBanner>Demo services. List your homelab services under lab.services in config.yaml.</DemoBanner> : null}

      {data?.sensors.length ? (
        <div className="grid grid-stats">
          {data.sensors.map((s) => {
            const value = Number(s.state);
            const pct = s.attributes.unit_of_measurement === '%' && Number.isFinite(value) ? value : null;
            return (
              <div className="stat" key={s.entity_id} data-nav tabIndex={-1}>
                <div className="stat-label">{s.attributes.friendly_name ?? s.entity_id}</div>
                <div className="stat-value">
                  {s.state}
                  <span className="stat-unit">{s.attributes.unit_of_measurement ?? ''}</span>
                </div>
                {pct !== null ? (
                  <div className={`stat-bar ${pct > 85 ? 'hot' : pct > 65 ? 'warm' : ''}`}>
                    <div style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="grid grid-services">
        {data?.services.map((svc, i) => (
          <button key={svc.name} className="service" data-nav onClick={() => svc.open && void post('/api/lab/open', { index: i })}>
            <span className={`dot ${svc.up === null ? '' : svc.up ? 'dot-on' : 'dot-off'}`} />
            <span className="service-text">
              <span className="service-name">{svc.name}</span>
              <span className="service-url">{svc.url.replace(/^https?:\/\//, '')}</span>
            </span>
            <span className="service-latency">{svc.up ? `${svc.latencyMs} ms` : svc.up === false ? 'Down' : '…'}</span>
            {svc.open ? <Icon name="external" size="1em" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const hearth = useHearth();
  const [confirm, setConfirm] = useState<null | { action: string; label: string }>(null);
  const [adding, setAdding] = useState(false);
  const sys = (action: string) => void post(`/api/system/${action}`);

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <section className="settings-group">
        <h2>Profiles</h2>
        <div className="profile-cards" data-nav-group>
          {hearth.profiles?.profiles.map((p) => (
            <button key={p.id} className="profile-card" data-nav onClick={() => hearth.editProfile(p.id)}>
              <Avatar profile={p} />
              <span className="profile-card-name">{p.name}</span>
              <span className="profile-card-sub">
                {p.kind === 'kid' ? `★ Kid · ${p.apps?.length ?? 'all'} apps · ${p.games?.length ?? 'all'} games` : `Parent${p.hasPin ? ' · PIN' : ''}`}
              </span>
            </button>
          ))}
          <button className="profile-card profile-card-add" data-nav onClick={() => setAdding(true)}>
            <span className="avatar avatar-md avatar-add">+</span>
            <span className="profile-card-name">Add profile</span>
            <span className="profile-card-sub">For the kids, or another adult</span>
          </button>
        </div>
      </section>
      <section className="settings-group">
        <h2>Look & apps</h2>
        <div className="settings-row" data-nav-group>
          <Button icon="bulb" onClick={hearth.openTheme}>Theme</Button>
          <Button icon="apps" onClick={hearth.editApps}>Arrange apps</Button>
        </div>
      </section>
      <section className="settings-group">
        <h2>Sound</h2>
        <div className="settings-row" data-nav-group>
          <Button icon="volumeDown" onClick={() => sys('volumeDown')}>Volume down</Button>
          <Button icon="volumeUp" onClick={() => sys('volumeUp')}>Volume up</Button>
          <Button icon="mute" onClick={() => sys('mute')}>Mute</Button>
        </div>
      </section>
      <section className="settings-group">
        <h2>Power</h2>
        <div className="settings-row" data-nav-group>
          <Button icon="moon" onClick={() => setConfirm({ action: 'suspend', label: 'Sleep' })}>Sleep</Button>
          <Button icon="refresh" onClick={() => setConfirm({ action: 'reboot', label: 'Restart' })}>Restart</Button>
          <Button icon="power" variant="danger" onClick={() => setConfirm({ action: 'poweroff', label: 'Shut down' })}>Shut down</Button>
          <Button icon="refresh" variant="ghost" onClick={() => location.reload()}>Reload interface</Button>
        </div>
      </section>
      <section className="settings-group">
        <h2>Controls</h2>
        <div className="help-grid">
          <div><kbd>Arrows</kbd> / D-pad / stick</div><div>Move</div>
          <div><kbd>Enter</kbd> / A</div><div>Select</div>
          <div><kbd>Esc</kbd> / <kbd>Backspace</kbd> / B</div><div>Back</div>
          <div><kbd>M</kbd> / Y / mic key</div><div>Voice assistant</div>
          <div>Remote Home / hold Guide button</div><div>Close any app and return here</div>
        </div>
      </section>
      <section className="settings-group">
        <h2>About</h2>
        <div className="about">
          <div>Config file: <code>{hearth.info?.configPath}</code></div>
          <div>
            Live TV {hearth.info?.demo.tv ? 'demo' : 'connected'} · Home Assistant {hearth.info?.demo.homeassistant ? 'demo' : 'configured'} · Games{' '}
            {hearth.info?.demo.games ? 'demo' : 'configured'}
          </div>
        </div>
      </section>

      {adding ? (
        <AddProfile
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            hearth.editProfile(id);
          }}
        />
      ) : null}
      {confirm ? (
        <Modal title={`${confirm.label}?`} onClose={() => setConfirm(null)}>
          <div className="modal-actions">
            <Button variant="primary" autoFocus onClick={() => { sys(confirm.action); setConfirm(null); }}>
              {confirm.label}
            </Button>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
