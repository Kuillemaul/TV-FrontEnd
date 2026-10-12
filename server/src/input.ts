import { createReadStream, readFileSync, type ReadStream } from 'node:fs';
import type { HotkeyConfig } from './config.js';

/**
 * Linux input helpers:
 *  - parse /proc/bus/input/devices to tell whether a keyboard and mouse are plugged in
 *  - watch evdev devices for global "Home" keys so the remote/controller can always
 *    get back to Hearth, even while Plex, a browser or Moonlight has focus.
 */

export const KEY_CODES: Record<string, number> = {
  KEY_ESC: 1,
  KEY_A: 30,
  KEY_Z: 44,
  KEY_SPACE: 57,
  KEY_HOMEPAGE: 172,
  KEY_BACK: 158,
  KEY_EXIT: 174,
  KEY_MENU: 139,
  KEY_HOME: 102,
  KEY_TV: 0x179,
  KEY_VOICECOMMAND: 0x246,
  BTN_LEFT: 0x110,
  BTN_SOUTH: 0x130,
  BTN_SELECT: 0x13a,
  BTN_START: 0x13b,
  BTN_MODE: 0x13c,
};

const EV_KEY = 1;
const REL_X = 0;
const REL_Y = 1;
const EVENT_SIZE = 24; // struct input_event on 64-bit: timeval(16) + type(2) + code(2) + value(4)

export interface InputDevice {
  name: string;
  handlers: string[];
  keys: bigint;
  rel: bigint;
}

function bitmap(words: string | undefined): bigint {
  if (!words) return 0n;
  // Words are space-separated hex longs, most significant first.
  return words
    .trim()
    .split(/\s+/)
    .reduce((acc, w) => (acc << 64n) | BigInt(`0x${w}`), 0n);
}

const hasBit = (map: bigint, bit: number) => ((map >> BigInt(bit)) & 1n) === 1n;

export function parseDevices(text: string): InputDevice[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const get = (prefix: string, key?: string) => {
        for (const line of block.split('\n')) {
          if (!line.startsWith(prefix)) continue;
          const body = line.slice(prefix.length).trim();
          if (!key) return body;
          if (body.startsWith(`${key}=`)) return body.slice(key.length + 1);
        }
        return undefined;
      };
      return {
        name: (get('N:', 'Name') ?? '').replace(/^"|"$/g, ''),
        handlers: (get('H:', 'Handlers') ?? '').split(/\s+/).filter(Boolean),
        keys: bitmap(get('B:', 'KEY')),
        rel: bitmap(get('B:', 'REL')),
      };
    })
    .filter((d) => d.handlers.length > 0);
}

export function isKeyboard(d: InputDevice): boolean {
  return [KEY_CODES.KEY_A, KEY_CODES.KEY_Z, KEY_CODES.KEY_SPACE, KEY_CODES.KEY_ESC].every((k) => hasBit(d.keys, k));
}

export function isMouse(d: InputDevice): boolean {
  return hasBit(d.rel, REL_X) && hasBit(d.rel, REL_Y) && hasBit(d.keys, KEY_CODES.BTN_LEFT);
}

export function readDevices(): InputDevice[] {
  try {
    return parseDevices(readFileSync('/proc/bus/input/devices', 'utf8'));
  } catch {
    return [];
  }
}

export interface KbmStatus {
  keyboard: string | null;
  mouse: string | null;
  /** Game controllers, in the order the kernel lists them (≈ the order they were connected). */
  gamepads: string[];
}

// DualSense/DualShock also expose motion-sensor and touchpad devices; those aren't extra players.
const NOT_A_PLAYER = /motion sensors|touchpad|accelerometer|consumer control/i;

/** Joystick devices (js0, js1…) that are real controllers. */
export function gamepads(devices = readDevices()): string[] {
  return devices.filter((d) => d.handlers.some((h) => /^js\d+$/.test(h)) && !NOT_A_PLAYER.test(d.name)).map((d) => d.name);
}

/** Names of the first connected keyboard and mouse, and all controllers. */
export function kbmStatus(devices = readDevices()): KbmStatus {
  return {
    keyboard: devices.find(isKeyboard)?.name ?? null,
    mouse: devices.find(isMouse)?.name ?? null,
    gamepads: gamepads(devices),
  };
}

/** Watches input devices that expose any configured hotkey and calls onHome. */
export class HotkeyWatcher {
  private streams = new Map<string, ReadStream>();
  private timer?: NodeJS.Timeout;
  private codes: Map<number, number>;
  private warned = new Set<string>();

  constructor(
    hotkeys: HotkeyConfig[],
    private readonly onHome: () => void,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    this.codes = new Map(
      hotkeys
        .map((h) => [KEY_CODES[h.key] ?? Number(h.key), h.holdMs] as [number, number])
        .filter(([code]) => Number.isFinite(code)),
    );
  }

  start(): void {
    if (this.codes.size === 0 || process.platform !== 'linux') return;
    this.scan();
    // Controllers and remotes come and go; rescan for new devices.
    this.timer = setInterval(() => this.scan(), 5000);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const s of this.streams.values()) s.destroy();
    this.streams.clear();
  }

  private scan(): void {
    for (const dev of readDevices()) {
      const event = dev.handlers.find((h) => h.startsWith('event'));
      if (!event || this.streams.has(event)) continue;
      if (![...this.codes.keys()].some((c) => hasBit(dev.keys, c))) continue;
      this.watch(`/dev/input/${event}`, event, dev.name);
    }
  }

  private watch(path: string, event: string, name: string): void {
    const stream = createReadStream(path, { highWaterMark: EVENT_SIZE * 32 });
    this.streams.set(event, stream);
    const holds = new Map<number, NodeJS.Timeout>();
    let rest = Buffer.alloc(0);

    stream.on('open', () => this.log.info(`hotkeys: watching ${name} (${event})`));
    stream.on('data', (chunk) => {
      let buf = Buffer.concat([rest, chunk as Buffer]);
      while (buf.length >= EVENT_SIZE) {
        const type = buf.readUInt16LE(16);
        const code = buf.readUInt16LE(18);
        const value = buf.readInt32LE(20);
        buf = buf.subarray(EVENT_SIZE);
        if (type !== EV_KEY || !this.codes.has(code)) continue;
        const holdMs = this.codes.get(code)!;
        if (value === 1) {
          if (holdMs === 0) this.onHome();
          else holds.set(code, setTimeout(() => this.onHome(), holdMs));
        } else if (value === 0) {
          clearTimeout(holds.get(code));
          holds.delete(code);
        }
      }
      rest = buf;
    });
    stream.on('error', (err) => {
      if (!this.warned.has(event)) {
        this.warned.add(event);
        this.log.warn(`hotkeys: cannot read ${path} (${err.message}). Is the user in the "input" group?`);
      }
    });
    stream.on('close', () => this.streams.delete(event));
  }
}
