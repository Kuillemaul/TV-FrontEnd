import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from './bus.js';

export interface CatalogApp {
  name: string;
  what?: string;
  port?: number;
  path?: string;
  media?: boolean;
  /** Flatpak app id. */
  id?: string;
}
export interface AppCatalog {
  docker: Record<string, CatalogApp>;
  flatpak: Record<string, CatalogApp>;
}
export type InstallKind = 'docker' | 'flatpak';

export interface InstallJob {
  app: string;
  action: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  message: string;
  at: number;
  port?: number;
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
}
export interface InstalledApp {
  kind: InstallKind;
  installed: boolean;
  port?: number;
  media?: string | null;
  apiKey?: string;
  token?: string;
}
export interface InstallStatus {
  jobs: Record<string, InstallJob>;
  apps: Record<string, InstalledApp>;
}

const CATALOG_PATH = fileURLToPath(new URL('../../os/apps/catalog.json', import.meta.url));

export function loadCatalog(): AppCatalog {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  return { docker: raw.docker, flatpak: raw.flatpak };
}

/**
 * Installs apps on this machine through os/hearth-apps.py (run as root by hearth-apps.path when a
 * request file appears). Hearth itself runs as the tv user, so it only drops requests and reads
 * progress. HEARTH_FAKE_INSTALL=1 pretends, for trying the screens on a laptop.
 */
export class AppInstaller {
  readonly catalog = loadCatalog();
  private readonly requests: string;
  private readonly statusFile: string;
  private timer?: NodeJS.Timeout;
  private last = '';
  private readonly fake = process.env.HEARTH_FAKE_INSTALL === '1';
  private fakeStatus: InstallStatus = { jobs: {}, apps: {} };
  /** Called when a job finishes (done or failed). */
  onFinished?: (jobId: string, job: InstallJob) => void;

  constructor(
    stateDir: string,
    private readonly bus: EventBus,
  ) {
    this.requests = join(stateDir, 'apps-requests');
    this.statusFile = join(stateDir, 'apps.json');
  }

  /** Whether this machine can install apps (the root helper is set up by os/install.sh). */
  get available(): boolean {
    return this.fake || existsSync('/etc/systemd/system/hearth-apps.path');
  }

  status(): InstallStatus {
    if (this.fake) return this.fakeStatus;
    try {
      return JSON.parse(readFileSync(this.statusFile, 'utf8'));
    } catch {
      return { jobs: {}, apps: {} };
    }
  }

  installed(app: string): InstalledApp | undefined {
    return this.status().apps[app];
  }

  request(kind: InstallKind, app: string, action: 'install' | 'remove' | 'keys', options: { media?: string; claim?: string } = {}): string {
    if (!this.catalog[kind]?.[app]) throw new Error(`${app} isn’t something Hearth can install`);
    if (!this.available) throw new Error('Installing isn’t set up on this machine (run sudo ./os/install.sh again)');
    const job = randomUUID().slice(0, 12);
    if (this.fake) this.pretend(job, kind, app, action);
    else {
      mkdirSync(this.requests, { recursive: true });
      writeFileSync(join(this.requests, `${job}.json`), JSON.stringify({ kind, app, action, ...options }));
    }
    this.watch();
    return job;
  }

  /** After a restart: keep following installs that are still running. */
  resume(): void {
    if (Object.values(this.status().jobs).some((j) => j.state === 'running' || j.state === 'queued')) this.watch();
  }

  /** Poll the status file while anything is running and tell the UIs when it changes. */
  private watch(): void {
    if (this.timer) return;
    const seen = new Set<string>();
    const started = Date.now();
    this.timer = setInterval(() => {
      const status = this.status();
      const text = JSON.stringify(status);
      if (text !== this.last) {
        this.last = text;
        this.bus.emit({ type: 'installs' });
        for (const [id, job] of Object.entries(status.jobs)) {
          if ((job.state === 'done' || job.state === 'failed') && !seen.has(id) && job.at >= started - 1000) {
            seen.add(id);
            this.onFinished?.(id, job);
          }
        }
      }
      const busy = Object.values(status.jobs).some((j) => j.state === 'running' || j.state === 'queued');
      const waiting = existsSync(this.requests) && !this.fake && readdirJson(this.requests) > 0;
      if (!busy && !waiting && Date.now() - started > 5000) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, 1500);
  }

  private pretend(job: string, kind: InstallKind, app: string, action: string): void {
    const set = (state: InstallJob['state'], message: string, extra: Partial<InstallJob> = {}) => {
      this.fakeStatus = { ...this.fakeStatus, jobs: { ...this.fakeStatus.jobs, [job]: { app, action, state, message, at: Date.now(), ...extra } } };
    };
    const name = this.catalog[kind][app].name;
    set('running', `Downloading ${name}…`);
    setTimeout(() => set('running', `Starting ${name}…`), 2500);
    setTimeout(() => {
      const port = this.catalog[kind][app].port;
      const apiKey = ['radarr', 'sonarr', 'seerr'].includes(app) ? 'fake-api-key' : undefined;
      if (action === 'remove') delete this.fakeStatus.apps[app];
      else this.fakeStatus.apps[app] = { kind, installed: true, port, apiKey };
      set('done', action === 'remove' ? `${name} removed` : `${name} is ${kind === 'docker' ? 'running' : 'installed'}`, { port, apiKey });
    }, 5000);
  }
}

function readdirJson(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
