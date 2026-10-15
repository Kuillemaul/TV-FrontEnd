import { useEffect, useState, type ReactNode } from 'react';
import { Button, Modal } from '../components/Layout';
import { post, useApi, useServerEvents } from '../lib/api';
import { FoundUrls, HomeAssistantPanel, ImmichPanel, MediaServerPanel, PlexPanel, SeerrPanel, TvheadendPanel, DownloadsPanel } from './ConnectPanels';
import { api, type SetupView } from './types';
import './setup.css';

export interface FoundService {
  host: string;
  port: number;
  url: string;
  kind: string;
  name: string;
  link?: 'plex' | 'jellyfin' | 'emby' | 'homeassistant' | 'tvheadend' | 'seerr' | 'radarr' | 'sonarr' | 'lidarr' | 'immich';
  /** Already linked or on the Lab page. */
  added: boolean;
}
export interface Discovery {
  running: boolean;
  progress: number;
  hosts: string[];
  results: FoundService[];
  error?: string;
  at?: number;
}

/** The last scan's results, kept up to date while one runs. */
export function useDiscovery() {
  const d = useApi<Discovery>('/api/discover');
  useServerEvents((e) => e.type === 'discover' && void d.reload());
  // Phones (the network editor) get no live events: check every second and a half while it looks.
  useEffect(() => {
    if (!d.data?.running) return;
    const t = setInterval(() => void d.reload(), 1500);
    return () => clearInterval(t);
  }, [d.data?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  return d;
}

/** First address found for each linkable service, for the link forms to start with. */
export function foundUrls(d: Discovery | null): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const f of d?.results ?? []) if (f.link && !out[f.link]) out[f.link] = f.url;
  return out;
}

/** Which setup choice a found app belongs to (so linking it in setup doesn't hide its page). */
const SERVICE_FOR: Record<string, string> = { radarr: 'downloads', sonarr: 'downloads', lidarr: 'downloads', immich: 'photos' };

/**
 * "Find my servers": type an address (or scan the whole network) and see what's running there.
 * Apps Hearth links to get "Link" (the form opens filled in); anything else can go on the Lab page.
 */
export function FindServers({ view, reload, mode = 'all', intro }: { view?: SetupView; reload?: () => void; mode?: 'all' | 'lab'; intro?: ReactNode }) {
  const { data } = useDiscovery();
  const [hosts, setHosts] = useState('');
  const [error, setError] = useState('');
  const [linking, setLinking] = useState<FoundService | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set());

  const start = async (network: boolean) => {
    setError('');
    const r = await post<{ ok: boolean; error?: string }>('/api/discover', network ? { network: true } : { hosts });
    if (!r.ok) setError(r.error ?? 'Couldn’t start looking');
  };
  const addToLab = async (f: FoundService) => {
    setAdding((s) => new Set(s).add(f.url));
    const r = await post<{ ok: boolean; error?: string }>('/api/lab/config/services', { item: { name: f.name.split(' · ')[0], url: f.url, open: true } });
    if (!r.ok) setError(r.error ?? 'Couldn’t add it');
    // In setup, adding something to the Lab means you want the Lab page.
    else if (view?.active && view.draft.services.lab === 'no') await api.patch({ services: { ...view.draft.services, lab: 'link' } });
    reload?.();
  };
  const markLinked = async (f: FoundService) => {
    const service = SERVICE_FOR[f.link!] ?? f.link!;
    if (view?.active && (view.draft.services as Record<string, string>)[service] === 'no') await api.patch({ services: { ...view.draft.services, [service]: 'link' } });
  };

  const results = (data?.results ?? []).filter((f) => mode === 'all' || !f.link);
  const labCandidates = results.filter((f) => !f.link && !f.added && !adding.has(f.url));

  return (
    <div className="find">
      {intro ?? (
        <p className="setup-text">
          Already have servers? Type their addresses and Hearth finds Plex, Jellyfin, Home Assistant, Radarr, Proxmox and the rest on them.
        </p>
      )}
      <div className="setup-row" data-nav-group>
        <label className="field">
          <span>Server addresses</span>
          <input data-nav value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="192.168.1.10, nas.lan" autoCapitalize="off" spellCheck={false} />
        </label>
        <Button variant="primary" icon="search" disabled={!hosts.trim() || data?.running} onClick={() => void start(false)}>
          Find
        </Button>
        <Button disabled={data?.running} onClick={() => void start(true)}>
          Scan my whole network
        </Button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {data?.running ? (
        <div className="setup-job">
          <span className="setup-spinner" /> Looking on {data.hosts.join(', ')}… {Math.round(data.progress * 100)}%
        </div>
      ) : data?.at && !results.length ? (
        <div className="setup-job">Nothing found on {data.hosts.join(', ')}.</div>
      ) : null}

      {results.length ? (
        <div className="find-list">
          {results.map((f) => (
            <div key={f.url} className={`find-row ${f.added ? 'added' : ''}`} data-nav-group>
              <span className="find-text">
                <b>{f.name}</b>
                <span>{f.url}</span>
              </span>
              {f.added || adding.has(f.url) ? (
                <span className="find-added">✓ {f.link ? 'Linked' : 'On the Lab page'}</span>
              ) : f.link && mode === 'all' ? (
                <Button variant="primary" onClick={() => setLinking(f)}>
                  Link
                </Button>
              ) : (
                <Button onClick={() => void addToLab(f)}>Add to Lab</Button>
              )}
            </div>
          ))}
          {labCandidates.length > 1 ? (
            <div className="setup-row" data-nav-group>
              <Button
                icon="plus"
                onClick={async () => {
                  for (const f of labCandidates) await addToLab(f);
                }}
              >
                Add all {labCandidates.length} to the Lab page
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {linking && view ? (
        <Modal title={`Link ${linking.name}`} onClose={() => setLinking(null)} wide>
          <FoundUrls.Provider value={{ [linking.link!]: linking.url }}>
            <div className="setup-item-body conn-panel">
              <LinkPanel found={linking} view={view} reload={() => (void markLinked(linking), reload?.())} />
            </div>
          </FoundUrls.Provider>
          <div className="modal-actions">
            <Button onClick={() => setLinking(null)}>Close</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function LinkPanel({ found, view, reload }: { found: FoundService; view: SetupView; reload: () => void }) {
  switch (found.link) {
    case 'plex':
      return <PlexPanel view={view} reload={reload} mode="link" />;
    case 'jellyfin':
    case 'emby':
      return <MediaServerPanel view={view} reload={reload} kind={found.link} mode="link" />;
    case 'homeassistant':
      return <HomeAssistantPanel view={view} reload={reload} mode="link" />;
    case 'tvheadend':
      return <TvheadendPanel view={view} reload={reload} mode="link" />;
    case 'seerr':
      return <SeerrPanel view={view} reload={reload} mode="link" />;
    case 'immich':
      return <ImmichPanel view={view} reload={reload} mode="link" />;
    default:
      return <DownloadsPanel view={view} reload={reload} mode="link" />;
  }
}
