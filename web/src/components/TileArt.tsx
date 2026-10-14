import { useId, type CSSProperties, type ReactNode } from 'react';
import type { AppTile, TileDesign, TileStyle } from '../lib/api';
import { BRAND_LOGOS, type BrandLogo } from './brandLogos';
import './tileart.css';

/**
 * Designed app tiles. Drawn as SVG at 480×270 (16:9) and scaled to fit, so they're sharp on a 4K TV.
 * Moving parts only animate while the tile is focused (or in the editor's preview).
 */

export const TILE_STYLES: Array<{ id: TileStyle; label: string }> = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'waves', label: 'Waves' },
  { id: 'rays', label: 'Sunburst' },
  { id: 'grid', label: 'Retro grid' },
  { id: 'stars', label: 'Night sky' },
  { id: 'bars', label: 'Equaliser' },
  { id: 'stripes', label: 'Stripes' },
  { id: 'glow', label: 'Spotlight' },
  { id: 'plain', label: 'Gradient' },
];

const BUILT_IN: Record<string, TileDesign> = {
  plex: { style: 'rays', colors: ['#1b1b1b', '#e5a00d'], text: 'plex', textStyle: 'bold' },
  netflix: { style: 'glow', colors: ['#0b0b0b', '#e50914'], text: 'Netflix', textStyle: 'caps' },
  youtube: { style: 'waves', colors: ['#1a0507', '#ff0033'], text: 'YouTube', icon: '▶️' },
  disney: { style: 'stars', colors: ['#06134a', '#4fc3ff'], text: 'Disney+' },
  prime: { style: 'aurora', colors: ['#0f171e', '#00a8e1'], text: 'prime video', textStyle: 'light' },
  max: { style: 'grid', colors: ['#06063a', '#5a6bff'], text: 'max', textStyle: 'bold' },
  spotify: { style: 'bars', colors: ['#0d0d0d', '#1db954'], text: 'Spotify' },
  jellyfin: { style: 'aurora', colors: ['#101024', '#aa5cc3'], text: 'Jellyfin' },
  moonlight: { style: 'stars', colors: ['#0a1028', '#7aa2ff'], text: 'Moonlight', icon: '🌙' },
};

/** The look an app gets when nobody has customised it. */
export function defaultDesign(app: Pick<AppTile, 'id' | 'name' | 'color'>): TileDesign {
  const known = BUILT_IN[app.id];
  if (known) return known;
  const c = /^#[0-9a-f]{6}$/i.test(app.color ?? '') ? app.color! : '#3b4252';
  return { style: app.id.startsWith('input-') ? 'stripes' : 'aurora', colors: [mix(c, '#000000', 0.62), c] };
}

const BRAND_ALIASES: Record<string, string> = { prime: 'primevideo', hbomax: 'max' };
/** Logos drawn in the brand's own colour (on dark tiles); the rest are white. */
const BRAND_FILL: Record<string, string> = { netflix: '#e50914', youtube: '#ff0000', youtubetv: '#ff0000', spotify: '#1ed760' };

/** The official logo for a built-in app (by id) or any app whose name matches one ("Crunchyroll", "Apple TV"…). */
export function brandLogo(app: Pick<AppTile, 'id' | 'name'>): { key: string; logo: BrandLogo } | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
  for (const key of [BRAND_ALIASES[app.id] ?? app.id, norm(app.name)]) {
    if (BRAND_LOGOS[key]) return { key, logo: BRAND_LOGOS[key] };
  }
  return undefined;
}

/** The tile picture for an app: custom picture, custom design, config logo (null → Tile draws it) or the default design. */
export function AppArt({ app, live }: { app: AppTile; live?: boolean }) {
  if (app.art?.type === 'image') return <img className="tile-art-photo" src={app.art.url} alt="" />;
  if (app.art?.type === 'design') return <TileArtSvg design={app.art.design} title={app.name} live={live} />;
  if (app.logo) return null;
  return <TileArtSvg design={defaultDesign(app)} title={app.name} live={live} brand={brandLogo(app)} />;
}

/** For <Tile art=…>: undefined when the app should keep its config logo. */
export const appArt = (app: AppTile, live?: boolean): ReactNode =>
  app.art || !app.logo ? <AppArt app={app} live={live} /> : undefined;

/* ------------------------------------------------------------------ drawing */

const W = 480;
const H = 270;
/** Retro grid: where the floor meets the sky. */
const HORIZON = 200;

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Blend a toward b by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const anim = (name: string, seconds: number, delay = 0, extra: CSSProperties = {}): CSSProperties => ({
  animation: `${name} ${seconds}s ease-in-out ${-delay}s infinite alternate`,
  ...extra,
});
const spinStyle = (seconds: number, ox: number, oy: number): CSSProperties => ({
  animation: `ta-spin ${seconds}s linear infinite`,
  transformBox: 'view-box',
  transformOrigin: `${ox}px ${oy}px`,
});

function wavePath(y: number, amp: number, len: number, phase: number): string {
  let d = `M -${len} ${H} L -${len} ${y}`;
  for (let x = -len; x <= W + len; x += 8) d += ` L ${x} ${(y + Math.sin(((x + phase) / len) * Math.PI * 2) * amp).toFixed(1)}`;
  return `${d} L ${W + len} ${H} Z`;
}

function Background({ style, c0, c1, id, seed }: { style: TileStyle; c0: string; c1: string; id: string; seed: string }): ReactNode {
  const r = rng(seed);
  switch (style) {
    case 'aurora':
      return (
        <>
          <rect width={W} height={H} fill={c0} />
          <g filter={`url(#${id}-blur)`}>
            <ellipse className="ta-anim" cx="110" cy="70" rx="170" ry="80" fill={c1} opacity="0.75" style={anim('ta-drift-a', 9)} />
            <ellipse className="ta-anim" cx="380" cy="210" rx="160" ry="90" fill={mix(c1, '#ffffff', 0.35)} opacity="0.45" style={anim('ta-drift-b', 11, 3)} />
            <ellipse className="ta-anim" cx="300" cy="40" rx="120" ry="60" fill={mix(c0, c1, 0.6)} opacity="0.8" style={anim('ta-drift-b', 13, 6)} />
          </g>
        </>
      );
    case 'waves':
      return (
        <>
          <rect width={W} height={H} fill={`url(#${id}-v)`} />
          {[
            { y: 170, a: 14, o: 0.25, s: 9 },
            { y: 195, a: 12, o: 0.45, s: 7 },
            { y: 222, a: 10, o: 0.85, s: 5 },
          ].map((w, i) => (
            <path key={i} className="ta-anim" d={wavePath(w.y, w.a, 160, i * 50)} fill={c1} opacity={w.o} style={{ animation: `ta-slide ${w.s}s linear infinite` }} />
          ))}
        </>
      );
    case 'rays':
      return (
        <>
          <rect width={W} height={H} fill={`url(#${id}-r)`} />
          <g className="ta-anim" style={spinStyle(60, 240, 300)} opacity="0.35">
            {Array.from({ length: 18 }, (_, i) => {
              const a = (i / 18) * Math.PI * 2;
              const b = a + Math.PI / 30;
              const R = 700;
              return <path key={i} d={`M 240 300 L ${240 + Math.cos(a) * R} ${300 + Math.sin(a) * R} L ${240 + Math.cos(b) * R} ${300 + Math.sin(b) * R} Z`} fill={c1} />;
            })}
          </g>
          <circle cx="240" cy="300" r="120" fill={`url(#${id}-glow)`} />
        </>
      );
    case 'grid': {
      const horizon = HORIZON;
      return (
        <>
          <rect width={W} height={H} fill={`url(#${id}-sky)`} />
          <circle cx="240" cy={horizon} r="56" fill={`url(#${id}-sun)`} mask={`url(#${id}-cuts)`} />
          <rect y={horizon} width={W} height={H - horizon} fill={mix(c0, '#000000', 0.3)} />
          <g stroke={c1} strokeWidth="1.4" opacity="0.8" clipPath={`url(#${id}-floor)`}>
            {Array.from({ length: 21 }, (_, i) => (
              <line key={i} x1={240} y1={horizon} x2={240 + (i - 10) * 90} y2={H} />
            ))}
            <g className="ta-anim" style={{ animation: 'ta-floor 1.6s linear infinite' }}>
              {Array.from({ length: 8 }, (_, i) => (
                <line key={i} x1={0} y1={horizon - 16 + i * 16} x2={W} y2={horizon - 16 + i * 16} />
              ))}
            </g>
          </g>
          <line x1="0" y1={horizon} x2={W} y2={horizon} stroke={mix(c1, '#ffffff', 0.5)} strokeWidth="2" />
        </>
      );
    }
    case 'stars':
      return (
        <>
          <rect width={W} height={H} fill={`url(#${id}-r)`} />
          {Array.from({ length: 46 }, (_, i) => (
            <circle
              key={i}
              className="ta-anim"
              cx={r() * W}
              cy={r() * H * 0.85}
              r={0.6 + r() * 1.6}
              fill={i % 7 === 0 ? c1 : '#ffffff'}
              opacity={0.4 + r() * 0.6}
              style={anim('ta-twinkle', 1.4 + r() * 2.5, r() * 4)}
            />
          ))}
          <ellipse cx="240" cy="320" rx="330" ry="110" fill={`url(#${id}-glow)`} />
        </>
      );
    case 'bars':
      return (
        <>
          <rect width={W} height={H} fill={c0} />
          <rect width={W} height={H} fill={`url(#${id}-glow2)`} />
          {Array.from({ length: 24 }, (_, i) => {
            const h = 30 + r() * 110;
            return (
              <rect
                key={i}
                className="ta-anim"
                x={8 + i * 19.6}
                y={H - h}
                width="12"
                height={h}
                rx="5"
                fill={c1}
                opacity={0.25 + (h / 140) * 0.45}
                style={anim('ta-bounce', 0.5 + r() * 0.7, r(), { transformBox: 'fill-box', transformOrigin: 'bottom' })}
              />
            );
          })}
        </>
      );
    case 'stripes':
      return (
        <>
          <rect width={W} height={H} fill={`url(#${id}-v)`} />
          <g transform="rotate(-30 240 135)" opacity="0.22">
            <g className="ta-anim" style={{ animation: 'ta-stripes 3s linear infinite' }}>
              {Array.from({ length: 22 }, (_, i) => (
                <rect key={i} x={-300 + i * 56} y={-300} width="24" height="900" fill={c1} />
              ))}
            </g>
          </g>
        </>
      );
    case 'glow':
      return (
        <>
          <rect width={W} height={H} fill={c0} />
          <ellipse className="ta-anim" cx="240" cy="135" rx="240" ry="150" fill={`url(#${id}-glow)`} style={anim('ta-pulse', 2.6, 0, { transformBox: 'view-box', transformOrigin: '240px 135px' })} />
          <rect y={H - 6} width={W} height="6" fill={c1} />
        </>
      );
    default:
      return <rect width={W} height={H} fill={`url(#${id}-d)`} />;
  }
}

export function TileArtSvg({ design, title, live, brand }: { design: TileDesign; title: string; live?: boolean; brand?: { key: string; logo: BrandLogo } }) {
  const id = `ta${useId().replace(/[^a-z0-9]/gi, '')}`;
  const [c0, c1] = design.colors;
  const style = design.style;
  const raw = design.text ?? title;
  const text = design.textStyle === 'caps' ? raw.toUpperCase() : raw;
  const icon = design.icon;
  const units = [...text].length * (design.textStyle === 'caps' ? 0.72 : 0.56) + (icon ? 1.3 : 0);
  const size = Math.max(18, Math.min(design.textStyle === 'caps' ? 50 : 64, 390 / Math.max(units, 1)));
  const weight = design.textStyle === 'light' ? 300 : 800;
  const spacing = design.textStyle === 'caps' ? size * 0.12 : design.textStyle === 'light' ? size * 0.02 : -size * 0.03;

  return (
    <svg className={`tile-art-svg ${live ? 'ta-live' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="38" />
        </filter>
        <filter id={`${id}-shadow`} x="-20%" y="-40%" width="140%" height="180%">
          <feDropShadow dx="0" dy="3" stdDeviation="6" floodColor="#000" floodOpacity="0.45" />
        </filter>
        <linearGradient id={`${id}-v`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={mix(c0, c1, 0.18)} />
          <stop offset="1" stopColor={mix(c0, '#000000', 0.35)} />
        </linearGradient>
        <linearGradient id={`${id}-d`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={mix(c0, c1, 0.75)} />
          <stop offset="1" stopColor={c0} />
        </linearGradient>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c0} />
          <stop offset="0.62" stopColor={mix(c0, c1, 0.45)} />
        </linearGradient>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={mix(c1, '#ffffff', 0.55)} />
          <stop offset="1" stopColor={c1} />
        </linearGradient>
        <radialGradient id={`${id}-r`} cx="0.5" cy="0.9" r="0.9">
          <stop offset="0" stopColor={mix(c0, c1, 0.35)} />
          <stop offset="1" stopColor={c0} />
        </radialGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor={c1} stopOpacity="0.75" />
          <stop offset="1" stopColor={c1} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-glow2`} cx="0.5" cy="1" r="0.8">
          <stop offset="0" stopColor={c1} stopOpacity="0.35" />
          <stop offset="1" stopColor={c1} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-cuts`}>
          <rect width={W} height={H} fill="#fff" />
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x="0" y={HORIZON - 30 + i * 6} width={W} height={1 + i * 0.9} fill="#000" />
          ))}
        </mask>
        <clipPath id={`${id}-floor`}>
          <rect y={HORIZON} width={W} height={H - HORIZON} />
        </clipPath>
      </defs>

      <Background style={style} c0={c0} c1={c1} id={id} seed={`${title}${style}`} />
      <rect width={W} height={H} fill={`url(#${id}-gloss)`} />
      <rect className="ta-sheen" x="-200" width="160" height={H} fill={`url(#${id}-sheen)`} transform="skewX(-18)" />

      {brand ? (
        <BrandMark brand={brand} title={title} shadow={`url(#${id}-shadow)`} />
      ) : (
      <text
        x={W / 2}
        y={H / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={design.textColor ?? '#ffffff'}
        fontSize={size}
        fontWeight={weight}
        letterSpacing={spacing}
        filter={`url(#${id}-shadow)`}
        style={{ fontFamily: 'var(--font, Inter, system-ui, sans-serif)' }}
      >
        {icon ? (
          <tspan style={{ fontFamily: '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif' }} fontWeight={400}>
            {icon}
            {' '}
          </tspan>
        ) : null}
        {text}
      </text>
      )}
    </svg>
  );
}

/** An official logo, centred: wordmarks on their own, symbols (Netflix N, YouTube…) with the name under them. */
function BrandMark({ brand, title, shadow }: { brand: { key: string; logo: BrandLogo }; title: string; shadow: string }) {
  const { key, logo } = brand;
  const fill = BRAND_FILL[key] ?? '#ffffff';
  const scale = logo.wordmark ? 9.5 : 4.4;
  const box = 24 * scale;
  const y = logo.wordmark ? (H - box) / 2 : H / 2 - box / 2 - 26;
  return (
    <g filter={shadow}>
      <g transform={`translate(${(W - box) / 2} ${y}) scale(${scale})`}>
        {/* YouTube's play triangle is a hole in the logo: white behind it, as in the real logo. */}
        {key === 'youtube' || key === 'youtubetv' ? <rect x="8" y="7.5" width="9" height="9" fill="#fff" /> : null}
        <path d={logo.path} fill={fill} />
      </g>
      {logo.wordmark ? null : (
        <text
          x={W / 2}
          y={y + box + 34}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#ffffff"
          fontSize={30}
          fontWeight={700}
          style={{ fontFamily: 'var(--font, Inter, system-ui, sans-serif)' }}
        >
          {title}
        </text>
      )}
    </g>
  );
}
