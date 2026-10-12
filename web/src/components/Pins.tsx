import { useMemo } from 'react';
import { pinKey, useApi, useServerEvents, type AppTile, type GameLibrary, type HaEntity, type Pin } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { EntityCard } from './EntityCard';
import { Icon } from './Icon';
import { Button, Modal, Row, Tile } from './Layout';

/** The pin carried by an element (or its tile), set with data-pin. */
export function pinOf(el: Element | null): Pin | null {
  const raw = el?.closest('[data-pin]')?.getAttribute('data-pin');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pin;
  } catch {
    return null;
  }
}

/** X / Menu / right-click on a tile: pin it to Home, or unpin and reorder on Home. */
export function PinMenu({ pin, label, onClose }: { pin: Pin; label?: string; onClose: () => void }) {
  const hearth = useHearth();
  const pins = hearth.profile?.pins ?? [];
  const key = pinKey(pin);
  const index = pins.findIndex((p) => pinKey(p) === key);
  const pinned = index >= 0;
  const name = pin.kind === 'game' ? pin.title : pin.kind === 'channel' ? pin.name : pin.kind === 'entity' ? (pin.name ?? pin.id) : (label ?? 'This app');
  const act = (fn: () => Promise<void>) => void fn().then(onClose);

  return (
    <Modal title={name} onClose={onClose}>
      <div className="modal-actions modal-actions-column" data-nav-group>
        <Button variant="primary" icon={pinned ? 'x' : 'pin'} autoFocus onClick={() => act(() => hearth.togglePin(pin))}>
          {pinned ? 'Remove from Home' : 'Pin to Home'}
        </Button>
        {pinned && index > 0 ? (
          <Button icon="left" onClick={() => act(() => hearth.movePin(key, -1))}>Move left</Button>
        ) : null}
        {pinned && index < pins.length - 1 ? (
          <Button icon="right" onClick={() => act(() => hearth.movePin(key, 1))}>Move right</Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

/** The "Pinned" row at the top of Home. */
export function PinnedRow({ apps, library }: { apps: AppTile[] | null; library: GameLibrary | null }) {
  const hearth = useHearth();
  const pins = hearth.profile?.pins ?? [];
  const entityIds = pins.filter((p) => p.kind === 'entity').map((p) => p.id);
  const ents = useApi<HaEntity[]>(entityIds.length && !hearth.isKid ? `/api/ha/entities?ids=${encodeURIComponent(entityIds.join(','))}` : null);
  useServerEvents((e) => {
    if (e.type === 'ha-state' && ents.data?.some((x) => x.entity_id === e.entity.entity_id)) {
      ents.setData(ents.data.map((x) => (x.entity_id === e.entity.entity_id ? e.entity : x)));
    }
  });

  const tiles = useMemo(
    () =>
      pins.flatMap((pin) => {
        const key = pinKey(pin);
        if (pin.kind === 'app') {
          // Only apps this profile can open.
          const a = apps?.find((x) => x.id === pin.id);
          return a ? [<Tile key={key} pin={pin} shape="app" title={a.name} color={a.color} image={a.logo} onSelect={() => hearth.launchApp(a.id)} />] : [];
        }
        if (pin.kind === 'game') {
          const g = library?.games.find((x) => x.hostId === pin.hostId && x.id === pin.gameId);
          if (library && !g && hearth.isKid) return [];
          return [
            <Tile
              key={key}
              pin={pin}
              shape="poster"
              title={g?.title ?? pin.title}
              image={g?.art ?? pin.art}
              badge={g?.requiresKbm ? <span className="badge"><Icon name="keyboard" size="1em" /></span> : undefined}
              onSelect={() =>
                g ? hearth.openGame(g) : hearth.playGame({ hostId: pin.hostId, gameId: pin.gameId, title: pin.title, requiresKbm: false, art: pin.art })
              }
            />,
          ];
        }
        if (pin.kind === 'channel') {
          if (hearth.profile && !hearth.profile.liveTv) return [];
          return [<Tile key={key} pin={pin} shape="app" title={pin.name} icon="tv" color="#2b3cff" onSelect={() => hearth.watchChannel(pin.id)} />];
        }
        const e = ents.data?.find((x) => x.entity_id === pin.id);
        return e ? [<EntityCard key={key} entity={e} compact />] : [];
      }),
    [pins, apps, library, ents.data, hearth],
  );

  if (!tiles.length) return null;
  return <Row title="Pinned">{tiles}</Row>;
}
