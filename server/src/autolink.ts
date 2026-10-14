import WebSocket from 'ws';
import { mediaBrowserAuth, mediaServerLogin, type MediaServerLogin } from './connect.js';

/**
 * Finishing the first-run setup of apps Hearth installed on this machine, so they're linked
 * without visiting their own web pages: the person picks a username and password on the TV.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(what: string, fn: () => Promise<T>, seconds = 90): Promise<T> {
  const end = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(2000);
    }
  }
  throw new Error(`${what}: ${(last as Error)?.message ?? 'no answer'}`);
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what} (HTTP ${res.status})`);
  return res;
}

/* ---------------------------------------------------------------- Jellyfin */

const LIBRARIES: Array<{ name: string; type: string; folder: string }> = [
  { name: 'Movies', type: 'movies', folder: 'movies' },
  { name: 'Shows', type: 'tvshows', folder: 'tv' },
  { name: 'Music', type: 'music', folder: 'music' },
];

/** Run Jellyfin's startup wizard: language, the admin account, then Movies/Shows/Music libraries. */
export async function setUpJellyfin(url: string, username: string, password: string): Promise<MediaServerLogin> {
  const headers = { 'Content-Type': 'application/json', Authorization: mediaBrowserAuth(), 'X-Emby-Authorization': mediaBrowserAuth() };
  const info = await retry('Jellyfin isn’t answering yet', async () => (await ok(await fetch(`${url}/System/Info/Public`), 'Jellyfin')).json() as Promise<{ StartupWizardCompleted?: boolean }>);
  if (!info.StartupWizardCompleted) {
    const lang = (process.env.LANG ?? 'en_US').split('.')[0];
    const [language, country] = lang.split('_');
    await ok(await fetch(`${url}/Startup/Configuration`, { method: 'POST', headers, body: JSON.stringify({ UICulture: `${language}-${country ?? 'US'}`, MetadataCountryCode: country ?? 'US', PreferredMetadataLanguage: language || 'en' }) }), 'Jellyfin settings');
    await ok(await fetch(`${url}/Startup/User`, { headers }), 'Jellyfin account');
    await ok(await fetch(`${url}/Startup/User`, { method: 'POST', headers, body: JSON.stringify({ Name: username, Password: password }) }), 'Jellyfin account');
    await ok(await fetch(`${url}/Startup/RemoteAccess`, { method: 'POST', headers, body: JSON.stringify({ EnableRemoteAccess: true, EnableAutomaticPortMapping: false }) }), 'Jellyfin network settings');
    await ok(await fetch(`${url}/Startup/Complete`, { method: 'POST', headers }), 'Finishing Jellyfin setup');
  }
  const login = await retry('Signing in to Jellyfin', () => mediaServerLogin(url, username, password), 30);
  const authed = { ...headers, Authorization: mediaBrowserAuth(login.token), 'X-Emby-Authorization': mediaBrowserAuth(login.token) };
  const existing = (await (await fetch(`${url}/Library/VirtualFolders`, { headers: authed })).json().catch(() => [])) as Array<{ Name: string }>;
  for (const lib of LIBRARIES) {
    if (existing.some((e) => e.Name === lib.name)) continue;
    const q = new URLSearchParams({ name: lib.name, collectionType: lib.type, refreshLibrary: 'true' });
    await fetch(`${url}/Library/VirtualFolders?${q}`, { method: 'POST', headers: authed, body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: `/media/${lib.folder}` }] } }) });
  }
  return login;
}

/* ---------------------------------------------------------------- Plex */

/** Add Movies and Shows libraries to a newly installed Plex Media Server (once it's claimed). */
export async function addPlexLibraries(url: string, token: string): Promise<void> {
  const sections = await retry(
    'Plex Media Server isn’t ready yet',
    async () => (await ok(await fetch(`${url}/library/sections?X-Plex-Token=${token}`, { headers: { Accept: 'application/json' } }), 'Plex')).json() as Promise<{ MediaContainer: { Directory?: Array<{ title: string }> } }>,
    120,
  );
  const have = new Set((sections.MediaContainer.Directory ?? []).map((d) => d.title));
  const libs = [
    { name: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', location: '/data/movies' },
    { name: 'TV Shows', type: 'show', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series', location: '/data/tv' },
    { name: 'Music', type: 'artist', agent: 'tv.plex.agents.music', scanner: 'Plex Music', location: '/data/music' },
  ];
  for (const lib of libs) {
    if (have.has(lib.name)) continue;
    const q = new URLSearchParams({ name: lib.name, type: lib.type, agent: lib.agent, scanner: lib.scanner, language: 'en-US', location: lib.location, 'X-Plex-Token': token });
    await fetch(`${url}/library/sections?${q}`, { method: 'POST' });
  }
}

/* ---------------------------------------------------------------- Home Assistant */

/**
 * Home Assistant's onboarding: create the owner account, accept the default location and
 * analytics choices, then make a long-lived token for Hearth.
 */
export async function setUpHomeAssistant(url: string, name: string, username: string, password: string): Promise<string> {
  const clientId = `${url}/`;
  const status = await retry('Home Assistant is still starting (this takes a minute or two the first time)', async () =>
    (await ok(await fetch(`${url}/api/onboarding`), 'Home Assistant')).json() as Promise<Array<{ step: string; done: boolean }>>,
  180);
  if (status.find((s) => s.step === 'user')?.done) throw new Error('Home Assistant already has an account. Link it with a token instead (Profile → Security → Long-lived tokens).');

  const user = (await (await ok(await fetch(`${url}/api/onboarding/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, name, username, password, language: 'en' }),
  }), 'Creating the Home Assistant account')).json()) as { auth_code: string };

  const tokens = (await (await ok(await fetch(`${url}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: user.auth_code, client_id: clientId }),
  }), 'Signing in to Home Assistant')).json()) as { access_token: string };
  const bearer = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' };
  // The remaining onboarding steps (best effort: older versions differ slightly).
  await fetch(`${url}/api/onboarding/core_config`, { method: 'POST', headers: bearer, body: '{}' }).catch(() => undefined);
  await fetch(`${url}/api/onboarding/analytics`, { method: 'POST', headers: bearer, body: '{}' }).catch(() => undefined);
  await fetch(`${url}/api/onboarding/integration`, { method: 'POST', headers: bearer, body: JSON.stringify({ client_id: clientId, redirect_uri: `${clientId}?auth_callback=1` }) }).catch(() => undefined);

  return longLivedToken(url, tokens.access_token);
}

function longLivedToken(url: string, accessToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/websocket`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Home Assistant didn’t make a token in time'));
    }, 15_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }));
      else if (msg.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'auth/long_lived_access_token', client_name: 'Hearth TV', lifespan: 3650 }));
      else if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.success) resolve(String(msg.result));
        else reject(new Error(msg.error?.message ?? 'Home Assistant refused to make a token'));
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('Home Assistant didn’t accept the sign-in'));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Home Assistant: ${err.message}`));
    });
  });
}
