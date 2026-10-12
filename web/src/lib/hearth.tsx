import { createContext, useContext } from 'react';
import type { Info, PageId } from './api';

export interface PlayRequest {
  hostId: string;
  gameId: string;
  title: string;
  requiresKbm: boolean;
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
}

export const HearthContext = createContext<Hearth | null>(null);

export function useHearth(): Hearth {
  const ctx = useContext(HearthContext);
  if (!ctx) throw new Error('useHearth outside provider');
  return ctx;
}
