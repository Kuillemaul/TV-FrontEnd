import { useEffect, useRef, useState } from 'react';
import { post, useApi, type AudioStatus } from '../lib/api';
import { useHearth } from '../lib/hearth';
import { Button, Chip, Modal } from './Layout';

const SPEAKERS: Record<string, { label: string; area: string }> = {
  mono: { label: 'Speaker', area: '1 / 2' },
  'front-left': { label: 'Front left', area: '1 / 1' },
  'front-center': { label: 'Centre', area: '1 / 2' },
  'front-right': { label: 'Front right', area: '1 / 3' },
  'side-left': { label: 'Side left', area: '2 / 1' },
  lfe: { label: 'Subwoofer', area: '3 / 2' },
  'side-right': { label: 'Side right', area: '2 / 3' },
  'rear-left': { label: 'Rear left', area: '3 / 1' },
  'rear-center': { label: 'Rear centre', area: '3 / 2' },
  'rear-right': { label: 'Rear right', area: '3 / 3' },
};

/** Settings → Sound: output port, stereo/5.1/7.1, volume and a speaker test. */
export function SoundSettings() {
  const hearth = useHearth();
  const { data, reload, setData } = useApi<AudioStatus>('/api/audio');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const current = data?.outputs.find((o) => o.id === data.current?.outputId);

  const choose = async (outputId: string, channels: number) => {
    setBusy(true);
    const res = await post<AudioStatus & { ok: boolean; error?: string }>('/api/audio/output', { outputId, channels });
    setBusy(false);
    if (res.ok) setData(res);
    else hearth.toast(res.error ?? 'Couldn’t switch the sound output', 'error');
  };
  const volume = async (action: 'volumeUp' | 'volumeDown' | 'mute') => {
    await post(`/api/system/${action}`);
    setTimeout(() => void reload(), 150);
  };

  return (
    <section className="settings-group">
      <h2>Sound</h2>
      {data && !data.available ? <p className="modal-sub">{data.error}</p> : null}
      {data?.outputs.length && !hearth.isKid ? (
        <>
          <div className="sound-label">Output</div>
          <div className="chips sound-outputs" data-nav-group>
            {data.outputs.map((o) => (
              <Chip
                key={o.id}
                active={o.id === data.current?.outputId}
                dot={o.available ? 'on' : 'off'}
                onClick={() => {
                  // Keep the same channel layout on the new port when it has one.
                  const keep = o.layouts.find((l) => l.channels === data.current?.channels) ?? o.layouts[0];
                  void choose(o.id, keep.channels);
                }}
              >
                {o.label}
              </Chip>
            ))}
          </div>
          {current && current.layouts.length > 1 ? (
            <>
              <div className="sound-label">Speakers</div>
              <div className="chips" data-nav-group>
                {current.layouts.map((l) => (
                  <Chip key={l.channels} active={l.channels === data.current?.channels} onClick={() => void choose(current.id, l.channels)}>
                    {l.label}
                  </Chip>
                ))}
              </div>
            </>
          ) : null}
          {current && !current.available ? (
            <p className="modal-sub">Nothing seems to be plugged into {current.label}. Pick the port with the green dot.</p>
          ) : null}
        </>
      ) : null}
      <div className="settings-row" data-nav-group>
        <Button icon="volumeDown" onClick={() => void volume('volumeDown')}>Volume down</Button>
        <Button icon="volumeUp" onClick={() => void volume('volumeUp')}>Volume up</Button>
        <Button icon="mute" onClick={() => void volume('mute')}>{data?.sink?.muted ? 'Unmute' : 'Mute'}</Button>
        {data?.sink ? (
          <Button icon="play" onClick={() => setTesting(true)} disabled={busy}>
            Test speakers
          </Button>
        ) : null}
        {data?.sink ? <span className="sound-volume">{data.sink.muted ? 'Muted' : `${data.sink.volume}%`}</span> : null}
      </div>
      {testing && data?.sink ? <SpeakerTest channels={data.sink.channels} onClose={() => setTesting(false)} /> : null}
    </section>
  );
}

function SpeakerTest({ channels, onClose }: { channels: string[]; onClose: () => void }) {
  const [playing, setPlaying] = useState<number | null>(null);
  const [error, setError] = useState('');
  const cycle = useRef(0);
  useEffect(() => () => void cycle.current++, []);

  const play = async (i: number) => {
    setPlaying(i);
    const res = await post('/api/audio/test', { channel: i });
    if (!res.ok) setError(res.error ?? 'Test failed');
    return res.ok;
  };
  const one = async (i: number) => {
    const run = ++cycle.current;
    setError('');
    await play(i);
    if (cycle.current === run) setPlaying(null);
  };
  const all = async () => {
    const run = ++cycle.current;
    setError('');
    for (let i = 0; i < channels.length && cycle.current === run; i++) {
      if (!(await play(i))) break;
      await new Promise((r) => setTimeout(r, 350));
    }
    if (cycle.current === run) setPlaying(null);
  };

  return (
    <Modal title="Test speakers" onClose={onClose} wide>
      <p className="modal-sub">Pick a speaker to hear a chime from it (the subwoofer hums). If one is silent or comes from the wrong place, check its cable or your receiver’s speaker setup.</p>
      <div className="speaker-map" data-nav-group>
        <div className="speaker-you">You</div>
        {channels.map((ch, i) => {
          const s = SPEAKERS[ch];
          return (
            <button
              key={ch}
              className={`speaker ${playing === i ? 'speaker-on' : ''}`}
              style={s ? { gridArea: s.area } : undefined}
              data-nav
              onClick={() => void one(i)}
            >
              {s?.label ?? ch}
            </button>
          );
        })}
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="modal-actions" data-nav-group>
        <Button variant="primary" icon="play" autoFocus onClick={() => void all()}>
          Play all in turn
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
