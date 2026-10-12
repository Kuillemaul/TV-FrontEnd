import { useEffect, useRef, useState } from 'react';
import { useApi, type KbmStatus } from '../lib/api';
import { pauseGamepadNav } from '../nav/spatial';
import { Button, Modal } from './Layout';

interface PadView {
  index: number;
  id: string;
  standard: boolean;
  buttons: number[];
  axes: number[];
}

const HOLD_TO_EXIT_MS = 2000;

const snapshot = (): PadView[] =>
  navigator
    .getGamepads()
    .filter((g): g is Gamepad => g !== null)
    .map((g) => ({ index: g.index, id: g.id, standard: g.mapping === 'standard', buttons: g.buttons.map((b) => b.value), axes: [...g.axes] }));

/** Live view of every controller's buttons and sticks. Controllers stop navigating while it's open. */
export function ControllerTest({ onClose }: { onClose: () => void }) {
  const [pads, setPads] = useState<PadView[]>([]);
  const [holding, setHolding] = useState(0);
  const linux = useApi<KbmStatus>('/api/system/input', 2000);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const resume = pauseGamepadNav();
    let frame = 0;
    let bSince = 0;
    const rumbled = new Set<number>();
    const tick = (now: number) => {
      const view = snapshot();
      setPads(view);
      // Hold B on any controller to leave (B is a normal button here, so a tap must not exit).
      const bHeld = view.some((p) => p.buttons[1] > 0.5);
      bSince = bHeld ? bSince || now : 0;
      setHolding(bSince ? Math.min(1, (now - bSince) / HOLD_TO_EXIT_MS) : 0);
      if (bSince && now - bSince >= HOLD_TO_EXIT_MS) return close.current();
      // Both sticks pressed in → rumble test.
      for (const gp of navigator.getGamepads()) {
        if (!gp) continue;
        const both = gp.buttons[10]?.pressed && gp.buttons[11]?.pressed;
        if (both && !rumbled.has(gp.index)) {
          rumbled.add(gp.index);
          void gp.vibrationActuator?.playEffect('dual-rumble', { duration: 500, strongMagnitude: 1, weakMagnitude: 1 }).catch(() => undefined);
        } else if (!both) rumbled.delete(gp.index);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      resume();
    };
  }, []);

  const kernel = linux.data?.gamepads ?? [];

  return (
    <Modal title="Controllers" onClose={onClose} wide>
      <p className="modal-sub">
        {kernel.length
          ? `The TV sees ${kernel.length} controller${kernel.length === 1 ? '' : 's'}: ${kernel.join(', ')}.`
          : pads.length
            ? ''
            : 'The TV doesn’t see any controllers. Plug one in, or pair it over Bluetooth.'}{' '}
        Press any button on each one to wake it up here. Press both sticks in to test rumble.
      </p>
      <div className="pad-list">
        {pads.length === 0 ? <div className="pad-empty">Waiting for a button press…</div> : null}
        {pads.map((p, n) => (
          <PadCard key={p.index} pad={p} player={n + 1} />
        ))}
      </div>
      <div className="modal-actions">
        <Button onClick={onClose} autoFocus>Done</Button>
        <span className="pad-exit">
          Hold <b>B</b> to exit
          <span className="pad-exit-bar">
            <span style={{ width: `${holding * 100}%` }} />
          </span>
        </span>
      </div>
    </Modal>
  );
}

const on = (v: number | undefined) => (v ?? 0) > 0.5;

function PadCard({ pad, player }: { pad: PadView; player: number }) {
  const b = pad.buttons;
  const name = pad.id.replace(/\s*\(.*?Vendor.*\)\s*$/i, '').trim() || pad.id;
  return (
    <div className="pad-card">
      <div className="pad-head">
        <span className="pad-player">Player {player}</span>
        <span className="pad-name">{name}</span>
      </div>
      {pad.standard ? (
        <div className="pad">
          <div className="pad-shoulders">
            <Trigger label="LT" value={b[6]} />
            <Key label="LB" lit={on(b[4])} />
            <span className="pad-spacer" />
            <Key label="RB" lit={on(b[5])} />
            <Trigger label="RT" value={b[7]} />
          </div>
          <div className="pad-body">
            <div className="pad-cluster">
              <Stick x={pad.axes[0]} y={pad.axes[1]} pressed={on(b[10])} />
              <div className="pad-dpad">
                <Key label="▲" lit={on(b[12])} style="up" />
                <Key label="◀" lit={on(b[14])} style="left" />
                <Key label="▶" lit={on(b[15])} style="right" />
                <Key label="▼" lit={on(b[13])} style="down" />
              </div>
            </div>
            <div className="pad-middle">
              <Key label="View" lit={on(b[8])} />
              <Key label="Guide" lit={on(b[16])} />
              <Key label="Menu" lit={on(b[9])} />
            </div>
            <div className="pad-cluster">
              <div className="pad-face">
                <Key label="Y" lit={on(b[3])} style="up" color="#f5c84c" />
                <Key label="X" lit={on(b[2])} style="left" color="#4c9df5" />
                <Key label="B" lit={on(b[1])} style="right" color="#f55c5c" />
                <Key label="A" lit={on(b[0])} style="down" color="#5cd67a" />
              </div>
              <Stick x={pad.axes[2]} y={pad.axes[3]} pressed={on(b[11])} />
            </div>
          </div>
        </div>
      ) : (
        <div className="pad-raw">
          {b.map((v, i) => (
            <Key key={i} label={String(i)} lit={on(v)} />
          ))}
          {pad.axes.map((v, i) => (
            <Trigger key={`a${i}`} label={`Axis ${i}`} value={(v + 1) / 2} />
          ))}
        </div>
      )}
    </div>
  );
}

function Key({ label, lit, style, color }: { label: string; lit: boolean; style?: string; color?: string }) {
  return (
    <span className={`pad-key ${style ? `pad-${style}` : ''} ${lit ? 'lit' : ''}`} style={color ? ({ '--key': color } as React.CSSProperties) : undefined}>
      {label}
    </span>
  );
}

function Trigger({ label, value = 0 }: { label: string; value?: number }) {
  return (
    <span className="pad-trigger">
      <span className="pad-trigger-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      <span className="pad-trigger-label">{label}</span>
    </span>
  );
}

function Stick({ x = 0, y = 0, pressed }: { x?: number; y?: number; pressed: boolean }) {
  // Values above ~0.15 at rest mean stick drift; show the numbers so it's obvious.
  const drift = Math.hypot(x, y);
  return (
    <span className={`pad-stick ${pressed ? 'lit' : ''}`}>
      <span className="pad-stick-dot" style={{ transform: `translate(${x * 1.3}rem, ${y * 1.3}rem)` }} />
      <span className={`pad-stick-val ${drift > 0.15 && drift < 0.5 ? 'warn' : ''}`}>
        {x.toFixed(2)}, {y.toFixed(2)}
      </span>
    </span>
  );
}
