import { useEffect, useRef, useState } from 'react';
import type { UiAction } from '../lib/api';
import { startMic, type MicStream } from '../lib/mic';
import { Icon } from './Icon';
import { Button, useBack } from './Layout';

type Phase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'done' | 'error' | 'typing';

interface Result {
  text: string;
  speech: string;
  action?: UiAction;
  audio?: string;
}

const MAX_LISTEN_MS = 10_000;

/**
 * Voice assistant overlay. Streams the mic to Hearth, which runs it through Home
 * Assistant's Assist speech-to-text, then either handles a TV command itself or
 * passes the request on to Home Assistant. You can also type a command here.
 */
export function VoiceOverlay({ onAction, onClose }: { onAction: (a: UiAction) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [typed, setTyped] = useState('');
  const ws = useRef<WebSocket | null>(null);
  const mic = useRef<MicStream | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useBack(panelRef, onClose);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  const stopMic = () => {
    mic.current?.stop();
    mic.current = null;
  };

  useEffect(() => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
    sock.binaryType = 'arraybuffer';
    ws.current = sock;
    let timeout: number | undefined;
    let closeTimer: number | undefined;

    const finishListening = () => {
      stopMic();
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'stop' }));
    };

    sock.onopen = () => sock.send(JSON.stringify({ type: 'start' }));
    sock.onmessage = async (m) => {
      const msg = JSON.parse(m.data);
      switch (msg.type) {
        case 'listening':
          try {
            mic.current = await startMic((pcm) => sock.readyState === WebSocket.OPEN && sock.send(pcm));
            setPhase('listening');
            timeout = window.setTimeout(finishListening, MAX_LISTEN_MS);
          } catch {
            setReply('No microphone found. Type a command instead.');
            setPhase('typing');
          }
          break;
        case 'speech-start':
          setPhase('hearing');
          break;
        case 'speech-end':
          clearTimeout(timeout);
          finishListening();
          setPhase('thinking');
          break;
        case 'transcript':
          stopMic();
          setTranscript(msg.text);
          setPhase('thinking');
          break;
        case 'result': {
          const r = msg as Result & { type: string };
          setReply(r.speech);
          setPhase('done');
          if (r.audio) void new Audio(r.audio).play().catch(() => {});
          if (r.action) actionRef.current(r.action);
          closeTimer = window.setTimeout(onClose, r.action ? 1500 : 6000);
          break;
        }
        case 'error':
          stopMic();
          setReply(msg.message);
          setPhase('typing');
          break;
      }
    };
    sock.onerror = () => {
      setReply('Voice service unavailable. Type a command instead.');
      setPhase('typing');
    };

    return () => {
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      stopMic();
      sock.close();
    };
  }, [onClose]);

  useEffect(() => {
    if (phase === 'typing') requestAnimationFrame(() => inputRef.current?.focus());
  }, [phase]);

  const submitTyped = () => {
    if (!typed.trim() || ws.current?.readyState !== WebSocket.OPEN) return;
    setTranscript(typed);
    setReply('');
    setPhase('thinking');
    ws.current.send(JSON.stringify({ type: 'text', text: typed }));
    setTyped('');
  };

  const label: Record<Phase, string> = {
    connecting: 'Starting…',
    listening: 'Listening…',
    hearing: 'Listening…',
    thinking: 'Thinking…',
    done: '',
    error: '',
    typing: 'Type a command',
  };

  return (
    <div className="voice-backdrop" onClick={onClose}>
      <div className="voice-panel" data-nav-scope ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className={`voice-orb voice-${phase}`}>
          <Icon name="mic" size="2.6em" />
        </div>
        <div className="voice-label">{label[phase]}</div>
        {transcript ? <div className="voice-transcript">“{transcript}”</div> : null}
        {reply ? <div className="voice-reply">{reply}</div> : null}
        <div className="voice-hints">Try “open Netflix”, “play Elden Ring”, “watch channel 4”, or “turn off the living room lights”.</div>
        <form
          className="voice-input"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <input
            ref={inputRef}
            data-nav
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type a command…"
          />
          <Button icon="check" onClick={submitTyped} variant="primary" />
          <Button icon="x" onClick={onClose} />
        </form>
      </div>
    </div>
  );
}
