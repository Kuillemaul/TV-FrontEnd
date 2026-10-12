import { useState } from 'react';
import { post, useApi, type AppTile, type MutationResult } from '../lib/api';
import { Icon } from './Icon';
import { Button, Modal } from './Layout';

const COLORS = ['#e50914', '#ff7a45', '#ffc93c', '#3ddc97', '#4cc9f0', '#2b3cff', '#b48cff', '#ff5d8f', '#3b4252'];

/**
 * Reorder, show/hide and add app tiles for one profile. Rows are vertical so a remote can
 * move them with ▲/▼; the focused button follows the row as it moves.
 */
export function AppOrderEditor({
  title,
  order,
  onChange,
  onClose,
}: {
  title: string;
  /** Visible app ids in order; null = all apps in default order. */
  order: string[] | null;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const { data: all, reload } = useApi<AppTile[]>('/api/apps?all=1');
  const [adding, setAdding] = useState(false);
  // Local copy so quick successive edits never race the server round-trip.
  const [local, setLocal] = useState<string[] | null>(order);
  if (!all) return null;

  const change = (next: string[]) => {
    setLocal(next);
    onChange(next);
  };
  const shown = local ?? all.map((a) => a.id);
  const byId = new Map(all.map((a) => [a.id, a]));
  const visible = shown.map((id) => byId.get(id)).filter((a): a is AppTile => Boolean(a));
  const hidden = all.filter((a) => !shown.includes(a.id));
  const ids = visible.map((a) => a.id);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    change(next);
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <p className="modal-sub">▲ ▼ to reorder · Hide removes a tile from this profile · Add brings one back</p>
      <div className="order-list">
        {visible.map((a, i) => (
          <div className="order-row" key={a.id} data-nav-group>
            <span className="order-pos">{i + 1}</span>
            <span className="order-chip" style={{ background: a.color ?? '#333' }} />
            <span className="order-name">{a.name}</span>
            {/* Never `disabled`: a disabled button drops focus right after moving a row to the end. */}
            <button className={`order-btn ${i === 0 ? 'dim' : ''}`} data-nav onClick={() => move(i, -1)} aria-label="Move up">▲</button>
            <button className={`order-btn ${i === ids.length - 1 ? 'dim' : ''}`} data-nav onClick={() => move(i, 1)} aria-label="Move down">▼</button>
            <button className="order-btn order-hide" data-nav onClick={() => change(ids.filter((x) => x !== a.id))}>
              Hide
            </button>
          </div>
        ))}
        {visible.length === 0 ? <div className="empty">No apps on this profile yet. Add some below.</div> : null}
      </div>

      {hidden.length ? (
        <>
          <h3 className="order-heading">Not on this profile</h3>
          <div className="order-hidden" data-nav-group>
            {hidden.map((a) => (
              <button key={a.id} className="chip" data-nav onClick={() => change([...ids, a.id])}>
                <span className="order-chip small" style={{ background: a.color ?? '#333' }} />
                + Add {a.name}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="modal-actions" data-nav-group>
        <Button variant="primary" onClick={onClose} autoFocus={visible.length === 0 && hidden.length === 0}>
          Done
        </Button>
        <Button icon="external" onClick={() => setAdding(true)}>
          Add a web app
        </Button>
        {all.some((a) => a.custom) ? <RemoveCustom apps={all.filter((a) => a.custom)} onRemoved={() => void reload()} /> : null}
      </div>

      {adding ? (
        <AddWebApp
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            void reload();
            change([...ids, id]);
          }}
        />
      ) : null}
    </Modal>
  );
}

function RemoveCustom({ apps, onRemoved }: { apps: AppTile[]; onRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="trash" variant="ghost" onClick={() => setOpen(true)}>
        Delete web apps
      </Button>
      {open ? (
        <Modal title="Delete a web app" onClose={() => setOpen(false)}>
          <div className="order-hidden" data-nav-group>
            {apps.map((a) => (
              <button
                key={a.id}
                className="chip"
                data-nav
                onClick={async () => {
                  await post(`/api/custom-apps/${a.id}`, {}, 'DELETE');
                  onRemoved();
                  setOpen(false);
                }}
              >
                <Icon name="trash" size="1em" /> {a.name}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function AddWebApp({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [color, setColor] = useState(COLORS[4]);
  const [error, setError] = useState('');

  const submit = async () => {
    const res = await post<MutationResult>('/api/custom-apps', { name, url, color });
    if (!res.ok) return setError(res.error ?? 'Could not add app');
    const added = res.customApps?.at(-1);
    if (added) onAdded(added.id);
  };

  return (
    <Modal title="Add a web app" onClose={onClose}>
      <p className="modal-sub">Any website, opened full screen like the other apps (e.g. Twitch, Crunchyroll, PBS Kids).</p>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input data-nav data-nav-default value={name} onChange={(e) => setName(e.target.value)} placeholder="PBS Kids" />
        </label>
        <label className="field">
          <span>Web address</span>
          <input data-nav value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="field">
          <span>Colour</span>
          <div className="color-row" data-nav-group>
            {COLORS.map((c) => (
              <button
                key={c}
                data-nav
                className={`color-dot ${color === c ? 'chosen' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" icon="check" onClick={() => void submit()}>
          Add
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
