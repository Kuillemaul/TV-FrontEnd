import { useEffect, useMemo, useState } from 'react';
import { post, useApi, type AppTile, type Channel, type GameLibrary, type Limits, type Pin, type Profile, type ProfilesState, type ThemeChoice } from '../lib/api';
import { BACKGROUNDS, FONTS, PALETTES, findBackground, findFont, themeVars } from '../lib/theme';
import type { Notify, useProfiles } from './Admin';

type ProfilesApi = ReturnType<typeof useProfiles>;
type MutationReply = Partial<ProfilesState> & { ok: boolean; error?: string };

const pinLabel = (p: Pin, apps: AppTile[] = []) =>
  p.kind === 'game' ? `Game · ${p.title}` : p.kind === 'channel' ? `Channel · ${p.name}` : p.kind === 'entity' ? `Control · ${p.name ?? p.id}` : `App · ${apps.find((a) => a.id === p.id)?.name ?? p.id}`;

export function ProfilesSection({ profiles, notify }: { profiles: ProfilesApi; notify: Notify }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = profiles.data?.profiles ?? [];
  const current = list.find((p) => p.id === selected) ?? list[0];

  const add = async (kind: Profile['kind']) => {
    const name = prompt(kind === 'kid' ? 'Name for the kid’s profile' : 'Name for the new profile');
    if (!name) return;
    const res = await post<MutationReply>('/api/profiles', { name, kind });
    if (profiles.apply(res, notify, `Added ${name}`)) setSelected(res.profiles?.find((p) => p.name === name.trim().slice(0, 20))?.id ?? null);
  };

  return (
    <section>
      <h1>Profiles</h1>
      <div className="ad-split">
        <div className="ad-list">
          {list.map((p) => (
            <button key={p.id} className={`ad-list-item ${current?.id === p.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
              <span className="ad-avatar" style={{ background: p.color }}>
                {p.name.charAt(0).toUpperCase()}
              </span>
              <span className="ad-list-text">
                <b>{p.name}</b>
                <small>
                  {p.kind === 'kid' ? 'Kid' : 'Parent'}
                  {profiles.data?.activeId === p.id ? ' · on screen' : ''}
                </small>
              </span>
            </button>
          ))}
          <div className="ad-list-add">
            <button className="ad-btn small" onClick={() => void add('admin')}>
              + Parent
            </button>
            <button className="ad-btn small" onClick={() => void add('kid')}>
              + Kid
            </button>
          </div>
        </div>
        {current ? <ProfileEditor key={current.id} profile={current} profiles={profiles} notify={notify} onDeleted={() => setSelected(null)} /> : null}
      </div>
    </section>
  );
}

function ProfileEditor({ profile, profiles, notify, onDeleted }: { profile: Profile; profiles: ProfilesApi; notify: Notify; onDeleted: () => void }) {
  const [draft, setDraft] = useState<Profile>(profile);
  const [newPin, setNewPin] = useState('');
  useEffect(() => setDraft(profile), [profile]);
  const apps = useApi<AppTile[]>('/api/apps?all=1');
  const tvChannels = useApi<{ channels: Channel[] }>('/api/tv/channels');
  const library = useApi<GameLibrary>('/api/games?all=1');
  const photos = useApi<{ files: Array<{ file: string }> }>('/api/admin/backgrounds');
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile) || newPin !== '';
  const set = (patch: Partial<Profile>) => setDraft((d) => ({ ...d, ...patch }));
  const kid = draft.kind === 'kid';

  const save = async () => {
    if (newPin && !/^\d{4}$/.test(newPin)) return notify('A PIN is 4 digits', true);
    const patch: Record<string, unknown> = {
      name: draft.name,
      color: draft.color,
      kind: draft.kind,
      liveTv: draft.liveTv,
      hiddenChannels: draft.hiddenChannels ?? [],
      apps: draft.apps,
      games: draft.games,
      theme: draft.theme,
      pins: draft.pins ?? [],
      ...(draft.limits ? { limits: draft.limits } : {}),
      ...(newPin ? { pin: newPin } : {}),
    };
    const res = await post<MutationReply>(`/api/profiles/${profile.id}`, patch, 'PUT');
    if (profiles.apply(res, notify, `Saved ${draft.name}`)) setNewPin('');
  };
  const removePin = async () => {
    const res = await post<MutationReply>(`/api/profiles/${profile.id}`, { pin: null }, 'PUT');
    profiles.apply(res, notify, 'PIN removed');
  };
  const remove = async () => {
    if (!confirm(`Delete ${profile.name}? Their apps, games, pins and theme go too.`)) return;
    const res = await post<MutationReply>(`/api/profiles/${profile.id}`, {}, 'DELETE');
    if (profiles.apply(res, notify, `Deleted ${profile.name}`)) onDeleted();
  };
  const showOnTv = async () => {
    const res = await post<MutationReply>('/api/profiles/active', { id: profile.id });
    profiles.apply(res, notify, `${profile.name} is now on the TV`);
  };

  return (
    <div className="ad-editor">
      <div className="ad-card">
        <h2>Basics</h2>
        <div className="ad-grid">
          <label>
            Name
            <input value={draft.name} maxLength={20} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label>
            Colour
            <input type="color" value={draft.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
          <label>
            Type
            <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as Profile['kind'] })}>
              <option value="admin">Parent (sees everything, can change settings)</option>
              <option value="kid">Kid (only what you pick, screen-time limits)</option>
            </select>
          </label>
          <label className="ad-check">
            <input type="checkbox" checked={draft.liveTv} onChange={(e) => set({ liveTv: e.target.checked })} />
            Can watch Live TV
          </label>
        </div>
        {!kid ? (
          <div className="ad-row">
            <label>
              {profile.hasPin ? 'New PIN' : 'PIN (4 digits, asked when switching to this profile)'}
              <input value={newPin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} />
            </label>
            {profile.hasPin ? (
              <button className="ad-btn ghost" onClick={() => void removePin()}>
                Remove PIN
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {kid ? (
        <div className="ad-card">
          <h2>Screen time</h2>
          <LimitsEditor limits={draft.limits} onChange={(limits) => set({ limits })} />
        </div>
      ) : null}

      <div className="ad-card">
        <h2>Look</h2>
        <ThemePicker theme={draft.theme} photos={photos.data?.files.map((f) => f.file) ?? []} onChange={(theme) => set({ theme })} />
      </div>

      <div className="ad-card">
        <h2>Apps</h2>
        <AppsPicker all={apps.data ?? []} value={draft.apps} onChange={(a) => set({ apps: a })} />
      </div>

      <div className="ad-card">
        <h2>Live TV channels</h2>
        {!draft.liveTv ? (
          <p className="ad-muted">Live TV is off for this profile (tick “Can watch Live TV” above).</p>
        ) : !tvChannels.data ? (
          <p className="ad-muted">Loading channels…</p>
        ) : !tvChannels.data.channels.length ? (
          <p className="ad-muted">
            No channels found. For the Plex tuner, add <code>livetv:</code> with <code>plex: true</code> in the Config file (Plex
            set up under <code>plex:</code>), save, then come back here.
          </p>
        ) : (
          <ChannelsPicker all={tvChannels.data.channels} hidden={draft.hiddenChannels ?? []} onChange={(h) => set({ hiddenChannels: h })} />
        )}
      </div>

      <div className="ad-card">
        <h2>Games</h2>
        <GamesPicker library={library.data} value={draft.games} onChange={(g) => set({ games: g })} />
      </div>

      <div className="ad-card">
        <h2>Pinned to Home</h2>
        {draft.pins?.length ? (
          <OrderedList
            items={draft.pins}
            label={(p) => pinLabel(p, apps.data ?? [])}
            onChange={(pins) => set({ pins })}
          />
        ) : (
          <p className="ad-muted">Nothing pinned. On the TV, press X (or P / right-click) on an app, game or channel to pin it.</p>
        )}
      </div>

      <div className="ad-savebar">
        <button className="ad-btn primary" disabled={!dirty} onClick={() => void save()}>
          {dirty ? 'Save changes' : 'Saved'}
        </button>
        {dirty ? (
          <button className="ad-btn ghost" onClick={() => { setDraft(profile); setNewPin(''); }}>
            Discard
          </button>
        ) : null}
        <span className="ad-grow" />
        {profiles.data?.activeId !== profile.id ? (
          <button className="ad-btn" onClick={() => void showOnTv()}>
            Switch the TV to {profile.name}
          </button>
        ) : null}
        <button className="ad-btn danger" onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  );
}

function LimitsEditor({ limits, onChange }: { limits?: Limits; onChange: (l: Limits) => void }) {
  const l: Limits = limits ?? { dailyMinutes: null, bedtime: null, wakeTime: null };
  return (
    <div className="ad-grid">
      <label>
        Minutes per day (blank = no limit)
        <input
          type="number"
          min={0}
          step={15}
          value={l.dailyMinutes ?? ''}
          onChange={(e) => onChange({ ...l, dailyMinutes: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <label>
        Bedtime (nothing new can start after)
        <input type="time" value={l.bedtime ?? ''} onChange={(e) => onChange({ ...l, bedtime: e.target.value || null })} />
      </label>
      <label>
        Allowed again from
        <input type="time" value={l.wakeTime ?? ''} onChange={(e) => onChange({ ...l, wakeTime: e.target.value || null })} />
      </label>
    </div>
  );
}

export function ThemePicker({ theme, photos, onChange }: { theme: ThemeChoice; photos: string[]; onChange: (t: ThemeChoice) => void }) {
  const backgrounds = [...BACKGROUNDS, ...photos.map((f) => ({ ...findBackground(`image:${f}`), name: f.replace(/\.[a-z]+$/, '') }))];
  return (
    <div className="ad-theme">
      <div className="ad-sub">Background</div>
      <div className="ad-swatches">
        {backgrounds.map((b) => {
          const vars = themeVars({ ...theme, background: b.id });
          return (
            <button
              key={b.id}
              className={`ad-swatch ${theme.background === b.id ? 'chosen' : ''}`}
              style={{ ...vars, background: 'var(--backdrop), var(--bg)' } as React.CSSProperties}
              onClick={() => onChange({ ...theme, background: b.id })}
              title={b.name}
            >
              <span>{b.name}</span>
            </button>
          );
        })}
      </div>
      <div className="ad-sub">Colours</div>
      <div className="ad-chips">
        {PALETTES.map((p) => (
          <button key={p.id} className={`ad-chip ${theme.palette === p.id ? 'chosen' : ''}`} onClick={() => onChange({ ...theme, palette: p.id })}>
            <i style={{ background: `linear-gradient(135deg, ${p.accent}, ${p.accent2})` }} />
            {p.name}
          </button>
        ))}
      </div>
      <div className="ad-sub">Font</div>
      <div className="ad-chips">
        {FONTS.map((f) => (
          <button key={f.id} className={`ad-chip ${theme.font === f.id ? 'chosen' : ''}`} style={{ fontFamily: findFont(f.id).family }} onClick={() => onChange({ ...theme, font: f.id })}>
            {f.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Ordered list with move up/down and remove. */
export function OrderedList<T>({ items, label, onChange }: { items: T[]; label: (t: T) => string; onChange: (items: T[]) => void }) {
  const move = (i: number, d: number) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <ol className="ad-ordered">
      {items.map((t, i) => (
        <li key={i}>
          <span>{label(t)}</span>
          <button className="ad-icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
            ↑
          </button>
          <button className="ad-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} title="Move down">
            ↓
          </button>
          <button className="ad-icon" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove">
            ✕
          </button>
        </li>
      ))}
    </ol>
  );
}

function AppsPicker({ all, value, onChange }: { all: AppTile[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const byId = new Map(all.map((a) => [a.id, a]));
  const chosen = value ?? [];
  const others = all.filter((a) => !chosen.includes(a.id));
  return (
    <div>
      <label className="ad-check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : all.map((a) => a.id))} />
        Every app, in the standard order
      </label>
      {value !== null ? (
        <>
          <OrderedList items={chosen} label={(id) => byId.get(id)?.name ?? id} onChange={onChange} />
          {others.length ? (
            <select className="ad-add" value="" onChange={(e) => e.target.value && onChange([...chosen, e.target.value])}>
              <option value="">+ Add an app…</option>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GamesPicker({ library, value, onChange }: { library: GameLibrary | null; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [q, setQ] = useState('');
  const games = useMemo(
    () => (library?.games ?? []).filter((g) => !q || g.title.toLowerCase().includes(q.toLowerCase())),
    [library, q],
  );
  const chosen = new Set(value ?? []);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    onChange([...next]);
  };
  return (
    <div>
      <label className="ad-check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [])} />
        Every game
      </label>
      {value !== null ? (
        <>
          <input className="ad-search" placeholder={`Search ${library?.games.length ?? 0} games…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="ad-games">
            {games.slice(0, 300).map((g) => {
              const key = `${g.hostId}:${g.id}`;
              return (
                <label key={key} className="ad-check">
                  <input type="checkbox" checked={chosen.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
                  {g.title} <small>{g.platform}{g.rating ? ` · ${g.rating}` : ''}</small>
                </label>
              );
            })}
          </div>
          <p className="ad-muted">{chosen.size} chosen.</p>
        </>
      ) : null}
    </div>
  );
}

/** Tick the channels this profile sees; unticked ones are hidden (new channels show by default). */
function ChannelsPicker({ all, hidden, onChange }: { all: Channel[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const off = new Set(hidden);
  const shown = all.filter((c) => !off.has(c.id)).length;
  return (
    <>
      <p className="ad-muted">
        {shown} of {all.length} shown in the guide, on Home and when changing channel.{' '}
        <button className="ad-link" onClick={() => onChange([])}>
          Show all
        </button>{' '}
        <button className="ad-link" onClick={() => onChange(all.map((c) => c.id))}>
          Hide all
        </button>
      </p>
      <div className="ad-channel-list">
        {all.map((c) => (
          <label key={c.id} className="ad-check">
            <input
              type="checkbox"
              checked={!off.has(c.id)}
              onChange={(e) => onChange(e.target.checked ? hidden.filter((x) => x !== c.id) : [...hidden, c.id])}
            />
            <span>
              <b>{c.number}</b> {c.name}
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
