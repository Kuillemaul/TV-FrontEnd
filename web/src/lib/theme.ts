/**
 * Themes are three independent choices (background, colour palette, font) so any
 * combination looks right: backgrounds tint their glows with the palette's accent.
 * Fonts are bundled, so they work on a TV with no internet.
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/600.css';
import '@fontsource/lora/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';

export interface Theme {
  background: string;
  palette: string;
  font: string;
}

export interface Palette {
  id: string;
  name: string;
  accent: string;
  accent2: string;
}

export interface Background {
  id: string;
  name: string;
  bg: string;
  panel: string;
  /** CSS background layers; may use rgba(var(--accent-rgb), a) and var(--accent-2-rgb). */
  layers: string;
}

export interface Font {
  id: string;
  name: string;
  family: string;
  sample: string;
}

export const PALETTES: Palette[] = [
  { id: 'indigo', name: 'Indigo', accent: '#7b8cff', accent2: '#b48cff' },
  { id: 'ember', name: 'Ember', accent: '#ff7a45', accent2: '#ffb547' },
  { id: 'mint', name: 'Mint', accent: '#3ddc97', accent2: '#4cc9f0' },
  { id: 'rose', name: 'Rose', accent: '#ff5d8f', accent2: '#c77dff' },
  { id: 'sunny', name: 'Sunny', accent: '#ffc93c', accent2: '#ff6b6b' },
  { id: 'ice', name: 'Ice', accent: '#7fd3ff', accent2: '#a5b4fc' },
  { id: 'mono', name: 'Graphite', accent: '#d9dde4', accent2: '#8a93a3' },
];

export const BACKGROUNDS: Background[] = [
  {
    id: 'aurora',
    name: 'Aurora',
    bg: '#07090e',
    panel: '#131824',
    layers:
      'radial-gradient(60rem 40rem at 85% -10%, rgba(var(--accent-rgb), 0.18), transparent 60%), radial-gradient(50rem 30rem at -10% 110%, rgba(var(--accent-2-rgb), 0.12), transparent 60%)',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    bg: '#030407',
    panel: '#10131b',
    layers: 'radial-gradient(90rem 60rem at 50% 0%, rgba(255, 255, 255, 0.035), transparent 70%)',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    bg: '#03121d',
    panel: '#0b2232',
    layers:
      'radial-gradient(70rem 40rem at 100% 0%, rgba(var(--accent-rgb), 0.16), transparent 60%), linear-gradient(180deg, #06263a 0%, #03121d 55%, #020a12 100%)',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    bg: '#140912',
    panel: '#25131f',
    layers:
      'radial-gradient(70rem 35rem at 20% 115%, rgba(255, 122, 69, 0.28), transparent 60%), radial-gradient(60rem 40rem at 90% -10%, rgba(var(--accent-2-rgb), 0.2), transparent 60%)',
  },
  {
    id: 'forest',
    name: 'Forest',
    bg: '#06110c',
    panel: '#10211a',
    layers:
      'radial-gradient(70rem 40rem at 0% 0%, rgba(61, 220, 151, 0.12), transparent 60%), radial-gradient(60rem 40rem at 100% 100%, rgba(var(--accent-rgb), 0.12), transparent 60%)',
  },
  {
    id: 'space',
    name: 'Starfield',
    bg: '#04040a',
    panel: '#12121f',
    layers:
      'radial-gradient(1px 1px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 80%, #fff, transparent), radial-gradient(1.5px 1.5px at 40% 70%, rgba(255,255,255,0.8), transparent), radial-gradient(1px 1px at 85% 20%, #fff, transparent), radial-gradient(1px 1px at 55% 15%, rgba(255,255,255,0.7), transparent), radial-gradient(60rem 40rem at 80% 10%, rgba(var(--accent-rgb), 0.14), transparent 60%)',
  },
  {
    id: 'candy',
    name: 'Candy',
    bg: '#1a0f33',
    panel: '#2a1b4d',
    layers:
      'radial-gradient(40rem 40rem at 10% 10%, rgba(var(--accent-rgb), 0.35), transparent 60%), radial-gradient(45rem 45rem at 95% 30%, rgba(var(--accent-2-rgb), 0.3), transparent 60%), radial-gradient(50rem 30rem at 50% 120%, rgba(76, 201, 240, 0.3), transparent 60%)',
  },
];

export const FONTS: Font[] = [
  { id: 'inter', name: 'Clean', family: "'Inter', 'Segoe UI', Roboto, sans-serif", sample: 'Aa' },
  { id: 'poppins', name: 'Modern', family: "'Poppins', 'Inter', sans-serif", sample: 'Aa' },
  { id: 'nunito', name: 'Rounded', family: "'Nunito', 'Inter', sans-serif", sample: 'Aa' },
  { id: 'fredoka', name: 'Playful', family: "'Fredoka', 'Nunito', sans-serif", sample: 'Aa' },
  { id: 'space-grotesk', name: 'Techy', family: "'Space Grotesk', 'Inter', sans-serif", sample: 'Aa' },
  { id: 'lora', name: 'Classic', family: "'Lora', Georgia, serif", sample: 'Aa' },
];

export const DEFAULT_THEME: Theme = { background: 'aurora', palette: 'indigo', font: 'inter' };

/** Dark text on light accents (Sunny, Ice…), white on dark ones. */
function onColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#12141a' : '#ffffff';
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

export const findPalette = (id: string) => PALETTES.find((p) => p.id === id) ?? PALETTES[0];
export const findBackground = (id: string) => BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
export const findFont = (id: string) => FONTS.find((f) => f.id === id) ?? FONTS[0];

/** CSS variables for a theme; applied to :root, or to an element for previews. */
export function themeVars(theme: Theme): Record<string, string> {
  const p = findPalette(theme.palette);
  const b = findBackground(theme.background);
  return {
    '--accent': p.accent,
    '--accent-2': p.accent2,
    '--accent-rgb': rgb(p.accent),
    '--accent-2-rgb': rgb(p.accent2),
    '--on-accent': onColor(p.accent),
    '--bg': b.bg,
    '--panel': b.panel,
    '--backdrop': b.layers,
    '--font': findFont(theme.font).family,
  };
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(theme))) root.style.setProperty(k, v);
}
