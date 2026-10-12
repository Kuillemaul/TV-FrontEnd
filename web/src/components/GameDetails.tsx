import { useEffect, useState } from 'react';
import { formatMinutes, get, useApi, type Game, type GameDetails as Details, type KbmStatus } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Icon } from './Icon';
import { Button, Chip, Modal } from './Layout';

const RATING_LABEL: Record<string, string> = { E: 'Everyone', E10: 'Everyone 10+', T: 'Teen', M: 'Mature 17+' };

export function RatingBadge({ rating }: { rating: Game['rating'] }) {
  if (!rating) return null;
  return (
    <span className={`rating rating-${rating.toLowerCase()}`} title={RATING_LABEL[rating]}>
      {rating === 'E10' ? 'E10+' : rating}
    </span>
  );
}

/** Screenshot, description and play time, shown before a game starts. */
export function GameDetailsModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const hearth = useHearth();
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [shot, setShot] = useState(0);
  // Emulated games: how many controllers to set up. Starts at the number connected to the TV.
  const emulated = game.platform !== 'PC' && !/windows|ms-dos|pc \(/i.test(game.platform);
  const input = useApi<KbmStatus>(emulated ? '/api/system/input' : null, 3000);
  const connected = Math.max(1, Math.min(4, input.data?.gamepads.length ?? 1));
  const [players, setPlayers] = useState<number | null>(null);
  const chosenPlayers = players ?? connected;

  useEffect(() => {
    get<Details>(`/api/games/${encodeURIComponent(game.hostId)}/details/${encodeURIComponent(game.id)}`)
      .then(setD)
      .catch(() => setError('Details aren’t available while the PC is asleep.'));
  }, [game.hostId, game.id]);

  const info = d ?? game;
  const backdrop = d?.screenshots[shot];
  const play = () => {
    onClose();
    hearth.playGame({
      hostId: game.hostId,
      gameId: game.id,
      title: game.title,
      requiresKbm: game.requiresKbm,
      art: game.art,
      players: emulated ? chosenPlayers : undefined,
    });
  };
  const playedLib = d?.libraryPlaytimeMinutes ?? 0;
  const playedHearth = d?.hearthPlaytimeMinutes ?? 0;

  return (
    <Modal title={info.title} onClose={onClose} wide>
      <div className="details">
        <div className="details-backdrop">
          {backdrop ? <img src={backdrop} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
        </div>
        <div className="details-body">
          <div className="details-poster">
            <span className="tile-poster-title">{info.title}</span>
            {info.art ? <img src={info.art} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
          </div>
          <div className="details-text">
            <div className="details-meta">
              <RatingBadge rating={info.rating} />
              <span>{info.store || info.platform}</span>
              {d?.year ? <span>{d.year}</span> : null}
              {d?.genres.length ? <span>{d.genres.join(' · ')}</span> : null}
              <span>{info.hostName}</span>
            </div>
            <div className="details-badges">
              {info.requiresKbm ? (
                <span className="badge badge-kbm">
                  <Icon name="keyboard" size="1em" /> Keyboard & mouse
                </span>
              ) : info.controller === 'full' ? (
                <span className="badge">
                  <Icon name="gamepad" size="1em" /> Controller
                </span>
              ) : null}
              {!info.installed ? <span className="badge badge-warn">Not installed</span> : null}
            </div>
            <p className="details-desc">{d ? d.description || 'No description yet.' : error || 'Loading…'}</p>
            {playedLib || playedHearth ? (
              <div className="details-played">
                Played {formatMinutes(Math.max(playedLib, playedHearth))}
                {playedHearth ? <span> · {formatMinutes(playedHearth)} on this TV</span> : null}
              </div>
            ) : null}
            {emulated ? (
              <div className="details-players" data-nav-group>
                <span className="modal-sub">
                  Players{input.data ? ` · ${input.data.gamepads.length} controller${input.data.gamepads.length === 1 ? '' : 's'} connected` : ''}
                </span>
                {[1, 2, 3, 4].map((n) => (
                  <Chip key={n} active={chosenPlayers === n} onClick={() => setPlayers(n)}>
                    {n}
                  </Chip>
                ))}
              </div>
            ) : null}
            <div className="modal-actions" data-nav-group>
              <Button variant="primary" icon="play" onClick={play} autoFocus>
                {info.installed ? 'Play' : 'Install & play'}
              </Button>
              {d && d.screenshots.length > 1 ? (
                <Button icon="camera" onClick={() => setShot((shot + 1) % d.screenshots.length)}>
                  Screenshot {shot + 1}/{d.screenshots.length}
                </Button>
              ) : null}
              <Button onClick={onClose}>Close</Button>
            </div>
            {!info.installed ? <p className="modal-sub">Playnite will install it on {info.hostName} first; the TV shows the PC so you can follow along.</p> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
