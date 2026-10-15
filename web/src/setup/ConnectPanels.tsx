import QRCode from 'qrcode';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components/Layout';
import { api, hereUrl, jobFor, type InstallJob, type ServiceId, type SetupView } from './types';

/* ---------------------------------------------------------------- small pieces */

/** Addresses found by "Find my servers", by service: the link forms start filled in with them. */
export const FoundUrls = createContext<Partial<Record<string, string>>>({});
const useFound = (kind: string) => useContext(FoundUrls)[kind];

export function Qr({ url, size = 9 }: { url: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#000', light: '#fff' } }).then(setSrc).catch(() => setSrc(''));
  }, [url]);
  return src ? <img className="setup-qr" src={src} alt={`QR code for ${url}`} style={{ width: `${size}rem`, height: `${size}rem` }} /> : null;
}

/** "Open this on your phone": a QR code and the address. */
export function OnPhone({ url, children }: { url: string; children: ReactNode }) {
  return (
    <div className="setup-onphone">
      <Qr url={url} size={7} />
      <div>
        <div>{children}</div>
        <div className="setup-url">{url}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, secret, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input data-nav type={secret ? 'password' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      {hint ? <small className="setup-hint">{hint}</small> : null}
    </label>
  );
}

export function JobLine({ job, name }: { job?: InstallJob; name: string }) {
  if (!job) return <div className="setup-job">Waiting to install {name}…</div>;
  return (
    <div className={`setup-job setup-job-${job.state}`}>
      {job.state === 'running' || job.state === 'queued' ? <span className="setup-spinner" /> : null}
      {job.state === 'failed' ? `Couldn’t install ${name}: ${job.message}` : job.message}
    </div>
  );
}

/** Run a connect call: shows errors, reloads the view on success. */
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const go = async <T,>(fn: () => Promise<{ ok: boolean; error?: string } & T>, done?: (r: T) => string | void) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'That didn’t work');
      else {
        const n = done?.(r);
        if (n) setNote(n);
        reload();
      }
      return r.ok;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, go, setError };
}

function Status({ error, note }: { error: string; note: string }) {
  return (
    <>
      {error ? <div className="form-error">{error}</div> : null}
      {note ? <div className="setup-ok">{note}</div> : null}
    </>
  );
}

const Linked = ({ what, url }: { what: string; url?: string }) => (
  <div className="setup-ok">
    ✓ Linked to {what}
    {url ? <span className="setup-url"> · {url}</span> : null}
  </div>
);

/* ---------------------------------------------------------------- Plex */

function PlexSignIn({ onSignedIn }: { onSignedIn: (servers: Array<{ name: string; url: string; local: boolean }>) => void }) {
  const [pin, setPin] = useState<{ id: number; code: string; link: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pin) return;
    const t = setInterval(async () => {
      const r = await api.call<{ signedIn: boolean; servers?: Array<{ name: string; url: string; local: boolean }> }>(`/api/connect/plex/pin/${pin.id}`, undefined, 'GET');
      if (!r.ok) {
        setError(r.error ?? 'Sign-in failed');
        setPin(null);
      } else if (r.signedIn) {
        setPin(null);
        onSignedIn(r.servers ?? []);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pin) {
    return (
      <>
        {error ? <div className="form-error">{error}</div> : null}
        <Button
          variant="primary"
          onClick={async () => {
            const r = await api.call<{ id: number; code: string; link: string }>('/api/connect/plex/pin');
            if (r.ok) setPin(r);
            else setError(r.error ?? 'Couldn’t reach plex.tv');
          }}
        >
          Sign in with Plex
        </Button>
      </>
    );
  }
  return (
    <div className="setup-pin">
      <OnPhone url={pin.link}>
        On your phone or computer, go to <b>plex.tv/link</b> and enter:
      </OnPhone>
      <div className="setup-code">{pin.code}</div>
      <div className="setup-job">
        <span className="setup-spinner" /> Waiting for you to enter the code…
      </div>
    </div>
  );
}

export function PlexPanel({ view, reload, mode }: { view: SetupView; reload: () => void; mode: 'link' | 'install' }) {
  const [servers, setServers] = useState<Array<{ name: string; url: string; local: boolean }> | null>(null);
  const [manual, setManual] = useState(useFound('plex') ?? '');
  const { busy, error, note, go } = useAction(reload);
  const job = jobFor(view, 'plex');

  useEffect(() => {
    if (view.plexSignedIn && !servers && mode === 'link') void api.call<{ servers: typeof servers }>('/api/connect/plex/servers', undefined, 'GET').then((r) => r.ok && setServers(r.servers));
  }, [view.plexSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.linked.plex) return <Linked what="Plex" url={view.linked.plex.url} />;
  if (!view.plexSignedIn) return <PlexSignIn onSignedIn={(s) => (setServers(s), reload())} />;

  if (mode === 'install') {
    if (job) {
      return (
        <>
          <JobLine job={job} name="Plex Media Server" />
          {job.state === 'done' ? <div className="setup-job"><span className="setup-spinner" /> Adding Movies, TV Shows and Music libraries…</div> : null}
          {job.state === 'failed' ? <Button onClick={() => void go(() => api.call('/api/connect/plex/install'))}>Try again</Button> : null}
        </>
      );
    }
    return (
      <>
        <p className="setup-text">Signed in. Plex Media Server will be installed here and added to your account, with libraries for {view.draft.media}/movies, /tv and /music.</p>
        <Status error={error} note={note} />
        <Button variant="primary" disabled={busy} onClick={() => void go(() => api.call('/api/connect/plex/install'))}>
          Install Plex Media Server
        </Button>
      </>
    );
  }

  return (
    <>
      <p className="setup-text">{servers?.length ? 'Which server?' : servers ? 'No servers on this account. Enter its address:' : 'Finding your servers…'}</p>
      <div className="setup-choices" data-nav-group>
        {servers?.map((s) => (
          <button key={s.url} className="setup-choice" data-nav disabled={busy} onClick={() => void go(() => api.call('/api/connect/plex', { url: s.url }), () => `Linked to ${s.name}`)}>
            <b>{s.name}</b>
            <span>{s.url}</span>
          </button>
        ))}
      </div>
      <div className="setup-row">
        <Field label="Or its address" value={manual} onChange={setManual} placeholder="http://192.168.1.10:32400" />
        <Button disabled={busy || !manual} onClick={() => void go(() => api.call('/api/connect/plex', { url: manual }))}>
          Link
        </Button>
      </div>
      <Status error={error} note={note} />
    </>
  );
}

/* ---------------------------------------------------------------- Jellyfin / Emby */

export function MediaServerPanel({ view, reload, kind, mode }: { view: SetupView; reload: () => void; kind: 'jellyfin' | 'emby'; mode: 'link' | 'install' }) {
  const name = kind === 'jellyfin' ? 'Jellyfin' : 'Emby';
  const [url, setUrl] = useState(useFound(kind) ?? '');
  const [found, setFound] = useState<Array<{ name: string; url: string }> | null>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [quick, setQuick] = useState<{ code: string; secret: string } | null>(null);
  const { busy, error, note, go, setError } = useAction(reload);
  const job = jobFor(view, 'jellyfin');
  const linked = view.linked[kind];

  useEffect(() => {
    if (mode === 'link' && !linked) void api.call<{ servers: Array<{ name: string; url: string }> }>('/api/connect/mediaserver/discover').then((r) => setFound(r.ok ? r.servers : []));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!quick) return;
    const t = setInterval(async () => {
      const r = await api.call<{ signedIn: boolean }>('/api/connect/jellyfin/quick/check', { url, secret: quick.secret });
      if (!r.ok) {
        setError(r.error ?? 'Quick Connect failed');
        setQuick(null);
      } else if (r.signedIn) {
        setQuick(null);
        reload();
      }
    }, 3000);
    return () => clearInterval(t);
  }, [quick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (linked) {
    return (
      <>
        <Linked what={name} url={linked.url} />
        <p className="setup-text">
          {kind === 'jellyfin'
            ? 'One more thing, later: open the Jellyfin app on the TV once and sign in (same server). Then Continue watching on Home plays straight in it.'
            : 'Open the Emby tile once and sign in; Continue watching on Home then opens things in it.'}
        </p>
      </>
    );
  }

  if (mode === 'install') {
    if (job?.state !== 'done') return <JobLine job={job} name="Jellyfin" />;
    return (
      <>
        <p className="setup-text">Jellyfin is running. Choose a username and password for it (you’ll use these in the Jellyfin app on phones too). Libraries are made for Movies, Shows and Music in {view.draft.media}.</p>
        <div className="form">
          <Field label="Username" value={user} onChange={setUser} placeholder="me" />
          <Field label="Password" value={pass} onChange={setPass} secret />
        </div>
        <Status error={error} note={note} />
        <Button variant="primary" disabled={busy || !user} onClick={() => void go(() => api.call('/api/connect/jellyfin/create', { username: user, password: pass }))}>
          {busy ? 'Setting up…' : 'Create account'}
        </Button>
      </>
    );
  }

  return (
    <>
      {!url ? (
        <>
          <p className="setup-text">{found === null ? `Looking for ${name} on your network…` : found.length ? 'Found on your network:' : `No ${name} server answered. Enter its address:`}</p>
          <div className="setup-choices" data-nav-group>
            {found?.map((s) => (
              <button key={s.url} className="setup-choice" data-nav onClick={() => setUrl(s.url)}>
                <b>{s.name}</b>
                <span>{s.url}</span>
              </button>
            ))}
          </div>
          <ManualUrl placeholder="http://192.168.1.10:8096" onPick={setUrl} />
        </>
      ) : (
        <>
          <p className="setup-text">
            Server: <b>{url}</b>{' '}
            <button className="setup-link" data-nav onClick={() => setUrl('')}>
              change
            </button>
          </p>
          {quick ? (
            <div className="setup-pin">
              <p className="setup-text">In a Jellyfin app where you’re signed in, open Settings → Quick Connect and enter:</p>
              <div className="setup-code">{quick.code}</div>
              <div className="setup-job">
                <span className="setup-spinner" /> Waiting for approval…
              </div>
            </div>
          ) : (
            <>
              <div className="form">
                <Field label="Username" value={user} onChange={setUser} />
                <Field label="Password" value={pass} onChange={setPass} secret />
              </div>
              <div className="setup-row" data-nav-group>
                <Button variant="primary" disabled={busy || !user} onClick={() => void go(() => api.call(`/api/connect/${kind}/login`, { url, username: user, password: pass }), (r: { user?: string }) => `Signed in as ${r.user}`)}>
                  Sign in
                </Button>
                {kind === 'jellyfin' ? (
                  <Button
                    onClick={async () => {
                      const r = await api.call<{ code: string; secret: string }>('/api/connect/jellyfin/quick', { url });
                      if (r.ok) setQuick(r);
                      else setError(r.error ?? 'Quick Connect failed');
                    }}
                  >
                    Use Quick Connect instead
                  </Button>
                ) : null}
              </div>
            </>
          )}
          <Status error={error} note={note} />
        </>
      )}
    </>
  );
}

function ManualUrl({ placeholder, onPick }: { placeholder: string; onPick: (url: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="setup-row">
      <Field label="Address" value={v} onChange={setV} placeholder={placeholder} />
      <Button disabled={!/^https?:\/\/./.test(v)} onClick={() => onPick(v.replace(/\/+$/, ''))}>
        Next
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- Home Assistant */

export function HomeAssistantPanel({ view, reload, mode }: { view: SetupView; reload: () => void; mode: 'link' | 'install' }) {
  const [url, setUrl] = useState(useFound('homeassistant') ?? 'http://homeassistant.local:8123');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const { busy, error, note, go } = useAction(reload);
  const job = jobFor(view, 'homeassistant');

  if (view.linked.homeassistant) return <Linked what="Home Assistant" url={view.linked.homeassistant.url} />;
  if (mode === 'install') {
    if (job?.state !== 'done') return <JobLine job={job} name="Home Assistant" />;
    return (
      <>
        <p className="setup-text">Home Assistant is running. Create its owner account here (it starts in the background, so this can take a minute):</p>
        <div className="form">
          <Field label="Your name" value={name} onChange={setName} placeholder="Sam" />
          <Field label="Username" value={user} onChange={setUser} placeholder="sam" />
          <Field label="Password" value={pass} onChange={setPass} secret hint="At least 6 characters" />
        </div>
        <Status error={error} note={note} />
        <Button variant="primary" disabled={busy || !user || pass.length < 6} onClick={() => void go(() => api.call('/api/connect/homeassistant/create', { name, username: user, password: pass }))}>
          {busy ? 'Setting up… (up to 2 minutes)' : 'Create account and link'}
        </Button>
        <OnPhone url={hereUrl(view, 'homeassistant')}>Afterwards, add your lights and devices in Home Assistant on your phone:</OnPhone>
      </>
    );
  }
  return (
    <>
      <div className="form">
        <Field label="Address" value={url} onChange={setUrl} />
        <Field label="Long-lived access token" value={token} onChange={setToken} secret hint="In Home Assistant: your profile → Security → Long-lived access tokens → Create token" />
      </div>
      {view.phoneUrl && !view.phoneUrl.includes(location.host) ? <OnPhone url={view.phoneUrl}>Easier to paste the token on your phone:</OnPhone> : null}
      <Status error={error} note={note} />
      <Button variant="primary" disabled={busy || !token} onClick={() => void go(() => api.call('/api/connect/homeassistant', { url, token }), (r: { name?: string }) => `Linked to ${r.name}`)}>
        Link
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- Live TV */

export function TvheadendPanel({ view, reload, mode }: { view: SetupView; reload: () => void; mode: 'link' | 'install' }) {
  const [url, setUrl] = useState(useFound('tvheadend') ?? 'http://');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const { busy, error, note, go } = useAction(reload);
  const job = jobFor(view, 'tvheadend');
  if (mode === 'install') {
    return (
      <>
        <JobLine job={job} name="Tvheadend" />
        {job?.state === 'done' ? (
          <OnPhone url={hereUrl(view, 'tvheadend')}>Now scan for channels: open Tvheadend on your phone and follow its setup wizard (pick your tuner, country and channel list).</OnPhone>
        ) : null}
      </>
    );
  }
  if (view.linked.tvheadend) return <Linked what="Tvheadend" url={view.linked.tvheadend.url} />;
  return (
    <>
      <div className="form">
        <Field label="Address" value={url} onChange={setUrl} placeholder="http://192.168.1.10:9981" />
        <Field label="Username (if it asks for one)" value={user} onChange={setUser} />
        <Field label="Password" value={pass} onChange={setPass} secret />
      </div>
      <Status error={error} note={note} />
      <Button variant="primary" disabled={busy} onClick={() => void go(() => api.call('/api/connect/tvheadend', { url, username: user, password: pass }))}>
        Link
      </Button>
    </>
  );
}

export function PlexDvrPanel({ view, reload }: { view: SetupView; reload: () => void }) {
  const { busy, error, note, go } = useAction(reload);
  if (view.linked.plexdvr) return <Linked what="Plex Live TV & DVR" />;
  return (
    <>
      <p className="setup-text">Uses the tuner and guide set up in your Plex server (Settings → Live TV & DVR).</p>
      <Status error={error} note={note} />
      <Button variant="primary" disabled={busy || !view.linked.plex} onClick={() => void go(() => api.call('/api/connect/plexdvr', { on: true }))}>
        {view.linked.plex ? 'Use Plex for Live TV' : 'Link Plex first'}
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- requests & downloads */

function ArrForm({ kind, label, placeholder, keyHint, reload }: { kind: 'seerr' | 'radarr' | 'sonarr'; label: string; placeholder: string; keyHint: string; reload: () => void }) {
  const [url, setUrl] = useState(useFound(kind) ?? 'http://');
  const [key, setKey] = useState('');
  const { busy, error, note, go } = useAction(reload);
  return (
    <div className="setup-subform">
      <div className="form">
        <Field label={`${label} address`} value={url} onChange={setUrl} placeholder={placeholder} />
        <Field label="API key" value={key} onChange={setKey} hint={keyHint} />
      </div>
      <Status error={error} note={note} />
      <Button variant="primary" disabled={busy || !key} onClick={() => void go(() => api.call('/api/connect/arr', { kind, url, apiKey: key }))}>
        Link {label}
      </Button>
    </div>
  );
}

export function SeerrPanel({ view, reload, mode }: { view: SetupView; reload: () => void; mode: 'link' | 'install' }) {
  const job = jobFor(view, 'seerr');
  if (mode === 'install') {
    return (
      <>
        <JobLine job={job} name="Seerr" />
        {job?.state === 'done' ? <OnPhone url={hereUrl(view, 'seerr')}>Finish Seerr on your phone: sign in with your Plex or Jellyfin account and point it at Radarr and Sonarr.</OnPhone> : null}
        {view.linked.seerr ? <Linked what="Seerr" url={view.linked.seerr.url} /> : null}
      </>
    );
  }
  if (view.linked.seerr) return <Linked what="Seerr" url={view.linked.seerr.url} />;
  return <ArrForm kind="seerr" label="Seerr" placeholder="http://192.168.1.10:5055" keyHint="Seerr → Settings → General → API key" reload={reload} />;
}

export function DownloadsPanel({ view, reload, mode }: { view: SetupView; reload: () => void; mode: 'link' | 'install' }) {
  if (mode === 'install') {
    const qb = jobFor(view, 'qbittorrent');
    const allDone = ['radarr', 'sonarr', 'prowlarr', 'qbittorrent'].every((a) => jobFor(view, a)?.state === 'done');
    return (
      <>
        {['radarr', 'sonarr', 'prowlarr', 'qbittorrent'].map((a) => (
          <JobLine key={a} job={jobFor(view, a)} name={view.catalog.docker[a]?.name ?? a} />
        ))}
        {qb?.password ? (
          <div className="setup-text">
            qBittorrent sign-in: <b>{qb.username}</b> / <b>{qb.password}</b> (change it in its settings)
          </div>
        ) : null}
        {allDone ? (
          <OnPhone url={hereUrl(view, 'prowlarr')}>
            Last step, on your phone: add search sites in Prowlarr, then in Radarr and Sonarr add qBittorrent as the download client (Settings → Download clients, host <b>localhost</b>, port 8080).
          </OnPhone>
        ) : null}
      </>
    );
  }
  return (
    <>
      {view.linked.radarr ? <Linked what="Radarr" url={view.linked.radarr.url} /> : <ArrForm kind="radarr" label="Radarr" placeholder="http://192.168.1.10:7878" keyHint="Radarr → Settings → General → API key" reload={reload} />}
      {view.linked.sonarr ? <Linked what="Sonarr" url={view.linked.sonarr.url} /> : <ArrForm kind="sonarr" label="Sonarr" placeholder="http://192.168.1.10:8989" keyHint="Sonarr → Settings → General → API key" reload={reload} />}
    </>
  );
}

/* ---------------------------------------------------------------- games */

export function GamesPanel({ view, reload }: { view: SetupView; reload: () => void }) {
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const { busy, error, note, go } = useAction(reload);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <JobLine job={jobFor(view, 'moonlight')} name="Moonlight" />
      {view.linked.games ? <div className="setup-ok">✓ {view.linked.games.names.join(', ')}</div> : null}
      <p className="setup-text">
        On each gaming PC, install Apollo (or Sunshine) and the Hearth PC agent (<b>pc-agent/setup-windows.ps1</b>). The agent shows its token when it’s set up. You can also add PCs later in Settings.
      </p>
      <div className="form">
        <Field label="PC address" value={address} onChange={setAddress} placeholder="192.168.1.50" />
        <Field label="Agent token" value={token} onChange={setToken} />
      </div>
      <Status error={error} note={note} />
      <Button variant="primary" disabled={busy || !address || !token} onClick={() => void go(() => api.call('/api/connect/games', { address, token }), (r: { name?: string }) => { setAddress(''); setToken(''); return `Added ${r.name}. Pair it with Moonlight after setup (Settings → Gaming PCs).`; })}>
        Add PC
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- the checklist */

export interface ConnectItem {
  id: string;
  title: string;
  done: boolean;
  /** Short state shown on the collapsed card. */
  state: string;
  panel: ReactNode;
}

/** What still needs linking or installing for the choices made, in a sensible order. */
export function connectItems(view: SetupView, reload: () => void): ConnectItem[] {
  const s = view.draft.services;
  const items: ConnectItem[] = [];
  const flat = (app: string, title: string) => {
    const job = jobFor(view, app);
    const installed = view.installs.apps[app]?.installed;
    items.push({ id: app, title, done: Boolean(installed || job?.state === 'done'), state: installed || job?.state === 'done' ? 'Installed' : job?.state === 'failed' ? 'Failed' : 'Installing…', panel: <JobLine job={job} name={title} /> });
  };
  const how = (id: ServiceId) => (s[id] === 'install' ? 'install' : 'link');
  const jobState = (app: string) => {
    const j = jobFor(view, app);
    return j?.state === 'failed' ? 'Failed' : j?.state === 'done' ? 'Installed' : 'Installing…';
  };

  if (s.plex !== 'no') {
    items.push({ id: 'plex', title: s.plex === 'install' ? 'Plex Media Server (install here)' : 'Plex', done: Boolean(view.linked.plex), state: view.linked.plex ? 'Linked' : view.plexSignedIn ? (s.plex === 'install' ? jobState('plex') : 'Pick a server') : 'Sign in', panel: <PlexPanel view={view} reload={reload} mode={how('plex')} /> });
    flat('plex-htpc', 'Plex app for the TV');
  }
  if (s.jellyfin !== 'no') {
    items.push({ id: 'jellyfin', title: s.jellyfin === 'install' ? 'Jellyfin (install here)' : 'Jellyfin', done: Boolean(view.linked.jellyfin), state: view.linked.jellyfin ? 'Linked' : s.jellyfin === 'install' ? (jobFor(view, 'jellyfin')?.state === 'done' ? 'Create account' : jobState('jellyfin')) : 'Sign in', panel: <MediaServerPanel view={view} reload={reload} kind="jellyfin" mode={how('jellyfin')} /> });
    flat('jellyfin-player', 'Jellyfin app for the TV');
  }
  if (s.emby !== 'no') items.push({ id: 'emby', title: 'Emby', done: Boolean(view.linked.emby), state: view.linked.emby ? 'Linked' : 'Sign in', panel: <MediaServerPanel view={view} reload={reload} kind="emby" mode="link" /> });
  if (s.kodi !== 'no') flat('kodi', 'Kodi');
  if (s.homeassistant !== 'no') {
    items.push({ id: 'homeassistant', title: s.homeassistant === 'install' ? 'Home Assistant (install here)' : 'Home Assistant', done: Boolean(view.linked.homeassistant), state: view.linked.homeassistant ? 'Linked' : s.homeassistant === 'install' ? (jobFor(view, 'homeassistant')?.state === 'done' ? 'Create account' : jobState('homeassistant')) : 'Add token', panel: <HomeAssistantPanel view={view} reload={reload} mode={how('homeassistant')} /> });
  }
  if (s.tvheadend !== 'no') {
    const done = s.tvheadend === 'install' ? jobFor(view, 'tvheadend')?.state === 'done' : Boolean(view.linked.tvheadend);
    items.push({ id: 'tvheadend', title: s.tvheadend === 'install' ? 'Tvheadend (install here)' : 'Tvheadend', done, state: done ? (s.tvheadend === 'install' ? 'Scan channels' : 'Linked') : s.tvheadend === 'install' ? jobState('tvheadend') : 'Add address', panel: <TvheadendPanel view={view} reload={reload} mode={how('tvheadend')} /> });
  }
  if (s.plexdvr !== 'no') items.push({ id: 'plexdvr', title: 'Live TV from Plex', done: Boolean(view.linked.plexdvr), state: view.linked.plexdvr ? 'On' : 'Turn on', panel: <PlexDvrPanel view={view} reload={reload} /> });
  if (s.seerr !== 'no') {
    const done = s.seerr === 'install' ? jobFor(view, 'seerr')?.state === 'done' : Boolean(view.linked.seerr);
    items.push({ id: 'seerr', title: s.seerr === 'install' ? 'Seerr (install here)' : 'Seerr', done, state: done ? (s.seerr === 'install' ? 'Finish on phone' : 'Linked') : s.seerr === 'install' ? jobState('seerr') : 'Add key', panel: <SeerrPanel view={view} reload={reload} mode={how('seerr')} /> });
  }
  if (s.downloads !== 'no') {
    const done = s.downloads === 'install' ? ['radarr', 'sonarr', 'prowlarr', 'qbittorrent'].every((a) => jobFor(view, a)?.state === 'done') : Boolean(view.linked.radarr || view.linked.sonarr);
    items.push({ id: 'downloads', title: s.downloads === 'install' ? 'Radarr, Sonarr & co (install here)' : 'Radarr & Sonarr', done, state: done ? (s.downloads === 'install' ? 'Finish on phone' : 'Linked') : s.downloads === 'install' ? 'Installing…' : 'Add keys', panel: <DownloadsPanel view={view} reload={reload} mode={how('downloads')} /> });
  }
  if (s.games !== 'no') items.push({ id: 'games', title: 'Gaming PCs', done: Boolean(view.linked.games), state: view.linked.games ? `${view.linked.games.count} added` : 'Add a PC (or later)', panel: <GamesPanel view={view} reload={reload} /> });
  return items;
}
