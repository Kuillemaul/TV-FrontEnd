import { useEffect, useRef, useState } from 'react';
import { onScopedBack } from '../nav/spatial';
import { Icon } from '../components/Icon';
import { Button, Modal, NotSetUp, PageHeader, Row, Tile } from '../components/Layout';
import { get, post, useApi, type DownloadItem, type MediaResult } from '../lib/api';
import { useHearth } from '../lib/hearth';

type ListReply = { ok: boolean; error?: string; results?: MediaResult[] };

/** "Request Dune Part Three" by voice: open that title's card once the Requests page is up. */
let pendingMedia: { id: number; mediaType: 'movie' | 'tv' } | null = null;
export function openMediaLater(media: { id: number; mediaType: 'movie' | 'tv' }): void {
  pendingMedia = media;
  window.dispatchEvent(new Event('hearth-open-media'));
}

const STATUS: Record<MediaResult['status'], { label: string; cls: string } | null> = {
  none: null,
  requested: { label: 'Requested', cls: 'req-requested' },
  processing: { label: 'On its way', cls: 'req-processing' },
  partial: { label: 'Partly here', cls: 'req-partial' },
  available: { label: 'In library', cls: 'req-available' },
  blocked: { label: 'Blocked', cls: 'req-blocked' },
};

function StatusBadge({ media }: { media: MediaResult }) {
  if (media.approval === 'pending') return <span className="badge req-requested">Awaiting approval</span>;
  if (media.approval === 'declined') return <span className="badge req-blocked">Declined</span>;
  const s = STATUS[media.status];
  return s ? <span className={`badge ${s.cls}`}>{s.label}</span> : null;
}

function MediaRow({ title, items, onOpen }: { title: string; items: MediaResult[] | undefined; onOpen: (m: MediaResult) => void }) {
  if (!items?.length) return null;
  return (
    <Row title={title}>
      {items.slice(0, 20).map((m) => (
        <Tile
          key={`${m.mediaType}:${m.id}`}
          shape="poster"
          title={m.title}
          subtitle={[m.mediaType === 'tv' ? 'Series' : 'Film', m.year].filter(Boolean).join(' · ')}
          image={m.poster}
          badge={<StatusBadge media={m} />}
          onSelect={() => onOpen(m)}
        />
      ))}
    </Row>
  );
}

function useList(path: string | null) {
  const [items, setItems] = useState<MediaResult[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
    let live = true;
    get<ListReply>(path)
      .then((r) => live && (r.ok ? setItems(r.results ?? []) : setError(r.error ?? 'Seerr didn’t answer')))
      .catch(() => live && setError('Seerr didn’t answer'));
    return () => {
      live = false;
    };
  }, [path]);
  return { items, error, setItems };
}

/** What's downloading in Radarr, Sonarr and Lidarr. Also used on Home. */
export function DownloadsList({ compact }: { compact?: boolean }) {
  const { data } = useApi<{ items: DownloadItem[]; errors: string[] }>('/api/downloads', 10_000);
  if (!data) return null;
  if (!data.items.length) {
    if (compact) return null;
    return (
      <section className="row">
        <header className="row-header"><h2>Downloading</h2></header>
        <p className="modal-sub">{data.errors.length ? data.errors.join(' · ') : 'Nothing downloading right now.'}</p>
      </section>
    );
  }
  return (
    <section className="row">
      <header className="row-header"><h2>Downloading</h2></header>
      <div className="dl-list" data-nav-group>
        {data.items.slice(0, compact ? 4 : 30).map((d) => (
          <div key={d.id} className="dl-item" data-nav tabIndex={-1}>
            <Icon name={d.kind === 'lidarr' ? 'volumeUp' : d.kind === 'sonarr' ? 'tv' : 'play'} size="1.6em" />
            <div className="dl-text">
              <div className="dl-title">{d.title}</div>
              <div className="dl-sub">{[d.subtitle, d.timeLeft ? `${d.timeLeft} left` : d.status].filter(Boolean).join(' · ')}</div>
              <div className="dl-bar"><div style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
            </div>
            <div className="dl-pct">{Math.round(d.progress * 100)}%</div>
          </div>
        ))}
      </div>
      {!compact && data.errors.length ? <p className="modal-sub">{data.errors.join(' · ')}</p> : null}
    </section>
  );
}

export function RequestsPage() {
  const hearth = useHearth();
  const features = hearth.info?.features;
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<MediaResult | null>(null);
  useEffect(() => {
    const show = () => {
      const want = pendingMedia;
      pendingMedia = null;
      if (!want) return;
      void get<{ ok: boolean; media?: MediaResult }>(`/api/requests/media/${want.mediaType}/${want.id}`).then((r) => r.media && setOpen(r.media));
    };
    show();
    window.addEventListener('hearth-open-media', show);
    return () => window.removeEventListener('hearth-open-media', show);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 450);
    return () => clearTimeout(t);
  }, [query]);

  const seerr = Boolean(features?.requests);
  const search = useList(seerr && debounced ? `/api/requests/search?q=${encodeURIComponent(debounced)}` : null);
  const recent = useList(seerr ? '/api/requests/recent' : null);
  const trending = useList(seerr ? '/api/requests/discover/trending' : null);
  const movies = useList(seerr ? '/api/requests/discover/movies' : null);
  const tv = useList(seerr ? '/api/requests/discover/tv' : null);
  const upcoming = useList(seerr ? '/api/requests/discover/upcoming' : null);

  // After a request, show the new status everywhere the title appears.
  const updated = (m: MediaResult) => {
    for (const list of [search, recent, trending, movies, tv, upcoming]) {
      list.setItems((items) => items?.map((x) => (x.id === m.id && x.mediaType === m.mediaType ? { ...x, status: m.status } : x)));
    }
    setOpen(m);
  };

  return (
    <div className="page">
      <PageHeader title="Requests">
        {seerr ? (
          <label className="search" data-nav-group>
            <Icon name="search" size="1.2em" />
            <input data-nav value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a film or show" />
          </label>
        ) : null}
      </PageHeader>

      {features?.downloads ? <DownloadsList /> : null}

      {!seerr ? (
        <NotSetUp icon="download" title="Seerr isn’t set up">
          Add your Seerr address and API key under <code>requests</code> in config.yaml (Seerr → Settings → General → API Key).
        </NotSetUp>
      ) : debounced ? (
        search.items?.length === 0 ? <div className="empty">Nothing found for “{debounced}”.</div> : <MediaRow title={`Results for “${debounced}”`} items={search.items} onOpen={setOpen} />
      ) : (
        <>
          {trending.error ? <p className="form-error">{trending.error}</p> : null}
          <MediaRow title="Recently requested" items={recent.items} onOpen={setOpen} />
          <MediaRow title="Trending" items={trending.items} onOpen={setOpen} />
          <MediaRow title="Popular films" items={movies.items} onOpen={setOpen} />
          <MediaRow title="Popular shows" items={tv.items} onOpen={setOpen} />
          <MediaRow title="Coming soon" items={upcoming.items} onOpen={setOpen} />
        </>
      )}

      {open ? <MediaModal media={open} onClose={() => setOpen(null)} onRequested={updated} /> : null}
    </div>
  );
}

/** Full-screen trailer inside Hearth (YouTube embed). Back closes it and you're back on Request. */
function TrailerPlayer({ youtubeKey, title, onClose }: { youtubeKey: string; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => onScopedBack(() => ref.current, onClose), [onClose]);
  useEffect(() => {
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button')?.focus());
  }, []);
  const src = `https://www.youtube-nocookie.com/embed/${youtubeKey}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  return (
    <div className="trailer" data-nav-scope ref={ref}>
      <iframe src={src} title={`${title} trailer`} allow="autoplay; encrypted-media; fullscreen" />
      <div className="trailer-bar" data-nav-group>
        <span>{title} · trailer</span>
        <button className="btn" data-nav onClick={onClose}>
          Back to request
        </button>
        <button className="btn btn-ghost" data-nav onClick={() => void post('/api/youtube/play', { key: youtubeKey })}>
          Won’t play? Open in YouTube
        </button>
      </div>
    </div>
  );
}

function MediaModal({ media: initial, onClose, onRequested }: { media: MediaResult; onClose: () => void; onRequested: (m: MediaResult) => void }) {
  const hearth = useHearth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [media, setMedia] = useState(initial);
  const [trailer, setTrailer] = useState(false);
  // Search results don't carry the trailer; the details do (and a fresh status).
  useEffect(() => {
    setMedia(initial);
    void get<{ ok: boolean; media?: MediaResult }>(`/api/requests/media/${initial.mediaType}/${initial.id}`).then(
      (r) => r.media && setMedia((m) => ({ ...m, ...r.media, approval: m.approval })),
    );
  }, [initial]);
  const canRequest = media.status === 'none';

  const request = async () => {
    setBusy(true);
    setError('');
    const res = await post<{ ok: boolean; error?: string; media?: MediaResult }>('/api/requests', { mediaType: media.mediaType, id: media.id });
    setBusy(false);
    if (!res.ok || !res.media) return setError(res.error ?? 'Seerr didn’t accept the request');
    hearth.toast(`Requested ${media.title}`);
    onRequested({ ...media, status: res.media.status === 'none' ? 'requested' : res.media.status });
  };

  return (
    <Modal title={media.title} onClose={onClose} wide>
      <div className="details">
        <div className="details-backdrop">{media.backdrop ? <img src={media.backdrop} alt="" /> : null}</div>
        <div className="details-body">
          <div className="details-poster">
            <span className="tile-poster-title">{media.title}</span>
            {media.poster ? <img src={media.poster} alt="" /> : null}
          </div>
          <div className="details-text">
            <div className="details-meta">
              <span>{media.mediaType === 'tv' ? 'Series' : 'Film'}</span>
              {media.year ? <span>{media.year}</span> : null}
              <StatusBadge media={media} />
            </div>
            <p className="details-desc">{media.overview || 'No description.'}</p>
            {error ? <div className="form-error">{error}</div> : null}
            <div className="modal-actions" data-nav-group>
              {canRequest ? (
                <Button variant="primary" icon="download" autoFocus onClick={() => void request()} disabled={busy}>
                  {busy ? 'Requesting…' : media.mediaType === 'tv' ? 'Request all seasons' : 'Request'}
                </Button>
              ) : media.status === 'available' || media.status === 'partial' ? (
                <Button variant="primary" icon="play" autoFocus onClick={() => { onClose(); hearth.launchApp('plex'); }}>
                  Open Plex
                </Button>
              ) : null}
              {media.trailer ? (
                <Button icon="play" onClick={() => setTrailer(true)}>
                  Trailer
                </Button>
              ) : null}
              <Button onClick={onClose} autoFocus={!canRequest && media.status !== 'available' && media.status !== 'partial'}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
      {trailer && media.trailer ? <TrailerPlayer youtubeKey={media.trailer} title={media.title} onClose={() => setTrailer(false)} /> : null}
    </Modal>
  );
}
