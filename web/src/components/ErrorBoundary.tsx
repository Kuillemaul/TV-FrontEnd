import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Send a UI error to the server's log (journalctl), so a blank screen leaves a trace. */
export function reportError(message: string, stack?: string): void {
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(message).slice(0, 500), stack: stack?.slice(0, 2000), path: location.pathname }),
    }).catch(() => undefined);
  } catch {
    /* nothing else to do */
  }
}

let installed = false;
/** Errors outside React rendering (timers, promises) are logged too. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => reportError(e.message, (e.error as Error | undefined)?.stack));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    reportError(r?.message ?? String(e.reason), r?.stack);
  });
}

/**
 * If a screen crashes, show what happened and a way back instead of a blank TV. OK reloads;
 * it also reloads by itself after a while so the TV never stays stuck.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  private timer: number | undefined;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
    this.timer = window.setTimeout(() => location.reload(), 30_000);
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>Hearth hit a problem</h1>
        <p>Press OK to start the screen again. It also restarts by itself in 30 seconds.</p>
        <button autoFocus onClick={() => location.reload()} ref={(b) => b?.focus()}>
          Restart screen
        </button>
        <pre>{error.message}</pre>
      </div>
    );
  }
}
