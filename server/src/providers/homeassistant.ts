import WebSocket from 'ws';
import type { EventBus } from '../bus.js';
import type { HomeAssistantConfig } from '../config.js';

export interface HaEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; unit_of_measurement?: string };
  last_changed?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (msg: any) => void;

export interface PipelineRun {
  /** Send a chunk of 16 kHz mono S16LE audio. */
  sendAudio(chunk: Buffer): void;
  /** Signal end of audio (if HA's VAD hasn't already). */
  end(): void;
}

/**
 * Home Assistant client: one authenticated WebSocket for live state updates,
 * Assist pipelines and conversation, plus REST for service calls and proxies.
 */
export class HomeAssistant {
  private ws?: WebSocket;
  private nextId = 1;
  private handlers = new Map<number, Handler>();
  private states = new Map<string, HaEntity>();
  private watched = new Set<string>();
  private stateListeners = new Set<(entity: HaEntity, old: HaEntity | null) => void>();
  private retry = 1000;
  connected = false;

  constructor(
    readonly cfg: HomeAssistantConfig,
    private readonly bus: EventBus,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    extraWatched: string[] = [],
  ) {
    for (const s of cfg.dashboard) for (const c of s.cards) this.watched.add(typeof c === 'string' ? c : c.entity);
    for (const e of [...cfg.favorites, ...extraWatched]) this.watched.add(e);
    if (cfg.weather) this.watched.add(cfg.weather);
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const url = this.cfg.url.replace(/^http/, 'ws') + '/api/websocket';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'auth_required':
          ws.send(JSON.stringify({ type: 'auth', access_token: this.cfg.token }));
          break;
        case 'auth_ok':
          this.onReady();
          break;
        case 'auth_invalid':
          this.log.warn(`Home Assistant rejected the token: ${msg.message}`);
          ws.close();
          break;
        default:
          if (typeof msg.id === 'number') this.handlers.get(msg.id)?.(msg);
      }
    });
    ws.on('close', () => this.onClose());
    ws.on('error', (err) => this.log.warn(`Home Assistant websocket: ${err.message}`));
  }

  private async onReady(): Promise<void> {
    this.connected = true;
    this.retry = 1000;
    this.log.info('Connected to Home Assistant');
    this.bus.emit({ type: 'ha-connection', connected: true });

    const states: HaEntity[] = (await this.command({ type: 'get_states' })) ?? [];
    this.states = new Map(states.map((s) => [s.entity_id, s]));

    const id = this.send({ type: 'subscribe_events', event_type: 'state_changed' });
    this.handlers.set(id, (msg) => {
      const next: HaEntity | null = msg.event?.data?.new_state;
      if (msg.type !== 'event' || !next) return;
      const old: HaEntity | null = msg.event?.data?.old_state ?? null;
      for (const fn of this.stateListeners) fn(next, old);
      this.states.set(next.entity_id, next);
      if (this.watched.has(next.entity_id)) this.bus.emit({ type: 'ha-state', entity: next });
    });
  }

  private onClose(): void {
    if (this.connected) this.bus.emit({ type: 'ha-connection', connected: false });
    this.connected = false;
    for (const h of this.handlers.values()) h({ type: 'result', success: false, error: { message: 'disconnected' } });
    this.handlers.clear();
    setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30000);
  }

  private send(msg: Record<string, unknown>): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) throw new Error('Home Assistant is not connected');
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ ...msg, id }));
    return id;
  }

  /** Send a command and resolve with its result. */
  command<T = any>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.send(msg);
      this.handlers.set(id, (res) => {
        if (res.type !== 'result') return;
        this.handlers.delete(id);
        if (res.success) resolve(res.result);
        else reject(new Error(res.error?.message ?? 'Home Assistant command failed'));
      });
    });
  }

  /** Every state change in Home Assistant (alerts, doorbell). */
  onStateChange(fn: (entity: HaEntity, old: HaEntity | null) => void): void {
    this.stateListeners.add(fn);
  }

  /** Numeric history for one entity, downsampled to at most `points` values. */
  async history(entityId: string, hours: number, points = 60): Promise<Array<[number, number]>> {
    const start = new Date(Date.now() - hours * 3600_000).toISOString();
    const res = await this.fetch(
      `/api/history/period/${start}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`,
    );
    if (!res.ok) throw new Error(`history ${entityId}: HTTP ${res.status}`);
    const [rows = []] = (await res.json()) as Array<Array<{ state: string; last_changed: string }>>;
    const series = rows
      .map((r) => [Date.parse(r.last_changed), Number(r.state)] as [number, number])
      .filter(([, v]) => Number.isFinite(v));
    return downsample(series, points);
  }

  entity(id: string): HaEntity | undefined {
    return this.states.get(id);
  }

  /** False for entities HA doesn't have (e.g. an example id left in config.yaml); true until states load. */
  known(id: string): boolean {
    return this.states.size === 0 || this.states.has(id);
  }

  entities(ids: string[]): HaEntity[] {
    return ids.map((id) => this.states.get(id) ?? { entity_id: id, state: 'unavailable', attributes: {} });
  }

  watch(ids: string[]): void {
    for (const id of ids) this.watched.add(id);
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    await this.command({ type: 'call_service', domain, service, service_data: data });
  }

  /** Raw REST fetch against HA with the token (camera snapshots, TTS audio). */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.cfg.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.cfg.token}`, ...(init?.headers ?? {}) },
    });
  }

  /**
   * Run an Assist pipeline from speech-to-text only. Hearth then checks the transcript
   * against its own commands ("open Netflix", "play Halo") before handing it to HA.
   * With stage "wake_word" it only listens for the wake word (openWakeWord in HA).
   */
  runStt(onEvent: (type: string, data: any) => void, stage: 'stt' | 'wake_word' = 'stt'): PipelineRun {
    let handlerId: number | null = null;
    let queued: Buffer[] = [];
    let ended = false;

    const id = this.send({
      type: 'assist_pipeline/run',
      start_stage: stage,
      end_stage: stage,
      input: stage === 'wake_word' ? { sample_rate: 16000, timeout: 3600 } : { sample_rate: 16000 },
      ...(this.cfg.voice.pipeline ? { pipeline: this.cfg.voice.pipeline } : {}),
    });

    const sendBinary = (chunk: Buffer) => this.ws?.send(Buffer.concat([Buffer.from([handlerId!]), chunk]));

    this.handlers.set(id, (msg) => {
      if (msg.type === 'result' && !msg.success) {
        this.handlers.delete(id);
        onEvent('error', { message: msg.error?.message ?? 'Pipeline failed to start' });
        return;
      }
      if (msg.type !== 'event') return;
      const { type, data } = msg.event;
      if (type === 'run-start') {
        handlerId = data.runner_data.stt_binary_handler_id;
        for (const c of queued) sendBinary(c);
        queued = [];
        if (ended) sendBinary(Buffer.alloc(0));
      }
      if (type === 'run-end' || type === 'error') this.handlers.delete(id);
      onEvent(type, data);
    });

    return {
      sendAudio: (chunk) => {
        if (ended) return;
        if (handlerId === null) queued.push(chunk);
        else sendBinary(chunk);
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (handlerId !== null) sendBinary(Buffer.alloc(0));
      },
    };
  }

  /** Send text to HA's conversation agent; returns the spoken reply. */
  async converse(text: string, conversationId?: string): Promise<{ speech: string; conversationId?: string }> {
    const result = await this.command({
      type: 'conversation/process',
      text,
      language: this.cfg.voice.language,
      conversation_id: conversationId,
    });
    return {
      speech: result?.response?.speech?.plain?.speech ?? '',
      conversationId: result?.conversation_id,
    };
  }

  /** Get a path (relative to HA) to an audio file speaking `message`, if TTS is configured. */
  async ttsPath(message: string): Promise<string | null> {
    const engine = this.cfg.voice.ttsEngine;
    if (!engine || !message) return null;
    const res = await this.fetch('/api/tts_get_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: engine, message, language: this.cfg.voice.language }),
    });
    if (!res.ok) return null;
    const { url } = (await res.json()) as { url: string };
    return new URL(url).pathname;
  }
}

/** Keep the shape of a series while cutting it to `points` buckets (bucket averages). */
export function downsample(series: Array<[number, number]>, points: number): Array<[number, number]> {
  if (series.length <= points) return series;
  const size = series.length / points;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const bucket = series.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (bucket.length) out.push([bucket[0][0], bucket.reduce((a, [, v]) => a + v, 0) / bucket.length]);
  }
  return out;
}
