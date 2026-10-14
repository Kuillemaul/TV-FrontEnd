import { useState } from 'react';
import { EntityCard } from '../components/EntityCard';
import { NowPlaying } from '../components/NowPlaying';
import { AddProfile, Avatar, PinPad } from '../components/Profiles';
import { Sparkline } from '../components/Sparkline';
import { SettingsExtras } from '../components/SettingsExtras';
import { SoundSettings } from '../components/SoundSettings';
import { ControllerTest } from '../components/ControllerTest';
import { GamingPcsSettings } from '../components/Pairing';
import { DisplaySettings } from '../components/DisplaySettings';
import { BluetoothSettings } from '../components/BluetoothSettings';
import { WifiSettings } from '../components/WifiSettings';
import { Icon } from '../components/Icon';
import { Button, DemoBanner, Modal, NotSetUp, PageHeader, Tile } from '../components/Layout';
import { post, useApi, useServerEvents, type AppTile, type Dashboard, type HaEntity, type LabStatus } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { focusElement } from '../nav/spatial';
import { appArt } from '../components/TileArt';

export function AppsPage() {
  const hearth = useHearth();
  const { data, reload } = useApi<AppTile[]>('/api/apps');
  useServerEvents((e) => e.type === 'apps' && void reload());
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
          <Tile key={a.id} pin={{ kind: 'app', id: a.id }} shape="app" title={a.name} color={a.color} image={a.logo} art={appArt(a)} autoFocus={i === 0} onSelect={() => hearth.launchApp(a.id)} />
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
      {data && !data.setup ? (
        <NotSetUp icon="bulb" title="Home Assistant isn’t connected yet">
          Add your Home Assistant address and a long-lived access token under <code>homeassistant</code> in config.yaml.
        </NotSetUp>
      ) : null}
      {data?.setup && !data.connected ? <DemoBanner>Reconnecting to Home Assistant…</DemoBanner> : null}
      <NowPlaying dash={data} />
      {data?.sections.map((s, si) => (
        <section className="ha-section" key={s.title}>
          <h2>{s.title}</h2>
          <div className="grid grid-entities">
            {s.entities.map((e, ei) => (
              // Start on the first device, not the music controls above.
              <EntityCard key={e.entity_id} entity={e} isDefault={si === 0 && ei === 0} />
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
      {data && !data.demo && !data.services.length && !data.sensors.length ? (
        <NotSetUp icon="server" title="No home lab services yet">
          List your servers under <code>lab.services</code> in config.yaml (and HA sensors under <code>lab.sensors</code>) to see
          whether they’re up.
        </NotSetUp>
      ) : null}

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
                <Sparkline entity={s.entity_id} unit={s.attributes.unit_of_measurement} />
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
      <LabActions />
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: 'profiles', label: 'Profiles & family', icon: 'home' },
  { id: 'look', label: 'Look & apps', icon: 'palette' },
  { id: 'tv', label: 'TV & picture', icon: 'tv' },
  { id: 'sound', label: 'Sound', icon: 'volumeUp' },
  { id: 'network', label: 'Network & remote', icon: 'wifi' },
  { id: 'games', label: 'Games & controllers', icon: 'gamepad' },
  { id: 'alerts', label: 'Alerts & automations', icon: 'bell' },
  { id: 'about', label: 'Help & about', icon: 'settings' },
] as const;
type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
/** The section you were last in, for coming back to Settings. */
let lastSettingsSection: SettingsSectionId = 'profiles';

export function SettingsPage() {
  const hearth = useHearth();
  const [current, setCurrent] = useState<SettingsSectionId>(lastSettingsSection);
  const choose = (id: SettingsSectionId) => {
    lastSettingsSection = id;
    setCurrent(id);
  };
  const [confirm, setConfirm] = useState<null | { action: string; label: string }>(null);
  const [adding, setAdding] = useState(false);
  const [padTest, setPadTest] = useState(false);
  const sys = (action: string) => void post(`/api/system/${action}`);

  const section = SETTINGS_SECTIONS.find((x) => x.id === current) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <div className="settings-layout">
        {/* Moving down the menu shows each section; Right goes into it. */}
        <nav className="settings-menu" data-nav-group data-nav-exit-right=".settings-content [data-nav]" data-nav-exit-left="none" data-nav-exit-up=".topbar .tab-active" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((x) => (
            <button
              key={x.id}
              className={`settings-menu-item ${x.id === section.id ? 'active' : ''}`}
              data-nav
              data-nav-default={x.id === section.id || undefined}
              onFocus={() => choose(x.id)}
              onClick={() => {
                choose(x.id);
                // OK on a section opens it: focus its first setting.
                requestAnimationFrame(() => {
                  const first = document.querySelector<HTMLElement>('.settings-content [data-nav]');
                  if (first) focusElement(first);
                });
              }}
            >
              <Icon name={x.icon} size="1.2em" />
              <span>{x.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content" key={section.id} data-nav-exit-left=".settings-menu-item.active" data-nav-exit-right="none" data-nav-exit-down="none" data-nav-exit-up=".topbar .tab-active">
          {section.id === 'profiles' ? (
            <>
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
              <SettingsExtras part="family" />
            </>
          ) : null}
          {section.id === 'look' ? (
            <section className="settings-group">
              <h2>Look & apps</h2>
              <div className="settings-row" data-nav-group>
                <Button icon="palette" onClick={hearth.openTheme}>Theme</Button>
                <Button icon="apps" onClick={hearth.editApps}>Arrange apps</Button>
              </div>
            </section>
          ) : null}
          {section.id === 'look' ? <SettingsExtras part="look" /> : null}
          {section.id === 'tv' ? (
            <>
              <SettingsExtras part="tv" />
              <DisplaySettings />
              <section className="settings-group">
                <h2>Sleep timer</h2>
                <div className="settings-row" data-nav-group>
                  <Button icon="moon" variant="ghost" onClick={() => void post('/api/sleep', { minutes: 0 }).then(() => hearth.toast('Sleep timer off'))}>
                    Off
                  </Button>
                  {[15, 30, 60, 90, 120].map((m) => {
                    const label = m < 60 ? `${m} min` : `${m / 60} h`.replace('1.5 h', '1½ h');
                    return (
                      <Button key={m} onClick={() => void post('/api/sleep', { minutes: m }).then(() => hearth.toast(`Going to sleep in ${label}`))}>
                        {label}
                      </Button>
                    );
                  })}
                </div>
                <p className="modal-sub">Or say “sleep timer one hour”, or use quick settings. A minute before, you can choose to keep watching.</p>
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
            </>
          ) : null}
          {section.id === 'sound' ? <SoundSettings /> : null}
          {section.id === 'network' ? (
            <>
              <WifiSettings />
              <BluetoothSettings />
              <SettingsExtras part="remote" />
            </>
          ) : null}
          {section.id === 'games' ? (
            <>
              {!hearth.isKid ? <GamingPcsSettings /> : null}
              <section className="settings-group">
                <h2>Controllers</h2>
                <div className="settings-row" data-nav-group>
                  <Button icon="gamepad" onClick={() => setPadTest(true)}>Test controllers</Button>
                </div>
              </section>
            </>
          ) : null}
          {section.id === 'alerts' ? <SettingsExtras part="alerts" /> : null}
          {section.id === 'about' ? (
            <>
              <section className="settings-group">
                <h2>Controls</h2>
                <div className="help-grid">
                  <div><kbd>Arrows</kbd> / D-pad / stick</div><div>Move</div>
                  <div><kbd>Enter</kbd> / A</div><div>Select (on a text box: on-screen keyboard)</div>
                  <div><kbd>Esc</kbd> / <kbd>Backspace</kbd> / B</div><div>Back</div>
                  <div><kbd>M</kbd> / Y / mic key</div><div>Voice assistant</div>
                  <div><kbd>P</kbd> / X / Menu key / right-click</div><div>Pin to Home (or move/unpin on Home); elsewhere, quick settings</div>
                  <div>LB / RB</div><div>Previous / next page</div>
                  <div>Remote Home / hold Guide button</div><div>Close any app and return here</div>
                </div>
              </section>
              <section className="settings-group">
                <h2>About</h2>
                <div className="about">
                  {hearth.info?.admin ? (
                    <div>
                      Edit everything from your phone or laptop: <code>{hearth.info.admin.url}</code>
                    </div>
                  ) : null}
                  <div>Config file: <code>{hearth.info?.configPath}</code></div>
                  <div>
                    {(['tv', 'homeassistant', 'games'] as const)
                      .map((k) => `${{ tv: 'Live TV', homeassistant: 'Home Assistant', games: 'Games' }[k]} ${hearth.info?.demo[k] ? 'demo' : hearth.info?.setup[k] ? 'set up' : 'not set up'}`)
                      .join(' · ')}
                  </div>
                  {hearth.info?.ignoredExamples.length ? (
                    <div>Skipped example entries still in config.yaml (safe to delete): {hearth.info.ignoredExamples.join(', ')}</div>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>

      {padTest ? <ControllerTest onClose={() => setPadTest(false)} /> : null}
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

/** One-button homelab actions (restart a container, reboot a Pi…). Parents only, PIN-confirmed. */
function LabActions() {
  const hearth = useHearth();
  const { data } = useApi<{ demo: boolean; actions: Array<{ index: number; name: string }> }>(hearth.isKid ? null : '/api/lab/actions');
  const [pending, setPending] = useState<{ index: number; name: string } | null>(null);
  const [error, setError] = useState('');
  if (!data?.actions.length) return null;

  const runAction = async (index: number, pin?: string) => {
    const res = await post(`/api/lab/actions/${index}`, { pin });
    if (res.ok) setPending(null);
    else setError(res.error ?? 'Failed');
  };
  const needsPin = Boolean(hearth.profile?.hasPin);

  return (
    <section className="lab-actions settings-group">
      <h2>Actions</h2>
      <div className="settings-row" data-nav-group>
        {data.actions.map((a) => (
          <Button key={a.index} icon="refresh" onClick={() => { setError(''); setPending(a); }}>
            {a.name}
          </Button>
        ))}
      </div>
      {pending && needsPin ? (
        <PinPad title={`PIN to run “${pending.name}”`} error={error} onClose={() => setPending(null)} onSubmit={(pin) => void runAction(pending.index, pin)} />
      ) : pending ? (
        <Modal title={`${pending.name}?`} onClose={() => setPending(null)}>
          <p className="modal-text">Tip: set a PIN on your profile so this always asks for it.</p>
          {error ? <div className="form-error">{error}</div> : null}
          <div className="modal-actions">
            <Button variant="primary" autoFocus onClick={() => void runAction(pending.index)}>Run it</Button>
            <Button onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
