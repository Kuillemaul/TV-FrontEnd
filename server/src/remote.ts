import { randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { StateStore } from './state.js';

export type RemoteCommand =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ok'
  | 'back'
  | 'home'
  | 'voice'
  | 'playpause'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'text';

/** Linux key names and codes (input-event-codes.h) for injecting remote presses into other apps (via ydotool). */
export const REMOTE_KEYS: Partial<Record<RemoteCommand, { key: string; code: number }>> = {
  up: { key: 'KEY_UP', code: 103 },
  down: { key: 'KEY_DOWN', code: 108 },
  left: { key: 'KEY_LEFT', code: 105 },
  right: { key: 'KEY_RIGHT', code: 106 },
  ok: { key: 'KEY_ENTER', code: 28 },
  back: { key: 'KEY_ESC', code: 1 },
  playpause: { key: 'KEY_SPACE', code: 57 },
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopback = (ip: string | undefined) => !ip || LOOPBACK.has(ip);

/**
 * Pairing for the phone remote. The TV shows a 4-digit code (rotates every 10 minutes);
 * the phone enters it once and gets a long-lived token cookie. Anything that isn't the TV
 * itself must present a paired token to use the API.
 */
export class RemotePairing {
  private code = '';
  private codeAt = 0;
  private misses = 0;

  constructor(private readonly state: StateStore) {}

  currentCode(): string {
    if (!this.code || Date.now() - this.codeAt > 10 * 60_000) {
      this.code = String(randomInt(0, 10000)).padStart(4, '0');
      this.codeAt = Date.now();
      this.misses = 0;
    }
    return this.code;
  }

  pair(code: string, label: string): string | null {
    if (!this.code || code !== this.code || Date.now() - this.codeAt > 10 * 60_000) {
      // Five wrong guesses burn the code, so a 4-digit code can't be brute-forced.
      if (++this.misses >= 5) this.code = '';
      return null;
    }
    const token = randomBytes(24).toString('base64url');
    this.state.addRemoteToken(token, label.slice(0, 40) || 'Phone');
    this.code = ''; // one use per code
    return token;
  }

  valid(token: string | undefined): boolean {
    return Boolean(token && this.state.remoteTokens[token]);
  }

  get paired(): number {
    return Object.keys(this.state.remoteTokens).length;
  }

  forgetAll(): void {
    this.state.clearRemoteTokens();
  }
}

/** First LAN IPv4 address, for the QR code on the TV. */
export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export function cookieToken(header: string | undefined): string | undefined {
  return header
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === 'hearth_remote')?.[1];
}
