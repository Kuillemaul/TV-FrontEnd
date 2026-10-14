import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, Chip, DemoBanner, Modal, NotSetUp, PageHeader } from '../components/Layout';
import { formatTime, post, useApi, type Channel, type Guide, type Programme, type Recording } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { useNow } from './Home';

const SLOT = 30 * 60_000;
const REM_PER_MIN = 0.42;
const HOURS = 4;

export function LiveTvPage() {
  const hearth = useHearth();
  const [tab, setTab] = useState<'guide' | 'recordings'>('guide');
  const [choosing, setChoosing] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <div className="page">
      <PageHeader title="Live TV">
        <Chip active={tab === 'guide'} onClick={() => setTab('guide')}>Guide</Chip>
        <Chip active={tab === 'recordings'} onClick={() => setTab('recordings')}>Recordings</Chip>
        {!hearth.isKid ? (
          <Chip active={false} onClick={() => setChoosing(true)}>
            Choose channels
          </Chip>
        ) : null}
      </PageHeader>
      {tab === 'guide' ? <GuideGrid key={version} onChoose={() => setChoosing(true)} /> : <Recordings />}
      {choosing ? (
        <ChannelPicker
          onClose={(changed) => {
            setChoosing(false);
            if (changed) setVersion((v) => v + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/** Pick which channels this profile sees in the guide, on Home and when zapping. */
function ChannelPicker({ onClose }: { onClose: (changed: boolean) => void }) {
  const hearth = useHearth();
  const { data } = useApi<{ channels: Channel[] }>('/api/tv/channels');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(hearth.profile?.hiddenChannels ?? []));
  const [busy, setBusy] = useState(false);
  const all = data?.channels ?? [];
  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = async () => {
    if (!hearth.profile) return;
    setBusy(true);
    // Only remember channels that still exist.
    const ids = all.filter((c) => hidden.has(c.id)).map((c) => c.id);
    const res = await post(`/api/profiles/${hearth.profile.id}`, { hiddenChannels: ids }, 'PUT');
    setBusy(false);
    if (!res.ok) return hearth.toast(res.error ?? 'Couldn’t save the channels', 'error');
    hearth.toast(`${all.length - ids.length} of ${all.length} channels shown for ${hearth.profile.name}`);
    onClose(true);
  };
  const shown = all.filter((c) => !hidden.has(c.id)).length;
  return (
    <Modal title={`Channels for ${hearth.profile?.name ?? 'this profile'}`} onClose={() => onClose(false)} wide>
      <p className="modal-sub">
        Select a channel to show or hide it. {all.length ? `${shown} of ${all.length} shown.` : 'Loading channels…'} “SD copy”
        means an HD channel shows the same programmes. New channels show up by themselves.
      </p>
      <div className="channel-pick" data-nav-group>
        {all.map((c) => (
          <button key={c.id} data-nav className={`channel-pick-item ${hidden.has(c.id) ? 'off' : ''}`} onClick={() => toggle(c.id)}>
            {c.icon ? <img src={c.icon} alt="" /> : <span className="channel-pick-icon" />}
            <span className="channel-pick-num">{c.number}</span>
            <span className="channel-pick-name">{c.name}</span>
            {c.hd ? <span className="ch-tag">HD</span> : null}
            {c.radio ? <span className="ch-tag ch-tag-dim">Radio</span> : null}
            {c.duplicateOf ? <span className="ch-tag ch-tag-dim">SD copy</span> : null}
            <Icon name={hidden.has(c.id) ? 'x' : 'check'} size="1.1em" />
          </button>
        ))}
      </div>
      <div className="modal-actions" data-nav-group>
        <Button onClick={() => void save()} disabled={busy || !all.length}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {all.some((c) => c.duplicateOf) ? (
          <Button variant="ghost" onClick={() => setHidden((h) => new Set([...h, ...all.filter((c) => c.duplicateOf).map((c) => c.id)]))}>
            Hide SD copies
          </Button>
        ) : null}
        {all.some((c) => c.radio) ? (
          <Button variant="ghost" onClick={() => setHidden((h) => new Set([...h, ...all.filter((c) => c.radio).map((c) => c.id)]))}>
            Hide radio
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setHidden(new Set())}>
          Show all
        </Button>
        <Button variant="ghost" onClick={() => setHidden(new Set(all.map((c) => c.id)))}>
          Hide all
        </Button>
        <Button variant="ghost" onClick={() => onClose(false)}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

function GuideGrid({ onChoose }: { onChoose: () => void }) {
  const hearth = useHearth();
  const now = useNow(30_000);
  const { data } = useApi<Guide>(`/api/tv/guide?hours=${HOURS}`, 5 * 60_000);
  const [selected, setSelected] = useState<Programme | null>(null);
  const h24 = hearth.info?.clock24h ?? false;

  const start = Math.floor(now / SLOT) * SLOT;
  const end = start + HOURS * 3600_000;
  const slots = Array.from({ length: (HOURS * 60) / 30 }, (_, i) => start + i * SLOT);
  const width = ((end - start) / 60_000) * REM_PER_MIN;

  const byChannel = useMemo(() => {
    const map = new Map<string, Programme[]>();
    for (const p of data?.programmes ?? []) {
      if (p.end <= start || p.start >= end) continue;
      map.set(p.channelId, [...(map.get(p.channelId) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.start - b.start);
    return map;
  }, [data, start, end]);

  if (!data) return <div className="empty">Loading guide…</div>;
  if (!data.demo && data.channels.length === 0 && (hearth.profile?.hiddenChannels?.length ?? 0) > 0) {
    return (
      <div className="empty">
        Every channel is hidden for this profile.{' '}
        {!hearth.isKid ? (
          <Button onClick={onChoose} autoFocus>
            Choose channels
          </Button>
        ) : null}
      </div>
    );
  }
  if (!data.demo && data.channels.length === 0) {
    return (
      <NotSetUp icon="tv" title="No channels yet">
        Plug in the USB tuner, scan for channels in Tvheadend, then add its address under <code>livetv.tvheadend</code> in
        config.yaml (Setup guide, section 2).
      </NotSetUp>
    );
  }
  const homeChannel = data.channels.find((c) => c.id === data.lastChannel)?.id ?? data.channels[0]?.id;
  const channel = selected ? data.channels.find((c) => c.id === selected.channelId) : undefined;
  const airing = selected ? selected.start <= now && selected.end > now : false;

  return (
    <>
      {data.demo ? <DemoBanner>Demo guide. Connect Tvheadend and your USB tuner in config.yaml to see real channels.</DemoBanner> : null}
      <div className="guide">
        <div className="guide-row guide-times">
          <div className="guide-channel guide-corner">{formatTime(now, h24)}</div>
          <div className="guide-timeline" style={{ width: `${width}rem` }}>
            {slots.map((t) => (
              <div key={t} className="guide-time" style={{ left: `${((t - start) / 60_000) * REM_PER_MIN}rem` }}>
                {formatTime(t, h24)}
              </div>
            ))}
            <div className="guide-now" style={{ left: `${((now - start) / 60_000) * REM_PER_MIN}rem` }} />
          </div>
        </div>
        {data.channels.map((ch) => (
          <div className="guide-row" key={ch.id} data-nav-group>
            <button
              className="guide-channel"
              data-nav
              data-pin={JSON.stringify({ kind: 'channel', id: ch.id, name: `${ch.number} ${ch.name}` })}
              onClick={() => hearth.watchChannel(ch.id)}
            >
              {ch.icon ? <img src={ch.icon} alt="" /> : null}
              <span className="guide-channel-num">{ch.number}</span>
              <span className="guide-channel-name">{ch.name}</span>
              {ch.hd ? <span className="ch-tag">HD</span> : null}
            </button>
            <div className="guide-timeline" style={{ width: `${width}rem` }}>
              {(byChannel.get(ch.id) ?? []).map((p) => {
                const from = Math.max(p.start, start);
                const to = Math.min(p.end, end);
                const live = p.start <= now && p.end > now;
                return (
                  <button
                    key={p.id}
                    data-nav
                    data-nav-default={(live && ch.id === homeChannel) || undefined}
                    className={`guide-prog ${live ? 'live' : ''}`}
                    style={{ left: `${((from - start) / 60_000) * REM_PER_MIN}rem`, width: `${((to - from) / 60_000) * REM_PER_MIN}rem` }}
                    onClick={() => setSelected(p)}
                  >
                    <span className="guide-prog-title">{p.title}</span>
                    <span className="guide-prog-time">
                      {formatTime(p.start, h24)} – {formatTime(p.end, h24)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {selected ? (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
          <div className="modal-sub">
            {channel ? `${channel.number} ${channel.name} · ` : ''}
            {formatTime(selected.start, h24)} – {formatTime(selected.end, h24)}
            {selected.subtitle ? ` · ${selected.subtitle}` : ''}
          </div>
          {selected.description ? <p className="modal-text">{selected.description}</p> : null}
          <div className="modal-actions">
            {airing ? (
              <Button variant="primary" icon="play" autoFocus onClick={() => { setSelected(null); hearth.watchChannel(selected.channelId); }}>
                Watch now
              </Button>
            ) : null}
            <Button icon="record" autoFocus={!airing} onClick={() => { void post('/api/tv/record', { programmeId: selected.id }); setSelected(null); }}>
              Record
            </Button>
            <Button icon="record" onClick={() => { void post('/api/tv/record', { programmeId: selected.id, series: true }); setSelected(null); }}>
              Record series
            </Button>
            <Button onClick={() => setSelected(null)}>Close</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Recordings() {
  const hearth = useHearth();
  const { data, reload } = useApi<{ demo: boolean; recordings: Recording[] }>('/api/tv/recordings', 30_000);
  const h24 = hearth.info?.clock24h ?? false;
  if (!data) return <div className="empty">Loading recordings…</div>;
  if (!data.recordings.length) {
    return (
      <div className="empty">
        Nothing recording or coming up. Pick a show in the guide and choose Record. Finished recordings from Plex appear
        under Recently added on Home.
      </div>
    );
  }

  const remove = async (id: string) => {
    await post(`/api/tv/recordings/${id}`, {}, 'DELETE');
    void reload();
  };

  return (
    <div className="list">
      {data.recordings.map((r) => (
        <div className="list-item" key={r.id} data-nav-group>
          <div className={`rec-status rec-${r.status}`}>
            <Icon name={r.status === 'completed' ? 'play' : 'record'} size="1.2em" />
          </div>
          <div className="list-text">
            <div className="list-title">{r.title}</div>
            <div className="list-sub">
              {r.channelName} · {new Date(r.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}{' '}
              {formatTime(r.start, h24)} · {r.status}
            </div>
          </div>
          {r.status === 'completed' ? (
            <Button icon="play" variant="primary" onClick={() => void post(`/api/tv/recordings/${r.id}/play`)}>
              Play
            </Button>
          ) : null}
          <Button icon="trash" variant="ghost" onClick={() => void remove(r.id)}>
            {r.status === 'scheduled' ? 'Cancel' : 'Delete'}
          </Button>
        </div>
      ))}
    </div>
  );
}
