import type { EventBus } from '../bus.js';
import type { DashboardSection } from '../config.js';
import type { HaEntity } from './homeassistant.js';

/** In-memory stand-in for Home Assistant so the Smart Home and Lab pages are explorable in demo mode. */
export class DemoHome {
  private states = new Map<string, HaEntity>();

  readonly dashboard: DashboardSection[] = [
    { title: 'Living Room', cards: ['light.living_room', 'light.tv_backlight', 'media_player.living_room', 'scene.movie_time'] },
    { title: 'Climate', cards: ['climate.thermostat', 'sensor.outdoor_temperature', 'sensor.indoor_humidity'] },
    { title: 'Security', cards: ['lock.front_door', 'binary_sensor.garage_door', 'cover.garage', 'camera.front_porch'] },
  ];
  readonly favorites = ['light.living_room', 'light.tv_backlight', 'scene.movie_time', 'lock.front_door'];
  readonly labSensors = ['sensor.proxmox_cpu', 'sensor.nas_disk_used', 'sensor.ups_load', 'sensor.internet_download'];
  readonly weather = 'weather.home';

  constructor(private readonly bus: EventBus) {
    const add = (entity_id: string, state: string, attributes: HaEntity['attributes']) =>
      this.states.set(entity_id, { entity_id, state, attributes });
    add('light.living_room', 'on', { friendly_name: 'Ceiling Lights', brightness: 180 });
    add('light.tv_backlight', 'off', { friendly_name: 'TV Backlight', brightness: 120 });
    add('media_player.living_room', 'playing', { friendly_name: 'Sonos', media_title: 'Lo-fi Beats' });
    add('scene.movie_time', 'scening', { friendly_name: 'Movie Time' });
    add('climate.thermostat', 'heat', { friendly_name: 'Thermostat', temperature: 70, current_temperature: 68, unit_of_measurement: '°F' });
    add('sensor.outdoor_temperature', '54', { friendly_name: 'Outside', unit_of_measurement: '°F' });
    add('sensor.indoor_humidity', '41', { friendly_name: 'Humidity', unit_of_measurement: '%' });
    add('lock.front_door', 'locked', { friendly_name: 'Front Door' });
    add('binary_sensor.garage_door', 'off', { friendly_name: 'Garage Sensor', device_class: 'garage_door' });
    add('cover.garage', 'closed', { friendly_name: 'Garage Door' });
    add('camera.front_porch', 'idle', { friendly_name: 'Front Porch' });
    add('sensor.proxmox_cpu', '23', { friendly_name: 'Proxmox CPU', unit_of_measurement: '%' });
    add('sensor.nas_disk_used', '61', { friendly_name: 'NAS Disk', unit_of_measurement: '%' });
    add('sensor.ups_load', '18', { friendly_name: 'UPS Load', unit_of_measurement: '%' });
    add('sensor.internet_download', '842', { friendly_name: 'Internet ↓', unit_of_measurement: 'Mbit/s' });
    add('weather.home', 'partlycloudy', { friendly_name: 'Home', temperature: 54, temperature_unit: '°F', humidity: 62 });
  }

  /** Every camera.* entity, for "show the garage camera". */
  cameras(): Array<{ id: string; name: string }> {
    return [...this.states.values()]
      .filter((e) => e.entity_id.startsWith('camera.'))
      .map((e) => ({ id: e.entity_id, name: String(e.attributes.friendly_name ?? e.entity_id.slice(7).replace(/_/g, ' ')) }));
  }

  byDomain(domains: string[]): HaEntity[] {
    return [...this.states.values()].filter((e) => domains.includes(e.entity_id.split('.')[0]));
  }

  entities(ids: string[]): HaEntity[] {
    return ids.map((id) => this.states.get(id) ?? { entity_id: id, state: 'unavailable', attributes: {} });
  }

  callService(domain: string, service: string, data: Record<string, unknown>): void {
    const id = String(data.entity_id ?? '');
    const e = this.states.get(id);
    if (!e) return;
    const flip: Record<string, string> = {
      turn_on: 'on', turn_off: 'off', lock: 'locked', unlock: 'unlocked',
      open_cover: 'open', close_cover: 'closed', media_pause: 'paused', media_play: 'playing',
    };
    let state = e.state;
    if (service === 'toggle') state = e.state === 'on' ? 'off' : 'on';
    else if (service === 'media_play_pause') state = e.state === 'playing' ? 'paused' : 'playing';
    else if (flip[service]) state = flip[service];
    const attributes = { ...e.attributes };
    if (service === 'set_temperature') attributes.temperature = data.temperature;
    if (data.brightness !== undefined) attributes.brightness = data.brightness;
    if (domain === 'scene') state = 'scening';
    const next = { ...e, state, attributes };
    this.states.set(id, next);
    this.bus.emit({ type: 'ha-state', entity: next });
  }
}
