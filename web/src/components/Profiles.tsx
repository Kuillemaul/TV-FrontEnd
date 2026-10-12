import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { post, type MutationResult, type Profile } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { themeVars } from '../lib/theme';
import { focusFirst } from '../nav/spatial';
import { AppOrderEditor } from './AppOrderEditor';
import { GamePicker } from './GamePicker';
import { Icon } from './Icon';
import { Button, Chip, Modal, useBack } from './Layout';
import { LimitsEditor } from './ScreenTime';
import { ThemeMenu } from './ThemeMenu';

export const PROFILE_COLORS = ['#7b8cff', '#ff7a45', '#ffc93c', '#3ddc97', '#4cc9f0', '#ff5d8f', '#c77dff', '#d9dde4'];

export function Avatar({ profile, size = 'md' }: { profile: Pick<Profile, 'name' | 'color' | 'kind'>; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${size}`} style={{ '--avatar': profile.color } as CSSProperties}>
      {profile.name.trim().charAt(0).toUpperCase() || '?'}
      {profile.kind === 'kid' && size !== 'sm' ? <span className="avatar-badge">★</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* PIN pad                                                             */
/* ------------------------------------------------------------------ */

export function PinPad({ title, onSubmit, onClose, error }: { title: string; onSubmit: (pin: string) => void; onClose: () => void; error?: string }) {
  const [pin, setPin] = useState('');
  const add = (d: string) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      onSubmit(next);
      setTimeout(() => setPin(''), 300);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) add(e.key);
      if (e.key === 'Backspace') {
        e.stopPropagation();
        setPin((p) => p.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <Modal title={title} onClose={onClose}>
      <div className={`pin-dots ${error ? 'shake' : ''}`} key={error}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
        ))}
      </div>
      {error ? <div className="form-error center">{error}</div> : null}
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
          k ? (
            <button
              key={i}
              data-nav
              data-nav-default={k === '5' || undefined}
              className="pin-key"
              onClick={() => (k === '⌫' ? setPin(pin.slice(0, -1)) : add(k))}
            >
              {k}
            </button>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Who's watching?                                                     */
/* ------------------------------------------------------------------ */

export function ProfilePicker({ onDone, canClose }: { onDone: () => void; canClose: boolean }) {
  const { profiles } = useHearth();
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useBack(ref, () => canClose && onDone());

  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
  }, []);

  if (!profiles) return null;

  const choose = async (p: Profile, pin?: string) => {
    if (p.hasPin && p.id !== profiles.activeId && pin === undefined) {
      setError('');
      setPinFor(p);
      return;
    }
    const res = await post<MutationResult>('/api/profiles/active', { id: p.id, pin });
    if (res.ok) {
      setPinFor(null);
      onDone();
    } else setError(res.error ?? 'Could not switch');
  };

  return (
    <div className="picker-screen" data-nav-scope ref={ref}>
      <h1 className="picker-title">Who's watching?</h1>
      <div className="picker-row">
        {profiles.profiles.map((p) => (
          <button
            key={p.id}
            data-nav
            data-nav-default={p.id === profiles.activeId || undefined}
            className="picker-profile"
            style={themeVars(p.theme) as CSSProperties}
            onClick={() => void choose(p)}
          >
            <Avatar profile={p} size="lg" />
            <span className="picker-name">
              {p.name}
              {p.hasPin ? <Icon name="lock" size="0.9em" /> : null}
            </span>
          </button>
        ))}
      </div>
      {pinFor ? (
        <PinPad
          title={`Enter ${pinFor.name}'s PIN`}
          error={error}
          onClose={() => setPinFor(null)}
          onSubmit={(pin) => void choose(pinFor, pin)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Avatar menu (top bar)                                               */
/* ------------------------------------------------------------------ */

export function ProfileMenu({ onClose, onSwitch, onTheme }: { onClose: () => void; onSwitch: () => void; onTheme: () => void }) {
  const { profile } = useHearth();
  if (!profile) return null;
  return (
    <Modal title={profile.name} onClose={onClose}>
      <div className="menu-list">
        <button className="menu-item" data-nav data-nav-default onClick={onSwitch}>
          <Icon name="refresh" /> Switch profile
        </button>
        <button className="menu-item" data-nav onClick={onTheme}>
          <Icon name="bulb" /> Change theme
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Profile management (Settings)                                       */
/* ------------------------------------------------------------------ */

export async function saveProfile(id: string, patch: Partial<Profile> & { pin?: string | null }): Promise<MutationResult> {
  return post<MutationResult>(`/api/profiles/${id}`, patch, 'PUT');
}

export function AddProfile({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Profile['kind']>('kid');
  const [color, setColor] = useState(PROFILE_COLORS[2]);
  const [error, setError] = useState('');

  const create = async () => {
    const res = await post<MutationResult>('/api/profiles', { name, kind, color });
    if (!res.ok) return setError(res.error ?? 'Could not create profile');
    const created = res.profiles?.at(-1);
    if (created) onCreated(created.id);
  };

  return (
    <Modal title="Add a profile" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input data-nav data-nav-default value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={20} />
        </label>
        <div className="field">
          <span>Type</span>
          <div className="chips" data-nav-group>
            <Chip active={kind === 'kid'} onClick={() => setKind('kid')}>★ Kid · curated apps & games</Chip>
            <Chip active={kind === 'admin'} onClick={() => setKind('admin')}>Parent · everything</Chip>
          </div>
        </div>
        <ColorRow value={color} onChange={setColor} />
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" icon="check" onClick={() => void create()}>
          Create
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="field">
      <span>Colour</span>
      <div className="color-row" data-nav-group>
        {PROFILE_COLORS.map((c) => (
          <button key={c} data-nav className={`color-dot ${value === c ? 'chosen' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
        ))}
      </div>
    </div>
  );
}

type Sub = null | 'apps' | 'games' | 'theme' | 'pin' | 'delete' | 'limits';

export function ProfileEditor({ profileId, onClose }: { profileId: string; onClose: () => void }) {
  const { profiles, profile: active } = useHearth();
  const p = profiles?.profiles.find((x) => x.id === profileId);
  const [sub, setSub] = useState<Sub>(null);
  const [name, setName] = useState(p?.name ?? '');
  const [error, setError] = useState('');
  // A just-created profile arrives a moment after the editor opens.
  useEffect(() => {
    if (p) setName(p.name);
  }, [p?.id, p?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || !profiles) return null;

  const save = async (patch: Partial<Profile> & { pin?: string | null }) => {
    const res = await saveProfile(p.id, patch);
    setError(res.ok ? '' : res.error ?? 'Could not save');
    return res.ok;
  };

  const appCount = p.apps ? `${p.apps.length} apps` : 'All apps';
  const gameCount = p.games ? `${p.games.length} games` : 'All games';

  return (
    <Modal title={`Edit ${p.name}`} onClose={onClose} wide>
      <div className="editor-head" style={themeVars(p.theme) as CSSProperties}>
        <Avatar profile={p} size="lg" />
        <div className="form editor-fields">
          <label className="field">
            <span>Name</span>
            <input data-nav value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== p.name && void save({ name })} maxLength={20} />
          </label>
          <ColorRow value={p.color} onChange={(color) => void save({ color })} />
        </div>
      </div>

      <div className="editor-grid">
        <EditorCard icon="apps" title="Apps" detail={`${appCount} · order & hide`} onClick={() => setSub('apps')} autoFocus />
        <EditorCard icon="gamepad" title="Games" detail={gameCount} onClick={() => setSub('games')} />
        <EditorCard icon="tv" title="Live TV" detail={p.liveTv ? 'Allowed' : 'Hidden'} onClick={() => void save({ liveTv: !p.liveTv })} toggled={p.liveTv} />
        <EditorCard icon="bulb" title="Theme" detail="Background, colours, font" onClick={() => setSub('theme')} />
        {p.kind === 'kid' ? (
          <EditorCard
            icon="moon"
            title="Screen time"
            detail={
              [p.limits?.dailyMinutes ? `${p.limits.dailyMinutes} min a day` : null, p.limits?.bedtime ? `bed ${p.limits.bedtime}` : null].filter(Boolean).join(' · ') ||
              'No limits'
            }
            onClick={() => setSub('limits')}
          />
        ) : null}
        <EditorCard
          icon="lock"
          title="Type"
          detail={p.kind === 'kid' ? '★ Kid (curated)' : 'Parent (full access)'}
          onClick={() => void save({ kind: p.kind === 'kid' ? 'admin' : 'kid' })}
        />
        {p.kind === 'admin' ? (
          <EditorCard icon="lock" title="PIN" detail={p.hasPin ? 'On · select to change' : 'Off'} onClick={() => setSub('pin')} toggled={p.hasPin} />
        ) : null}
        {p.id !== active?.id ? <EditorCard icon="trash" title="Delete" detail="Remove this profile" onClick={() => setSub('delete')} danger /> : null}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="modal-actions">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>

      {sub === 'apps' ? <AppOrderEditor title={`${p.name}'s apps`} order={p.apps} onChange={(apps) => void save({ apps })} onClose={() => setSub(null)} /> : null}
      {sub === 'games' ? <GamePicker title={`${p.name}'s games`} value={p.games} onChange={(games) => void save({ games })} onClose={() => setSub(null)} /> : null}
      {sub === 'theme' ? (
        <ThemeMenu
          title={`${p.name}'s theme`}
          initial={p.theme}
          restore={p.id === active?.id ? undefined : active?.theme}
          onSave={(theme) => {
            void save({ theme });
            setSub(null);
          }}
          onClose={() => setSub(null)}
        />
      ) : null}
      {sub === 'limits' ? <LimitsEditor profile={p} onClose={() => setSub(null)} /> : null}
      {sub === 'pin' ? (
        <PinMenu
          hasPin={p.hasPin}
          onSet={async (pin) => {
            if (await save({ pin })) setSub(null);
          }}
          onClose={() => setSub(null)}
        />
      ) : null}
      {sub === 'delete' ? (
        <Modal title={`Delete ${p.name}?`} onClose={() => setSub(null)}>
          <div className="modal-actions">
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                const res = await post<MutationResult>(`/api/profiles/${p.id}`, {}, 'DELETE');
                if (res.ok) onClose();
                else setError(res.error ?? 'Could not delete');
              }}
            >
              Delete
            </Button>
            <Button onClick={() => setSub(null)} autoFocus>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}

function PinMenu({ hasPin, onSet, onClose }: { hasPin: boolean; onSet: (pin: string | null) => void; onClose: () => void }) {
  const [entering, setEntering] = useState(!hasPin);
  if (entering) return <PinPad title="Choose a 4-digit PIN" onSubmit={(pin) => onSet(pin)} onClose={onClose} />;
  return (
    <Modal title="PIN" onClose={onClose}>
      <p className="modal-text">A PIN stops kid profiles from switching into this one.</p>
      <div className="modal-actions">
        <Button variant="primary" onClick={() => setEntering(true)}>
          Change PIN
        </Button>
        <Button variant="danger" onClick={() => onSet(null)}>
          Remove PIN
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

function EditorCard({
  icon,
  title,
  detail,
  onClick,
  autoFocus,
  toggled,
  danger,
}: {
  icon: string;
  title: string;
  detail: string;
  onClick: () => void;
  autoFocus?: boolean;
  toggled?: boolean;
  danger?: boolean;
}) {
  return (
    <button className={`editor-card ${danger ? 'danger' : ''}`} data-nav data-nav-default={autoFocus || undefined} onClick={onClick}>
      <Icon name={icon} size="1.6em" />
      <span className="editor-card-text">
        <span className="editor-card-title">{title}</span>
        <span className="editor-card-detail">{detail}</span>
      </span>
      {toggled !== undefined ? <span className={`toggle ${toggled ? 'on' : ''}`} /> : null}
    </button>
  );
}
