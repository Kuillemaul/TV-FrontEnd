import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { RequestsConfig } from './providers/seerr.js';

/** How a tile launches something on the TV. */
export type LaunchSpec =
  | { type: 'command'; command: string[]; env?: Record<string, string> }
  | { type: 'web'; url: string; userAgent?: string };

export interface AppTile {
  id: string;
  name: string;
  /** Brand colour used for the tile background. */
  color?: string;
  /** Optional logo image (URL or path served by the UI). */
  logo?: string;
  launch: LaunchSpec;
  /** Translate controller buttons into arrow/Enter/Esc key presses for this app (default on, off for Moonlight). */
  controllerKeys?: boolean;
}

export interface TvheadendConfig {
  url: string;
  username?: string;
  password?: string;
  /** Streaming profile, e.g. "pass" (untouched) or "matroska". */
  profile: string;
}

export interface LiveTvConfig {
  tvheadend?: TvheadendConfig;
  /** Player command; {playlist} and {index} are substituted. */
  player: string[];
  /** Player command for a single recording; {url} is substituted. */
  recordingPlayer: string[];
}

export type DashboardCard = string | { entity: string; name?: string };

export interface DashboardSection {
  title: string;
  cards: DashboardCard[];
}

export interface HomeAssistantConfig {
  url: string;
  token: string;
  /** Sections shown on the Smart Home page. */
  dashboard: DashboardSection[];
  /** Entities shown as quick toggles on the Home page. */
  favorites: string[];
  /** weather.* entity for the Home hero. */
  weather?: string;
  /** Full Lovelace dashboard to open in the kiosk browser. */
  lovelacePath?: string;
  voice: {
    /** Assist pipeline id; omit for the preferred pipeline. */
    pipeline?: string;
    language?: string;
    /** TTS engine entity (e.g. tts.piper) used to speak replies. Omit to stay silent. */
    ttsEngine?: string;
  };
}

export interface LabService {
  name: string;
  url: string;
  /** URL to health-check if different from url. */
  check?: string;
  /** Open the service in the kiosk browser when selected. */
  open?: boolean;
}

/** A Home Assistant service call, e.g. { service: "scene.turn_on", data: { entity_id: "scene.movie_time" } }. */
export interface ServiceCall {
  service: string;
  data?: Record<string, unknown>;
}

export interface LabAction {
  name: string;
  /** Call a Home Assistant service (e.g. button.press on a Proxmox/Portainer button). */
  ha?: ServiceCall;
  /** Or hit a URL (e.g. a Portainer/Unraid webhook). */
  http?: { url: string; method?: string; headers?: Record<string, string>; body?: string };
}

export interface LabConfig {
  services: LabService[];
  /** Home Assistant sensor entities shown as stats (CPU, disk, UPS…). */
  sensors: string[];
  /** One-button actions (restart a container/VM…). Parents only; asks for the PIN. */
  actions: LabAction[];
}

/** Lights/scenes that follow what's on screen ("movie time"). */
export interface SceneRule {
  name: string;
  /** Session ids to match: "app:plex", "livetv", "recording", "game:*", "app:*", "*". */
  match: string[];
  start?: ServiceCall;
  stop?: ServiceCall;
}

export interface AlertRule {
  entity: string;
  /** Fire when the entity changes to this state (and optionally from this one). */
  to?: string;
  from?: string;
  title: string;
  message?: string;
  camera?: string;
  seconds?: number;
}

export interface AlertsConfig {
  /** binary_sensor/event entity for the doorbell, and the camera to show. */
  doorbell?: { entity: string; camera?: string; seconds: number };
  rules: AlertRule[];
  /** Raise an alert when a lab service goes down. */
  labDown: boolean;
}

export interface TvControlConfig {
  /** Commands for the TV itself (HDMI-CEC via cec-ctl by default). {addr} = physical address. */
  commands: { on: string[]; off: string[]; hearth: string[]; input: string[] };
  /** Other HDMI devices, shown as app tiles that switch the TV input. */
  inputs: Array<{ id: string; name: string; physAddr: string; color?: string }>;
}

export interface GameHostConfig {
  id: string;
  name: string;
  /** Hearth PC agent base URL, e.g. http://192.168.1.50:47800 */
  agent: string;
  token: string;
  /** Host name / IP Moonlight should stream from. */
  moonlightHost: string;
  /** Sunshine app to stream (usually "Desktop"). */
  moonlightApp: string;
  /** MAC address for Wake-on-LAN. */
  mac?: string;
  /** Ask the agent to close the game when the stream ends. */
  quitOnExit: boolean;
  /**
   * Apollo (or any host that creates a virtual monitor when the stream connects): start the
   * stream first and have the agent wait for the virtual display before starting the game.
   */
  virtualDisplay: boolean;
  /** When you quit from inside the game, end the stream and return to Hearth. */
  endStreamOnGameExit: boolean;
  /** Cover the stream with a Hearth loading screen until the game is up (hides the PC desktop). */
  loadingScreen: boolean;
  /** Seconds to keep the loading screen after the game's process starts (its window needs a moment). */
  revealSeconds: number;
  /** End the session on the PC when the stream ends (Apollo: switches your monitors back on). */
  endSessionOnExit: boolean;
}

export interface GamingConfig {
  /** Moonlight command; {host} and {app} are substituted. */
  moonlight: string[];
  hosts: GameHostConfig[];
  /** Per-title overrides for keyboard/mouse requirement, keyed by "<hostId>:<gameId>" or title. */
  kbmOverrides: Record<string, boolean>;
}

export interface HotkeyConfig {
  /** Linux input key code name, e.g. KEY_HOMEPAGE or BTN_MODE. */
  key: string;
  /** Hold time before triggering (ms). 0 = on press. */
  holdMs: number;
}

export interface HearthConfig {
  server: { port: number; host: string };
  ui: { name: string; clock24h: boolean };
  /** Browser used for web apps; {url} and {profile} are substituted. */
  browser: string[];
  apps: AppTile[];
  livetv: LiveTvConfig;
  homeassistant?: HomeAssistantConfig;
  lab: LabConfig;
  /** The network editor (http://<tv>:<port>, home network only, no login). */
  admin: { enabled: boolean; port: number };
  /** Seerr for requests; Radarr/Sonarr/Lidarr for the download queue. */
  requests: RequestsConfig;
  gaming: GamingConfig;
  /** Global keys that close the foreground app and return to Hearth. */
  homeKeys: HotkeyConfig[];
  scenes: SceneRule[];
  alerts: AlertsConfig;
  tv: TvControlConfig;
  plex?: { url: string; token: string; webUrl?: string };
  screensaver: { idleMinutes: number; pickerAfterMinutes: number; photosDir?: string };
  remote: {
    /** Injects keys into apps (Plex, browser…) when the phone remote is used. {key} = Linux key name. */
    keyCommand: string[];
  };
  system: {
    volumeUp: string[];
    volumeDown: string[];
    mute: string[];
    suspend: string[];
    reboot: string[];
    poweroff: string[];
  };
  stateDir: string;
  /** True when no config file was found (or demo: true): sample data fills the empty sections. */
  demo: boolean;
  /** Untouched example entries that were skipped (see stripExamples). */
  ignoredExamples: string[];
}

const TV_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';

export const DEFAULT_APPS: AppTile[] = [
  { id: 'plex', name: 'Plex', color: '#e5a00d', launch: { type: 'command', command: ['flatpak', 'run', 'tv.plex.PlexHTPC'] } },
  { id: 'netflix', name: 'Netflix', color: '#e50914', launch: { type: 'web', url: 'https://www.netflix.com/browse' } },
  { id: 'youtube', name: 'YouTube', color: '#ff0033', launch: { type: 'web', url: 'https://www.youtube.com/tv', userAgent: TV_UA } },
  { id: 'disney', name: 'Disney+', color: '#113ccf', launch: { type: 'web', url: 'https://www.disneyplus.com' } },
  { id: 'prime', name: 'Prime Video', color: '#00a8e1', launch: { type: 'web', url: 'https://www.primevideo.com' } },
  { id: 'max', name: 'Max', color: '#002be7', launch: { type: 'web', url: 'https://play.max.com' } },
  { id: 'spotify', name: 'Spotify', color: '#1db954', launch: { type: 'web', url: 'https://open.spotify.com' } },
];

function defaults(): HearthConfig {
  return {
    server: { port: 8787, host: '127.0.0.1' },
    ui: { name: 'Living Room', clock24h: false },
    browser: [
      'google-chrome-stable',
      '--kiosk',
      '--app={url}',
      '--user-data-dir={profile}',
      '--ozone-platform-hint=auto',
      '--noerrdialogs',
      '--disable-session-crashed-bubble',
      '--autoplay-policy=no-user-gesture-required',
    ],
    apps: DEFAULT_APPS,
    livetv: {
      player: [
        'mpv', '--fs', '--force-window=immediate', '--title=Hearth Live TV',
        '--playlist={playlist}', '--playlist-start={index}',
      ],
      recordingPlayer: ['mpv', '--fs', '--force-window=immediate', '--title=Hearth Recording', '{url}'],
    },
    lab: { services: [], sensors: [], actions: [] },
    requests: {},
    admin: { enabled: true, port: 8780 },
    scenes: [],
    alerts: { rules: [], labDown: true },
    tv: {
      commands: {
        on: ['cec-ctl', '-d', '/dev/cec0', '--to', '0', '--image-view-on'],
        off: ['cec-ctl', '-d', '/dev/cec0', '--to', '0', '--standby'],
        hearth: ['cec-ctl', '-d', '/dev/cec0', '--playback', '--active-source', 'phys-addr={addr}'],
        input: ['cec-ctl', '-d', '/dev/cec0', '--to', '15', '--set-stream-path', 'phys-addr={addr}'],
      },
      inputs: [],
    },
    screensaver: { idleMinutes: 5, pickerAfterMinutes: 30 },
    remote: { keyCommand: ['ydotool', 'key', '{code}:1', '{code}:0'] },
    gaming: { moonlight: ['flatpak', 'run', 'com.moonlight_stream.Moonlight', 'stream', '{host}', '{app}'], hosts: [], kbmOverrides: {} },
    homeKeys: [
      { key: 'KEY_HOMEPAGE', holdMs: 0 },
      { key: 'BTN_MODE', holdMs: 1000 },
    ],
    system: {
      volumeUp: ['wpctl', 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '5%+'],
      volumeDown: ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '5%-'],
      mute: ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'],
      suspend: ['systemctl', 'suspend'],
      reboot: ['systemctl', 'reboot'],
      poweroff: ['systemctl', 'poweroff'],
    },
    stateDir: join(homedir(), '.local', 'state', 'hearth'),
    demo: true,
    ignoredExamples: [],
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normaliseHost(h: any, i: number): GameHostConfig {
  if (!h?.agent) throw new Error(`gaming.hosts[${i}] needs an "agent" URL`);
  const id = String(h.id ?? `host${i}`);
  return {
    id,
    name: String(h.name ?? id),
    agent: String(h.agent).replace(/\/$/, ''),
    token: String(h.token ?? ''),
    moonlightHost: String(h.moonlightHost ?? new URL(h.agent).hostname),
    moonlightApp: String(h.moonlightApp ?? 'Desktop'),
    mac: h.mac && !isPlaceholder(h.mac) ? String(h.mac) : undefined,
    quitOnExit: h.quitOnExit ?? true,
    virtualDisplay: h.virtualDisplay ?? false,
    endStreamOnGameExit: h.endStreamOnGameExit ?? true,
    loadingScreen: h.loadingScreen ?? true,
    revealSeconds: Number(h.revealSeconds ?? 5),
    endSessionOnExit: h.endSessionOnExit ?? true,
  };
}

export function resolveConfigPath(): string {
  // Relative to the repo (server/src or server/dist → ../../config), not the working directory,
  // because `npm start` runs from inside server/.
  return resolve(process.env.HEARTH_CONFIG ?? fileURLToPath(new URL('../../config/config.yaml', import.meta.url)));
}

/** Values in config.example.yaml that mean "not filled in yet". */
const PLACEHOLDER = /^(YOUR_|PASTE_|SAME_TOKEN|change-me$)|AA:BB:CC:DD/i;
export const isPlaceholder = (v: unknown) => typeof v === 'string' && PLACEHOLDER.test(v);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * config.yaml usually starts as a copy of config.example.yaml. Drop the example entries that were
 * never changed (the sample Proxmox, washer alert, Xbox input…) so they don't show up as broken
 * tiles. Anything you edited, even slightly, is kept.
 */
export function stripExamples(raw: any, example: any): string[] {
  const dropped: string[] = [];
  const lists: Array<[string, (r: any) => any[] | undefined, (r: any, v: any[]) => void]> = [
    ['lab.services', (r) => r.lab?.services, (r, v) => (r.lab.services = v)],
    ['lab.sensors', (r) => r.lab?.sensors, (r, v) => (r.lab.sensors = v)],
    ['lab.actions', (r) => r.lab?.actions, (r, v) => (r.lab.actions = v)],
    ['scenes', (r) => r.scenes, (r, v) => (r.scenes = v)],
    ['alerts.rules', (r) => r.alerts?.rules, (r, v) => (r.alerts.rules = v)],
    ['tv.inputs', (r) => r.tv?.inputs, (r, v) => (r.tv.inputs = v)],
    ['gaming.hosts', (r) => r.gaming?.hosts, (r, v) => (r.gaming.hosts = v)],
    ['homeassistant.favorites', (r) => r.homeassistant?.favorites, (r, v) => (r.homeassistant.favorites = v)],
    ['homeassistant.dashboard', (r) => r.homeassistant?.dashboard, (r, v) => (r.homeassistant.dashboard = v)],
  ];
  for (const [name, get, set] of lists) {
    const mine = get(raw);
    const theirs = get(example);
    if (!Array.isArray(mine) || !Array.isArray(theirs)) continue;
    const kept = mine.filter((x) => !theirs.some((e) => same(e, x)));
    if (kept.length !== mine.length) dropped.push(`${name} (${mine.length - kept.length})`);
    set(raw, kept);
  }
  if (raw.alerts?.doorbell && same(raw.alerts.doorbell, example.alerts?.doorbell)) {
    delete raw.alerts.doorbell;
    dropped.push('alerts.doorbell');
  }
  const kbm = raw.gaming?.kbmOverrides;
  if (kbm && example.gaming?.kbmOverrides) {
    for (const [k, v] of Object.entries(example.gaming.kbmOverrides)) {
      if (kbm[k] === v) {
        delete kbm[k];
        dropped.push(`gaming.kbmOverrides "${k}"`);
      }
    }
  }
  return dropped;
}

export function loadConfig(path = resolveConfigPath()): HearthConfig {
  const cfg = defaults();
  if (!existsSync(path)) return cfg;

  const raw: any = parse(readFileSync(path, 'utf8')) ?? {};
  const examplePath = join(dirname(path), 'config.example.yaml');
  if (existsSync(examplePath) && resolve(examplePath) !== resolve(path)) {
    try {
      cfg.ignoredExamples = stripExamples(raw, parse(readFileSync(examplePath, 'utf8')) ?? {});
    } catch {
      /* example unreadable: use the config as is */
    }
  }
  cfg.demo = Boolean(raw.demo ?? false);
  Object.assign(cfg.server, raw.server);
  Object.assign(cfg.ui, raw.ui);
  if (Array.isArray(raw.browser)) cfg.browser = raw.browser;
  if (Array.isArray(raw.apps)) cfg.apps = raw.apps;
  if (raw.stateDir) cfg.stateDir = raw.stateDir;
  if (Array.isArray(raw.homeKeys)) cfg.homeKeys = raw.homeKeys.map((k: any) => ({ key: String(k.key), holdMs: Number(k.holdMs ?? 0) }));
  Object.assign(cfg.system, raw.system);

  if (raw.livetv) {
    if (Array.isArray(raw.livetv.player)) cfg.livetv.player = raw.livetv.player;
    if (Array.isArray(raw.livetv.recordingPlayer)) cfg.livetv.recordingPlayer = raw.livetv.recordingPlayer;
    if (raw.livetv.tvheadend?.url) {
      cfg.livetv.tvheadend = {
        url: String(raw.livetv.tvheadend.url).replace(/\/$/, ''),
        username: raw.livetv.tvheadend.username,
        password: raw.livetv.tvheadend.password,
        profile: raw.livetv.tvheadend.profile ?? 'pass',
      };
    }
  }

  const ha = raw.homeassistant;
  if (ha?.url && ha?.token && !isPlaceholder(ha.token)) {
    cfg.homeassistant = {
      url: String(ha.url).replace(/\/$/, ''),
      token: String(ha.token),
      dashboard: Array.isArray(ha.dashboard) ? ha.dashboard : [],
      favorites: Array.isArray(ha.favorites) ? ha.favorites : [],
      weather: ha.weather,
      lovelacePath: ha.lovelacePath,
      voice: { ...(ha.voice ?? {}) },
    };
  }

  if (raw.lab) {
    cfg.lab.services = Array.isArray(raw.lab.services) ? raw.lab.services : [];
    cfg.lab.sensors = Array.isArray(raw.lab.sensors) ? raw.lab.sensors : [];
    cfg.lab.actions = Array.isArray(raw.lab.actions) ? raw.lab.actions : [];
  }
  if (raw.admin) cfg.admin = { enabled: raw.admin.enabled ?? true, port: Number(raw.admin.port ?? 8780) };
  if (raw.requests) {
    for (const k of ['seerr', 'radarr', 'sonarr', 'lidarr'] as const) {
      const svc = raw.requests[k];
      if (svc?.url && svc?.apiKey && !isPlaceholder(svc.apiKey)) {
        cfg.requests[k] = { url: String(svc.url).replace(/\/(login)?\/?$/, ''), apiKey: String(svc.apiKey) };
      }
    }
    if (['all', 'requested', 'off'].includes(raw.requests.notify)) cfg.requests.notify = raw.requests.notify;
  }
  if (Array.isArray(raw.scenes)) cfg.scenes = raw.scenes;
  if (raw.alerts) {
    cfg.alerts = {
      doorbell: raw.alerts.doorbell?.entity ? { seconds: 30, ...raw.alerts.doorbell } : undefined,
      rules: Array.isArray(raw.alerts.rules) ? raw.alerts.rules : [],
      labDown: raw.alerts.labDown ?? true,
    };
  }
  if (raw.tv) {
    Object.assign(cfg.tv.commands, raw.tv.commands);
    cfg.tv.inputs = (raw.tv.inputs ?? []).map((x: any, i: number) => ({ id: x.id ?? `input${i}`, ...x }));
  }
  if (raw.plex?.url && raw.plex?.token && !isPlaceholder(raw.plex.token)) cfg.plex = { url: String(raw.plex.url).replace(/\/$/, ''), token: raw.plex.token, webUrl: raw.plex.webUrl };
  Object.assign(cfg.screensaver, raw.screensaver);
  if (Array.isArray(raw.remote?.keyCommand)) cfg.remote.keyCommand = raw.remote.keyCommand;

  if (raw.gaming) {
    if (Array.isArray(raw.gaming.moonlight)) cfg.gaming.moonlight = raw.gaming.moonlight;
    // A PC whose token was never filled in can't be talked to; leave it out until it is.
    cfg.gaming.hosts = (raw.gaming.hosts ?? []).filter((h: any) => !isPlaceholder(h?.token)).map(normaliseHost);
    cfg.gaming.kbmOverrides = raw.gaming.kbmOverrides ?? {};
  }

  return cfg;
}

/** Replace {placeholders} in every argument of a command template. */
export function expand(template: string[], vars: Record<string, string | number>): string[] {
  return template.map((arg) => arg.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
}
