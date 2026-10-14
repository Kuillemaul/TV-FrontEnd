/** What the PC agent reports about the person at the PC (Windows; null where it can't tell). */
export interface Presence {
  /** Seconds since the last keyboard, mouse or controller input on the PC. */
  idleSeconds?: number | null;
  /** The lock screen is showing. */
  locked?: boolean | null;
  /** The window in front; fullscreen means it covers its whole monitor (a game or a video). */
  foreground?: { title: string; exe: string; fullscreen: boolean } | null;
}

export interface HostBusy {
  /** Shown on the TV, e.g. "Someone is playing Elden Ring on Gaming PC". */
  reason: string;
  idleSeconds: number | null;
}

/** A fullscreen app left open counts as "in use" for this long without input (a film, a paused game). */
const FULLSCREEN_IDLE_S = 30 * 60;
/** After a Hearth stream ends, Apollo's virtual display can linger this long. */
const STREAM_LINGER_MS = 60_000;
/** Input this soon after a Hearth stream ended was still the stream (Moonlight's input counts as the PC's). */
const STREAM_INPUT_GRACE_MS = 15_000;

/**
 * Is someone else using this PC, so streaming would take over their screen? Hearth's own stream never
 * counts, nor does input that came from it. Unknown (an old agent, Linux, the PC asleep) is "not busy".
 */
export function hostBusy(o: {
  name: string;
  /** null when the PC didn't answer. */
  health: { streamDisplay?: boolean | null; presence?: Presence | null } | null;
  /** Hearth is streaming from this PC right now. */
  ours: boolean;
  /** When Hearth's last stream from this PC ended (ms), if it has. */
  oursEndedAt?: number;
  now: number;
  /** Input within this many minutes means someone's there; 0 turns the check off. */
  idleMinutes: number;
}): HostBusy | null {
  const { name, health, ours, oursEndedAt, now, idleMinutes } = o;
  if (!health || ours || idleMinutes <= 0) return null;
  const recentlyOurs = oursEndedAt !== undefined && now - oursEndedAt < STREAM_LINGER_MS;
  if (health.streamDisplay === true && !recentlyOurs) return { reason: `${name} is streaming to another device`, idleSeconds: null };

  const p = health.presence;
  if (!p || p.locked || p.idleSeconds == null) return null;
  const idle = p.idleSeconds;
  const inputWasOurs = oursEndedAt !== undefined && now - idle * 1000 <= oursEndedAt + STREAM_INPUT_GRACE_MS;
  if (inputWasOurs) return null;
  const fg = p.foreground;
  const app = fg?.fullscreen ? fg.title || fg.exe.replace(/\.exe$/i, '') : null;
  if (idle < idleMinutes * 60) return { reason: app ? `Someone is playing ${app} on ${name}` : `Someone is using ${name}`, idleSeconds: idle };
  if (app && idle < FULLSCREEN_IDLE_S) return { reason: `${app} is open on ${name}`, idleSeconds: idle };
  return null;
}
