import { useEffect, useRef, type ReactNode } from 'react';
import { formatTime, post, useApi } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { focusFirst } from '../nav/spatial';
import { Icon } from './Icon';
import { useBack } from './Layout';

interface AudioState {
  available: boolean;
  sink: { volume: number; muted: boolean } | null;
}

const SLEEP_CHOICES = [15, 30, 60, 90];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="theme-section">
      <h3>{title}</h3>
      <div className="quick-row" data-nav-group>
        {children}
      </div>
    </section>
  );
}

function QuickButton({ icon, label, active, onClick, autoFocus }: { icon?: string; label: string; active?: boolean; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button type="button" className={`quick-btn ${active ? 'quick-btn-on' : ''}`} data-nav data-nav-default={autoFocus || undefined} onClick={onClick}>
      {icon ? <Icon name={icon} size="1.3em" /> : null}
      <span>{label}</span>
    </button>
  );
}

/**
 * Everyday controls in one place (Menu / X with nothing to pin, or the sliders button in the top bar):
 * sleep timer, volume, TV power, movie-time lights, the doorbell camera, profile and notifications.
 */
export function QuickPanel({
  sleepEndsAt,
  unread,
  onClose,
  onSwitchProfile,
  onTheme,
  onNotifications,
}: {
  sleepEndsAt: number | null;
  unread: number;
  onClose: () => void;
  onSwitchProfile: () => void;
  onTheme: () => void;
  onNotifications: () => void;
}) {
  const hearth = useHearth();
  const ref = useRef<HTMLDivElement>(null);
  const audio = useApi<AudioState>('/api/audio');
  const settings = useApi<{ scenes: boolean }>('/api/settings');
  const h24 = hearth.info?.clock24h ?? false;
  const camera = hearth.info?.features.doorbellCamera;
  useBack(ref, onClose);

  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
  }, []);

  const act = async (path: string, body: unknown, done?: string) => {
    const res = await post(path, body);
    if (!res.ok) hearth.toast(res.error ?? 'That didn’t work', 'error');
    else if (done) hearth.toast(done);
    return res.ok;
  };
  const sleepMinutes = sleepEndsAt ? Math.max(1, Math.ceil((sleepEndsAt - Date.now()) / 60_000)) : 0;
  const sink = audio.data?.available ? audio.data.sink : null;
  const volume = async (delta: number) => {
    if (!sink) return;
    if (await act('/api/audio/volume', { percent: sink.volume + delta })) void audio.reload();
  };

  return (
    <div className="theme-backdrop" onClick={onClose}>
      <aside className="theme-panel quick-panel" data-nav-scope ref={ref} onClick={(e) => e.stopPropagation()} aria-label="Quick settings">
        <h2 className="theme-title">Quick settings</h2>

        <Section title={sleepEndsAt ? `Sleep timer · off at ${formatTime(sleepEndsAt, h24)} (${sleepMinutes} min)` : 'Sleep timer'}>
          <QuickButton icon="moon" label="Off" active={!sleepEndsAt} onClick={() => void act('/api/sleep', { minutes: 0 })} autoFocus />
          {SLEEP_CHOICES.map((m) => (
            <QuickButton key={m} label={m < 60 ? `${m} min` : `${m / 60} h`.replace('1.5 h', '1½ h')} onClick={() => void act('/api/sleep', { minutes: m })} />
          ))}
        </Section>

        {sink ? (
          <Section title={`Sound · ${sink.muted ? 'muted' : `${sink.volume}%`}`}>
            <QuickButton icon="volumeDown" label="Quieter" onClick={() => void volume(-5)} />
            <QuickButton icon="volumeUp" label="Louder" onClick={() => void volume(5)} />
            <QuickButton
              icon="mute"
              label={sink.muted ? 'Unmute' : 'Mute'}
              active={sink.muted}
              onClick={() => void act('/api/audio/mute', { muted: !sink.muted }).then((ok) => {
                if (ok) void audio.reload();
              })}
            />
          </Section>
        ) : null}

        <Section title="TV">
          <QuickButton icon="power" label="Turn TV off" onClick={() => void act('/api/tv-control/off', {})} />
          <QuickButton icon="tv" label="Switch to Hearth" onClick={() => void act('/api/tv-control/hearth', {})} />
        </Section>

        {!hearth.isKid && (hearth.info?.setup.homeassistant || camera) ? (
          <Section title="Home">
            {hearth.info?.setup.homeassistant && settings.data ? (
              <QuickButton
                icon="bulb"
                label="Movie-time lights"
                active={settings.data.scenes}
                onClick={async () => {
                  const res = await post('/api/settings', { scenes: !settings.data!.scenes }, 'PUT');
                  if (!res.ok) hearth.toast(res.error ?? 'Couldn’t change that', 'error');
                  void settings.reload();
                }}
              />
            ) : null}
            {camera ? (
              <QuickButton
                icon="camera"
                label="Doorbell camera"
                onClick={() => {
                  onClose();
                  void act('/api/pip', { entity: camera, name: 'Doorbell' });
                }}
              />
            ) : null}
          </Section>
        ) : null}

        <Section title={hearth.profile ? `${hearth.profile.name}` : 'Profile'}>
          {(hearth.profiles?.profiles.length ?? 0) > 1 ? <QuickButton icon="refresh" label="Switch profile" onClick={onSwitchProfile} /> : null}
          <QuickButton icon="palette" label="Theme" onClick={onTheme} />
          <QuickButton icon="bell" label={unread ? `Notifications (${unread} new)` : 'Notifications'} active={unread > 0} onClick={onNotifications} />
        </Section>
      </aside>
    </div>
  );
}
