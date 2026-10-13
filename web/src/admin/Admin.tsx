import { useEffect, useState } from 'react';
import { get, post, useApi, type Info, type ProfilesState } from '../lib/api';
import { AppsSection, BackgroundsSection, ConfigSection, TvSection } from './AdminSections';
import { ProfilesSection } from './AdminProfiles';
import './admin.css';

type Section = 'overview' | 'profiles' | 'apps' | 'backgrounds' | 'tv' | 'config';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'apps', label: 'Apps' },
  { id: 'backgrounds', label: 'Backgrounds' },
  { id: 'tv', label: 'TV settings' },
  { id: 'config', label: 'Config file' },
];

export type Notify = (message: string, bad?: boolean) => void;

/** Shared profile state for the editor; every change comes back as the new full state. */
export function useProfiles() {
  const api = useApi<ProfilesState>('/api/profiles');
  const apply = (res: Partial<ProfilesState> & { ok?: boolean; error?: string }, notify?: Notify, done?: string) => {
    if (res.ok === false) {
      notify?.(res.error ?? 'That didn’t work', true);
      return false;
    }
    if (res.profiles) api.setData(res as ProfilesState);
    if (done) notify?.(done);
    return true;
  };
  return { ...api, apply };
}

/** The network editor: http://<tv>:8780/admin from any device on the home network. */
export function AdminPage() {
  const [section, setSection] = useState<Section>(() => (location.hash.slice(1) as Section) || 'overview');
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const info = useApi<Info>('/api/info');
  const profiles = useProfiles();

  useEffect(() => {
    document.documentElement.classList.add('is-admin');
    document.title = 'Hearth editor';
  }, []);
  useEffect(() => {
    location.hash = section;
  }, [section]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.bad ? 6000 : 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const notify: Notify = (text, bad = false) => setToast({ text, bad });

  return (
    <div className="ad">
      <aside className="ad-side">
        <div className="ad-brand">
          <span className="ad-mark" />
          <div>
            <div className="ad-brand-name">{info.data?.name ?? 'Hearth'}</div>
            <div className="ad-brand-sub">Editor</div>
          </div>
        </div>
        <nav className="ad-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="ad-side-foot">Changes show on the TV straight away.</div>
      </aside>
      <main className="ad-main">
        {section === 'overview' ? <Overview info={info.data} profiles={profiles.data} notify={notify} go={setSection} /> : null}
        {section === 'profiles' ? <ProfilesSection profiles={profiles} notify={notify} /> : null}
        {section === 'apps' ? <AppsSection profiles={profiles} notify={notify} /> : null}
        {section === 'backgrounds' ? <BackgroundsSection profiles={profiles} notify={notify} /> : null}
        {section === 'tv' ? <TvSection notify={notify} /> : null}
        {section === 'config' ? <ConfigSection notify={notify} /> : null}
      </main>
      {toast ? <div className={`ad-toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div> : null}
    </div>
  );
}

function Overview({ info, profiles, notify, go }: { info: Info | null; profiles: ProfilesState | null; notify: Notify; go: (s: Section) => void }) {
  const active = profiles?.profiles.find((p) => p.id === profiles.activeId);
  const restart = async () => {
    if (!confirm('Restart Hearth on the TV? The screen goes back to Home.')) return;
    await post('/api/admin/restart');
    notify('Restarting…');
    waitForRestart(info?.bootId, () => location.reload());
  };
  const row = (label: string, value: string, section?: Section) => (
    <div className="ad-kv">
      <span>{label}</span>
      <b>{value}</b>
      {section ? (
        <button className="ad-link" onClick={() => go(section)}>
          Edit
        </button>
      ) : null}
    </div>
  );
  return (
    <section>
      <h1>Overview</h1>
      <div className="ad-card">
        {row('TV name', info?.name ?? '…', 'config')}
        {row('Watching now', info?.session?.title ?? 'Nothing (Home)')}
        {row('Profile on screen', active?.name ?? '…', 'profiles')}
        {row('Profiles', String(profiles?.profiles.length ?? '…'), 'profiles')}
        {(['tv', 'homeassistant', 'games'] as const).map((k) =>
          row(
            { tv: 'Live TV', homeassistant: 'Home Assistant', games: 'Gaming PCs' }[k],
            info ? (info.demo[k] ? 'Demo' : info.setup[k] ? 'Set up' : 'Not set up') : '…',
            'config',
          ),
        )}
        {row('Requests (Seerr)', info ? (info.features.requests ? 'Set up' : 'Not set up') : '…', 'config')}
      </div>
      {info?.ignoredExamples.length ? (
        <div className="ad-card ad-note">
          <b>Example entries still in config.yaml</b> (skipped, safe to delete): {info.ignoredExamples.join(', ')}
        </div>
      ) : null}
      <div className="ad-actions">
        <button className="ad-btn" onClick={() => void restart()}>
          Restart Hearth
        </button>
      </div>
    </section>
  );
}

/** Poll until the server comes back with a new boot id, then call done. */
export function waitForRestart(oldBoot: string | undefined, done: () => void): void {
  const started = Date.now();
  const tick = async () => {
    try {
      const i = await get<Info>('/api/info');
      if (i.bootId && i.bootId !== oldBoot) return done();
    } catch {
      /* still restarting */
    }
    if (Date.now() - started < 60_000) setTimeout(() => void tick(), 1000);
  };
  setTimeout(() => void tick(), 1500);
}
