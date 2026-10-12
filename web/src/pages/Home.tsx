import { useEffect, useMemo, useState } from 'react';
import { EntityCard } from '../components/EntityCard';
import { Icon } from '../components/Icon';
import { Row, Tile } from '../components/Layout';
import { formatTime, post, useApi, useServerEvents, type AppTile, type Dashboard, type GameLibrary, type Guide, type OnDeckItem } from '../lib/api';
import { useHearth } from '../lib/hearth';

function greeting(h: number): string {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function HomePage() {
  const hearth = useHearth();
  const now = useNow();
  const apps = useApi<AppTile[]>('/api/apps');
  const liveTv = hearth.profile?.liveTv ?? true;
  const guide = useApi<Guide>(liveTv ? '/api/tv/guide?hours=1' : null, 60_000);
  const library = useApi<GameLibrary>('/api/games');
  const dash = useApi<Dashboard>('/api/ha/dashboard');
  // Continue watching only for profiles that can see Plex.
  const hasPlex = apps.data?.some((a) => a.id === 'plex') ?? false;
  const deck = useApi<{ demo: boolean; items: OnDeckItem[] }>(hasPlex ? '/api/plex/ondeck' : null, 5 * 60_000);

  useServerEvents((e) => {
    if (e.type !== 'ha-state' || !dash.data) return;
    const swap = (list: typeof dash.data.favorites) => list.map((x) => (x.entity_id === e.entity.entity_id ? e.entity : x));
    dash.setData({
      ...dash.data,
      favorites: swap(dash.data.favorites),
      weather: dash.data.weather?.entity_id === e.entity.entity_id ? e.entity : dash.data.weather,
    });
  });

  const onNow = useMemo(() => {
    if (!guide.data) return [];
    return guide.data.channels.slice(0, 12).map((ch) => ({
      ch,
      prog: guide.data!.programmes.find((p) => p.channelId === ch.id && p.start <= now && p.end > now),
    }));
  }, [guide.data, now]);

  const lastChannel = guide.data?.channels.find((c) => c.id === guide.data?.lastChannel) ?? guide.data?.channels[0];
  const weather = dash.data?.weather;
  const h24 = hearth.info?.clock24h ?? false;
  const gameById = (hostId: string, gameId: string) => library.data?.games.find((g) => g.hostId === hostId && g.id === gameId);

  return (
    <div className="page page-home">
      <section className="hero">
        <div>
          <div className="hero-time">{formatTime(now, h24)}</div>
          <div className="hero-date">
            {greeting(new Date(now).getHours())} · {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
        {weather ? (
          <div className="hero-weather">
            <Icon name="cloud" size="2.4em" />
            <div>
              <div className="hero-weather-temp">
                {String(weather.attributes.temperature ?? '–')}
                {String(weather.attributes.temperature_unit ?? '°')}
              </div>
              <div className="hero-weather-state">{weather.state.replace('partlycloudy', 'partly cloudy')}</div>
            </div>
          </div>
        ) : null}
      </section>

      <Row title="Watch">
        {liveTv ? (
          <Tile
            shape="app"
            title="Live TV"
            icon="tv"
            color="#2b3cff"
            autoFocus
            badge={lastChannel ? <span className="badge">{lastChannel.number} {lastChannel.name}</span> : undefined}
            onSelect={() => (lastChannel ? hearth.watchChannel(lastChannel.id) : hearth.navigate('tv'))}
          />
        ) : null}
        {apps.data?.map((a, i) => (
          <Tile key={a.id} autoFocus={!liveTv && i === 0} shape="app" title={a.name} color={a.color} image={a.logo} onSelect={() => hearth.launchApp(a.id)} />
        ))}
      </Row>

      {hasPlex && deck.data?.items.length ? (
        <Row title="Continue watching">
          {deck.data.items.map((item) => (
            <Tile
              key={item.id}
              title={item.title}
              subtitle={item.subtitle}
              image={item.thumb}
              icon="play"
              color="#1f1a10"
              progress={item.progress}
              onSelect={() => void post(`/api/plex/open/${encodeURIComponent(item.id)}`)}
            />
          ))}
        </Row>
      ) : null}

      {onNow.length ? (
        <Row title="On now">
          {onNow.map(({ ch, prog }) => (
            <Tile
              key={ch.id}
              title={prog?.title ?? 'No listing'}
              subtitle={`${ch.number} · ${ch.name}${prog ? ` · until ${formatTime(prog.end, h24)}` : ''}`}
              image={ch.icon}
              icon="tv"
              progress={prog ? (now - prog.start) / (prog.end - prog.start) : undefined}
              onSelect={() => hearth.watchChannel(ch.id)}
            />
          ))}
        </Row>
      ) : null}

      {library.data?.recent.length ? (
        <Row title="Jump back in">
          {library.data.recent.map((r) => {
            const g = gameById(r.hostId, r.gameId);
            return (
              <Tile
                key={`${r.hostId}:${r.gameId}`}
                shape="poster"
                title={r.title}
                image={r.art}
                badge={g?.requiresKbm ? <span className="badge"><Icon name="keyboard" size="1em" /></span> : undefined}
                onSelect={() =>
                  g ? hearth.openGame(g) : hearth.playGame({ hostId: r.hostId, gameId: r.gameId, title: r.title, requiresKbm: false, art: r.art })
                }
              />
            );
          })}
        </Row>
      ) : library.data?.games.length ? (
        <Row title="Games">
          {library.data.games.slice(0, 12).map((g) => (
            <Tile
              key={`${g.hostId}:${g.id}`}
              shape="poster"
              title={g.title}
              subtitle={g.platform}
              image={g.art}
              badge={g.requiresKbm ? <span className="badge"><Icon name="keyboard" size="1em" /></span> : undefined}
              onSelect={() => hearth.openGame(g)}
            />
          ))}
        </Row>
      ) : null}

      {!hearth.isKid && dash.data?.favorites.length ? (
        <Row title="Quick controls">
          {dash.data.favorites.map((e) => (
            <EntityCard key={e.entity_id} entity={e} compact />
          ))}
        </Row>
      ) : null}
    </div>
  );
}
