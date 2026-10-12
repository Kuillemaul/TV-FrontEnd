import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ThemeChoice } from '../lib/api';
import { applyTheme, BACKGROUNDS, findFont, FONTS, PALETTES, themeVars } from '../lib/theme';
import { focusFirst } from '../nav/spatial';
import { Icon } from './Icon';
import { Button, useBack } from './Layout';

/**
 * Side panel for picking background, colours and font. Moving focus over a swatch previews
 * it across the whole TV instantly; Select keeps it; Save stores it on the profile.
 * Back cancels and restores the previous look.
 */
export function ThemeMenu({
  title,
  initial,
  restore,
  onSave,
  onClose,
}: {
  title: string;
  initial: ThemeChoice;
  /** Look to return to when the panel closes (when editing someone else's profile). */
  restore?: ThemeChoice;
  onSave: (theme: ThemeChoice) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<ThemeChoice>(initial);
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef(false);

  const back = restore ?? initial;
  const cancel = () => {
    applyTheme(back);
    onClose();
  };
  useBack(ref, cancel);

  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
    // Restore the profile's look if the panel goes away without saving.
    return () => {
      if (!saved.current || restore) applyTheme(back);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = (patch: Partial<ThemeChoice>) => applyTheme({ ...chosen, ...patch });
  const pick = (patch: Partial<ThemeChoice>) => {
    const next = { ...chosen, ...patch };
    setChosen(next);
    applyTheme(next);
  };

  return (
    <div className="theme-backdrop">
      <aside className="theme-panel" data-nav-scope ref={ref} onMouseLeave={() => applyTheme(chosen)}>
        <h2 className="theme-title">{title}</h2>

        <section className="theme-section">
          <h3>Background</h3>
          <div className="theme-grid theme-backgrounds" data-nav-group>
            {BACKGROUNDS.map((b) => {
              const vars = themeVars({ ...chosen, background: b.id });
              return (
                <button
                  key={b.id}
                  data-nav
                  data-nav-default={chosen.background === b.id || undefined}
                  className={`swatch swatch-bg ${chosen.background === b.id ? 'chosen' : ''}`}
                  style={{ ...vars, background: 'var(--backdrop), var(--bg)' } as CSSProperties}
                  onFocus={() => preview({ background: b.id })}
                  onClick={() => pick({ background: b.id })}
                >
                  <span className="swatch-label">{b.name}</span>
                  {chosen.background === b.id ? <Check /> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="theme-section">
          <h3>Colours</h3>
          <div className="theme-grid theme-palettes" data-nav-group>
            {PALETTES.map((p) => (
              <button
                key={p.id}
                data-nav
                className={`swatch swatch-palette ${chosen.palette === p.id ? 'chosen' : ''}`}
                onFocus={() => preview({ palette: p.id })}
                onClick={() => pick({ palette: p.id })}
              >
                <span className="palette-dot" style={{ background: `linear-gradient(135deg, ${p.accent} 50%, ${p.accent2} 50%)` }} />
                <span className="swatch-label">{p.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="theme-section">
          <h3>Font</h3>
          <div className="theme-grid theme-fonts" data-nav-group>
            {FONTS.map((f) => (
              <button
                key={f.id}
                data-nav
                className={`swatch swatch-font ${chosen.font === f.id ? 'chosen' : ''}`}
                style={{ fontFamily: f.family }}
                onFocus={() => preview({ font: f.id })}
                onClick={() => pick({ font: f.id })}
              >
                <span className="font-sample">{f.sample}</span>
                <span className="swatch-label">{f.name}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="theme-summary">
          {BACKGROUNDS.find((b) => b.id === chosen.background)?.name} · {PALETTES.find((p) => p.id === chosen.palette)?.name} ·{' '}
          {findFont(chosen.font).name}
        </div>
        <div className="modal-actions" data-nav-group>
          <Button
            variant="primary"
            icon="check"
            onClick={() => {
              saved.current = true;
              applyTheme(chosen);
              onSave(chosen);
            }}
          >
            Save
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      </aside>
    </div>
  );
}

function Check() {
  return (
    <span className="swatch-check">
      <Icon name="check" size="0.9em" />
    </span>
  );
}
