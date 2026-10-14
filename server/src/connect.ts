import { createSocket } from 'node:dgram';
import { hostname } from 'node:os';

/**
 * Talking to the services Hearth links to, for the setup screen and Settings → Connections:
 * sign-ins, finding servers on the network, and checking an address + key works before saving it.
 * Every check throws an Error with a message fit to show on the TV.
 */

const TIMEOUT = 8000;
export const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

export function checkUrl(url: unknown, what = 'The address'): string {
  const s = trimUrl(String(url ?? ''));
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw new Error(`${what} should look like http://192.168.1.20:8096`);
  return s;
}

async function call(url: string, init: RequestInit = {}, what = 'It'): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new Error(`${what} didn’t answer at ${new URL(url).host}. Is the address right, and is it running?`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${what} said no: check the key, token or password`);
  if (!res.ok) throw new Error(`${what} answered with an error (HTTP ${res.status})`);
  return res;
}

/* ---------------------------------------------------------------- Plex */

const PLEX_HEADERS = { 'X-Plex-Product': 'Hearth', 'X-Plex-Client-Identifier': 'hearth-tv', 'X-Plex-Device-Name': 'Hearth', Accept: 'application/json' };

/** Start "sign in with Plex": show the code, the person enters it at plex.tv/link. */
export async function plexPinStart(): Promise<{ id: number; code: string; link: string }> {
  const res = await call('https://plex.tv/api/v2/pins?strong=false', { method: 'POST', headers: PLEX_HEADERS }, 'Plex');
  const pin = (await res.json()) as { id: number; code: string };
  return { id: pin.id, code: pin.code, link: 'https://plex.tv/link' };
}

/** The account token once the code has been entered, else null. */
export async function plexPinCheck(id: number): Promise<string | null> {
  const res = await call(`https://plex.tv/api/v2/pins/${id}`, { headers: PLEX_HEADERS }, 'Plex');
  const pin = (await res.json()) as { authToken?: string | null; expiresIn?: number };
  if (!pin.authToken && pin.expiresIn !== undefined && pin.expiresIn <= 0) throw new Error('That code expired. Get a new one.');
  return pin.authToken ?? null;
}

export interface PlexServer {
  name: string;
  url: string;
  token: string;
  local: boolean;
}

/** Plex Media Servers on this account, best address first (local, plain http). */
export async function plexServers(token: string): Promise<PlexServer[]> {
  const res = await call('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0', { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } }, 'Plex');
  const list = (await res.json()) as Array<{ name: string; provides: string; accessToken?: string; connections: Array<{ uri: string; local: boolean; protocol: string; address: string; port: number }> }>;
  const out: PlexServer[] = [];
  for (const r of list) {
    if (!r.provides.split(',').includes('server')) continue;
    const conns = [...r.connections].sort((a, b) => Number(b.local) - Number(a.local));
    const best = conns.find((c) => c.local) ?? conns[0];
    if (!best) continue;
    // A local plain-http address avoids certificate trouble on the home network.
    const url = best.local ? `http://${best.address}:${best.port}` : best.uri;
    out.push({ name: r.name, url, token: r.accessToken ?? token, local: best.local });
  }
  return out;
}

/** A claim code links a newly installed Plex Media Server to the account (valid 4 minutes). */
export async function plexClaimToken(token: string): Promise<string> {
  const res = await call('https://plex.tv/api/claim/token.json', { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } }, 'Plex');
  return ((await res.json()) as { token: string }).token;
}

export async function testPlex(url: string, token: string): Promise<{ name: string }> {
  const res = await call(`${url}/identity`, { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } }, 'Plex');
  const id = (await res.json()) as { MediaContainer?: { friendlyName?: string } };
  // /identity doesn't check the token; a library call does.
  await call(`${url}/library/sections`, { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } }, 'Plex');
  return { name: id.MediaContainer?.friendlyName ?? 'Plex' };
}

/* ---------------------------------------------------------------- Jellyfin / Emby */

const DEVICE_ID = `hearth-${hostname()}`;
export const mediaBrowserAuth = (token?: string) =>
  `MediaBrowser Client="Hearth", Device="Hearth TV", DeviceId="${DEVICE_ID}", Version="1.0"${token ? `, Token="${token}"` : ''}`;
const mbHeaders = (token?: string) => ({ Authorization: mediaBrowserAuth(token), 'X-Emby-Authorization': mediaBrowserAuth(token), 'Content-Type': 'application/json', Accept: 'application/json' });

/** Jellyfin (and Emby) servers that answer the network discovery broadcast. */
export function discoverMediaServers(waitMs = 1500): Promise<Array<{ name: string; url: string; id: string }>> {
  return new Promise((resolve) => {
    const found = new Map<string, { name: string; url: string; id: string }>();
    const sock = createSocket('udp4');
    const done = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found.values()]);
    };
    sock.on('error', done);
    sock.on('message', (msg) => {
      try {
        const r = JSON.parse(msg.toString()) as { Address: string; Id: string; Name: string };
        if (r.Address && r.Id) found.set(r.Id, { name: r.Name, url: trimUrl(r.Address), id: r.Id });
      } catch {
        /* not a server reply */
      }
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      for (const [text, port] of [['Who is JellyfinServer?', 7359], ['who is EmbyServer?', 7359]] as const) sock.send(text, port, '255.255.255.255');
      setTimeout(done, waitMs);
    });
  });
}

export async function mediaServerInfo(url: string): Promise<{ name: string; product: string }> {
  const res = await call(`${url}/System/Info/Public`, { headers: mbHeaders() }, 'The media server');
  const info = (await res.json()) as { ServerName?: string; ProductName?: string };
  return { name: info.ServerName ?? 'Media server', product: info.ProductName ?? 'Jellyfin Server' };
}

export interface MediaServerLogin {
  token: string;
  userId: string;
  userName: string;
}

export async function mediaServerLogin(url: string, username: string, password: string): Promise<MediaServerLogin> {
  const res = await call(`${url}/Users/AuthenticateByName`, { method: 'POST', headers: mbHeaders(), body: JSON.stringify({ Username: username, Pw: password }) }, 'The media server');
  const r = (await res.json()) as { AccessToken: string; User: { Id: string; Name: string } };
  return { token: r.AccessToken, userId: r.User.Id, userName: r.User.Name };
}

/** Jellyfin Quick Connect: show the code, approve it in any signed-in Jellyfin app. */
export async function quickConnectStart(url: string): Promise<{ code: string; secret: string }> {
  let res: Response;
  try {
    res = await call(`${url}/QuickConnect/Initiate`, { method: 'POST', headers: mbHeaders() }, 'Jellyfin');
  } catch (err) {
    if (/error \(HTTP (401|404)\)|said no/.test((err as Error).message)) throw new Error('Quick Connect is off on this server (Dashboard → General). Use your username and password instead.');
    throw err;
  }
  const r = (await res.json()) as { Code: string; Secret: string };
  return { code: r.Code, secret: r.Secret };
}

/** Signed in once the code was approved, else null. */
export async function quickConnectCheck(url: string, secret: string): Promise<MediaServerLogin | null> {
  const res = await call(`${url}/QuickConnect/Connect?secret=${encodeURIComponent(secret)}`, { headers: mbHeaders() }, 'Jellyfin');
  if (!((await res.json()) as { Authenticated: boolean }).Authenticated) return null;
  const auth = await call(`${url}/Users/AuthenticateWithQuickConnect`, { method: 'POST', headers: mbHeaders(), body: JSON.stringify({ Secret: secret }) }, 'Jellyfin');
  const r = (await auth.json()) as { AccessToken: string; User: { Id: string; Name: string } };
  return { token: r.AccessToken, userId: r.User.Id, userName: r.User.Name };
}

export async function testMediaServer(url: string, token: string): Promise<void> {
  await call(`${url}/Users/Me`, { headers: mbHeaders(token) }, 'The media server');
}

/* ---------------------------------------------------------------- the rest */

export async function testHomeAssistant(url: string, token: string): Promise<{ name: string }> {
  await call(`${url}/api/`, { headers: { Authorization: `Bearer ${token}` } }, 'Home Assistant');
  const res = await call(`${url}/api/config`, { headers: { Authorization: `Bearer ${token}` } }, 'Home Assistant');
  return { name: ((await res.json()) as { location_name?: string }).location_name ?? 'Home Assistant' };
}

export async function testTvheadend(url: string, username?: string, password?: string): Promise<{ name: string }> {
  const headers: Record<string, string> = username ? { Authorization: 'Basic ' + Buffer.from(`${username}:${password ?? ''}`).toString('base64') } : {};
  const res = await call(`${url}/api/serverinfo`, { headers }, 'Tvheadend');
  return { name: ((await res.json()) as { name?: string }).name ?? 'Tvheadend' };
}

const ARR_PATHS: Record<string, string> = {
  seerr: '/api/v1/settings/main',
  radarr: '/api/v3/system/status',
  sonarr: '/api/v3/system/status',
  lidarr: '/api/v1/system/status',
};
const ARR_NAMES: Record<string, string> = { seerr: 'Seerr', radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };

export async function testArr(kind: string, url: string, apiKey: string): Promise<void> {
  if (!ARR_PATHS[kind]) throw new Error('Unknown service');
  await call(`${url}${ARR_PATHS[kind]}`, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } }, ARR_NAMES[kind]);
}

/** The Hearth PC agent: /health answers anyone (gives the PC's name), /browse/sources checks the token. */
export async function testGamingAgent(agent: string, token: string): Promise<{ name: string }> {
  const res = await call(`${agent}/health`, {}, 'The PC (Hearth agent)');
  const r = (await res.json()) as { host?: string };
  await call(`${agent}/browse/sources`, { headers: { Authorization: `Bearer ${token}` } }, 'The PC (Hearth agent)');
  return { name: r.host ?? 'Gaming PC' };
}
