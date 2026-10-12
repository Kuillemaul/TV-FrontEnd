import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, Chip, DemoBanner, PageHeader, Tile } from '../components/Layout';
import { useApi, type GameLibrary } from '../lib/api';
import { useHearth } from '../lib/hearth';

/** Tiles drawn at once. Big libraries page in so the TV stays responsive to the remote. */
const PAGE_SIZE = 120;

export function GamesPage() {
  const hearth = useHearth();
  const { data, reload } = useApi<GameLibrary>('/api/games');
  const [host, setHost] = useState<string>('all');
  const [platform, setPlatform] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => setLimit(PAGE_SIZE), [host, platform, query]);

  const platforms = useMemo(() => {
    const games = data?.games.filter((g) => host === 'all' || g.hostId === host) ?? [];
    return [...new Set(games.map((g) => g.platform))].sort();
  }, [data, host]);

  const games = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.games ?? []).filter(
      (g) =>
        (host === 'all' || g.hostId === host) &&
        (platform === 'all' || g.platform === platform) &&
        (!q || g.title.toLowerCase().includes(q)),
    );
  }, [data, host, platform, query]);

  const refresh = async () => {
    await fetch('/api/games?refresh=1');
    void reload();
  };

  return (
    <div className="page">
      <PageHeader title="Games">
        <label className="search" data-nav-group>
          <Icon name="search" size="1.2em" />
          <input data-nav value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
        </label>
        <Button icon="refresh" variant="ghost" onClick={() => void refresh()} />
      </PageHeader>

      {data?.demo ? <DemoBanner>Demo library. Install the Hearth PC agent on your gaming and emulator PCs to see your real games.</DemoBanner> : null}

      <div className="chips" data-nav-group>
        <Chip active={host === 'all'} onClick={() => { setHost('all'); setPlatform('all'); }}>All PCs</Chip>
        {data?.hosts.map((h) => (
          <Chip key={h.id} active={host === h.id} dot={h.online ? 'on' : 'off'} onClick={() => { setHost(h.id); setPlatform('all'); }}>
            {h.name}
          </Chip>
        ))}
      </div>
      {platforms.length > 1 ? (
        <div className="chips" data-nav-group>
          <Chip active={platform === 'all'} onClick={() => setPlatform('all')}>All platforms</Chip>
          {platforms.map((p) => (
            <Chip key={p} active={platform === p} onClick={() => setPlatform(p)}>{p}</Chip>
          ))}
        </div>
      ) : null}

      {data && games.length === 0 ? <div className="empty">No games match.</div> : null}
      <div className="grid grid-posters">
        {games.slice(0, limit).map((g, i) => (
          <Tile
            autoFocus={i === 0}
            key={`${g.hostId}:${g.id}`}
            shape="poster"
            title={g.title}
            subtitle={`${g.store || g.platform} · ${g.hostName}`}
            image={g.art}
            badge={
              g.requiresKbm ? (
                <span className="badge badge-kbm" title="Needs keyboard & mouse">
                  <Icon name="keyboard" size="1em" />
                  <Icon name="mouse" size="1em" />
                </span>
              ) : g.controller === 'full' ? (
                <span className="badge" title="Full controller support">
                  <Icon name="gamepad" size="1em" />
                </span>
              ) : undefined
            }
            onSelect={() => hearth.playGame({ hostId: g.hostId, gameId: g.id, title: g.title, requiresKbm: g.requiresKbm })}
          />
        ))}
        {games.length > limit ? (
          <Tile
            shape="poster"
            title={`Show ${Math.min(PAGE_SIZE, games.length - limit)} more`}
            subtitle={`${games.length - limit} not shown · search or filter to narrow`}
            onSelect={() => setLimit((l) => l + PAGE_SIZE)}
          />
        ) : null}
      </div>
    </div>
  );
}
