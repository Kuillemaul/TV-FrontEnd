import { useEffect, useState } from 'react';
import { post, useApi, type Channel } from '../lib/api';
import type { Notify } from './Admin';

/** Editor → TV settings → Channel names: give Live TV channels the names you know them by. */
export function ChannelNamesCard({ notify }: { notify: Notify }) {
  const api = useApi<{ channels: Channel[]; names: Record<string, string> }>('/api/tv/channels');
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (api.data) setNames(api.data.names ?? {});
  }, [api.data]);

  if (!api.data?.channels.length) return null;
  const saved = api.data.names ?? {};
  const dirty = JSON.stringify(names) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true);
    const res = await post('/api/admin/tv/channel-names', { names }, 'PUT');
    setBusy(false);
    notify(res.ok ? 'Channel names saved' : (res.error ?? 'Couldn’t save the names'), !res.ok);
    void api.reload();
  };

  return (
    <div className="ad-card">
      <h2>Channel names</h2>
      <p className="ad-muted">Type a name to replace the one Hearth shows; leave it empty to keep the standard name.</p>
      <div className="ad-channel-names">
        {api.data.channels.map((c) => (
          <label key={c.id}>
            <b>{c.number}</b>
            <input
              value={names[c.id] ?? ''}
              placeholder={saved[c.id] ? '' : c.name}
              maxLength={40}
              onChange={(e) => setNames({ ...names, [c.id]: e.target.value })}
            />
            {c.hd ? <em className="ad-tag">HD</em> : null}
          </label>
        ))}
      </div>
      <div className="ad-actions">
        <button className="ad-btn primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save names'}
        </button>
      </div>
    </div>
  );
}
