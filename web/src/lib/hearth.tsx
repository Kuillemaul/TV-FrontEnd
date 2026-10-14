import { createContext, useContext } from 'react';
import type { Game, Info, PageId, Pin, Profile, ProfilesState } from './api';

export interface PlayRequest {
  hostId: string;
  gameId: string;
  title: string;
  requiresKbm: boolean;
  art?: string;
  /** Controllers to set up in the emulator (Eden/yuzu); defaults to how many are connected. */
  players?: number;
  /** Stream even though someone is using the PC. */
  force?: boolean;
}

export interface Hearth {
  info: Info | null;
  page: PageId;
  navigate(page: PageId): void;
  launchApp(id: string): void;
  watchChannel(id: string): void;
  /** Starts a game; shows the keyboard/mouse prompt first when the game needs one. */
  playGame(game: PlayRequest): void;
  toast(message: string, level?: 'info' | 'error'): void;
  profiles: ProfilesState | null;
  /** The active profile ("who's watching"). */
  profile: Profile | null;
  isKid: boolean;
  /** Open an editor overlay for a profile (Settings). */
  editProfile(id: string): void;
  /** Open the app order/visibility editor for the active profile. */
  editApps(): void;
  openTheme(): void;
  /** Show a game's details (screenshot, description, play time) with a Play button. */
  openGame(game: Game): void;
  /** Pin to / unpin from this profile's Home. */
  togglePin(pin: Pin): Promise<void>;
  movePin(key: string, delta: number): Promise<void>;
}

export const HearthContext = createContext<Hearth | null>(null);

export function useHearth(): Hearth {
  const ctx = useContext(HearthContext);
  if (!ctx) throw new Error('useHearth outside provider');
  return ctx;
}
