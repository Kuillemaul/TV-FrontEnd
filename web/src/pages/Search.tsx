import { useEffect, useRef, useState } from 'react';
import { Button, Modal, PageHeader, Row, Tile } from '../components/Layout';
import { appArt } from '../components/TileArt';
import { formatTime, get, post, type AppTile, type Game, type MediaResult, type Programme } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { openMediaLater } from './Requests';

interface LibraryHit {
  id: string;
  type: 'movie' | 'show' | 'episode';
  title: string;
  year?: number;
  subtitle?: string;
  thumb?: string;
}

interface TvHit extends Programme {
  channelName: string;
  channelNumber: number;
  hd?: boolean;
  live: boolean;
}

interface Results {
  q: string;
  library: LibraryHit[];
  tv: TvHit[];
  requests: MediaResult[];
  games: Game[];
  apps: AppTile[];
}

let pendingQuery = '';
/** Open the Search page with this query already typed (voice: "search for Dune"). */
export function openSearchLater(query: string): void {
  pendingQuery = query;
  window.dispatchEvent(new Event('hearth-search'));
}

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long' });
};

/** Search everything: your Plex library, what's on TV in the next two days, Seerr, games and apps. */
export function SearchPage() {
  const hearth = useHearth();
  const h24 = hearth.info?.clock24h ?? false;
  const [query, setQuery] = useState(() => {
    const q = pendingQuery;
    pendingQuery = '';
    return q;
  });
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [airing, setAiring] = useState<TvHit | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef('');

  useEffect(() => {
    const onSearch = () => {
      setQuery(pendingQuery);
      pendingQuery = '';
    };
    window.addEventListener('hearth-search', onSearch);
    return () => window.removeEventListener('hearth-search', onSearch);
  }, []);

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (q.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await get<Results>(`/api/search?q=${encodeURIComponent(q)}`);
        if (latest.current === q) setResults(r);
      } catch {
        if (latest.current === q) hearth.toast('Search didn’t work. Try again.', 'error');
      } finally {
        if (latest.current === q) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const openLibrary = async (item: LibraryHit) => {
    const res = await post(`/api/plex/open/${item.id}`);
    if (!res.ok) hearth.toast(res.error ?? 'Couldn’t open that in Plex', 'error');
  };
  const choose = (p: TvHit) => (p.live ? hearth.watchChannel(p.channelId) : setAiring(p));
  const record = async (p: TvHit, series: boolean) => {
    const res = await post('/api/tv/record', { programmeId: p.id, series });
    if (!res.ok) hearth.toast(res.error ?? 'Couldn’t set up the recording', 'error');
    setAiring(null);
  };

  const r = results;
  const total = r ? r.library.length + r.tv.length + r.requests.length + r.games.length + r.apps.length : 0;
  return (
    <div className="page">
      <PageHeader title="Search" />
      <div className="search-box">
        <input
          ref={input}
          data-nav
          data-nav-default
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Films, shows, channels, games…"
          aria-label="Search"
        />
        {loading ? <span className="search-spinner" /> : null}
      </div>
      {!query.trim() ? (
        <p className="empty">Type with a keyboard or the phone remote, or say “search for…”. Searches Plex, the TV guide, requests, games and apps.</p>
      ) : r && !loading && total === 0 ? (
        <p className="empty">Nothing found for “{r.q}”.</p>
      ) : null}

      {r?.tv.length ? (
        <Row title="On TV">
          {r.tv.map((p) => (
            <Tile
              key={p.id}
              shape="wide"
              icon="tv"
              title={p.title}
              subtitle={`${p.live ? 'On now' : `${dayLabel(p.start)} ${formatTime(p.start, h24)}`} · ${p.channelNumber} ${p.channelName}`}
              badge={p.live ? <span className="badge badge-live">Live</span> : p.hd ? <span className="badge">HD</span> : undefined}
              onSelect={() => choose(p)}
            />
          ))}
        </Row>
      ) : null}
      {r?.library.length ? (
        <Row title="In your library">
          {r.library.map((m) => (
            <Tile key={m.id} shape="poster" title={m.title} subtitle={m.subtitle ?? (m.year ? String(m.year) : undefined)} image={m.thumb} onSelect={() => void openLibrary(m)} />
          ))}
        </Row>
      ) : null}
      {r?.requests.length ? (
        <Row title="Not in your library: request it">
          {r.requests.map((m) => (
            <Tile
              key={`${m.mediaType}${m.id}`}
              shape="poster"
              title={m.title}
              subtitle={[m.year, m.mediaType === 'tv' ? 'TV' : 'Film'].filter(Boolean).join(' · ')}
              image={m.poster}
              badge={m.status !== 'none' ? <span className="badge">{m.status === 'requested' || m.status === 'processing' ? 'Requested' : 'Partly there'}</span> : undefined}
              onSelect={() => {
                hearth.navigate('requests');
                openMediaLater(m);
              }}
            />
          ))}
        </Row>
      ) : null}
      {r?.games.length ? (
        <Row title="Games">
          {r.games.map((g) => (
            <Tile key={`${g.hostId}:${g.id}`} shape="poster" title={g.title} subtitle={g.hostName} image={g.art} onSelect={() => hearth.openGame(g)} />
          ))}
        </Row>
      ) : null}
      {r?.apps.length ? (
        <Row title="Apps">
          {r.apps.map((a) => (
            <Tile key={a.id} shape="app" title={a.name} color={a.color} image={a.logo} art={appArt(a)} onSelect={() => hearth.launchApp(a.id)} />
          ))}
        </Row>
      ) : null}

      {airing ? (
        <Modal title={airing.title} onClose={() => setAiring(null)}>
          <p className="modal-sub">
            {dayLabel(airing.start)} {formatTime(airing.start, h24)} – {formatTime(airing.end, h24)} · {airing.channelNumber} {airing.channelName}
            {airing.subtitle ? ` · ${airing.subtitle}` : ''}
          </p>
          {airing.description ? <p className="modal-sub">{airing.description}</p> : null}
          <div className="modal-actions" data-nav-group>
            <Button icon="record" onClick={() => void record(airing, false)} autoFocus>
              Record
            </Button>
            <Button icon="record" variant="ghost" onClick={() => void record(airing, true)}>
              Record series
            </Button>
            <Button variant="ghost" onClick={() => setAiring(null)}>
              Close
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
