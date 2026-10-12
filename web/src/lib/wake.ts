import { useEffect, useRef } from 'react';
import { startMic, type MicStream } from './mic';

/**
 * Always-listening wake word ("Hey Jarvis", "OK Nabu"… whatever your Home Assistant
 * wake word engine uses). Streams the mic to Home Assistant through Hearth; when the
 * wake word is heard, onWake opens the normal voice panel. Paused while that panel is open.
 */
export function useWakeWord(enabled: boolean, paused: boolean, onWake: () => void): void {
  const cb = useRef(onWake);
  cb.current = onWake;

  useEffect(() => {
    if (!enabled || paused) return;
    let mic: MicStream | null = null;
    let closed = false;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: 'wake-start' }));
      try {
        const m = await startMic((pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm));
        if (closed) m.stop();
        else mic = m;
      } catch {
        ws.close();
      }
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'wake-detected') cb.current();
    };

    return () => {
      closed = true;
      mic?.stop();
      ws.close();
    };
  }, [enabled, paused]);
}
