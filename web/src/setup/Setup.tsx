import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Layout';
import { Logo } from '../components/Logo';
import { useApi, useServerEvents } from '../lib/api';
import { focusFirst, onNavCommand } from '../nav/spatial';
import { connectItems, Qr } from './ConnectPanels';
import { Connections } from './Connections';
import { FindServers, foundUrls, useDiscovery } from './FindServers';
import { FoundUrls } from './ConnectPanels';
import { api, type Choice, type Draft, type ServiceId, type SetupView, type Step } from './types';
import './setup.css';

const ORDER: Step[] = ['welcome', 'name', 'watch', 'extras', 'apps', 'folder', 'connect'];
const MEDIA_INSTALLS: ServiceId[] = ['plex', 'jellyfin', 'tvheadend', 'downloads', 'photos'];
const needsFolder = (d: Draft) => MEDIA_INSTALLS.some((s) => d.services[s] === 'install');

/**
 * The first-run setup: the TV shows it on first boot, and http://<tv>:8780/setup shows the same
 * steps on a phone (handy for typing addresses and tokens). Both follow the server's draft.
 */
export function Setup({ onPhone = false }: { onPhone?: boolean }) {
  const { data: view, setData, reload } = useApi<SetupView>('/api/setup', 3000);
  const [finished, setFinished] = useState<null | 'setup' | 'demo'>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useServerEvents((e) => (e.type === 'setup' || e.type === 'installs') && void reload());

  const discovery = useDiscovery();
  // Servers found by "Find my servers": tick "I have one" for each (once), and show the Lab page if
  // other apps turned up.
  const applied = useRef(new Set<string>());
  useEffect(() => {
    if (!view?.active || !discovery.data || discovery.data.running) return;
    const changes: Partial<Draft['services']> = {};
    for (const f of discovery.data.results) {
      const svc = (f.link ? ({ radarr: 'downloads', sonarr: 'downloads', lidarr: 'downloads', immich: 'photos' } as Record<string, ServiceId>)[f.link] ?? f.link : 'lab') as ServiceId;
      if (applied.current.has(svc) || view.draft.services[svc] !== 'no') continue;
      applied.current.add(svc);
      changes[svc] = 'link';
    }
    if (Object.keys(changes).length) void patch({ services: { ...view.draft.services, ...changes } });
  }, [discovery.data?.running, discovery.data?.results.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = view?.draft.step ?? 'welcome';
  const loaded = Boolean(view);
  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
  }, [step, loaded]);

  // Quick presses send several changes; only the newest reply is shown (an older one arriving late would undo them).
  const seq = useRef(0);
  const patch = async (body: Partial<Draft>) => {
    if (view) setData({ ...view, draft: { ...view.draft, ...body, services: { ...view.draft.services, ...(body.services ?? {}) } } });
    const mine = ++seq.current;
    const r = await api.patch(body);
    if (!r.ok) setError(r.error ?? 'That didn’t work');
    else if (mine === seq.current) {
      setError('');
      setData(r);
    }
    return r.ok;
  };
  const go = (dir: 1 | -1) => {
    if (!view) return;
    let i = ORDER.indexOf(step) + dir;
    if (ORDER[i] === 'folder' && !needsFolder(view.draft)) i += dir;
    if (i >= 0 && i < ORDER.length) void patch({ step: ORDER[i] });
  };
  useEffect(() => onNavCommand((cmd) => cmd === 'back' && step !== 'welcome' && step !== 'connect' && go(-1)));

  if (finished) {
    return (
      <div className={`setup ${onPhone ? 'setup-phone' : ''}`}>
        <div className="setup-card setup-center">
          <Logo size="5rem" />
          <h1>{finished === 'demo' ? 'Loading the sample data…' : 'All set!'}</h1>
          <p className="setup-text">{onPhone ? 'The TV is starting Hearth with your settings. You can close this page.' : 'Starting Hearth with your settings…'}</p>
          {!onPhone ? <span className="setup-spinner big" /> : null}
        </div>
      </div>
    );
  }
  if (!view) return <div className="setup" />;
  if (!view.active && onPhone) {
    return (
      <div className="setup setup-phone">
        <header className="setup-head">
          <Logo size="2.4rem" />
          <span className="setup-head-title">Hearth</span>
          <a className="setup-link" style={{ marginLeft: 'auto' }} href="/admin">
            Editor
          </a>
        </header>
        <main className="setup-card">
          <Connections onPhone />
        </main>
      </div>
    );
  }

  const d = view.draft;
  const svc = (id: ServiceId, v: Choice) => void patch({ services: { [id]: v } as Draft['services'] });
  const stepNo = ORDER.filter((s) => s !== 'folder' || needsFolder(d)).indexOf(step);

  return (
    <div className={`setup ${onPhone ? 'setup-phone' : ''}`} ref={ref} data-nav-scope>
      <header className="setup-head">
        <Logo size="2.6rem" />
        <span className="setup-head-title">Set up Hearth</span>
        {step !== 'welcome' ? (
          <span className="setup-dots" aria-label={`Step ${stepNo} of ${ORDER.length - 2}`}>
            {ORDER.slice(1)
              .filter((s) => s !== 'folder' || needsFolder(d))
              .map((s, i) => (
                <span key={s} className={i + 1 <= stepNo ? 'on' : ''} />
              ))}
          </span>
        ) : null}
        {!onPhone && view.phoneUrl && step !== 'welcome' ? (
          <span className="setup-head-phone">
            <Qr url={view.phoneUrl} size={4.2} />
            <span>Typing is easier
              <br />
              on your phone
            </span>
          </span>
        ) : null}
      </header>

      <main className="setup-card">
        {step === 'welcome' ? <Welcome view={view} onPhone={onPhone} onDemo={async () => {
          const r = await api.call('/api/setup/demo');
          if (r.ok) setFinished('demo');
          else setError(r.error ?? 'That didn’t work');
        }} onStart={() => go(1)} /> : null}

        {step === 'name' ? (
          <>
            <h1>What’s this TV called?</h1>
            <p className="setup-text">It’s shown on screen and used for its Home Assistant sensors.</p>
            <label className="field setup-name">
              <input data-nav value={d.name} onChange={(e) => setData({ ...view, draft: { ...d, name: e.target.value } })} onBlur={() => void patch({ name: d.name })} />
            </label>
            <div className="setup-row" data-nav-group>
              {['Living Room', 'Bedroom', 'Den', 'Kids’ Room', 'Games Room'].map((n) => (
                <button key={n} className={`chip ${d.name === n ? 'chip-active' : ''}`} data-nav onClick={() => void patch({ name: n })}>
                  {n}
                </button>
              ))}
            </div>
            <h3 className="setup-sub">Clock</h3>
            <div className="setup-row" data-nav-group>
              <button className={`chip ${!d.clock24h ? 'chip-active' : ''}`} data-nav onClick={() => void patch({ clock24h: false })}>
                9:30 PM
              </button>
              <button className={`chip ${d.clock24h ? 'chip-active' : ''}`} data-nav onClick={() => void patch({ clock24h: true })}>
                21:30
              </button>
            </div>
          </>
        ) : null}

        {step === 'watch' ? (
          <>
            <h1>Your own movies and shows</h1>
            <p className="setup-text">Pick any you use. None of these? Skip ahead: streaming apps come next.</p>
            <details className="setup-find" open={Boolean(discovery.data?.results.length)}>
              <summary data-nav tabIndex={0}>Already have servers? Find what’s on them</summary>
              <FindServers view={view} reload={() => void reload()} intro={<p className="setup-text">Type your servers’ addresses (or scan the network). Anything Hearth can link is ticked below, and its address filled in later.</p>} />
            </details>
            <ChoiceRow view={view} id="plex" title="Plex" what="Your Plex server: Continue watching, Recently added and search on the Home screen." labels={{ link: 'I have a Plex server', install: 'Install Plex on this TV' }} onPick={svc} />
            <ChoiceRow view={view} id="jellyfin" title="Jellyfin" what="Free, open-source media server." labels={{ link: 'I have a Jellyfin server', install: 'Install Jellyfin on this TV' }} onPick={svc} />
            <ChoiceRow view={view} id="emby" title="Emby" what="Emby server, opened in its web app." labels={{ link: 'I have an Emby server' }} onPick={svc} />
            <ChoiceRow view={view} id="kodi" title="Kodi" what="Kodi media center, with its own library and add-ons." labels={{ install: 'Use Kodi' }} onPick={svc} />
          </>
        ) : null}

        {step === 'extras' ? (
          <>
            <h1>What else?</h1>
            <p className="setup-text">Pages for things you don’t use stay hidden. You can change all of this later in Settings.</p>
            <LiveTvRow view={view} onPick={(tvheadend, plexdvr) => void patch({ services: { tvheadend, plexdvr } as Draft['services'] })} />
            <ChoiceRow view={view} id="homeassistant" title="Smart home" what="Lights, cameras, doorbell pop-ups and sensors, through Home Assistant." labels={{ link: 'I have Home Assistant', install: 'Install Home Assistant here' }} onPick={svc} />
            <ChoiceRow view={view} id="seerr" title="Requests" what="Ask for movies and shows from the TV, through Seerr (Overseerr / Jellyseerr)." labels={{ link: 'I have Seerr', install: 'Install Seerr here' }} onPick={svc} />
            <ChoiceRow view={view} id="downloads" title="Downloads" what="See what’s downloading, and get told when it’s ready: Radarr and Sonarr." labels={{ link: 'I have Radarr / Sonarr', install: 'Install them here' }} onPick={svc} />
            <ChoiceRow view={view} id="photos" title="Photos" what="Back up your phones’ photos with Immich (face recognition can run on a gaming PC)." labels={{ link: 'I have Immich', install: 'Install Immich here' }} onPick={svc} />
            <ChoiceRow view={view} id="games" title="Game streaming" what="Play games from your gaming PCs with Moonlight." labels={{ link: 'Yes, from my PCs' }} onPick={svc} />
            <ChoiceRow view={view} id="lab" title="Home lab page" what="Server status, Home Assistant stats and one-button jobs." labels={{ link: 'Show it' }} onPick={svc} />
          </>
        ) : null}

        {step === 'apps' ? (
          <>
            <h1>Streaming apps</h1>
            <p className="setup-text">They open full screen like on any smart TV; sign in once. Add any other website later from the Apps page.</p>
            <div className="setup-apps" data-nav-group>
              {view.webApps.map((a) => {
                const on = d.apps.includes(a.id);
                return (
                  <button key={a.id} className={`setup-app ${on ? 'on' : ''}`} data-nav style={{ '--app': a.color ?? '#333' } as React.CSSProperties} onClick={() => void patch({ apps: on ? d.apps.filter((x) => x !== a.id) : [...d.apps, a.id] })}>
                    <span className="setup-app-check">{on ? '✓' : '+'}</span>
                    {a.name}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {step === 'folder' ? <FolderStep view={view} onPick={(media) => void patch({ media })} /> : null}

        {step === 'connect' ? <ConnectStep view={view} reload={() => void reload()} /> : null}

        {error ? <div className="form-error">{error}</div> : null}
      </main>

      {step !== 'welcome' ? (
        <footer className="setup-foot" data-nav-group>
          <Button onClick={() => go(-1)}>Back</Button>
          {step === 'connect' ? (
            <Button
              variant="primary"
              icon="check"
              onClick={async () => {
                const r = await api.call('/api/setup/finish');
                if (r.ok) setFinished('setup');
                else setError(r.error ?? 'That didn’t work');
              }}
            >
              Finish
            </Button>
          ) : (
            <Button variant="primary" onClick={() => go(1)}>
              Next
            </Button>
          )}
        </footer>
      ) : null}
    </div>
  );
}

function Welcome({ view, onPhone, onStart, onDemo }: { view: SetupView; onPhone: boolean; onStart: () => void; onDemo: () => void }) {
  return (
    <div className="setup-welcome">
      <div>
        <Logo size="6rem" />
        <h1 className="setup-hello">Welcome to Hearth</h1>
        <p className="setup-text">Let’s set up this TV: your media server, streaming apps, smart home and games. Use what you already have, or install it right here. About five minutes.</p>
        <div className="setup-row" data-nav-group>
          <Button variant="primary" autoFocus onClick={onStart}>
            Set up this TV
          </Button>
          <Button onClick={onDemo}>Look around with sample data first</Button>
        </div>
      </div>
      {!onPhone && view.phoneUrl ? (
        <div className="setup-welcome-phone">
          <Qr url={view.phoneUrl} size={11} />
          <div>Or set up on your phone</div>
          <div className="setup-url">{view.phoneUrl}</div>
        </div>
      ) : null}
    </div>
  );
}

/** One thing you might use, with "no / I have one / install here" buttons. */
function ChoiceRow({ view, id, title, what, labels, onPick }: { view: SetupView; id: ServiceId; title: string; what: string; labels: Partial<Record<Choice, string>>; onPick: (id: ServiceId, v: Choice) => void }) {
  const value = view.draft.services[id];
  const options = view.allowed[id].filter((c) => c === 'no' || (labels[c] && (c !== 'install' || id === 'kodi' || view.installAvailable)));
  return (
    <div className={`setup-choice-row ${value !== 'no' ? 'on' : ''}`}>
      <div className="setup-choice-text">
        <b>{title}</b>
        <span>{what}</span>
      </div>
      <div className="setup-row" data-nav-group>
        {options.map((c) => (
          <button key={c} className={`chip ${value === c ? 'chip-active' : ''}`} data-nav onClick={() => onPick(id, c)}>
            {c === 'no' ? 'No' : labels[c]}
          </button>
        ))}
      </div>
    </div>
  );
}

function LiveTvRow({ view, onPick }: { view: SetupView; onPick: (tvheadend: Choice, plexdvr: Choice) => void }) {
  const s = view.draft.services;
  const value = s.plexdvr === 'link' ? 'plex' : s.tvheadend;
  const options: Array<[string, string, Choice, Choice]> = [
    ['no', 'No', 'no', 'no'],
    ['link', 'I have Tvheadend', 'link', 'no'],
    ...(view.installAvailable ? ([['install', 'Install Tvheadend here (TV tuner)', 'install', 'no']] as Array<[string, string, Choice, Choice]>) : []),
    ...(s.plex !== 'no' ? ([['plex', 'From my Plex server', 'no', 'link']] as Array<[string, string, Choice, Choice]>) : []),
  ];
  return (
    <div className={`setup-choice-row ${value !== 'no' ? 'on' : ''}`}>
      <div className="setup-choice-text">
        <b>Live TV</b>
        <span>Watch and record over-the-air channels, with a guide.</span>
      </div>
      <div className="setup-row" data-nav-group>
        {options.map(([v, label, tvh, dvr]) => (
          <button key={v} className={`chip ${value === v ? 'chip-active' : ''}`} data-nav onClick={() => onPick(tvh, dvr)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FolderStep({ view, onPick }: { view: SetupView; onPick: (path: string) => void }) {
  const current = view.draft.media;
  const [custom, setCustom] = useState('');
  const options = [
    { path: '/srv/media', label: 'On this TV’s own drive', detail: view.mounts.find((m) => m.path === '/srv') },
    ...view.mounts.filter((m) => m.path !== '/srv').map((m) => ({ path: m.path, label: m.path, detail: m })),
  ];
  return (
    <>
      <h1>Where do your movies and shows go?</h1>
      <p className="setup-text">
        The apps you’re installing keep their files here, in folders called movies, tv, music, downloads and recordings. Have them on a USB drive or NAS? Plug it in or mount it first and it shows up below.
      </p>
      <div className="setup-choices" data-nav-group>
        {options.map((o) => (
          <button key={o.path} className={`setup-choice ${current === o.path ? 'on' : ''}`} data-nav onClick={() => onPick(o.path)}>
            <b>{o.label}</b>
            <span>
              {o.path}
              {o.detail ? ` · ${o.detail.freeGb} GB free of ${o.detail.sizeGb} GB` : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="setup-row">
        <label className="field">
          <span>Another folder</span>
          <input data-nav value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="/mnt/storage/media" />
        </label>
        <Button disabled={!custom} onClick={() => onPick(custom)}>
          Use it
        </Button>
      </div>
      {!options.some((o) => o.path === current) ? <div className="setup-ok">Using {current}</div> : null}
    </>
  );
}

function ConnectStep({ view, reload }: { view: SetupView; reload: () => void }) {
  const items = connectItems(view, reload);
  const discovery = useDiscovery();
  const [open, setOpen] = useState<string | null>(null);
  const shown = open ?? items.find((i) => !i.done)?.id ?? null;
  if (!items.length) {
    return (
      <>
        <h1>Nothing to link</h1>
        <p className="setup-text">You’re only using streaming apps for now. Choose Finish to start using Hearth; add more any time in Settings → Connections.</p>
      </>
    );
  }
  return (
    <>
      <h1>Link everything up</h1>
      <p className="setup-text">Installs run in the background while you go. Anything you skip can be done later in Settings → Connections.</p>
      <FoundUrls.Provider value={foundUrls(discovery.data)}>
      <div className="setup-items">
        {items.map((i) => (
          <section key={i.id} className={`setup-item ${i.done ? 'done' : ''} ${shown === i.id ? 'open' : ''}`}>
            <button className="setup-item-head" data-nav onClick={() => setOpen(shown === i.id ? '' : i.id)}>
              <span className="setup-item-mark">{i.done ? '✓' : ''}</span>
              <b>{i.title}</b>
              <span className="setup-item-state">{i.state}</span>
            </button>
            {shown === i.id ? <div className="setup-item-body">{i.panel}</div> : null}
          </section>
        ))}
      </div>
      </FoundUrls.Provider>
      <h3 className="setup-sub">More on your servers</h3>
      <FindServers view={view} reload={reload} intro={<p className="setup-text">Find other apps on your servers to link, or to watch on the Lab page.</p>} />
    </>
  );
}
