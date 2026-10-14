import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Modal, PageHeader, Row, Tile } from '../components/Layout';
import { OnScreenKeyboard } from '../components/OnScreenKeyboard';
import { appArt } from '../components/TileArt';
import { formatTime, get, post, useApi, type AppTile, type Game, type GameLibrary, type Guide, type MediaResult, type OnDeckItem, type Programme } from '../lib/api';
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

/** Searches you picked a result from, newest first, per profile (this TV only). */
const recentKey = (profileId: string | undefined) => `hearth.recentSearches.${profileId ?? 'default'}`;
function loadRecent(profileId: string | undefined): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(profileId)) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}
function saveRecent(profileId: string | undefined, list: string[]): void {
  try {
    localStorage.setItem(recentKey(profileId), JSON.stringify(list));
  } catch {
    /* storage unavailable: recent searches just aren't remembered */
  }
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
  const profileId = hearth.profile?.id;
  const [recent, setRecent] = useState(() => loadRecent(profileId));
  /** Remember the search when you pick something from its results. */
  const remember = () => {
    const q = query.trim();
    if (q.length < 2) return;
    const next = [q, ...recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    setRecent(next);
    saveRecent(profileId, next);
  };

  // Ideas before you type: what's on now, new in Plex and games you played lately (all things that will match).
  const guide = useApi<Guide>(hearth.info?.setup.tv ? '/api/tv/guide?hours=1' : null);
  const fresh = useApi<{ items: OnDeckItem[] }>('/api/plex/recent');
  const library = useApi<GameLibrary>('/api/games');
  const ideas = useMemo(() => {
    const now = Date.now();
    const onNow = (guide.data?.programmes ?? []).filter((p) => p.start <= now && p.end > now).map((p) => p.title);
    const titles = [...onNow.slice(0, 4), ...(fresh.data?.items ?? []).slice(0, 3).map((i) => i.title), ...(library.data?.recent ?? []).slice(0, 2).map((g) => g.title)];
    const seen = new Set(recent.map((r) => r.toLowerCase()));
    return titles.filter((t) => t && !/paid programming|no listing/i.test(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 8);
  }, [guide.data, fresh.data, library.data, recent]);

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
    remember();
    const res = await post(`/api/plex/open/${item.id}`);
    if (!res.ok) hearth.toast(res.error ?? 'Couldn’t open that in Plex', 'error');
  };
  const choose = (p: TvHit) => {
    remember();
    if (p.live) hearth.watchChannel(p.channelId);
    else setAiring(p);
  };
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
      <div className="search-top">
        <div className="search-entry">
          <div className="search-box">
            <input
              ref={input}
              data-nav
              data-osk-off
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Films, shows, channels, games…"
              aria-label="Search"
            />
            {loading ? <span className="search-spinner" /> : null}
          </div>
          <OnScreenKeyboard value={query} onChange={setQuery} autoFocus />
        </div>
        <div className="search-aside">
          {!query.trim() ? (
            <>
              {recent.length ? (
                <div className="search-suggest">
                  <h3>Recent searches</h3>
                  <div className="chips" data-nav-group>
                    {recent.map((r) => (
                      <Chip key={r} active={false} onClick={() => setQuery(r)}>
                        {r}
                      </Chip>
                    ))}
                    <Chip active={false} onClick={() => { setRecent([]); saveRecent(profileId, []); }}>
                      Clear
                    </Chip>
                  </div>
                </div>
              ) : null}
              {ideas.length ? (
                <div className="search-suggest">
                  <h3>Try</h3>
                  <div className="chips" data-nav-group>
                    {ideas.map((t) => (
                      <Chip key={t} active={false} onClick={() => setQuery(t)}>
                        {t}
                      </Chip>
                    ))}
                  </div>
                </div>
              ) : null}
              <p>
                Searches Plex, the TV guide, requests, games and apps. Type here, with a keyboard or the phone remote, or say
                “search for…”.
              </p>
            </>
          ) : query.trim().length < 2 ? (
            <p>Keep typing…</p>
          ) : r && !loading && total === 0 ? (
            <p>Nothing found for “{r.q}”.</p>
          ) : r && total ? (
            <p>
              {total} result{total === 1 ? '' : 's'} for “{r.q}”. Press down to see them.
            </p>
          ) : null}
        </div>
      </div>

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
                remember();
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
            <Tile key={`${g.hostId}:${g.id}`} shape="poster" title={g.title} subtitle={g.hostName} image={g.art} onSelect={() => { remember(); hearth.openGame(g); }} />
          ))}
        </Row>
      ) : null}
      {r?.apps.length ? (
        <Row title="Apps">
          {r.apps.map((a) => (
            <Tile key={a.id} shape="app" title={a.name} color={a.color} image={a.logo} art={appArt(a)} onSelect={() => { remember(); hearth.launchApp(a.id); }} />
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
