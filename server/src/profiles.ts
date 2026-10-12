import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Theme {
  background: string;
  palette: string;
  font: string;
}

export type ProfileKind = 'admin' | 'kid';

export interface Profile {
  id: string;
  name: string;
  color: string;
  kind: ProfileKind;
  /** sha256 of the PIN; only parent profiles can have one. */
  pinHash?: string;
  /** Ordered app ids shown to this profile. null = every app in the default order. */
  apps: string[] | null;
  /** Allowed games as "<hostId>:<gameId>". null = every game. */
  games: string[] | null;
  liveTv: boolean;
  theme: Theme;
  /** Screen-time rules (kid profiles). */
  limits?: Limits;
}

export interface Limits {
  /** Minutes of watching/playing allowed per day; null = unlimited. */
  dailyMinutes: number | null;
  /** "HH:MM" after which nothing can be started, until wakeTime. */
  bedtime: string | null;
  wakeTime: string | null;
}

export const NO_LIMITS: Limits = { dailyMinutes: null, bedtime: null, wakeTime: null };

export type PublicProfile = Omit<Profile, 'pinHash'> & { hasPin: boolean };

export interface CustomApp {
  id: string;
  name: string;
  url: string;
  color: string;
}

interface Store {
  profiles: Profile[];
  activeId: string;
  customApps: CustomApp[];
}

export const DEFAULT_THEME: Theme = { background: 'aurora', palette: 'indigo', font: 'inter' };
export const KID_THEME: Theme = { background: 'candy', palette: 'sunny', font: 'fredoka' };

export class PermissionError extends Error {}

const hash = (pin: string) => createHash('sha256').update(`hearth:${pin}`).digest('hex');

/** Profiles ("who's watching") with per-profile apps, games, Live TV access and theme. */
export class ProfileStore {
  private data: Store;
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'profiles.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      const me: Profile = { id: 'main', name: 'Me', color: '#7b8cff', kind: 'admin', apps: null, games: null, liveTv: true, theme: DEFAULT_THEME };
      this.data = { profiles: [me], activeId: me.id, customApps: [] };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  static toPublic({ pinHash, ...p }: Profile): PublicProfile {
    return { ...p, hasPin: Boolean(pinHash) };
  }

  get all(): Profile[] {
    return this.data.profiles;
  }

  get active(): Profile {
    return this.data.profiles.find((p) => p.id === this.data.activeId) ?? this.data.profiles[0];
  }

  get customApps(): CustomApp[] {
    return this.data.customApps;
  }

  private get(id: string): Profile {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Unknown profile');
    return p;
  }

  private requireAdmin(): void {
    if (this.active.kind !== 'admin') throw new PermissionError('Only a parent profile can do that');
  }

  setActive(id: string, pin?: string): Profile {
    const p = this.get(id);
    if (p.pinHash && p.id !== this.active.id && hash(pin ?? '') !== p.pinHash) throw new PermissionError('Wrong PIN');
    this.data.activeId = p.id;
    this.save();
    return p;
  }

  create(input: { name: string; kind: ProfileKind; color?: string }): Profile {
    this.requireAdmin();
    const kid = input.kind === 'kid';
    const p: Profile = {
      id: randomUUID().slice(0, 8),
      name: input.name.trim().slice(0, 20) || 'New profile',
      color: input.color ?? (kid ? '#ffb547' : '#7b8cff'),
      kind: kid ? 'kid' : 'admin',
      // Kids start with an empty, hand-picked list; parents see everything.
      apps: kid ? [] : null,
      games: kid ? [] : null,
      liveTv: !kid,
      theme: kid ? KID_THEME : DEFAULT_THEME,
    };
    this.data.profiles.push(p);
    this.save();
    return p;
  }

  update(id: string, patch: Partial<Omit<Profile, 'id' | 'pinHash'>> & { pin?: string | null }): Profile {
    const p = this.get(id);
    const onlyTheme = Object.keys(patch).every((k) => k === 'theme');
    // Anyone may restyle their own profile; everything else needs a parent.
    if (!(onlyTheme && id === this.active.id)) this.requireAdmin();

    if (patch.name !== undefined) p.name = patch.name.trim().slice(0, 20) || p.name;
    if (patch.color) p.color = patch.color;
    if (patch.kind) {
      if (patch.kind === 'kid' && p.kind === 'admin' && this.data.profiles.filter((x) => x.kind === 'admin').length === 1) {
        throw new Error('Keep at least one parent profile');
      }
      p.kind = patch.kind;
      if (p.kind === 'kid') delete p.pinHash;
    }
    if (patch.apps !== undefined) p.apps = patch.apps;
    if (patch.games !== undefined) p.games = patch.games;
    if (patch.liveTv !== undefined) p.liveTv = patch.liveTv;
    if (patch.limits !== undefined) p.limits = { ...NO_LIMITS, ...p.limits, ...patch.limits };
    if (patch.theme) p.theme = { ...p.theme, ...patch.theme };
    if (patch.pin !== undefined) {
      if (patch.pin === null || patch.pin === '') delete p.pinHash;
      else if (!/^\d{4}$/.test(patch.pin)) throw new Error('PIN must be 4 digits');
      else if (p.kind === 'admin') p.pinHash = hash(patch.pin);
    }
    this.save();
    return p;
  }

  /** True if the profile has no PIN or the PIN matches (used to confirm sensitive actions). */
  checkPin(id: string, pin?: string): boolean {
    const p = this.get(id);
    return !p.pinHash || hash(pin ?? '') === p.pinHash;
  }

  remove(id: string): void {
    this.requireAdmin();
    const p = this.get(id);
    if (p.kind === 'admin' && this.data.profiles.filter((x) => x.kind === 'admin').length === 1) {
      throw new Error('Keep at least one parent profile');
    }
    this.data.profiles = this.data.profiles.filter((x) => x.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.data.profiles.find((x) => x.kind === 'admin')!.id;
    this.save();
  }

  addCustomApp(input: { name: string; url: string; color?: string }): CustomApp {
    this.requireAdmin();
    if (!/^https?:\/\//.test(input.url)) throw new Error('Enter a full web address starting with https://');
    const app: CustomApp = {
      id: `custom-${randomUUID().slice(0, 8)}`,
      name: input.name.trim().slice(0, 24) || new URL(input.url).hostname,
      url: input.url,
      color: input.color ?? '#3b4252',
    };
    // Which profiles show it is up to the app editor that added it.
    this.data.customApps.push(app);
    this.save();
    return app;
  }

  removeCustomApp(id: string): void {
    this.requireAdmin();
    this.data.customApps = this.data.customApps.filter((a) => a.id !== id);
    for (const p of this.data.profiles) if (p.apps) p.apps = p.apps.filter((a) => a !== id);
    this.save();
  }

  /** Apply a profile's ordering/curation to the full app list. */
  static orderApps<T extends { id: string }>(profile: Profile, apps: T[]): T[] {
    if (!profile.apps) return apps;
    const byId = new Map(apps.map((a) => [a.id, a]));
    return profile.apps.map((id) => byId.get(id)).filter((a): a is T => Boolean(a));
  }

  static allowsGame(profile: Profile, hostId: string, gameId: string): boolean {
    return !profile.games || profile.games.includes(`${hostId}:${gameId}`);
  }
}
