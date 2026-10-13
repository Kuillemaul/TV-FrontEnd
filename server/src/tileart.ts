import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Custom looks for app tiles: either a design (style + colours + text, drawn by the UI so it stays
 * sharp at any size and can animate) or an uploaded picture. Kept in <stateDir>/tiles.
 */

export const TILE_STYLES = ['aurora', 'waves', 'rays', 'grid', 'stars', 'bars', 'stripes', 'glow', 'plain'] as const;
export type TileStyle = (typeof TILE_STYLES)[number];

export interface TileDesign {
  style: TileStyle;
  /** Background, accent. */
  colors: [string, string];
  /** Text on the tile (defaults to the app name). */
  text?: string;
  textColor?: string;
  textStyle?: 'bold' | 'light' | 'caps';
  /** An emoji shown with the text. */
  icon?: string;
}

export type TileArt = { type: 'design'; design: TileDesign; v: number } | { type: 'image'; file: string; v: number };

export const TILE_IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_BYTES = 8 * 1024 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;

/** Check a design from the editor; returns a clean copy or throws a friendly error. */
export function cleanDesign(d: unknown): TileDesign {
  const x = (d ?? {}) as Record<string, unknown>;
  if (!TILE_STYLES.includes(x.style as TileStyle)) throw new Error('Pick a style');
  const colors = Array.isArray(x.colors) ? x.colors : [];
  if (colors.length !== 2 || !colors.every((c) => typeof c === 'string' && HEX.test(c))) throw new Error('Pick two colours');
  const out: TileDesign = { style: x.style as TileStyle, colors: [colors[0].toLowerCase(), colors[1].toLowerCase()] };
  if (typeof x.text === 'string' && x.text.trim()) out.text = x.text.trim().slice(0, 30);
  if (typeof x.textColor === 'string' && HEX.test(x.textColor)) out.textColor = x.textColor.toLowerCase();
  if (x.textStyle === 'bold' || x.textStyle === 'light' || x.textStyle === 'caps') out.textStyle = x.textStyle;
  if (typeof x.icon === 'string' && x.icon.trim()) out.icon = [...x.icon.trim()].slice(0, 4).join('');
  return out;
}

const safeId = (id: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('Unknown app');
  return id;
};

export class TileArtStore {
  private art: Record<string, TileArt> = {};
  private readonly index: string;

  constructor(readonly dir: string) {
    this.index = join(dir, 'tiles.json');
    try {
      if (existsSync(this.index)) this.art = JSON.parse(readFileSync(this.index, 'utf8'));
    } catch {
      this.art = {};
    }
  }

  get(id: string): TileArt | undefined {
    return this.art[id];
  }

  all(): Record<string, TileArt> {
    return this.art;
  }

  setDesign(id: string, design: unknown): TileArt {
    const art: TileArt = { type: 'design', design: cleanDesign(design), v: Date.now() };
    this.replace(safeId(id), art);
    return art;
  }

  /** Save an uploaded picture (a data: URL from the editor). */
  setImage(id: string, dataUrl: string): TileArt {
    safeId(id);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUrl);
    if (!m) throw new Error('Upload a JPG, PNG or WebP picture');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_BYTES) throw new Error('That picture is over 8 MB');
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[m[1]]!;
    mkdirSync(this.dir, { recursive: true });
    const v = Date.now();
    const file = `${id}-${v}${ext}`;
    writeFileSync(join(this.dir, file), bytes);
    const art: TileArt = { type: 'image', file, v };
    this.replace(id, art);
    return art;
  }

  reset(id: string): void {
    this.replace(safeId(id), undefined);
  }

  /** Path of an uploaded picture, or null. */
  file(name: string): { path: string; type: string } | null {
    const type = TILE_IMAGE_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()];
    if (!type || name.includes('/') || name.includes('..')) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? { path, type } : null;
  }

  private replace(id: string, art: TileArt | undefined): void {
    const old = this.art[id];
    if (old?.type === 'image') {
      try {
        unlinkSync(join(this.dir, old.file));
      } catch {
        /* already gone */
      }
    }
    if (art) this.art[id] = art;
    else delete this.art[id];
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.index, JSON.stringify(this.art, null, 2));
  }
}
