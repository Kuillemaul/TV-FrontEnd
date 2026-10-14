import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { formatMinutes, post, useApi, useServerEvents, type Profile, type ScreenTimeStatus, type TvSettings } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Button } from './Layout';
import { LimitsEditor } from './ScreenTime';

function Toggle({ label, detail, on, onChange }: { label: string; detail: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className="editor-card" data-nav onClick={() => onChange(!on)}>
      <span className="editor-card-text">
        <span className="editor-card-title">{label}</span>
        <span className="editor-card-detail">{detail}</span>
      </span>
      <span className={`toggle ${on ? 'on' : ''}`} />
    </button>
  );
}

/** Settings sections for screen time, TV power, automations, alerts and the phone remote. */
/** One part of Settings: family screen time, TV power, alerts & automations, or the phone remote. */
export function SettingsExtras({ part }: { part: 'family' | 'tv' | 'alerts' | 'remote' | 'look' }) {
  const hearth = useHearth();
  const { data: settings, setData: setSettings } = useApi<TvSettings>('/api/settings');
  const { data: st, reload: reloadSt } = useApi<{ profiles: Array<ScreenTimeStatus & { name: string }> }>('/api/screentime', 30_000);
  const [limitsFor, setLimitsFor] = useState<Profile | null>(null);
  useServerEvents((e) => (e.type === 'screentime' || e.type === 'profiles') && void reloadSt());

  const update = async (patch: Partial<TvSettings>) => {
    if (settings) setSettings({ ...settings, ...patch });
    await post('/api/settings', patch, 'PUT');
  };
  const kids = hearth.profiles?.profiles.filter((p) => p.kind === 'kid') ?? [];

  return (
    <>
      {part === 'family' && kids.length ? (
        <section className="settings-group">
          <h2>Screen time</h2>
          <div className="st-list">
            {kids.map((k) => {
              const s = st?.profiles.find((x) => x.profileId === k.id);
              const limit = s?.limitMinutes;
              return (
                <div className="st-row" key={k.id} data-nav-group>
                  <div className="st-text">
                    <div className="st-name">{k.name}</div>
                    <div className="st-sub">
                      {s ? `${formatMinutes(s.usedMinutes)} today${limit != null ? ` of ${formatMinutes(limit)}` : ' · no daily limit'}` : '…'}
                      {s?.bedtime ? ` · bedtime ${s.bedtime}` : ''}
                    </div>
                    {limit ? (
                      <div className="st-bar">
                        <div style={{ width: `${Math.min(100, ((s?.usedMinutes ?? 0) / limit) * 100)}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <Button onClick={() => void post(`/api/screentime/${k.id}/bonus`, { minutes: 15 })}>+15 min</Button>
                  <Button onClick={() => void post(`/api/screentime/${k.id}/bonus`, { minutes: 30 })}>+30 min</Button>
                  <Button icon="moon" onClick={() => setLimitsFor(k)}>
                    Limits
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {part === 'tv' ? (
      <section className="settings-group">
        <h2>TV</h2>
        <div className="settings-row" data-nav-group>
          <Button icon="power" onClick={() => void post('/api/tv-control/off')}>
            Turn TV off
          </Button>
          <Button icon="power" onClick={() => void post('/api/tv-control/on')}>
            Turn TV on
          </Button>
          <Button icon="tv" onClick={() => void post('/api/tv-control/hearth')}>
            Switch TV to Hearth
          </Button>
        </div>
        <p className="modal-sub">Uses HDMI-CEC (needs the Pulse-Eight USB adapter). Other inputs like an Xbox can be added as app tiles in config.yaml.</p>
      </section>
      ) : null}

      {part === 'alerts' ? (
      <section className="settings-group">
        <h2>Automations & alerts</h2>
        <div className="editor-grid" data-nav-group>
          <Toggle
            label="Movie-time lights"
            detail="Run your scenes when Plex, Live TV or games start and stop"
            on={settings?.scenes ?? true}
            onChange={(scenes) => void update({ scenes })}
          />
          <Toggle
            label="Alerts over apps"
            detail="Doorbell & alerts pop up even during a game"
            on={settings?.alertsOverApps ?? true}
            onChange={(alertsOverApps) => void update({ alertsOverApps })}
          />
          <Toggle
            label="Wake word"
            detail={hearth.info?.features.wakeWordAvailable ? 'Always listening for your Home Assistant wake word' : 'Needs Home Assistant with openWakeWord'}
            on={settings?.wakeWord ?? false}
            onChange={(wakeWord) => void update({ wakeWord })}
          />
        </div>
        <div className="settings-row" data-nav-group style={{ marginTop: '0.8rem' }}>
          <Button icon="doorbell" variant="ghost" onClick={() => void post('/api/alerts/test', { kind: 'doorbell' })}>
            Test doorbell
          </Button>
          <Button icon="bell" variant="ghost" onClick={() => void post('/api/alerts/test', { kind: 'info' })}>
            Test alert
          </Button>
          <Button icon="play" variant="ghost" onClick={() => void post('/api/alerts/test', { kind: 'ready' })}>
            Test “ready to watch”
          </Button>
        </div>
      </section>
      ) : null}

      {part === 'remote' ? <PhoneRemote /> : null}

      {part === 'look' ? (
        <section className="settings-group">
          <h2>Sounds</h2>
          <div className="editor-grid" data-nav-group>
            <Toggle
              label="Interface sounds"
              detail="A soft tick when moving around, a click when choosing, a note for Back"
              on={settings?.uiSounds ?? true}
              onChange={(uiSounds) => void update({ uiSounds })}
            />
          </div>
        </section>
      ) : null}
      {limitsFor ? <LimitsEditor profile={limitsFor} onClose={() => setLimitsFor(null)} /> : null}
    </>
  );
}

function PhoneRemote() {
  const hearth = useHearth();
  const { data, reload } = useApi<{ code: string; url: string | null; reachable: boolean; paired: number }>('/api/remote/pairing', 20_000);
  const [qr, setQr] = useState('');

  useEffect(() => {
    if (data?.url) QRCode.toDataURL(data.url, { margin: 1, width: 240, color: { dark: '#000', light: '#fff' } }).then(setQr).catch(() => setQr(''));
  }, [data?.url]);

  if (!data) return null;
  return (
    <section className="settings-group">
      <h2>Phone remote</h2>
      <div className="remote-pairing">
        {qr && data.reachable ? <img className="qr" src={qr} alt="QR code for the phone remote" /> : null}
        <div>
          {data.reachable ? (
            <>
              <p className="modal-text">
                Scan the code (or open <strong>{data.url}</strong>) on your phone, then enter:
              </p>
              <div className="pair-code">{data.code}</div>
            </>
          ) : (
            <>
              <p className="modal-text">Use your phone as a remote: Hearth needs to answer phones on your network. Phones still have to pair with a code shown here before they can control anything.</p>
              <div className="settings-row" data-nav-group>
                <Button
                  icon="check"
                  onClick={async () => {
                    const r = await post('/api/setup/phone-remote');
                    hearth.toast(r.ok ? 'Turning on the phone remote… Hearth restarts for a moment' : (r.error ?? 'Couldn’t turn it on'), r.ok ? 'info' : 'error');
                  }}
                >
                  Turn on phone remote
                </Button>
              </div>
            </>
          )}
          <p className="modal-sub">{data.paired ? `${data.paired} phone${data.paired > 1 ? 's' : ''} paired.` : 'No phones paired yet.'}</p>
          {data.paired ? (
            <Button
              variant="ghost"
              onClick={async () => {
                await post('/api/remote/tokens', {}, 'DELETE');
                void reload();
              }}
            >
              Forget all phones
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
