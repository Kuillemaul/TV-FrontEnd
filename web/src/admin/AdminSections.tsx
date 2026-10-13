import { useEffect, useRef, useState } from 'react';
import { get, post, useApi, type AppTile, type AudioStatus, type Info, type ProfilesState, type TvSettings } from '../lib/api';
import { findBackground, themeVars } from '../lib/theme';
import { waitForRestart, type Notify, type useProfiles } from './Admin';
import { TileGallery } from './TileDesigner';
import { WifiCard } from './WifiCard';

type ProfilesApi = ReturnType<typeof useProfiles>;
type MutationReply = Partial<ProfilesState> & { ok: boolean; error?: string };

/* ---------------------------------------------------------------- apps */

export function AppsSection({ profiles, notify }: { profiles: ProfilesApi; notify: Notify }) {
  const apps = useApi<AppTile[]>('/api/apps?all=1');
  const [form, setForm] = useState({ name: '', url: '', color: '#3b4252' });
  const custom = profiles.data?.customApps ?? [];

  const add = async () => {
    const res = await post<MutationReply>('/api/custom-apps', form);
    if (profiles.apply(res, notify, `Added ${form.name || form.url}`)) {
      setForm({ name: '', url: '', color: '#3b4252' });
      void apps.reload();
    }
  };
  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove ${name}?`)) return;
    const res = await post<MutationReply>(`/api/custom-apps/${id}`, {}, 'DELETE');
    if (profiles.apply(res, notify, `Removed ${name}`)) void apps.reload();
  };

  return (
    <section>
      <h1>Apps</h1>
      <div className="ad-card">
        <h2>Add a web app</h2>
        <p className="ad-muted">Any website opens full screen on the TV, e.g. a streaming service or your Jellyfin/Plex web page.</p>
        <div className="ad-grid">
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Crunchyroll" />
          </label>
          <label>
            Web address
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://www.crunchyroll.com" />
          </label>
          <label>
            Tile colour
            <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
          </label>
        </div>
        <button className="ad-btn primary" disabled={!form.url} onClick={() => void add()}>
          Add app
        </button>
      </div>

      <div className="ad-card">
        <h2>All apps</h2>
        <p className="ad-muted">Select a tile to change its look: pick a style and colours, or upload your own picture.</p>
        {apps.data ? <TileGallery apps={apps.data} notify={notify} onChanged={(list) => apps.setData(list)} /> : null}
        {custom.length ? (
          <>
            <div className="ad-sub">Your web apps</div>
            <div className="ad-chips">
              {custom.map((c) => (
                <span key={c.id} className="ad-chip">
                  {c.name}
                  <button onClick={() => void remove(c.id, c.name)} title={`Remove ${c.name}`}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </>
        ) : null}
        <p className="ad-muted">
          Which apps each person sees, and in what order, is set per profile (Profiles → Apps). Apps that launch programs
          (Plex HTPC, Moonlight…) live in the config file under <code>apps:</code>.
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- backgrounds */

export function BackgroundsSection({ profiles, notify }: { profiles: ProfilesApi; notify: Notify }) {
  const photos = useApi<{ files: Array<{ file: string; size: number }> }>('/api/admin/backgrounds');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      const res = await post<{ ok: boolean; error?: string; file?: string }>('/api/admin/backgrounds', { name: f.name, data });
      notify(res.ok ? `Uploaded ${f.name}` : `${f.name}: ${res.error}`, !res.ok);
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    void photos.reload();
  };
  const remove = async (file: string) => {
    if (!confirm(`Delete ${file}? Profiles using it go back to the Aurora background.`)) return;
    await post(`/api/admin/backgrounds/${encodeURIComponent(file)}`, {}, 'DELETE');
    for (const p of profiles.data?.profiles ?? []) {
      if (p.theme.background === `image:${file}`) await post(`/api/profiles/${p.id}`, { theme: { ...p.theme, background: 'aurora' } }, 'PUT');
    }
    void photos.reload();
    void profiles.reload();
  };
  const useFor = async (file: string, profileId: string) => {
    const p = profiles.data?.profiles.find((x) => x.id === profileId);
    if (!p) return;
    const res = await post<MutationReply>(`/api/profiles/${p.id}`, { theme: { ...p.theme, background: `image:${file}` } }, 'PUT');
    profiles.apply(res, notify, `${p.name}'s Home now uses ${file}`);
  };

  return (
    <section>
      <h1>Backgrounds</h1>
      <div className="ad-card">
        <h2>Your photos</h2>
        <p className="ad-muted">
          Upload a photo (JPG, PNG or WebP, up to 15 MB; 3840×2160 or 1920×1080 looks best) and use it as a profile's Home
          background. It's darkened a little so tiles stay readable. They also appear in the TV's own Theme menu.
        </p>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void upload(e.target.files)} disabled={busy} />
        <div className="ad-photos">
          {photos.data?.files.map(({ file }) => {
            const vars = themeVars({ background: `image:${file}`, palette: 'indigo', font: 'inter' });
            const users = profiles.data?.profiles.filter((p) => p.theme.background === `image:${file}`) ?? [];
            return (
              <div key={file} className="ad-photo">
                <div className="ad-photo-img" style={{ ...vars, background: findBackground(`image:${file}`).layers } as React.CSSProperties} />
                <div className="ad-photo-meta">
                  <b>{file}</b>
                  <small>{users.length ? `Used by ${users.map((u) => u.name).join(', ')}` : 'Not in use'}</small>
                  <select value="" onChange={(e) => e.target.value && void useFor(file, e.target.value)}>
                    <option value="">Use for…</option>
                    {profiles.data?.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button className="ad-btn ghost small" onClick={() => void remove(file)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {photos.data && !photos.data.files.length ? <p className="ad-muted">No photos yet.</p> : null}
        </div>
      </div>
      <p className="ad-muted">Built-in backgrounds, colours and fonts are under Profiles → Look.</p>
    </section>
  );
}

/* ---------------------------------------------------------------- TV settings */

interface DisplayStatus {
  available: boolean;
  error?: string;
  outputs: Array<{ name: string; description: string; enabled: boolean; modes: Array<{ width: number; height: number; refresh: number; preferred: boolean; current: boolean }> }>;
  pending: { revertAt: number } | null;
}

export function TvSection({ notify }: { notify: Notify }) {
  const settings = useApi<TvSettings>('/api/settings');
  const display = useApi<DisplayStatus>('/api/display');
  const audio = useApi<AudioStatus>('/api/audio');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const toggle = async (k: keyof TvSettings, v: boolean) => {
    const res = await post<TvSettings & { ok: boolean; error?: string }>('/api/settings', { [k]: v }, 'PUT');
    if (res.ok) settings.setData(res);
    else notify(res.error ?? 'Couldn’t change that', true);
  };

  const out = display.data?.outputs.find((o) => o.enabled && o.modes.length);
  const modes = out?.modes ?? [];
  const current = modes.find((m) => m.current);
  const setMode = async (key: string) => {
    const m = modes.find((x) => `${x.width}x${x.height}@${x.refresh}` === key);
    if (!m || !out) return;
    const res = await post<DisplayStatus & { ok: boolean; error?: string }>('/api/display/mode', { output: out.name, ...m });
    if (!res.ok) return notify(res.error ?? 'Couldn’t change the display', true);
    display.setData(res);
  };
  const keep = async () => {
    await post('/api/display/keep');
    notify('Display setting kept');
    void display.reload();
  };
  const revert = async () => {
    await post('/api/display/revert');
    void display.reload();
  };
  const pendingLeft = display.data?.pending ? Math.max(0, Math.ceil((display.data.pending.revertAt - now) / 1000)) : 0;
  useEffect(() => {
    if (display.data?.pending && pendingLeft === 0) void display.reload();
  }, [pendingLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  const sink = audio.data?.sink;
  const currentOut = audio.data?.outputs.find((o) => o.id === audio.data?.current?.outputId);
  const setOutput = async (outputId: string, channels: number) => {
    const res = await post<AudioStatus & { ok: boolean; error?: string }>('/api/audio/output', { outputId, channels });
    if (res.ok) audio.setData(res);
    else notify(res.error ?? 'Couldn’t switch the sound output', true);
  };
  const volume = async (percent: number) => {
    await post('/api/audio/volume', { percent });
    void audio.reload();
  };
  const test = async (channel: number) => {
    const res = await post('/api/audio/test', { channel });
    if (!res.ok) notify(res.error ?? 'Test failed', true);
  };

  const Toggle = ({ k, label, detail }: { k: keyof TvSettings; label: string; detail: string }) => (
    <label className="ad-check ad-toggle">
      <input type="checkbox" checked={Boolean(settings.data?.[k])} onChange={(e) => void toggle(k, e.target.checked)} />
      <span>
        <b>{label}</b>
        <small>{detail}</small>
      </span>
    </label>
  );

  return (
    <section>
      <h1>TV settings</h1>
      <WifiCard notify={notify} />
      <div className="ad-card">
        <h2>Automations</h2>
        <Toggle k="scenes" label="Movie-time lights" detail="Run your Home Assistant scenes when Plex, Live TV or games start and stop" />
        <Toggle k="alertsOverApps" label="Alerts over apps" detail="Doorbell and alerts pop up even during a film or game" />
        <Toggle k="wakeWord" label="Wake word" detail="Listen for the wake word (needs Home Assistant with openWakeWord)" />
      </div>

      <div className="ad-card">
        <h2>Display</h2>
        {!display.data ? <p className="ad-muted">Loading…</p> : !display.data.available || !out ? <p className="ad-muted">{display.data.error ?? 'No screen found.'}</p> : (
          <>
            <label>
              Resolution and refresh rate ({out.description})
              <select value={current ? `${current.width}x${current.height}@${current.refresh}` : ''} onChange={(e) => void setMode(e.target.value)}>
                {modes.map((m) => {
                  const key = `${m.width}x${m.height}@${m.refresh}`;
                  return (
                    <option key={key} value={key}>
                      {m.width}×{m.height} · {Math.round(m.refresh * 100) / 100} Hz{m.preferred ? ' (TV’s choice)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            {display.data.pending ? (
              <div className="ad-confirm">
                Check the TV. Going back in <b>{pendingLeft}</b> s unless you keep it.
                <button className="ad-btn primary small" onClick={() => void keep()}>
                  Keep
                </button>
                <button className="ad-btn small" onClick={() => void revert()}>
                  Go back
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="ad-card">
        <h2>Sound</h2>
        {!audio.data ? <p className="ad-muted">Loading…</p> : !audio.data.available ? <p className="ad-muted">{audio.data.error}</p> : (
          <>
            <div className="ad-grid">
              <label>
                Output
                <select
                  value={audio.data.current?.outputId ?? ''}
                  onChange={(e) => {
                    const o = audio.data!.outputs.find((x) => x.id === e.target.value);
                    if (o) void setOutput(o.id, (o.layouts.find((l) => l.channels === audio.data!.current?.channels) ?? o.layouts[0]).channels);
                  }}
                >
                  {audio.data.outputs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                      {o.available ? '' : ' (nothing plugged in)'}
                    </option>
                  ))}
                </select>
              </label>
              {currentOut && currentOut.layouts.length > 1 ? (
                <label>
                  Speakers
                  <select value={audio.data.current?.channels ?? 2} onChange={(e) => void setOutput(currentOut.id, Number(e.target.value))}>
                    {currentOut.layouts.map((l) => (
                      <option key={l.channels} value={l.channels}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {sink ? (
                <label>
                  Volume: {sink.volume}%
                  <input type="range" min={0} max={100} step={5} defaultValue={sink.volume} onChange={(e) => void volume(Number(e.target.value))} />
                </label>
              ) : null}
            </div>
            {sink ? (
              <div className="ad-chips">
                <span className="ad-sub">Test a speaker:</span>
                {sink.channels.map((c, i) => (
                  <button key={c} className="ad-chip" onClick={() => void test(i)}>
                    {c.replace('front-', 'front ').replace('rear-', 'rear ').replace('side-', 'side ').replace('lfe', 'subwoofer')}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="ad-card">
        <h2>Power</h2>
        <div className="ad-actions">
          <button className="ad-btn" onClick={() => confirm('Put the TV PC to sleep?') && void post('/api/system/suspend')}>
            Sleep
          </button>
          <button className="ad-btn" onClick={() => confirm('Restart the TV PC?') && void post('/api/system/reboot')}>
            Restart TV PC
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- config file */

export function ConfigSection({ notify }: { notify: Notify }) {
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [meta, setMeta] = useState<{ path: string; backups: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const info = useApi<Info>('/api/info');

  const load = async () => {
    const r = await get<{ path: string; yaml: string; backups: string[] }>('/api/admin/config');
    setText(r.yaml);
    setOriginal(r.yaml);
    setMeta({ path: r.path, backups: r.backups });
    setError(null);
  };
  useEffect(() => {
    void load();
  }, []);
  // Check as you type (debounced).
  useEffect(() => {
    if (text === null) return;
    const t = setTimeout(async () => {
      const r = await post<{ ok: boolean; error: string | null }>('/api/admin/config/check', { yaml: text });
      setError(r.ok ? null : r.error);
    }, 600);
    return () => clearTimeout(t);
  }, [text]);

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    const r = await post<{ ok: boolean; error?: string }>('/api/admin/config', { yaml: text, restart: true }, 'PUT');
    if (!r.ok) {
      setSaving(false);
      setError(r.error ?? 'Not saved');
      return notify(r.error ?? 'Not saved', true);
    }
    notify('Saved. Hearth is restarting…');
    waitForRestart(info.data?.bootId, () => {
      setSaving(false);
      notify('Restarted with the new settings');
      void load();
      void info.reload();
    });
  };
  const loadBackup = async (name: string) => {
    const r = await get<{ yaml: string }>(`/api/admin/config/backups/${encodeURIComponent(name)}`);
    setText(r.yaml);
    notify(`Loaded ${name} into the editor (not saved yet)`);
  };

  const dirty = text !== null && text !== original;
  return (
    <section className="ad-config">
      <h1>Config file</h1>
      <p className="ad-muted">
        Everything else lives here: Home Assistant, gaming PCs, Live TV, Plex, Seerr, home lab, alerts, remote keys…
        Each section is explained in <code>config.example.yaml</code>. Saving checks the file first, keeps a backup and restarts Hearth.
      </p>
      <div className="ad-config-bar">
        <code>{meta?.path}</code>
        <span className="ad-grow" />
        {meta?.backups.length ? (
          <select value="" onChange={(e) => e.target.value && void loadBackup(e.target.value)}>
            <option value="">Earlier versions…</option>
            {meta.backups.map((b) => (
              <option key={b} value={b}>
                {b.replace(/^config-|\.yaml$/g, '').replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3')}
              </option>
            ))}
          </select>
        ) : null}
        {dirty ? (
          <button className="ad-btn ghost small" onClick={() => setText(original)}>
            Undo changes
          </button>
        ) : null}
        <button className="ad-btn primary" disabled={!dirty || Boolean(error) || saving} onClick={() => void save()}>
          {saving ? 'Restarting…' : 'Save & restart'}
        </button>
      </div>
      <div className={`ad-status ${error ? 'bad' : 'good'}`}>{text === null ? 'Loading…' : error ? error : dirty ? 'Looks good. Not saved yet.' : 'Saved.'}</div>
      <textarea className="ad-yaml" spellCheck={false} value={text ?? ''} onChange={(e) => setText(e.target.value)} onKeyDown={tabIndent} />
    </section>
  );
}

/** Tab inserts two spaces (YAML uses spaces, never tabs). */
function tabIndent(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const el = e.currentTarget;
  const { selectionStart: s, selectionEnd: end, value } = el;
  // Through the native setter so React sees the change.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value.slice(0, s) + '  ' + value.slice(end));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.selectionStart = el.selectionEnd = s + 2;
}
