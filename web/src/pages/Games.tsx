import { useEffect, useMemo, useState } from 'react';
import { Browse } from '../components/Browse';
import { RatingBadge } from '../components/GameDetails';
import { Icon } from '../components/Icon';
import { Button, Chip, DemoBanner, NotSetUp, PageHeader, Tile } from '../components/Layout';
import { PcsPanel } from '../components/PcsPanel';
import { useApi, useServerEvents, type GameLibrary } from '../lib/api';
import { useHearth } from '../lib/hearth';

/** Tiles drawn at once. Big libraries page in so the TV stays responsive to the remote. */
const PAGE_SIZE = 120;

type Tab = 'mine' | 'pc' | 'emu';

export function GamesPage() {
  const hearth = useHearth();
  const { data, reload } = useApi<GameLibrary>('/api/games');
  // The server shows the saved list instantly and says when a PC's library actually changed.
  useServerEvents((e) => e.type === 'games' && void reload());
  const [tab, setTab] = useState<Tab>('mine');
  const [pcs, setPcs] = useState(false);
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
        {!hearth.isKid ? (
          <div className="chips tabs-inline" data-nav-group>
            <Chip active={tab === 'mine'} onClick={() => setTab('mine')}>★ My games</Chip>
            <Chip active={tab === 'pc'} onClick={() => setTab('pc')}>Browse PC</Chip>
            <Chip active={tab === 'emu'} onClick={() => setTab('emu')}>Browse emulated</Chip>
          </div>
        ) : null}
        {tab === 'mine' ? (
          <label className="search" data-nav-group>
            <Icon name="search" size="1.2em" />
            <input data-nav value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
          </label>
        ) : null}
        <Button icon="power" variant="ghost" onClick={() => setPcs(true)}>
          PCs
        </Button>
        {tab === 'mine' ? <Button icon="refresh" variant="ghost" onClick={() => void refresh()} /> : null}
      </PageHeader>

      {data?.demo ? <DemoBanner>Demo library. Install the Hearth PC agent on your gaming and emulator PCs to see your real games.</DemoBanner> : null}
      {data && !data.demo && data.hosts.length === 0 ? (
        <NotSetUp icon="gamepad" title="No gaming PCs yet">
          Install the Hearth agent on each PC, then add it under <code>gaming.hosts</code> in config.yaml with the token the
          agent’s installer printed.
        </NotSetUp>
      ) : null}

      {data && !data.demo && data.hosts.length === 0 ? null : tab !== 'mine' ? (
        <Browse mode={tab} onSelect={hearth.openGame} />
      ) : (
        <>
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

          {data && games.length === 0 ? <div className="empty">{hearth.isKid ? 'No games here yet. Ask a parent to add some!' : 'No games match.'}</div> : null}
          <div className="grid grid-posters">
            {games.slice(0, limit).map((g, i) => (
              <Tile
                autoFocus={i === 0}
                key={`${g.hostId}:${g.id}`}
                pin={{ kind: 'game', hostId: g.hostId, gameId: g.id, title: g.title, art: g.art }}
                shape="poster"
                title={g.title}
                subtitle={`${g.store || g.platform} · ${g.hostName}`}
                label={g.platform === 'PC' ? g.store || 'PC' : g.platform}
                image={g.art}
                badge={
                  <>
                    {g.requiresKbm ? (
                      <span className="badge badge-kbm" title="Needs keyboard & mouse">
                        <Icon name="keyboard" size="1em" />
                        <Icon name="mouse" size="1em" />
                      </span>
                    ) : g.controller === 'full' ? (
                      <span className="badge" title="Full controller support">
                        <Icon name="gamepad" size="1em" />
                      </span>
                    ) : null}
                    <RatingBadge rating={g.rating} />
                  </>
                }
                onSelect={() => hearth.openGame(g)}
              />
            ))}
            {games.length > limit ? (
              <Tile
                shape="poster"
                plain
                title={`Show ${Math.min(PAGE_SIZE, games.length - limit)} more`}
                subtitle={`${games.length - limit} not shown · search or filter to narrow`}
                onSelect={() => setLimit((l) => l + PAGE_SIZE)}
              />
            ) : null}
          </div>
        </>
      )}
      {pcs ? <PcsPanel onClose={() => setPcs(false)} /> : null}
    </div>
  );
}
