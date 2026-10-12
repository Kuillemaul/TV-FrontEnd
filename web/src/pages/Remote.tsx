import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';

type Cmd = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home' | 'voice' | 'playpause' | 'volumeUp' | 'volumeDown' | 'mute' | 'text';

async function send(cmd: Cmd, text?: string): Promise<boolean> {
  const res = await fetch('/api/remote/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, text }),
  });
  return res.ok;
}

const buzz = () => navigator.vibrate?.(12);

/**
 * Phone remote (open http://<tv>:8787/remote on your phone). Pair once with the code
 * shown in Settings on the TV, then: D-pad, OK, back, home, voice, volume, and typing.
 */
export function RemotePage() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    document.title = 'Hearth Remote';
    fetch('/api/info').then((r) => setPaired(r.ok)).catch(() => setPaired(false));
  }, []);

  const pair = async () => {
    const res = await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: navigator.userAgent.match(/\(([^;)]+)/)?.[1] ?? 'Phone' }),
    });
    const body = await res.json();
    if (body.ok) setPaired(true);
    else setError(body.error ?? 'That code didn’t match');
  };

  const press = (cmd: Cmd) => () => {
    buzz();
    void send(cmd).then((ok) => !ok && setPaired(false));
  };

  if (paired === null) return <div className="remote" />;

  if (!paired) {
    return (
      <div className="remote remote-pair">
        <div className="brand">
          <span className="brand-mark" /> Hearth
        </div>
        <h1>Pair this phone</h1>
        <p>On the TV, open Settings → Phone remote and enter the 4-digit code shown there.</p>
        <input
          className="remote-code"
          inputMode="numeric"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="••••"
          autoFocus
        />
        {error ? <div className="form-error">{error}</div> : null}
        <button className="remote-wide primary" disabled={code.length !== 4} onClick={() => void pair()}>
          Pair
        </button>
      </div>
    );
  }

  return (
    <div className="remote">
      <div className="remote-top">
        <button className="remote-key" onClick={press('back')} aria-label="Back">
          ←
        </button>
        <button className="remote-key" onClick={press('home')} aria-label="Home">
          <Icon name="home" />
        </button>
        <button className="remote-key" onClick={press('voice')} aria-label="Voice">
          <Icon name="mic" />
        </button>
      </div>

      <div className="dpad">
        <button className="dpad-up" onClick={press('up')} aria-label="Up">▲</button>
        <button className="dpad-left" onClick={press('left')} aria-label="Left">◀</button>
        <button className="dpad-ok" onClick={press('ok')}>OK</button>
        <button className="dpad-right" onClick={press('right')} aria-label="Right">▶</button>
        <button className="dpad-down" onClick={press('down')} aria-label="Down">▼</button>
      </div>

      <div className="remote-top">
        <button className="remote-key" onClick={press('volumeDown')} aria-label="Volume down">
          <Icon name="volumeDown" />
        </button>
        <button className="remote-key" onClick={press('playpause')} aria-label="Play/pause">
          <Icon name="play" />
        </button>
        <button className="remote-key" onClick={press('mute')} aria-label="Mute">
          <Icon name="mute" />
        </button>
        <button className="remote-key" onClick={press('volumeUp')} aria-label="Volume up">
          <Icon name="volumeUp" />
        </button>
      </div>

      <form
        className="remote-type"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          buzz();
          void send('text', text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type on the TV or say a command…" />
        <button className="primary">Send</button>
      </form>
      <p className="remote-hint">Typing goes into the box selected on the TV, or runs as a command (“play Mario Kart”).</p>
    </div>
  );
}
