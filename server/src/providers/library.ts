import type { OnDeckItem, SearchItem } from './plex.js';

export type { OnDeckItem, SearchItem };

/** Something to find in the library, e.g. what Radarr/Sonarr just imported. */
export interface FindQuery {
  title: string;
  year?: number;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
}

/**
 * Your own media server (Plex, Jellyfin or Emby) as Home, Search and "ready to watch" use it.
 * Artwork paths in returned items are already relative URLs through /api/library/thumb.
 */
export interface MediaLibrary {
  readonly kind: 'plex' | 'jellyfin' | 'emby';
  /** The app tile that plays from it (its id in config apps). */
  readonly appId: string;
  readonly name: string;
  onDeck(): Promise<OnDeckItem[]>;
  recentlyAdded(): Promise<OnDeckItem[]>;
  search(query: string): Promise<SearchItem[]>;
  /** The item id to play, or null if the server hasn't got it (yet). */
  find(q: FindQuery): Promise<string | null>;
  /** A show or season → its next unwatched episode; anything else as it is. */
  playable(id: string): Promise<string>;
  /** Fetch artwork from the server (the token stays here). */
  thumb(path: string): Promise<Response>;
  /** A web link straight to the item, for when its app tile is a web app. */
  itemUrl(id: string): Promise<string>;
  /** Ask the app on this TV to play the item (after its tile was started). Returns the title. */
  playOnPlayer(id: string, isThisTv: (address: string) => boolean, timeoutMs?: number): Promise<string>;
}

export const thumbUrl = (path: string) => `/api/library/thumb?path=${encodeURIComponent(path)}`;
