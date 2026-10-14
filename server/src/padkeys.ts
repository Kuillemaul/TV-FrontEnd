import { createReadStream, type ReadStream } from 'node:fs';
import type { AppTile } from './config.js';
import { readDevices } from './input.js';

/**
 * Lets a game controller drive apps that only understand a keyboard (Plex HTPC, YouTube TV,
 * Netflix…): reads the controllers straight from /dev/input and types the matching keys
 * (via ydotool) into whatever app is on screen. Only runs while such an app is open, so it
 * never doubles up with Hearth's own controller support, Moonlight or Live TV.
 *
 *   D-pad / left stick → arrows    A → Enter    B / View → Esc (back)    X / Y → Space (play/pause)
 *
 * Pointer mode, for websites made for a mouse (Prime Video, Disney+…): the left stick moves the mouse
 * pointer (faster the further you push) and A clicks. The D-pad still sends arrow keys.
 */

const EV_KEY = 1;
const EV_ABS = 3;
const EVENT_SIZE = 24;

export const PAD_KEYS = { up: 103, down: 108, left: 105, right: 106, enter: 28, esc: 1, space: 57 } as const;
export const KEY_NAMES: Record<number, string> = { 103: 'KEY_UP', 108: 'KEY_DOWN', 105: 'KEY_LEFT', 106: 'KEY_RIGHT', 28: 'KEY_ENTER', 1: 'KEY_ESC', 57: 'KEY_SPACE' };

/** Apps get controller → key translation unless they read controllers themselves (Moonlight) or opt out. */
export function wantsControllerKeys(tile: AppTile): boolean {
  if (tile.controllerKeys !== undefined) return tile.controllerKeys;
  return !(tile.launch.type === 'command' && /moonlight/i.test(tile.launch.command.join(' ')));
}

/** Mouse-made websites get the stick as a pointer. TV-style web apps (a TV user agent, e.g. YouTube TV) and native apps don't. */
export function wantsPointer(tile: AppTile): boolean {
  if (tile.controllerPointer !== undefined) return tile.controllerPointer;
  return tile.launch.type === 'web' && !tile.launch.userAgent;
}

export interface Pointer {
  move(dx: number, dy: number): void;
  click(): void;
}

/** Pointer speed: pixels per tick at full tilt, ticks per second, and the stick's dead zone. */
const POINTER_MAX = 28;
const POINTER_HZ = 30;
const POINTER_DEAD = 0.18;

const BUTTONS: Record<number, number> = {
  0x130: PAD_KEYS.enter, // A / south
  0x131: PAD_KEYS.esc, // B / east
  0x133: PAD_KEYS.space, // X
  0x134: PAD_KEYS.space, // Y
  0x13a: PAD_KEYS.esc, // View / Select / Share
};
type Dir = 'up' | 'down' | 'left' | 'right';
const DPAD: Record<number, Dir> = { 0x220: 'up', 0x221: 'down', 0x222: 'left', 0x223: 'right' };

const ABS_X = 0;
const ABS_Y = 1;
const ABS_HAT0X = 0x10;
const ABS_HAT0Y = 0x11;
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 120;

/** Turns one controller's raw events into key presses, with auto-repeat for held directions. */
export class PadTranslator {
  private hat = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private dpad = new Set<Dir>();
  /** Per stick axis: centred at 0 (−32768…32767) or at 128 (0…255), decided from the first value seen. */
  private unsigned: Partial<Record<number, boolean>> = {};
  private held: Dir | null = null;
  private timer?: NodeJS.Timeout;
  /** Pointer mode: the left stick's position (−1…1) and the timer that moves the pointer while it's pushed. */
  private analog = { x: 0, y: 0 };
  private pointerTimer?: NodeJS.Timeout;

  constructor(
    private readonly press: (code: number) => void,
    private readonly pointer?: Pointer,
  ) {}

  handle(type: number, code: number, value: number): void {
    if (type === EV_KEY) {
      if (this.pointer && code === 0x130) {
        if (value === 1) this.pointer.click();
        return;
      }
      if (code in BUTTONS) {
        if (value === 1) this.press(BUTTONS[code]);
        return;
      }
      if (code in DPAD) {
        if (value) this.dpad.add(DPAD[code]);
        else this.dpad.delete(DPAD[code]);
        this.update();
      }
      return;
    }
    if (type !== EV_ABS) return;
    if (code === ABS_HAT0X) this.hat.x = Math.sign(value);
    else if (code === ABS_HAT0Y) this.hat.y = Math.sign(value);
    else if (code === ABS_X || code === ABS_Y) {
      this.unsigned[code] ??= value >= 100 && value <= 156;
      const v = this.unsigned[code] ? (value - 128) / 128 : value / 32768;
      if (this.pointer) {
        this.analog[code === ABS_X ? 'x' : 'y'] = Math.max(-1, Math.min(1, v));
        this.steer();
        return;
      }
      const axis = Math.abs(v) > 0.6 ? Math.sign(v) : 0;
      if (code === ABS_X) this.stick.x = axis;
      else this.stick.y = axis;
    } else return;
    this.update();
  }

  private direction(): Dir | null {
    const [first] = this.dpad;
    if (first) return first;
    const x = this.hat.x || this.stick.x;
    const y = this.hat.y || this.stick.y;
    if (y) return y < 0 ? 'up' : 'down';
    if (x) return x < 0 ? 'left' : 'right';
    return null;
  }

  private update(): void {
    const dir = this.direction();
    if (dir === this.held) return;
    clearTimeout(this.timer);
    this.held = dir;
    if (!dir) return;
    this.press(PAD_KEYS[dir]);
    const repeat = () => {
      this.press(PAD_KEYS[dir]);
      this.timer = setTimeout(repeat, REPEAT_EVERY_MS);
    };
    this.timer = setTimeout(repeat, REPEAT_DELAY_MS);
  }

  /** Pointer mode: move while the stick is outside the dead zone, speed growing with the square of the push. */
  private steer(): void {
    const pushed = Math.hypot(this.analog.x, this.analog.y) > POINTER_DEAD;
    if (!pushed) {
      clearInterval(this.pointerTimer);
      this.pointerTimer = undefined;
      return;
    }
    if (this.pointerTimer) return;
    const tick = () => {
      const speed = (v: number) => (Math.abs(v) < POINTER_DEAD ? 0 : Math.round(Math.sign(v) * v * v * POINTER_MAX));
      const dx = speed(this.analog.x);
      const dy = speed(this.analog.y);
      if (dx || dy) this.pointer!.move(dx, dy);
    };
    tick();
    this.pointerTimer = setInterval(tick, 1000 / POINTER_HZ);
  }

  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.pointerTimer);
    this.pointerTimer = undefined;
    this.held = null;
  }
}

export class ControllerKeys {
  private streams = new Map<string, { stream: ReadStream; pad: PadTranslator }>();
  private timer?: NodeJS.Timeout;
  private warned = new Set<string>();
  private pointerMode = false;

  constructor(
    private readonly press: (code: number) => void,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    private readonly pointer?: Pointer,
  ) {}

  get active(): boolean {
    return this.timer !== undefined;
  }

  /** pointer: the left stick moves the mouse and A clicks (websites made for a mouse). */
  start(pointer = false): void {
    if (this.active && pointer !== this.pointerMode) this.stop();
    if (this.active || process.platform !== 'linux') return;
    this.pointerMode = pointer;
    this.scan();
    this.timer = setInterval(() => this.scan(), 3000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const { stream, pad } of this.streams.values()) {
      pad.stop();
      stream.destroy();
    }
    this.streams.clear();
  }

  private scan(): void {
    for (const dev of readDevices()) {
      if (!dev.handlers.some((h) => /^js\d+$/.test(h)) || /motion sensors|touchpad/i.test(dev.name)) continue;
      const event = dev.handlers.find((h) => h.startsWith('event'));
      if (!event || this.streams.has(event)) continue;
      this.watch(event, dev.name);
    }
  }

  private watch(event: string, name: string): void {
    const path = `/dev/input/${event}`;
    const stream = createReadStream(path, { highWaterMark: EVENT_SIZE * 32 });
    const pad = new PadTranslator(this.press, this.pointerMode ? this.pointer : undefined);
    this.streams.set(event, { stream, pad });
    let rest = Buffer.alloc(0);
    stream.on('open', () => this.log.info(`controller keys: ${name} (${event})`));
    stream.on('data', (chunk) => {
      let buf = Buffer.concat([rest, chunk as Buffer]);
      while (buf.length >= EVENT_SIZE) {
        pad.handle(buf.readUInt16LE(16), buf.readUInt16LE(18), buf.readInt32LE(20));
        buf = buf.subarray(EVENT_SIZE);
      }
      rest = buf;
    });
    stream.on('error', (err) => {
      if (!this.warned.has(event)) {
        this.warned.add(event);
        this.log.warn(`controller keys: cannot read ${path} (${err.message})`);
      }
    });
    stream.on('close', () => {
      pad.stop();
      if (this.streams.get(event)?.stream === stream) this.streams.delete(event);
    });
  }
}
