import { execFile, spawn } from 'node:child_process';

/**
 * Sound output control through PipeWire's PulseAudio interface (pactl/pacat from pulseaudio-utils).
 * A sound card has profiles like "output:hdmi-surround-extra1"; we present them as ports
 * (HDMI 1/2/3, analog, optical…) each with the channel layouts it supports.
 */

export interface AudioLayout {
  channels: number;
  label: string;
  profile: string;
}

export interface AudioOutput {
  id: string;
  card: string;
  label: string;
  /** Something is plugged into this port. */
  available: boolean;
  layouts: AudioLayout[];
}

export interface AudioStatus {
  available: boolean;
  error?: string;
  outputs: AudioOutput[];
  current: { outputId: string; channels: number } | null;
  sink: { name: string; description: string; channels: string[]; volume: number; muted: boolean } | null;
}

interface PactlProfile {
  description?: string;
  sinks?: number;
  available?: boolean | string;
}

export interface PactlCard {
  name: string;
  description?: string;
  properties?: Record<string, string>;
  profiles?: Record<string, PactlProfile>;
  active_profile?: string;
}

export interface PactlSink {
  name: string;
  description?: string;
  channel_map?: string | string[];
  mute?: boolean;
  volume?: Record<string, { value_percent?: string }>;
  properties?: Record<string, string>;
}

const LAYOUT_LABEL: Record<number, string> = { 2: 'Stereo', 6: '5.1 surround', 8: '7.1 surround' };

/** "hdmi-surround71-extra1" → port "hdmi-extra1", 8 channels. */
function parseOutputProfile(base: string): { port: string; portLabel: string; channels: number } | null {
  let m = /^hdmi-(stereo|surround|surround71)(?:-extra(\d+))?$/.exec(base);
  if (m) {
    const n = m[2] ? Number(m[2]) + 1 : 1;
    return { port: `hdmi${m[2] ? `-extra${m[2]}` : ''}`, portLabel: `HDMI ${n}`, channels: m[1] === 'stereo' ? 2 : m[1] === 'surround' ? 6 : 8 };
  }
  m = /^analog-(stereo|surround-51|surround-71)$/.exec(base);
  if (m) return { port: 'analog', portLabel: 'Headphone / line out', channels: m[1] === 'stereo' ? 2 : m[1] === 'surround-51' ? 6 : 8 };
  if (base === 'iec958-stereo') return { port: 'iec958', portLabel: 'Optical (S/PDIF)', channels: 2 };
  return null;
}

const isYes = (v: boolean | string | undefined) => v === true || v === 'yes' || v === undefined;

/** Turn pactl's card list into ports with their channel layouts. */
export function parseOutputs(cards: PactlCard[]): AudioOutput[] {
  const outputs: AudioOutput[] = [];
  for (const card of cards) {
    const builtin = card.name.startsWith('alsa_card.pci');
    const byPort = new Map<string, AudioOutput>();
    for (const [profile, info] of Object.entries(card.profiles ?? {})) {
      if (!profile.startsWith('output:') || profile.includes('+input:')) continue;
      const parsed = parseOutputProfile(profile.slice('output:'.length));
      const port = parsed?.port ?? profile;
      const id = `${card.name}|${port}`;
      let out = byPort.get(id);
      if (!out) {
        const label = parsed?.portLabel ?? info.description ?? profile;
        out = { id, card: card.name, label: builtin ? label : `${card.description ?? card.name} · ${label}`, available: false, layouts: [] };
        byPort.set(id, out);
      }
      out.available ||= isYes(info.available);
      const channels = parsed?.channels ?? 2;
      if (!out.layouts.some((l) => l.channels === channels)) out.layouts.push({ channels, label: LAYOUT_LABEL[channels] ?? `${channels} channels`, profile });
    }
    // Bluetooth/USB devices whose profiles aren't "output:…" (e.g. a2dp-sink): one port per card.
    if (byPort.size === 0 && !card.name.startsWith('alsa_card.')) {
      const profile = Object.entries(card.profiles ?? {}).find(([name, p]) => name !== 'off' && (p.sinks ?? 0) > 0)?.[0];
      if (profile) {
        byPort.set(card.name, { id: `${card.name}|${profile}`, card: card.name, label: card.description ?? card.name, available: true, layouts: [{ channels: 2, label: 'Stereo', profile }] });
      }
    }
    for (const out of byPort.values()) {
      out.layouts.sort((a, b) => a.channels - b.channels);
      outputs.push(out);
    }
  }
  return outputs.sort((a, b) => Number(b.available) - Number(a.available));
}

/** Which port/layout a card's active profile corresponds to. */
export function currentOutput(outputs: AudioOutput[], card: PactlCard): { outputId: string; channels: number } | null {
  const active = card.active_profile?.split('+input:')[0];
  for (const out of outputs) {
    if (out.card !== card.name) continue;
    const layout = out.layouts.find((l) => l.profile === active);
    if (layout) return { outputId: out.id, channels: layout.channels };
  }
  return null;
}

/** The profile to switch to, keeping a microphone input (e.g. "+input:analog-stereo") if one is in use. */
export function profileToApply(card: PactlCard, outputProfile: string): string {
  const input = card.active_profile?.split('+input:')[1];
  const withInput = input ? `${outputProfile}+input:${input}` : '';
  return withInput && card.profiles?.[withInput] ? withInput : outputProfile;
}

export function sinkBelongsTo(sink: PactlSink, card: PactlCard): boolean {
  const props = sink.properties ?? {};
  if (props['device.name'] === card.name) return true;
  const id = card.name.replace(/^[a-z]+_card\./, '');
  return sink.name.includes(id);
}

export const channelList = (map: PactlSink['channel_map']): string[] =>
  Array.isArray(map) ? map : (map ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * One speaker's test sound: a soft two-note chime (or a low hum for the subwoofer) in channel
 * `channel` only, silence everywhere else. Interleaved signed 16-bit little-endian PCM.
 */
export function testTone(channels: number, channel: number, lfe: boolean, rate = 48000): Buffer {
  const seconds = 1.1;
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    let s: number;
    if (lfe) {
      const env = Math.min(1, t / 0.05) * Math.min(1, (seconds - t) / 0.15);
      s = Math.sin(2 * Math.PI * 50 * t) * env * 0.8;
    } else {
      const note = (start: number, freq: number) => (t < start ? 0 : Math.sin(2 * Math.PI * freq * (t - start)) * Math.exp(-(t - start) * 4) * Math.min(1, (t - start) / 0.005));
      s = (note(0, 880) + note(0.22, 1318.5)) * 0.4;
    }
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), (i * channels + channel) * 2);
  }
  return buf;
}

function pactl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'Sound controls need pactl: sudo apt install pulseaudio-utils' : stderr.trim() || err.message));
      } else resolve(stdout);
    });
  });
}

const json = async <T>(what: string): Promise<T> => JSON.parse(await pactl(['-f', 'json', 'list', what])) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AudioControl {
  async status(): Promise<AudioStatus> {
    try {
      const [cards, sinks, defaultSink] = await Promise.all([json<PactlCard[]>('cards'), json<PactlSink[]>('sinks'), pactl(['get-default-sink'])]);
      const outputs = parseOutputs(cards);
      const sink = sinks.find((s) => s.name === defaultSink.trim()) ?? null;
      const owner = sink ? cards.find((c) => sinkBelongsTo(sink, c)) : undefined;
      const volumes = Object.values(sink?.volume ?? {}).map((v) => parseInt(v.value_percent ?? '0', 10));
      return {
        available: true,
        outputs,
        current: owner ? currentOutput(outputs, owner) : null,
        sink: sink
          ? {
              name: sink.name,
              description: sink.description ?? sink.name,
              channels: channelList(sink.channel_map),
              volume: volumes.length ? Math.max(...volumes) : 0,
              muted: Boolean(sink.mute),
            }
          : null,
      };
    } catch (err) {
      return { available: false, error: (err as Error).message, outputs: [], current: null, sink: null };
    }
  }

  /** Switch the card to the chosen port/layout, make it the default output and move playing audio to it. */
  async setOutput(outputId: string, channels: number): Promise<void> {
    const cards = await json<PactlCard[]>('cards');
    const out = parseOutputs(cards).find((o) => o.id === outputId);
    const layout = out?.layouts.find((l) => l.channels === channels) ?? out?.layouts[0];
    const card = cards.find((c) => c.name === out?.card);
    if (!out || !layout || !card) throw new Error('That output isn’t available');
    await pactl(['set-card-profile', card.name, profileToApply(card, layout.profile)]);

    // The new sink shows up a moment after the profile switch.
    let sink: PactlSink | undefined;
    for (let i = 0; i < 20 && !sink; i++) {
      sink = (await json<PactlSink[]>('sinks')).find((s) => sinkBelongsTo(s, card));
      if (!sink) await sleep(150);
    }
    if (!sink) throw new Error('The output switched but didn’t appear. Try again.');
    await pactl(['set-default-sink', sink.name]);
    await pactl(['set-sink-mute', sink.name, '0']);
    const inputs = await pactl(['list', 'short', 'sink-inputs']);
    for (const line of inputs.split('\n')) {
      const id = line.split('\t')[0];
      if (id) await pactl(['move-sink-input', id, sink.name]).catch(() => undefined);
    }
  }

  /**
   * Put the remembered output back if the sound system has drifted from it (after a reboot, or
   * when the TV is switched on later and HDMI comes back with a default profile). Leaves it alone
   * while the remembered port has nothing plugged in. Returns true when it switched.
   */
  async restore(choice: { outputId: string; channels: number } | undefined): Promise<boolean> {
    if (!choice) return false;
    const now = await this.status();
    if (!now.available) return false;
    const out = now.outputs.find((o) => o.id === choice.outputId);
    if (!out?.available) return false;
    if (now.current?.outputId === choice.outputId && now.current.channels === choice.channels) return false;
    await this.setOutput(choice.outputId, choice.channels);
    return true;
  }

  async setVolume(percent: number): Promise<void> {
    await pactl(['set-sink-volume', '@DEFAULT_SINK@', `${Math.max(0, Math.min(100, Math.round(percent)))}%`]);
    await pactl(['set-sink-mute', '@DEFAULT_SINK@', '0']);
  }

  async setMute(muted: boolean): Promise<void> {
    await pactl(['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
  }

  /** Play the test sound on one speaker of the current output. */
  async test(channel: number): Promise<void> {
    const status = await this.status();
    if (!status.sink) throw new Error(status.error ?? 'No sound output');
    const map = status.sink.channels;
    if (channel < 0 || channel >= map.length) throw new Error('No such speaker');
    const pcm = testTone(map.length, channel, map[channel] === 'lfe');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'pacat',
        ['--playback', `--device=${status.sink!.name}`, '--format=s16le', '--rate=48000', `--channels=${map.length}`, `--channel-map=${map.join(',')}`, '--latency-msec=100'],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('error', (err) => reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Sound test needs pacat: sudo apt install pulseaudio-utils') : err));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `pacat exited ${code}`))));
      proc.stdin.end(pcm);
    });
  }
}
