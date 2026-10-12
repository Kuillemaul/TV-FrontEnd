import { useRef } from 'react';
import { Icon } from './Icon';
import { Button, useBack } from './Layout';

export interface LaunchProgress {
  hostId: string;
  gameId: string;
  title: string;
  stage: 'starting' | 'waking' | 'launching' | 'streaming' | 'ended' | 'error';
  message: string;
}

const STEPS: Array<{ stage: LaunchProgress['stage']; label: string }> = [
  { stage: 'waking', label: 'Wake PC' },
  { stage: 'launching', label: 'Start game' },
  { stage: 'streaming', label: 'Connect stream' },
];

/** Full-screen progress while a PC wakes, starts the game and Moonlight connects. */
export function GameLaunch({ progress, onClose }: { progress: LaunchProgress; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useBack(ref, onClose);
  const current = STEPS.findIndex((s) => s.stage === progress.stage);
  const failed = progress.stage === 'error';
  return (
    <div className="launch-overlay" data-nav-scope ref={ref}>
      <div className="launch-card">
        <div className="launch-title">{progress.title}</div>
        <div className="launch-steps">
          {STEPS.map((s, i) => (
            <div key={s.stage} className={`launch-step ${i < current ? 'done' : i === current ? 'active' : ''}`}>
              <span className="launch-step-dot">{i < current ? <Icon name="check" size="1em" /> : i + 1}</span>
              {s.label}
            </div>
          ))}
        </div>
        <div className={`launch-message ${failed ? 'error' : ''}`}>
          {!failed ? <span className="spinner" /> : null}
          {progress.message}
        </div>
        {failed ? (
          <div className="modal-actions">
            <Button variant="primary" onClick={onClose} autoFocus>
              OK
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
