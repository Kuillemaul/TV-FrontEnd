import { useEffect, useRef, useState } from 'react';
import { formatMinutes, post, type Limits, type MutationResult, type Profile, type ScreenTimeStatus } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { focusFirst } from '../nav/spatial';
import { Icon } from './Icon';
import { Button, Chip, Modal } from './Layout';
import { PinPad, saveProfile } from './Profiles';

/** Small "time left" chip in the top bar for kid profiles with a daily limit. */
export function TimeLeftChip({ status }: { status: ScreenTimeStatus | null }) {
  if (!status || status.remainingMinutes === null) return null;
  const low = status.remainingMinutes <= 10;
  return (
    <span className={`time-chip ${low ? 'low' : ''}`} title="Screen time left today">
      <Icon name="moon" size="1em" /> {formatMinutes(status.remainingMinutes)} left
    </span>
  );
}

/**
 * Shown when a kid's screen time runs out or it's bedtime. A parent can add time
 * on the spot with their PIN.
 */
export function TimesUp({ reason, onSwitch, onClose }: { reason: 'limit' | 'bedtime'; onSwitch: () => void; onClose: () => void }) {
  const { profile, profiles } = useHearth();
  const [asking, setAsking] = useState<null | number>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  // Only parents with a PIN can add time from here; otherwise a kid could press it themselves.
  const parent = profiles?.profiles.find((p) => p.kind === 'admin' && p.hasPin);

  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
  }, []);

  const grant = async (minutes: number, pin: string) => {
    if (!profile || !parent) return;
    const res = await post<MutationResult>(`/api/screentime/${profile.id}/bonus`, { minutes, parentId: parent.id, pin });
    if (!res.ok) return setError(res.error ?? 'Wrong PIN');
    setAsking(null);
    onClose();
  };

  return (
    <div className="timesup" data-nav-scope ref={ref}>
      <div className="timesup-moon">{reason === 'bedtime' ? '🌙' : '⏰'}</div>
      <h1>{reason === 'bedtime' ? 'It’s bedtime' : 'That’s all for today'}</h1>
      <p>{reason === 'bedtime' ? `See you in the morning, ${profile?.name ?? ''}!` : `${profile?.name ?? 'You'} used up today’s screen time. Great job stopping!`}</p>
      <div className="modal-actions center" data-nav-group>
        {parent ? (
          <>
            <Button icon="lock" onClick={() => setAsking(15)}>
              Parent: +15 min
            </Button>
            <Button icon="lock" onClick={() => setAsking(30)}>
              +30 min
            </Button>
          </>
        ) : null}
        <Button icon="refresh" onClick={onSwitch}>
          Switch profile
        </Button>
      </div>
      {asking !== null && parent ? (
        <PinPad title={`${parent.name}'s PIN to add ${asking} minutes`} error={error} onClose={() => setAsking(null)} onSubmit={(pin) => void grant(asking, pin)} />
      ) : null}
    </div>
  );
}

const DAILY = [null, 30, 60, 90, 120, 180];
const BEDTIMES = [null, '19:00', '19:30', '20:00', '20:30', '21:00', '22:00'];
const WAKE = ['06:00', '07:00', '08:00'];

/** Daily allowance and bedtime for a kid profile. */
export function LimitsEditor({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [limits, setLimits] = useState<Limits>(profile.limits ?? { dailyMinutes: null, bedtime: null, wakeTime: '07:00' });
  const set = (patch: Partial<Limits>) => {
    const next = { ...limits, ...patch };
    setLimits(next);
    void saveProfile(profile.id, { limits: next });
  };

  return (
    <Modal title={`${profile.name}'s screen time`} onClose={onClose}>
      <p className="modal-sub">Time counts while something is playing (apps, Live TV, games), not while browsing menus.</p>
      <div className="form">
        <div className="field">
          <span>Each day</span>
          <div className="chips" data-nav-group>
            {DAILY.map((m) => (
              <Chip key={String(m)} active={limits.dailyMinutes === m} onClick={() => set({ dailyMinutes: m })}>
                {m === null ? 'No limit' : formatMinutes(m)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Bedtime</span>
          <div className="chips" data-nav-group>
            {BEDTIMES.map((b) => (
              <Chip key={String(b)} active={limits.bedtime === b} onClick={() => set({ bedtime: b })}>
                {b ?? 'Off'}
              </Chip>
            ))}
          </div>
        </div>
        {limits.bedtime ? (
          <div className="field">
            <span>Until</span>
            <div className="chips" data-nav-group>
              {WAKE.map((w) => (
                <Chip key={w} active={(limits.wakeTime ?? '07:00') === w} onClick={() => set({ wakeTime: w })}>
                  {w}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="modal-actions">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
