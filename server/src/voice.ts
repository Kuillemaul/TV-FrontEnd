import type { WebSocket } from 'ws';
import { matchIntent, type IntentCatalog, type UiAction } from './intents.js';
import type { HomeAssistant } from './providers/homeassistant.js';

export interface VoiceResult {
  text: string;
  speech: string;
  action?: UiAction;
  /** URL (proxied through Hearth) of a spoken reply. */
  audio?: string;
}

/**
 * Voice pipeline:
 *   mic (browser, 16 kHz PCM) → Hearth → HA Assist STT → transcript
 *   transcript → local TV intents, else → HA conversation agent → reply (+ optional TTS)
 */
export class VoiceService {
  private conversationId?: string;

  constructor(
    private readonly ha: HomeAssistant | undefined,
    private readonly catalog: () => Promise<IntentCatalog>,
    private readonly allowHome: () => boolean = () => true,
  ) {}

  async process(text: string): Promise<VoiceResult> {
    const local = matchIntent(text, await this.catalog());
    if (local) return { text, speech: local.speech, action: local.action, audio: await this.tts(local.speech) };

    if (!this.allowHome()) return { text, speech: "I can open your apps and games. Try “play” and a game's name." };
    if (!this.ha?.connected) {
      return { text, speech: this.ha ? 'Home Assistant is not connected right now.' : 'I can only control the TV until Home Assistant is set up.' };
    }
    const reply = await this.ha.converse(text, this.conversationId);
    this.conversationId = reply.conversationId;
    return { text, speech: reply.speech, audio: await this.tts(reply.speech) };
  }

  private async tts(message: string): Promise<string | undefined> {
    try {
      const path = await this.ha?.ttsPath(message);
      return path ? `/api/ha/proxy?path=${encodeURIComponent(path)}` : undefined;
    } catch {
      return undefined;
    }
  }

  /** Handle one /ws/voice connection from the UI. */
  handle(socket: WebSocket): void {
    const send = (msg: object) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
    let run: ReturnType<HomeAssistant['runStt']> | null = null;

    const finish = async (text: string) => {
      run = null;
      if (!text.trim()) return send({ type: 'error', message: "Sorry, I didn't catch that." });
      send({ type: 'transcript', text });
      try {
        send({ type: 'result', ...(await this.process(text)) });
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
    };

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        run?.sendAudio(data as Buffer);
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'text') void finish(String(msg.text ?? ''));
      if (msg.type === 'stop') run?.end();
      if (msg.type === 'start') {
        if (!this.ha?.connected) {
          send({ type: 'error', message: 'Voice needs Home Assistant – type a command instead.' });
          return;
        }
        try {
          run = this.ha.runStt((type, d) => {
            if (type === 'stt-vad-start') send({ type: 'speech-start' });
            if (type === 'stt-vad-end') send({ type: 'speech-end' });
            if (type === 'stt-end') void finish(d?.stt_output?.text ?? '');
            if (type === 'error') {
              run = null;
              send({ type: 'error', message: d?.message ?? 'Voice pipeline error' });
            }
          });
          send({ type: 'listening' });
        } catch (err) {
          send({ type: 'error', message: (err as Error).message });
        }
      }
    });
    socket.on('close', () => run?.end());
  }
}
