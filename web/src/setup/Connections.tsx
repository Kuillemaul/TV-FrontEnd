import { useContext, useState, type ReactNode } from 'react';
import { Button, Modal } from '../components/Layout';
import { useApi, useServerEvents } from '../lib/api';
import { HearthContext } from '../lib/hearth';
import { DownloadsPanel, GamesPanel, HomeAssistantPanel, MediaServerPanel, PlexDvrPanel, PlexPanel, SeerrPanel, TvheadendPanel } from './ConnectPanels';
import { api, jobFor, type SetupView } from './types';
import './setup.css';

interface Row {
  id: string;
  name: string;
  what: string;
  linked: { url?: string } | null;
  /** Panel for linking an existing one. */
  link?: (view: SetupView, reload: () => void) => ReactNode;
  /** Docker app(s) to install here, and the panel that follows the install. */
  install?: { apps: string[]; panel: (view: SetupView, reload: () => void) => ReactNode; needsSignIn?: boolean };
  /** config.yaml key(s) to unlink. */
  unlink?: string[];
}

const PAGES: Array<[string, string]> = [
  ['livetv', 'Live TV'],
  ['games', 'Games'],
  ['smarthome', 'Smart Home'],
  ['lab', 'Lab'],
];

/**
 * Settings → Connections (and the phone's /setup page once set up): what Hearth is linked to,
 * with Link / Install here / Unlink for each, page on/off switches, and "Run setup again".
 */
export function Connections({ onPhone = false, notify }: { onPhone?: boolean; notify?: (msg: string, bad?: boolean) => void }) {
  const { data: view, reload } = useApi<SetupView>('/api/setup', 4000);
  const [open, setOpen] = useState<{ row: Row; mode: 'link' | 'install' } | null>(null);
  useServerEvents((e) => (e.type === 'setup' || e.type === 'installs') && void reload());
  const hearth = useHearthSafe();
  const say = (msg: string, bad = false) => (notify ? notify(msg, bad) : hearth?.toast(msg, bad ? 'error' : 'info'));
  const hidden = new Set(useApiHide());

  if (!view) return null;
  const l = view.linked;
  const rows: Row[] = [
    { id: 'plex', name: 'Plex', what: 'Continue watching, Recently added, search', linked: l.plex, link: (v, r) => <PlexPanel view={v} reload={r} mode="link" />, install: { apps: ['plex'], needsSignIn: true, panel: (v, r) => <PlexPanel view={v} reload={r} mode="install" /> }, unlink: ['plex'] },
    { id: 'jellyfin', name: 'Jellyfin', what: 'Media server', linked: l.jellyfin, link: (v, r) => <MediaServerPanel view={v} reload={r} kind="jellyfin" mode="link" />, install: { apps: ['jellyfin'], panel: (v, r) => <MediaServerPanel view={v} reload={r} kind="jellyfin" mode="install" /> }, unlink: ['jellyfin'] },
    { id: 'emby', name: 'Emby', what: 'Media server', linked: l.emby, link: (v, r) => <MediaServerPanel view={v} reload={r} kind="emby" mode="link" />, unlink: ['emby'] },
    { id: 'homeassistant', name: 'Home Assistant', what: 'Smart home, doorbell, sensors, voice', linked: l.homeassistant, link: (v, r) => <HomeAssistantPanel view={v} reload={r} mode="link" />, install: { apps: ['homeassistant'], panel: (v, r) => <HomeAssistantPanel view={v} reload={r} mode="install" /> }, unlink: ['homeassistant'] },
    { id: 'tvheadend', name: 'Tvheadend', what: 'Live TV from a tuner', linked: l.tvheadend, link: (v, r) => <TvheadendPanel view={v} reload={r} mode="link" />, install: { apps: ['tvheadend'], panel: (v, r) => <TvheadendPanel view={v} reload={r} mode="install" /> }, unlink: ['tvheadend'] },
    { id: 'plexdvr', name: 'Live TV from Plex', what: 'Plex’s Live TV & DVR instead of Tvheadend', linked: l.plexdvr, link: (v, r) => <PlexDvrPanel view={v} reload={r} />, unlink: ['plexdvr'] },
    { id: 'seerr', name: 'Seerr', what: 'Requests', linked: l.seerr, link: (v, r) => <SeerrPanel view={v} reload={r} mode="link" />, install: { apps: ['seerr'], panel: (v, r) => <SeerrPanel view={v} reload={r} mode="install" /> }, unlink: ['seerr'] },
    { id: 'downloads', name: 'Radarr & Sonarr', what: 'Downloads, “ready to watch”', linked: l.radarr ?? l.sonarr, link: (v, r) => <DownloadsPanel view={v} reload={r} mode="link" />, install: { apps: ['radarr', 'sonarr', 'prowlarr', 'qbittorrent'], panel: (v, r) => <DownloadsPanel view={v} reload={r} mode="install" /> }, unlink: ['radarr', 'sonarr'] },
    { id: 'games', name: 'Gaming PCs', what: 'Game streaming with Moonlight', linked: l.games ? { url: l.games.names.join(', ') } : null, link: (v, r) => <GamesPanel view={v} reload={r} /> },
  ];

  const install = async (row: Row) => {
    if (row.install?.needsSignIn) return setOpen({ row, mode: 'install' });
    for (const app of row.install!.apps) {
      const r = await api.call('/api/setup/install', { kind: 'docker', app, media: view.draft.media });
      if (!r.ok) return say(r.error ?? 'Couldn’t start the install', true);
    }
    setOpen({ row, mode: 'install' });
    void reload();
  };
  const unlink = async (row: Row) => {
    for (const key of row.unlink ?? []) {
      const r = await api.call(`/api/connect/${key}`, {}, 'DELETE');
      if (!r.ok) return say(r.error ?? 'Couldn’t unlink', true);
    }
    say(`Unlinked ${row.name}. Hearth is restarting…`);
  };

  return (
    <div className={`connections ${onPhone ? 'setup-phone' : ''}`}>
      <section className="settings-group">
        <h2>Connections</h2>
        <p className="modal-sub">Link what you already have, or install it on this TV. Hearth restarts for a moment to use a new connection.</p>
        <div className="conn-list">
          {rows.map((row) => {
            const installing = row.install?.apps.some((a) => ['running', 'queued'].includes(jobFor(view, a)?.state ?? ''));
            return (
              <div key={row.id} className={`conn-row ${row.linked ? 'on' : ''}`} data-nav-group>
                <span className="conn-text">
                  <b>{row.name}</b>
                  <span>{row.linked ? `✓ ${row.linked.url ?? 'On'}` : installing ? 'Installing…' : row.what}</span>
                </span>
                {row.link ? (
                  <Button onClick={() => setOpen({ row, mode: 'link' })}>{row.linked ? (row.id === 'games' ? 'Add PC' : 'Change') : row.id === 'games' ? 'Add PC' : 'Link'}</Button>
                ) : null}
                {row.install && view.installAvailable && !row.linked ? <Button onClick={() => (installing ? setOpen({ row, mode: 'install' }) : void install(row))}>{installing ? 'Progress' : 'Install here'}</Button> : null}
                {row.linked && row.unlink ? (
                  <Button variant="ghost" onClick={() => void unlink(row)}>
                    Unlink
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-group">
        <h2>Pages</h2>
        <p className="modal-sub">Hide pages you don’t use from the top bar.</p>
        <div className="settings-row" data-nav-group>
          {PAGES.map(([id, label]) => (
            <button
              key={id}
              className={`chip ${hidden.has(id) ? '' : 'chip-active'}`}
              data-nav
              onClick={async () => {
                const next = hidden.has(id) ? [...hidden].filter((h) => h !== id) : [...hidden, id];
                const r = await api.call('/api/setup/pages', { hide: next }, 'PUT');
                if (!r.ok) say(r.error ?? 'Couldn’t change that', true);
              }}
            >
              {hidden.has(id) ? '○' : '●'} {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h2>Start over</h2>
        <p className="modal-sub">Go through the setup screens again (what you’ve set up is kept and filled in).</p>
        <div className="settings-row" data-nav-group>
          <Button
            icon="refresh"
            onClick={async () => {
              const r = await api.call('/api/setup/start');
              if (!r.ok) say(r.error ?? 'Couldn’t start setup', true);
            }}
          >
            Run setup again
          </Button>
        </div>
      </section>

      {open ? (
        <Modal title={open.mode === 'install' ? `${open.row.name} on this TV` : open.row.name} onClose={() => setOpen(null)} wide>
          <div className="setup-item-body conn-panel">
            {open.mode === 'install' ? (
              open.row.install!.panel(view, () => void reload())
            ) : (
              open.row.link!(view, () => void reload())
            )}
          </div>
          <div className="modal-actions">
            <Button onClick={() => setOpen(null)}>Close</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** Pages hidden in setup (from /api/info, which updates when they change). */
function useApiHide(): string[] {
  const { data, reload } = useApi<{ hide?: string[] }>('/api/info');
  useServerEvents((e) => e.type === 'setup' && void reload());
  return data?.hide ?? [];
}

/** The TV's toast when inside the shell; the phone page has no Hearth context. */
const useHearthSafe = () => useContext(HearthContext);
