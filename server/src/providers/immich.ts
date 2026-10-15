/* eslint-disable @typescript-eslint/no-explicit-any */

/** Immich's background jobs that use a lot of CPU, GPU or disk (paused while the TV is busy). */
export const HEAVY_QUEUES = [
  'thumbnailGeneration',
  'metadataExtraction',
  'videoConversion',
  'faceDetection',
  'facialRecognition',
  'smartSearch',
  'duplicateDetection',
  'sidecar',
  'library',
  'ocr',
];

/** Immich (photos): linking, pointing its machine learning at another PC, and pausing its heavy jobs. */
export class ImmichClient {
  constructor(private readonly cfg: { url: string; apiKey: string }) {}

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.cfg.url}/api${path}`, {
      ...init,
      headers: { 'x-api-key': this.cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error(`Immich didn’t answer at ${new URL(this.cfg.url).host}. Is the address right, and is it running?`);
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Immich said no: check the API key (from an admin account)'), { status: res.status });
    if (!res.ok) throw Object.assign(new Error(`Immich ${path}: HTTP ${res.status}`), { status: res.status });
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  /** Checks the key works (and is an admin's: the job and settings calls need that). */
  async test(): Promise<{ name: string }> {
    const me = await this.api('/users/me');
    if (me?.isAdmin === false) throw new Error('Use an API key from an Immich admin account');
    const about = await this.api('/server/about').catch(() => null);
    return { name: `Immich${about?.version ? ` ${about.version}` : ''}` };
  }

  /**
   * Where face recognition and smart search run: the first address that answers is used, so a
   * gaming PC can go first with this machine's own container as the fallback.
   */
  async setMachineLearning(urls: string[]): Promise<void> {
    const config = await this.api('/system-config');
    const ml = config.machineLearning ?? {};
    if ('urls' in ml) ml.urls = urls;
    else ml.url = urls[0];
    ml.enabled = true;
    config.machineLearning = ml;
    await this.api('/system-config', { method: 'PUT', body: JSON.stringify(config) });
  }

  /** Pause or resume the heavy queues. Queues an older/newer Immich doesn't have are skipped. */
  async setPaused(paused: boolean): Promise<void> {
    for (const name of HEAVY_QUEUES) {
      try {
        await this.api(`/jobs/${name}`, { method: 'PUT', body: JSON.stringify({ command: paused ? 'pause' : 'resume', force: false }) });
      } catch (err) {
        // Newer Immich: queues have their own endpoint.
        if ((err as { status?: number }).status === 404) {
          await this.api(`/queues/${name}`, { method: 'PUT', body: JSON.stringify({ isPaused: paused }) }).catch(() => undefined);
        }
      }
    }
  }
}

/** First-run setup of an Immich installed here: the admin account, then an API key for Hearth. */
export async function setUpImmich(url: string, email: string, password: string, name: string): Promise<string> {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Immich takes a while on first start (database migrations).
  const end = Date.now() + 180_000;
  for (;;) {
    const ping = await fetch(`${url}/api/server/ping`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (ping?.ok) break;
    if (Date.now() > end) throw new Error('Immich is still starting. Try again in a minute.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const signup = await fetch(`${url}/api/auth/admin-sign-up`, { method: 'POST', headers: json, body: JSON.stringify({ email, password, name }) });
  if (!signup.ok && signup.status !== 400) throw new Error(`Couldn’t create the Immich account (HTTP ${signup.status})`);
  const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email, password }) });
  if (!login.ok) {
    throw new Error(signup.status === 400 ? 'Immich already has an admin account. Link it with an API key instead (Account settings → API keys).' : `Couldn’t sign in to Immich (HTTP ${login.status})`);
  }
  const { accessToken } = (await login.json()) as { accessToken: string };
  const key = await fetch(`${url}/api/api-keys`, {
    method: 'POST',
    headers: { ...json, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: 'Hearth TV', permissions: ['all'] }),
  });
  if (!key.ok) throw new Error(`Couldn’t make an Immich API key (HTTP ${key.status})`);
  return ((await key.json()) as { secret: string }).secret;
}

/** Immich's machine-learning service answers /ping with "pong". */
export async function pingMachineLearning(url: string): Promise<boolean> {
  const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  return Boolean(res?.ok && /pong/i.test(await res.text()));
}
