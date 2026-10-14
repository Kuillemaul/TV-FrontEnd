/**
 * Soft interface sounds, made on the fly with Web Audio (no files): a tick when the highlight moves,
 * a click when something is chosen, a lower note for Back. Switched off in Settings → Look & apps.
 */

export type UiSound = 'move' | 'select' | 'back';

let enabled = true;
let ctx: AudioContext | null = null;
let lastMove = 0;

export function setUiSoundsEnabled(on: boolean): void {
  enabled = on;
}

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(c: AudioContext, freq: number, start: number, length: number, volume: number, type: OscillatorType = 'sine'): void {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(volume, start + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + length + 0.02);
}

export function playUiSound(kind: UiSound): void {
  if (!enabled) return;
  // Holding a direction repeats quickly: keep the ticks from turning into a buzz.
  if (kind === 'move') {
    const now = performance.now();
    if (now - lastMove < 55) return;
    lastMove = now;
  }
  const c = context();
  if (!c) return;
  const t = c.currentTime + 0.005;
  if (kind === 'move') tone(c, 1320, t, 0.045, 0.035);
  else if (kind === 'select') {
    tone(c, 880, t, 0.07, 0.06, 'triangle');
    tone(c, 1320, t + 0.045, 0.09, 0.05, 'triangle');
  } else {
    tone(c, 740, t, 0.07, 0.05, 'triangle');
    tone(c, 494, t + 0.05, 0.1, 0.045, 'triangle');
  }
}
