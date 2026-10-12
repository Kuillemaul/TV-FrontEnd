import { useEffect, useRef, type ReactNode } from 'react';
import { focusElement, focusFirst, onScopedBack } from '../nav/spatial';
import type { Pin } from '../lib/api';
import { Icon } from './Icon';

/** A titled horizontal row of tiles; remembers its focused tile. */
export function Row({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="row">
      <header className="row-header">
        <h2>{title}</h2>
        {action}
      </header>
      <div className="row-scroller" data-nav-group>
        {children}
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
}

export function Tile({ title, subtitle, image, color, shape = 'wide', badge, icon, progress, onSelect, autoFocus, pin }: TileProps) {
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
        {!image && icon ? <Icon name={icon} size="3em" /> : null}
        {!image && !icon && shape === 'app' ? <span className="tile-wordmark">{title}</span> : null}
        {image ? (
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
