/**
 * Captures the microphone as 16 kHz mono signed 16-bit PCM, which is what
 * Home Assistant's Assist pipeline expects. Chunks are ~100 ms each.
 */

const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export interface MicStream {
  stop(): void;
}

export async function startMic(onChunk: (pcm: ArrayBuffer) => void): Promise<MicStream> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // Asking for a 16 kHz context makes the browser resample the mic for us.
  const ctx = new AudioContext({ sampleRate: 16000 });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(media);
  const node = new AudioWorkletNode(ctx, 'pcm-tap');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(ctx.destination);

  let pending: Float32Array[] = [];
  let pendingLen = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    pending.push(e.data);
    pendingLen += e.data.length;
    if (pendingLen < 1600) return;
    const out = new Int16Array(pendingLen);
    let o = 0;
    for (const chunk of pending) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    pending = [];
    pendingLen = 0;
    onChunk(out.buffer);
  };

  return {
    stop() {
      node.port.onmessage = null;
      media.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
