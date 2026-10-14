import { useEffect, useState } from 'react';
import { post, useServerEvents, type Dashboard, type HaEntity } from '../lib/api';
import { Icon } from './Icon';

const call = (service: string, entity_id: string) => post('/api/ha/service', { domain: 'media_player', service, data: { entity_id } });

const isActive = (e: HaEntity) => e.entity_id.startsWith('media_player.') && (e.state === 'playing' || e.state === 'paused');

/**
 * What the house speakers are playing (Sonos, Spotify, any Home Assistant media player on the dashboard),
 * with previous / play-pause / next. Hidden when nothing is playing or paused.
 */
export function NowPlaying({ dash }: { dash: Dashboard | null }) {
  const [players, setPlayers] = useState<HaEntity[]>([]);

  useEffect(() => {
    if (!dash) return;
    const all = [...dash.favorites, ...dash.sections.flatMap((s) => s.entities)].filter((e) => e.entity_id.startsWith('media_player.'));
    setPlayers(all.filter((e, i) => all.findIndex((x) => x.entity_id === e.entity_id) === i));
  }, [dash]);

  useServerEvents((e) => {
    if (e.type !== 'ha-state' || !e.entity.entity_id.startsWith('media_player.')) return;
    setPlayers((list) => (list.some((p) => p.entity_id === e.entity.entity_id) ? list.map((p) => (p.entity_id === e.entity.entity_id ? e.entity : p)) : list));
  });

  // Playing first, then paused; one strip per player.
  const active = players.filter(isActive).sort((a, b) => Number(b.state === 'playing') - Number(a.state === 'playing'));
  if (!active.length) return null;

  return (
    <div className="now-playing-list">
      {active.slice(0, 2).map((p) => {
        const a = p.attributes;
        const title = String(a.media_title ?? 'Playing');
        const artist = [a.media_artist, a.media_album_name].filter(Boolean).join(' · ');
        const art = a.entity_picture && !dash?.demo ? `/api/ha/media-art/${p.entity_id}?t=${encodeURIComponent(title)}` : null;
        const playing = p.state === 'playing';
        return (
          <div className="now-playing" key={p.entity_id} data-nav-group>
            <div className="now-playing-art">
              {art ? <img src={art} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
              <Icon name="play" size="1.6em" />
            </div>
            <div className="now-playing-text">
              <div className="now-playing-title">{title}</div>
              <div className="now-playing-sub">
                {artist ? `${artist} · ` : ''}
                {String(a.friendly_name ?? p.entity_id)}
                {playing ? '' : ' · Paused'}
              </div>
            </div>
            <button className="now-playing-btn" data-nav aria-label="Previous" onClick={() => void call('media_previous_track', p.entity_id)}>
              <Icon name="prev" />
            </button>
            <button className="now-playing-btn now-playing-main" data-nav aria-label={playing ? 'Pause' : 'Play'} onClick={() => void call('media_play_pause', p.entity_id)}>
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button className="now-playing-btn" data-nav aria-label="Next" onClick={() => void call('media_next_track', p.entity_id)}>
              <Icon name="next" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
