import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { focusElement, focusFirst, onNavCommand } from '../nav/spatial';
import { Icon } from './Icon';
import { useBack } from './Layout';

const DIGITS = [...'1234567890'];
const LETTERS = ['abcdefghij', 'klmnopqrst', "uvwxyz'-.&"].map((r) => [...r]);
const SYMBOLS = ['!@#$%^*()_', '+=/\\:;"?,~', '<>[]{}|`€£'].map((r) => [...r]);

/** The end of long text, where you're typing. */
const tail = (text: string) => (text.length > 38 ? `…${text.slice(-37)}` : text);

/** Set a (React-controlled) input's value the way typing would, so its onChange runs. */
export function setInputValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Text typed on the phone remote while a key has focus goes to the keyboard instead of voice. */
export function typeIntoKeyboard(el: Element | null, text: string): boolean {
  const osk = el?.closest('[data-osk]');
  if (!osk) return false;
  osk.dispatchEvent(new CustomEvent('hearth-type', { detail: text }));
  return true;
}

function Key({ label, icon, span = 1, active, onPress, isDefault }: { label: string; icon?: string; span?: number; active?: boolean; onPress: () => void; isDefault?: boolean }) {
  return (
    <button
      type="button"
      className={`osk-key ${span > 1 ? 'osk-key-action' : ''} ${active ? 'osk-key-on' : ''}`}
      style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
      data-nav
      data-nav-default={isDefault || undefined}
      aria-label={label}
      onClick={onPress}
    >
      {icon ? <Icon name={icon} size="1.3em" /> : null}
      {icon && span < 2 ? null : <span>{label}</span>}
    </button>
  );
}

/**
 * A TV keyboard for the remote and controller: digits, a–z (Shift for capitals), a symbols page,
 * space and delete. A real keyboard and the phone remote's typing box also work while a key is focused,
 * and the controller's X button deletes.
 */
export function OnScreenKeyboard({ value, onChange, onDone, autoFocus }: { value: string; onChange: (value: string) => void; onDone?: () => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  const change = useRef(onChange);
  change.current = onChange;
  const type = (text: string) => change.current(latest.current + text);
  const del = () => change.current(latest.current.slice(0, -1));

  useEffect(() => {
    const el = ref.current!;
    const onType = (e: Event) => type((e as CustomEvent<string>).detail);
    el.addEventListener('hearth-type', onType);
    const off = onNavCommand((cmd) => {
      if (cmd === 'menu' && el.contains(document.activeElement)) del();
    });
    return () => {
      el.removeEventListener('hearth-type', onType);
      off();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A real keyboard types even though focus is on a key, not the text box. Backspace with nothing left goes back.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace' && latest.current) del();
    else if (e.key.length === 1) type(e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const rows = symbols ? SYMBOLS : LETTERS;
  const cased = (k: string) => (shift ? k.toUpperCase() : k);
  return (
    <div className="osk" ref={ref} data-osk data-nav-group onKeyDown={onKeyDown}>
      {DIGITS.map((k) => (
        <Key key={k} label={k} onPress={() => type(k)} />
      ))}
      {rows.flat().map((k, i) => (
        <Key key={`${symbols}${i}`} label={cased(k)} onPress={() => type(cased(k))} isDefault={autoFocus && i === 0} />
      ))}
      <Key label="Shift" icon="shift" active={shift} onPress={() => setShift(!shift)} />
      <Key label={symbols ? 'abc' : '#+='} span={2} onPress={() => setSymbols(!symbols)} />
      <Key label="Space" icon="space" span={onDone ? 3 : 4} onPress={() => type(' ')} />
      <Key label="Delete" icon="backspace" span={onDone ? 2 : 3} onPress={del} />
      {onDone ? <Key label="Done" icon="check" span={2} onPress={onDone} /> : null}
    </div>
  );
}

/** The keyboard in a small panel under a text box, while you type into it from the sofa. */
function KeyboardPopover({ input, onClose }: { input: HTMLInputElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(input.value);
  useBack(ref, onClose);

  useEffect(() => {
    requestAnimationFrame(() => ref.current && focusFirst(ref.current));
    return () => {
      if (input.isConnected) focusElement(input);
    };
  }, [input]);

  // Keep showing what's in the box if something else changes it (e.g. a form reset).
  useEffect(() => {
    const sync = () => setValue(input.value);
    input.addEventListener('input', sync);
    return () => input.removeEventListener('input', sync);
  }, [input]);

  const box = input.getBoundingClientRect();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const width = 40 * rem;
  // Line up with the box's left edge, or its right edge if that would run off the screen.
  const left = Math.max(rem, box.left + width < window.innerWidth - rem ? box.left : Math.min(box.right, window.innerWidth - rem) - width);
  const below = box.bottom + 0.8 * rem;
  const above = window.innerHeight - box.top + 0.8 * rem;
  const placeBelow = below + 24 * rem < window.innerHeight;
  const secret = input.type === 'password';

  return createPortal(
    <div className="osk-backdrop" onClick={onClose}>
      <div
        className="osk-popover"
        data-nav-scope
        ref={ref}
        role="dialog"
        aria-label="Keyboard"
        style={{ left, width, ...(placeBelow ? { top: below } : { bottom: above }) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="osk-display">
          {value ? tail(secret ? '•'.repeat(value.length) : value) : <span className="osk-placeholder">{input.placeholder || 'Type…'}</span>}
          <span className="osk-caret" />
        </div>
        <OnScreenKeyboard
          value={value}
          onChange={(v) => {
            setValue(v);
            setInputValue(input, v);
          }}
          onDone={onClose}
          autoFocus
        />
      </div>
    </div>,
    document.body,
  );
}

const wantsKeyboard = (el: EventTarget | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement &&
  el.hasAttribute('data-nav') &&
  !el.closest('form, [data-osk-off]') &&
  ['text', 'search', 'password', 'url', 'email', ''].includes(el.getAttribute('type') ?? '');

/**
 * Pops the on-screen keyboard up under any text box you press OK / A on. Mouse clicks and touch don't,
 * so a real keyboard and the phone page work as before. Opt out with `data-osk-off` on the box or a parent.
 */
export function KeyboardHost() {
  const [input, setInput] = useState<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.defaultPrevented && wantsKeyboard(e.target)) {
        e.preventDefault();
        setInput(e.target);
      }
    };
    // Controller A and the phone remote's OK "click" the focused element; those clicks have no pointer (detail 0).
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0 && wantsKeyboard(e.target)) setInput(e.target);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return input ? <KeyboardPopover input={input} onClose={() => setInput(null)} /> : null;
}
