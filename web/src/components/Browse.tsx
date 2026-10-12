import { useEffect, useMemo, useRef, useState } from 'react';
import { get, useApi, type BrowseSource, type Game } from '../lib/api';
import { Icon } from './Icon';
import { Chip, Tile } from './Layout';
import { RatingBadge } from './GameDetails';

const PAGE = 120;

/** Debounce a value so typing a search doesn't hit the PC on every key. */
function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function usePaged(url: string | null) {
  const [games, setGames] = useState<Game[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const req = useRef(0);

  const load = async (offset: number) => {
    if (!url) return;
    const id = ++req.current;
    setLoading(true);
    try {
      const res = await get<{ total: number; games: Game[] }>(`${url}&offset=${offset}&limit=${PAGE}`);
      if (id !== req.current) return;
      setTotal(res.total);
      setGames((g) => (offset === 0 ? res.games : [...g, ...res.games]));
      setError('');
    } catch {
      if (id === req.current) setError('That PC isn’t answering. Is it awake?');
    } finally {
      if (id === req.current) setLoading(false);
    }
  };

  useEffect(() => {
    setGames([]);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { games, total, loading, error, more: () => void load(games.length) };
}

function GameGrid({ games, total, loading, error, more, onSelect }: ReturnType<typeof usePaged> & { onSelect: (g: Game) => void }) {
  return (
    <>
      {error ? <div className="empty">{error}</div> : null}
      {!error && !loading && games.length === 0 ? <div className="empty">No games match.</div> : null}
      <div className="grid grid-posters">
        {games.map((g, i) => (
          <Tile
            key={`${g.hostId}:${g.id}`}
            autoFocus={i === 0}
            shape="poster"
            title={g.title}
            subtitle={`${g.store || g.platform}${g.favorite ? ' · ★' : ''}`}
            image={g.art}
            badge={
              <>
                {!g.installed ? <span className="badge badge-warn">Not installed</span> : null}
                <RatingBadge rating={g.rating} />
              </>
            }
            onSelect={() => onSelect(g)}
          />
        ))}
        {games.length < total ? (
          <Tile shape="poster" title={loading ? 'Loading…' : `Show more`} subtitle={`${total - games.length} more`} onSelect={more} />
        ) : null}
      </div>
    </>
  );
}

/**
 * Browse whole libraries, not just favourites: every PC game (installed or not, via
 * Playnite), or one emulated platform at a time from LaunchBox.
 */
export function Browse({ mode, onSelect }: { mode: 'pc' | 'emu'; onSelect: (g: Game) => void }) {
  const { data: sources } = useApi<BrowseSource[]>('/api/games/browse/sources');
  const [hostId, setHostId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());

  const pcHosts = useMemo(() => (sources ?? []).filter((s) => s.pc > 0), [sources]);
  const emuHosts = useMemo(() => (sources ?? []).filter((s) => s.platforms.length > 0), [sources]);
  const hosts = mode === 'pc' ? pcHosts : emuHosts;
  const host = hosts.find((h) => h.hostId === hostId) ?? hosts[0];

  useEffect(() => {
    setPlatform(null);
    setQuery('');
  }, [mode, host?.hostId]);

  const url =
    host && (mode === 'pc' || platform)
      ? `/api/games/browse/${encodeURIComponent(host.hostId)}?source=${mode === 'pc' ? 'pc' : 'platform'}&platform=${encodeURIComponent(platform ?? '')}&q=${encodeURIComponent(q)}`
      : null;
  const paged = usePaged(url);

  if (!sources) return <div className="empty">Asking your PCs what they have…</div>;
  if (hosts.length === 0) {
    return (
      <div className="empty">
        {mode === 'pc' ? 'No PC library found. Enable Playnite (or Steam) in the agent on your gaming PC.' : 'No LaunchBox library found on your emulator PC.'}
      </div>
    );
  }

  return (
    <div className="browse">
      <div className="chips" data-nav-group>
        {hosts.length > 1
          ? hosts.map((h) => (
              <Chip key={h.hostId} active={h.hostId === host?.hostId} dot={h.online ? 'on' : 'off'} onClick={() => setHostId(h.hostId)}>
                {h.hostName}
              </Chip>
            ))
          : null}
        {platform ? (
          <Chip active={false} onClick={() => setPlatform(null)}>
            ← All platforms
          </Chip>
        ) : null}
        {mode === 'pc' || platform ? (
          <label className="search">
            <Icon name="search" size="1.2em" />
            <input data-nav value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${platform ?? 'all PC games'}`} />
          </label>
        ) : null}
        {url ? <span className="browse-count">{paged.total.toLocaleString()} games</span> : null}
      </div>

      {mode === 'emu' && !platform ? (
        <div className="grid grid-platforms">
          {host!.platforms.map((p, i) => (
            <button key={p.name} className="platform-card" data-nav data-nav-default={i === 0 || undefined} onClick={() => setPlatform(p.name)}>
              <span className="platform-name">{p.name}</span>
              <span className="platform-count">{p.count.toLocaleString()} games</span>
            </button>
          ))}
        </div>
      ) : (
        <GameGrid {...paged} onSelect={onSelect} />
      )}
    </div>
  );
}
