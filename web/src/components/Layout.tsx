import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { focusElement, focusFirst, onScopedBack } from '../nav/spatial';
import type { Pin } from '../lib/api';
import { Icon } from './Icon';

/** A titled horizontal row of tiles; remembers its focused tile. Arrows at the ends scroll it with the mouse. */
export function Row({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 };
    setEdges((e) => (e.left === next.left && e.right === next.right ? e : next));
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [update]);
  const page = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section className="row">
      <header className="row-header">
        <h2>{title}</h2>
        {action}
      </header>
      <div className="row-body">
        <div className="row-scroller" data-nav-group ref={scroller} onScroll={update}>
          {children}
        </div>
        {/* Mouse only: not part of remote/controller navigation. */}
        {edges.left ? (
          <button className="row-arrow row-arrow-left" tabIndex={-1} aria-label="Scroll left" onClick={() => page(-1)}>
            <Icon name="left" size="1.6em" />
          </button>
        ) : null}
        {edges.right ? (
          <button className="row-arrow row-arrow-right" tabIndex={-1} aria-label="Scroll right" onClick={() => page(1)}>
            <Icon name="right" size="1.6em" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

interface TileProps {
  title: string;
  subtitle?: string;
  image?: string;
  color?: string;
  shape?: 'wide' | 'poster' | 'app' | 'square';
  badge?: ReactNode;
  icon?: string;
  progress?: number;
  onSelect: () => void;
  autoFocus?: boolean;
  /** Lets X / Menu / right-click pin this tile to Home. */
  pin?: Pin;
  /** Full-bleed artwork (designed app tiles); replaces image/wordmark. */
  art?: ReactNode;
}

export function Tile({ title, subtitle, image, color, shape = 'wide', badge, icon, progress, onSelect, autoFocus, pin, art }: TileProps) {
  return (
    <button
      className={`tile tile-${shape}`}
      data-nav
      data-pin={pin ? JSON.stringify(pin) : undefined}
      data-nav-default={autoFocus || undefined}
      onClick={onSelect}
      style={color ? ({ '--tile-color': color } as React.CSSProperties) : undefined}
    >
      <div className="tile-art">
        {/* Poster titles sit under the artwork so they show if the image is missing or fails. */}
        {shape === 'poster' ? <span className="tile-poster-title">{title}</span> : null}
        {art ? <div className="tile-art-layer">{art}</div> : null}
        {!art && !image && icon ? <Icon name={icon} size="3em" /> : null}
        {!art && !image && !icon && shape === 'app' ? <span className="tile-wordmark">{title}</span> : null}
        {image && !art ? (
          <img src={image} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        ) : null}
        {badge ? <div className="tile-badges">{badge}</div> : null}
        {progress !== undefined ? (
          <div className="tile-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
      </div>
      {shape !== 'app' ? (
        <div className="tile-meta">
          <div className="tile-title">{title}</div>
          {subtitle ? <div className="tile-subtitle">{subtitle}</div> : null}
        </div>
      ) : null}
    </button>
  );
}

/** Close an overlay with Back (Esc / B / remote Back) when it is the topmost one. */
export function useBack(ref: React.RefObject<HTMLElement | null>, onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => onScopedBack(() => ref.current, () => cb.current()), [ref]);
}

/** Modal dialog that traps navigation and restores focus on close. */
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useBack(ref, onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
    return () => {
      if (previous?.isConnected) focusElement(previous);
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} data-nav-scope ref={ref} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  icon,
  variant = 'default',
  autoFocus,
  disabled,
}: {
  children?: ReactNode;
  onClick: () => void;
  icon?: string;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`btn btn-${variant}`} data-nav data-nav-default={autoFocus || undefined} onClick={onClick} disabled={disabled}>
      {icon ? <Icon name={icon} size="1.2em" /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function Chip({ active, children, onClick, dot }: { active: boolean; children: ReactNode; onClick: () => void; dot?: 'on' | 'off' }) {
  return (
    <button className={`chip ${active ? 'chip-active' : ''}`} data-nav onClick={onClick}>
      {dot ? <span className={`dot dot-${dot}`} /> : null}
      {children}
    </button>
  );
}

/** Shown in place of a section that hasn't been set up in config.yaml yet. */
export function NotSetUp({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="not-set-up">
      <Icon name={icon} size="3rem" />
      <div className="not-set-up-title">{title}</div>
      <div className="not-set-up-text">{children}</div>
    </div>
  );
}

export function DemoBanner({ children }: { children: ReactNode }) {
  return <div className="demo-banner">{children}</div>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <div className="page-header-actions">{children}</div>
    </header>
  );
}
