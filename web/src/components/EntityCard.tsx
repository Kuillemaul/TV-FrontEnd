import { useEffect, useState } from 'react';
import { post, type HaEntity } from '../lib/api';
import { Icon } from './Icon';

const call = (domain: string, service: string, data: Record<string, unknown>) => post('/api/ha/service', { domain, service, data });

const DOMAIN_ICON: Record<string, string> = {
  light: 'bulb',
  switch: 'power',
  fan: 'power',
  input_boolean: 'power',
  climate: 'thermometer',
  lock: 'lock',
  camera: 'camera',
  media_player: 'play',
  scene: 'play',
  script: 'play',
  button: 'play',
  cover: 'home',
  weather: 'cloud',
};

function iconFor(e: HaEntity, domain: string): string {
  if (domain === 'sensor') return /°|temp/i.test(`${e.attributes.unit_of_measurement ?? ''}${e.attributes.device_class ?? ''}`) ? 'thermometer' : 'server';
  if (domain === 'binary_sensor') return /door|garage|window/.test(String(e.attributes.device_class ?? '')) ? 'home' : 'server';
  return DOMAIN_ICON[domain] ?? 'bulb';
}

const ACTIVE_STATES = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'heat', 'cool', 'heat_cool', 'auto']);

function primaryAction(e: HaEntity): (() => void) | null {
  const [domain] = e.entity_id.split('.');
  const entity_id = e.entity_id;
  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan':
    case 'input_boolean':
    case 'automation':
      return () => call(domain, 'toggle', { entity_id });
    case 'scene':
    case 'script':
      return () => call(domain, 'turn_on', { entity_id });
    case 'button':
    case 'input_button':
      return () => call(domain, 'press', { entity_id });
    case 'lock':
      return () => call('lock', e.state === 'locked' ? 'unlock' : 'lock', { entity_id });
    case 'cover':
      return () => call('cover', 'toggle', { entity_id });
    case 'media_player':
      return () => call('media_player', 'media_play_pause', { entity_id });
    default:
      return null;
  }
}

function describe(e: HaEntity): string {
  const [domain] = e.entity_id.split('.');
  const a = e.attributes;
  if (e.state === 'unavailable') return 'Unavailable';
  switch (domain) {
    case 'light':
      return e.state === 'on' && typeof a.brightness === 'number' ? `On · ${Math.round((a.brightness / 255) * 100)}%` : cap(e.state);
    case 'climate':
      return `${a.current_temperature ?? '–'}° → ${a.temperature ?? '–'}° · ${cap(e.state)}`;
    case 'media_player':
      return a.media_title ? `${cap(e.state)} · ${a.media_title}` : cap(e.state);
    case 'scene':
    case 'script':
    case 'button':
      return 'Activate';
    case 'binary_sensor':
      return a.device_class === 'garage_door' || a.device_class === 'door' || a.device_class === 'window'
        ? e.state === 'on' ? 'Open' : 'Closed'
        : e.state === 'on' ? 'Detected' : 'Clear';
    case 'weather':
      return `${a.temperature ?? '–'}${a.temperature_unit ?? '°'} · ${cap(e.state.replace('partlycloudy', 'partly cloudy'))}`;
    default:
      return a.unit_of_measurement ? `${e.state} ${a.unit_of_measurement}` : cap(e.state);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export function EntityCard({ entity, compact }: { entity: HaEntity; compact?: boolean }) {
  const [domain] = entity.entity_id.split('.');
  const name = entity.attributes.friendly_name ?? entity.entity_id;
  const action = primaryAction(entity);
  const active = ACTIVE_STATES.has(entity.state) || (domain === 'lock' && entity.state === 'unlocked');

  if (domain === 'camera') return <CameraCard entity={entity} />;

  return (
    <div className={`entity ${active ? 'entity-active' : ''} ${compact ? 'entity-compact' : ''}`}>
      <button
        className="entity-main"
        data-nav
        data-pin={JSON.stringify({ kind: 'entity', id: entity.entity_id, name: entity.attributes.friendly_name })}
        onClick={action ?? undefined}
        aria-disabled={!action}
      >
        <span className="entity-icon">
          <Icon name={iconFor(entity, domain)} size="1.6em" />
        </span>
        <span className="entity-text">
          <span className="entity-name">{name}</span>
          <span className="entity-state">{describe(entity)}</span>
        </span>
      </button>
      {!compact && domain === 'light' ? (
        <div className="entity-steppers">
          <button data-nav onClick={() => call('light', 'turn_on', { entity_id: entity.entity_id, brightness_step_pct: -20 })}>−</button>
          <button data-nav onClick={() => call('light', 'turn_on', { entity_id: entity.entity_id, brightness_step_pct: 20 })}>+</button>
        </div>
      ) : null}
      {!compact && domain === 'climate' ? (
        <div className="entity-steppers">
          <button data-nav onClick={() => call('climate', 'set_temperature', { entity_id: entity.entity_id, temperature: Number(entity.attributes.temperature) - 1 })}>−</button>
          <button data-nav onClick={() => call('climate', 'set_temperature', { entity_id: entity.entity_id, temperature: Number(entity.attributes.temperature) + 1 })}>+</button>
        </div>
      ) : null}
    </div>
  );
}

function CameraCard({ entity }: { entity: HaEntity }) {
  const [tick, setTick] = useState(Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="entity entity-camera">
      <button className="entity-main" data-nav onClick={() => setTick(Date.now())}>
        {failed ? (
          <span className="camera-placeholder">
            <Icon name="camera" size="2.4em" />
          </span>
        ) : (
          <img src={`/api/ha/camera/${entity.entity_id}?t=${tick}`} alt="" onError={() => setFailed(true)} onLoad={() => setFailed(false)} />
        )}
        <span className="entity-name camera-name">{entity.attributes.friendly_name ?? entity.entity_id}</span>
      </button>
    </div>
  );
}
