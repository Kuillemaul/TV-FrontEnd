import { useRef, useState } from 'react';
import { post, type AppTile, type TileDesign } from '../lib/api';
import { AppArt, defaultDesign, TileArtSvg, TILE_STYLES } from '../components/TileArt';
import type { Notify } from './Admin';

type Reply = { ok: boolean; error?: string; apps?: AppTile[] };

const readFile = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** Every app's tile; select one to restyle it. */
export function TileGallery({ apps, onChanged, notify }: { apps: AppTile[]; onChanged: (apps: AppTile[]) => void; notify: Notify }) {
  const [editing, setEditing] = useState<string | null>(null);
  const app = apps.find((a) => a.id === editing);
  return (
    <>
      <div className="ad-tiles">
        {apps.map((a) => (
          <button key={a.id} className={`ad-tile ad-tile-art ${editing === a.id ? 'active' : ''}`} style={{ background: a.color ?? '#333' }} onClick={() => setEditing(a.id)} title={`Change how ${a.name} looks`}>
            <AppArt app={a} live={editing === a.id} />
            {!a.art && a.logo ? <img className="ad-tile-logo" src={a.logo} alt="" /> : null}
            <span className="ad-tile-edit">✎ Edit look</span>
          </button>
        ))}
      </div>
      {app ? (
        <TileDesigner
          key={app.id}
          app={app}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            onChanged(list);
          }}
        />
      ) : null}
    </>
  );
}

function TileDesigner({ app, notify, onClose, onSaved }: { app: AppTile; notify: Notify; onClose: () => void; onSaved: (apps: AppTile[]) => void }) {
  const start = app.art?.type === 'design' ? app.art.design : defaultDesign(app);
  const [d, setD] = useState<TileDesign>({ ...start, text: start.text ?? app.name, textColor: start.textColor ?? '#ffffff', textStyle: start.textStyle ?? 'bold' });
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [edited, setEdited] = useState(false);
  const set = (patch: Partial<TileDesign>) => {
    setEdited(true);
    setD((x) => ({ ...x, ...patch }));
  };

  const done = (res: Reply, msg: string) => {
    setBusy(false);
    if (!res.ok) return notify(res.error ?? 'That didn’t work', true);
    if (res.apps) onSaved(res.apps);
    notify(msg);
  };
  const save = async () => {
    setBusy(true);
    done(await post<Reply>(`/api/admin/tiles/${app.id}`, { design: d }, 'PUT'), `${app.name} tile saved. It's on the TV now.`);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    done(await post<Reply>(`/api/admin/tiles/${app.id}/image`, { data: await readFile(f) }), `${app.name} now uses ${f.name}`);
    if (file.current) file.current.value = '';
  };
  const reset = async () => {
    setBusy(true);
    done(await post<Reply>(`/api/admin/tiles/${app.id}`, {}, 'DELETE'), `${app.name} is back to its standard tile`);
    onClose();
  };

  return (
    <div className="ad-designer">
      <div className="ad-designer-head">
        <h2>{app.name} tile</h2>
        <button className="ad-link" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="ad-designer-body">
        <div>
          <div className="ad-designer-preview">
            {app.art?.type === 'image' && !edited ? <AppArt app={app} /> : <TileArtSvg design={d} title={app.name} live />}
          </div>
          <p className="ad-muted">This is how it looks when it's selected. On the TV it only moves while highlighted.</p>
        </div>
        <div className="ad-designer-controls">
          <div className="ad-sub">Style</div>
          <div className="ad-styles">
            {TILE_STYLES.map((s) => (
              <button key={s.id} className={`ad-style ${d.style === s.id ? 'active' : ''}`} onClick={() => set({ style: s.id })}>
                <TileArtSvg design={{ ...d, style: s.id, text: s.label, icon: undefined, textStyle: 'bold' }} title={s.label} />
              </button>
            ))}
          </div>
          <div className="ad-grid">
            <label>
              Text
              <input value={d.text ?? ''} maxLength={30} onChange={(e) => set({ text: e.target.value })} placeholder={app.name} />
            </label>
            <label>
              Emoji (optional)
              <input value={d.icon ?? ''} maxLength={8} onChange={(e) => set({ icon: e.target.value || undefined })} placeholder="e.g. 🎬 🎮 🍿" />
            </label>
            <label>
              Lettering
              <select value={d.textStyle} onChange={(e) => set({ textStyle: e.target.value as TileDesign['textStyle'] })}>
                <option value="bold">Bold</option>
                <option value="light">Light</option>
                <option value="caps">CAPITALS</option>
              </select>
            </label>
          </div>
          <div className="ad-colors">
            <label>
              <input type="color" value={d.colors[0]} onChange={(e) => set({ colors: [e.target.value, d.colors[1]] })} />
              Background
            </label>
            <label>
              <input type="color" value={d.colors[1]} onChange={(e) => set({ colors: [d.colors[0], e.target.value] })} />
              Accent
            </label>
            <label>
              <input type="color" value={d.textColor ?? '#ffffff'} onChange={(e) => set({ textColor: e.target.value })} />
              Text
            </label>
            <button className="ad-link" onClick={() => set({ colors: [d.colors[1], d.colors[0]] })}>
              ⇄ Swap
            </button>
          </div>
          <div className="ad-actions">
            <button className="ad-btn primary" disabled={busy} onClick={() => void save()}>
              Save design
            </button>
            <button className="ad-btn" disabled={busy} onClick={() => file.current?.click()}>
              Use my own picture…
            </button>
            {app.art ? (
              <button className="ad-btn" disabled={busy} onClick={() => void reset()}>
                Back to standard
              </button>
            ) : null}
            <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
          <p className="ad-muted">
            <b>Own picture:</b> 16:9, ideally <b>960×540</b> (at least 480×270), JPG, PNG or WebP up to 8 MB. Corners are rounded
            for you; keep words away from the bottom-left corner, where badges go.
          </p>
        </div>
      </div>
    </div>
  );
}
