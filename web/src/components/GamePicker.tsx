import { useMemo, useState } from 'react';
import { gameKey, useApi, type GameLibrary } from '../lib/api';
import { Icon } from './Icon';
import { Button, Chip, Modal } from './Layout';

const PAGE = 90;

/** Hand-pick the games a profile can see. Select a poster to tick/untick it. */
export function GamePicker({
  title,
  value,
  onChange,
  onClose,
}: {
  title: string;
  /** null = every game */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  onClose: () => void;
}) {
  const { data } = useApi<GameLibrary>('/api/games?all=1');
  const [query, setQuery] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // Local copy so ticking several games quickly never races the server round-trip.
  const [local, setLocal] = useState<string[] | null>(value);
  const picked = useMemo(() => new Set(local ?? []), [local]);
  const set = (next: string[] | null) => {
    setLocal(next);
    onChange(next);
  };

  const games = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.games ?? []).filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!onlyPicked || picked.has(gameKey(g))));
  }, [data, query, onlyPicked, picked]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set([...next]);
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="picker-bar" data-nav-group>
        <Chip active={local === null} onClick={() => set(local === null ? [] : null)}>
          {local === null ? '✓ ' : ''}All games
        </Chip>
        {local !== null ? (
          <Chip active={onlyPicked} onClick={() => setOnlyPicked(!onlyPicked)}>
            Picked ({picked.size})
          </Chip>
        ) : null}
        <label className="search">
          <Icon name="search" size="1.1em" />
          <input data-nav value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" />
        </label>
      </div>
      {local === null ? (
        <p className="modal-sub">This profile sees every game. Turn off “All games” to hand-pick.</p>
      ) : (
        <div className="picker-grid">
          {games.slice(0, limit).map((g) => {
            const key = gameKey(g);
            const on = picked.has(key);
            return (
              <button key={key} data-nav className={`pick ${on ? 'picked' : ''}`} onClick={() => toggle(key)}>
                <span className="pick-art">
                  <span className="pick-title">{g.title}</span>
                  {g.art ? <img src={g.art} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
                  <span className="pick-check">{on ? <Icon name="check" size="1.2em" /> : null}</span>
                </span>
                <span className="pick-meta">{g.platform}</span>
              </button>
            );
          })}
          {games.length > limit ? (
            <button data-nav className="pick pick-more" onClick={() => setLimit(limit + PAGE)}>
              <span className="pick-art">Show more ({games.length - limit})</span>
            </button>
          ) : null}
        </div>
      )}
      <div className="modal-actions">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
