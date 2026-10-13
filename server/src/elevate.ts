import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Requests from the network admin editor run "elevated": they act as a parent whatever profile
 * is on the TV (a kid's profile being active mustn't stop you editing it from your laptop).
 */
const store = new AsyncLocalStorage<boolean>();

export const runElevated = <T>(fn: () => T): T => store.run(true, fn);
export const isElevated = (): boolean => store.getStore() === true;

/** The editor marks the requests it passes on with this header; the secret never leaves the process. */
export const ELEVATE_HEADER = 'x-hearth-elevated';
export const ELEVATE_SECRET = randomBytes(24).toString('hex');

/** First hook on the main server: requests from the editor run the rest of their life elevated. */
export function installElevation(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.headers[ELEVATE_HEADER] === ELEVATE_SECRET) store.run(true, done);
    else done();
  });
}

/** Home-network addresses only: loopback, RFC 1918, link-local, IPv6 unique/link-local. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}
