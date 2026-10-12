/**
 * Spatial navigation for a 10-foot UI.
 *
 * Any element with `data-nav` is focusable. Arrow keys / D-pad / left stick move focus to
 * the geometrically closest element in that direction. The topmost `[data-nav-scope]`
 * (e.g. an open modal) traps focus. `[data-nav-group]` containers (rows) remember their
 * last focused child so moving up/down between rows returns you where you were.
 *
 * Inputs:
 *   keyboard / IR / CEC remotes  → arrows, Enter, Escape/Backspace/BrowserBack
 *   game controllers             → D-pad/stick, A = select, B = back, Y = voice, Start = home
 *   mouse                        → hover focuses, click activates
 */

export type Dir = 'up' | 'down' | 'left' | 'right';
export type NavCommand = 'back' | 'voice' | 'home';

const SELECTOR = '[data-nav]:not([disabled])';
const groupMemory = new WeakMap<Element, HTMLElement>();
const listeners = new Set<(cmd: NavCommand) => void>();

export function onNavCommand(fn: (cmd: NavCommand) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(cmd: NavCommand): void {
  for (const fn of listeners) fn(cmd);
}

/** Trigger back/home/voice from elsewhere (e.g. the phone remote). */
export const dispatchNav = emit;

let lastInput = Date.now();
/** Time of the last remote/keyboard/controller/mouse input (for the screensaver). */
export const lastInputAt = () => lastInput;
export const markInput = () => {
  lastInput = Date.now();
};

function scopeRoot(): ParentNode {
  const scopes = document.querySelectorAll('[data-nav-scope]');
  return scopes.length ? scopes[scopes.length - 1] : document;
}

function focusables(): HTMLElement[] {
  return [...scopeRoot().querySelectorAll<HTMLElement>(SELECTOR)].filter((el) => el.getClientRects().length > 0);
}

export function focusElement(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

/** Focus the scope's default element (data-nav-default) or its first focusable. */
export function focusFirst(within?: ParentNode): void {
  const root = within ?? scopeRoot();
  const el =
    root.querySelector<HTMLElement>('[data-nav-default]:not([disabled])') ?? root.querySelector<HTMLElement>(SELECTOR);
  if (el) focusElement(el);
}

/** Focus something sensible if focus was lost (e.g. returning from an app). */
export function ensureFocus(): void {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || !focusables().includes(active)) focusFirst();
}

function score(dir: Dir, a: DOMRect, b: DOMRect): number | null {
  const E = 2;
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  let primary: number;
  let overlap: number;
  let cross: number;

  if (dir === 'left' || dir === 'right') {
    const forward = dir === 'right' ? bcx > acx + E : bcx < acx - E;
    if (!forward) return null;
    primary = dir === 'right' ? b.left - a.right : a.left - b.right;
    overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    cross = Math.abs(bcy - acy);
  } else {
    const forward = dir === 'down' ? bcy > acy + E : bcy < acy - E;
    if (!forward) return null;
    primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
    overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    cross = Math.abs(bcx - acx);
  }
  primary = Math.max(primary, 0);
  // Strongly prefer elements that line up with the current one.
  return overlap > 0 ? primary + cross * 0.1 : primary + cross * 2 + 200;
}

export function move(dir: Dir): void {
  const all = focusables();
  if (all.length === 0) return;
  const current = document.activeElement as HTMLElement | null;
  if (!current || !all.includes(current)) {
    focusFirst();
    return;
  }
  const a = current.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === current) continue;
    const s = score(dir, a, el.getBoundingClientRect());
    if (s !== null && s < bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (!best) return;

  if (dir === 'up' || dir === 'down') {
    const group = best.closest('[data-nav-group]');
    if (group && group !== current.closest('[data-nav-group]')) {
      const remembered = groupMemory.get(group);
      if (remembered?.isConnected && all.includes(remembered)) best = remembered;
    }
  }
  focusElement(best);
}

export function activateFocused(): void {
  activate();
}

function activate(): void {
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body) el.click();
}

/* ---------------- keyboard & remote ---------------- */

const KEY_DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'GoBack', 'Backspace']);
const HOME_KEYS = new Set(['BrowserHome', 'GoHome']);
const VOICE_KEYS = new Set(['F2', 'MicrophoneToggle', 'VoiceDial', 'LaunchAssistant']);

function onKeyDown(e: KeyboardEvent): void {
  markInput();
  const el = document.activeElement;
  const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const dir = KEY_DIRS[e.key];

  if (dir) {
    if (typing && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();
    move(dir);
  } else if (BACK_KEYS.has(e.key)) {
    if (typing && e.key === 'Backspace') return;
    e.preventDefault();
    emit('back');
  } else if (HOME_KEYS.has(e.key)) {
    e.preventDefault();
    emit('home');
  } else if (VOICE_KEYS.has(e.key) || (!typing && (e.key === 'm' || e.key === 'M'))) {
    e.preventDefault();
    emit('voice');
  } else if (e.key === 'Enter' && !typing && el instanceof HTMLElement && !(el instanceof HTMLButtonElement) && el.hasAttribute('data-nav')) {
    e.preventDefault();
    el.click();
  }
}

/* ---------------- game controllers ---------------- */

const enum Btn {
  A = 0,
  B = 1,
  Y = 3,
  Back = 8,
  Start = 9,
  Up = 12,
  Down = 13,
  Left = 14,
  Right = 15,
}

interface PadState {
  buttons: boolean[];
  dir: Dir | null;
  nextRepeat: number;
}

const pads = new Map<number, PadState>();
let polling = false;
let padNavPaused = 0;

/** Stop controllers from navigating (the controller tester reads them itself). Returns undo. */
export function pauseGamepadNav(): () => void {
  padNavPaused++;
  return () => {
    padNavPaused--;
  };
}

function padDir(gp: Gamepad): Dir | null {
  const b = (i: number) => gp.buttons[i]?.pressed;
  if (b(Btn.Up)) return 'up';
  if (b(Btn.Down)) return 'down';
  if (b(Btn.Left)) return 'left';
  if (b(Btn.Right)) return 'right';
  const [x = 0, y = 0] = gp.axes;
  if (Math.max(Math.abs(x), Math.abs(y)) < 0.55) return null;
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
}

function poll(now: number): void {
  const gps = navigator.getGamepads().filter((g): g is Gamepad => g !== null);
  if (gps.length === 0) {
    polling = false;
    return;
  }
  if (document.hasFocus()) {
    for (const gp of gps) {
      const prev = pads.get(gp.index) ?? { buttons: [], dir: null, nextRepeat: 0 };
      const pressed = gp.buttons.map((b) => b.pressed);
      if (pressed.some(Boolean) || padDir(gp)) markInput();
      if (padNavPaused) {
        pads.set(gp.index, { buttons: pressed, dir: padDir(gp), nextRepeat: prev.nextRepeat });
        continue;
      }
      const edge = (i: number) => pressed[i] && !prev.buttons[i];

      if (edge(Btn.A)) activate();
      if (edge(Btn.B) || edge(Btn.Back)) emit('back');
      if (edge(Btn.Y)) emit('voice');
      if (edge(Btn.Start)) emit('home');

      const dir = padDir(gp);
      let nextRepeat = prev.nextRepeat;
      if (dir && dir !== prev.dir) {
        move(dir);
        nextRepeat = now + 380;
      } else if (dir && now >= prev.nextRepeat) {
        move(dir);
        nextRepeat = now + 110;
      }
      pads.set(gp.index, { buttons: pressed, dir, nextRepeat });
    }
  }
  requestAnimationFrame(poll);
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  requestAnimationFrame(poll);
}

/* ---------------- mouse ---------------- */

let mouseTimer: number | undefined;

function onMouseMove(): void {
  markInput();
  document.body.classList.add('mouse-active');
  clearTimeout(mouseTimer);
  mouseTimer = window.setTimeout(() => document.body.classList.remove('mouse-active'), 3000);
}

function onMouseOver(e: MouseEvent): void {
  if (!document.body.classList.contains('mouse-active')) return;
  const target = (e.target as Element).closest<HTMLElement>(SELECTOR);
  if (target && target !== document.activeElement && focusables().includes(target)) target.focus({ preventScroll: true });
}

function onFocusIn(e: FocusEvent): void {
  const el = e.target as HTMLElement;
  const group = el.closest('[data-nav-group]');
  if (group) groupMemory.set(group, el);
}

export function installNavigation(): () => void {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('gamepadconnected', startPolling);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('focusin', onFocusIn);
  if (navigator.getGamepads().some(Boolean)) startPolling();
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('gamepadconnected', startPolling);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseover', onMouseOver);
    document.removeEventListener('focusin', onFocusIn);
  };
}

/** Call onBack when Back is pressed and `scope` is the topmost navigation scope. */
export function onScopedBack(scope: () => Element | null, onBack: () => void): () => void {
  return onNavCommand((cmd) => {
    if (cmd !== 'back') return;
    const scopes = document.querySelectorAll('[data-nav-scope]');
    const el = scope();
    if (el && scopes[scopes.length - 1] === el) onBack();
  });
}
