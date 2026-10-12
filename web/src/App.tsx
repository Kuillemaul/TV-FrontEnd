import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameLaunch, type LaunchProgress } from './components/GameLaunch';
import { Icon } from './components/Icon';
import { KbmPrompt } from './components/KbmPrompt';
import { VoiceOverlay } from './components/VoiceOverlay';
import { formatTime, get, post, useServerEvents, type Info, type PageId, type UiAction } from './lib/api';
import { HearthContext, type Hearth, type PlayRequest } from './lib/hearth';
import { ensureFocus, focusFirst, installNavigation, onNavCommand } from './nav/spatial';
import { GamesPage } from './pages/Games';
import { HomePage, useNow } from './pages/Home';
import { LiveTvPage } from './pages/LiveTv';
import { AppsPage, LabPage, SettingsPage, SmartHomePage } from './pages/Other';

const TABS: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'tv', label: 'Live TV', icon: 'tv' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'games', label: 'Games', icon: 'gamepad' },
  { id: 'smarthome', label: 'Smart Home', icon: 'bulb' },
  { id: 'lab', label: 'Lab', icon: 'server' },
];

interface Toast {
  id: number;
  message: string;
  level: 'info' | 'error';
}

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [page, setPage] = useState<PageId>('home');
  const history = useRef<PageId[]>([]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [kbmFor, setKbmFor] = useState<PlayRequest | null>(null);
  const [launch, setLaunch] = useState<LaunchProgress | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const now = useNow();

  useEffect(() => installNavigation(), []);
  useEffect(() => {
    get<Info>('/api/info').then(setInfo).catch(() => {});
  }, []);

  const toast = useCallback((message: string, level: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const navigate = useCallback((next: PageId) => {
    setPage((current) => {
      if (current !== next) history.current = [...history.current, current].slice(-20);
      return next;
    });
  }, []);

  // Focus the new page's default tile once its content has rendered.
  useEffect(() => {
    let tries = 0;
    let frame = 0;
    // Pages load data asynchronously: wait up to ~1s for their preferred element
    // (data-nav-default) before settling for the first focusable one.
    const attempt = () => {
      const main = mainRef.current;
      tries++;
      if (main?.querySelector('[data-nav-default]') || (tries > 60 && main?.querySelector('[data-nav]'))) focusFirst(main!);
      else if (tries < 120) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    mainRef.current?.scrollTo({ top: 0 });
    return () => cancelAnimationFrame(frame);
  }, [page]);

  const startGame = useCallback(
    (g: PlayRequest) => {
      setLaunch({ ...g, stage: 'starting', message: `Connecting to the PC…` });
      void post(`/api/games/${encodeURIComponent(g.hostId)}/${encodeURIComponent(g.gameId)}/launch`);
    },
    [],
  );

  const hearth = useMemo<Hearth>(
    () => ({
      info,
      page,
      navigate,
      toast,
      launchApp: (id) => void post(`/api/apps/${encodeURIComponent(id)}/launch`),
      watchChannel: (id) => void post('/api/tv/watch', { channelId: id }),
      playGame: (g) => (g.requiresKbm ? setKbmFor(g) : startGame(g)),
    }),
    [info, page, navigate, toast, startGame],
  );

  const runAction = useCallback(
    (a: UiAction) => {
      switch (a.type) {
        case 'navigate':
          return navigate(a.page);
        case 'launch-app':
          return hearth.launchApp(a.id);
        case 'watch-channel':
          return hearth.watchChannel(a.id);
        case 'launch-game':
          return hearth.playGame({ hostId: a.hostId, gameId: a.gameId, title: a.title, requiresKbm: a.requiresKbm });
        case 'stop':
          return void post('/api/session/stop');
      }
    },
    [hearth, navigate],
  );

  useServerEvents((e) => {
    switch (e.type) {
      case 'toast':
        return toast(e.message, e.level);
      case 'home':
        setVoiceOpen(false);
        setKbmFor(null);
        setLaunch(null);
        return navigate('home');
      case 'session':
        if (!e.session) requestAnimationFrame(ensureFocus);
        return;
      case 'game-status':
        setLaunch((l) => {
          if (!l || l.hostId !== e.hostId || l.gameId !== e.gameId) return l;
          if (e.stage === 'ended') return null;
          return { ...l, stage: e.stage, message: e.message };
        });
        if (e.stage === 'streaming') setTimeout(() => setLaunch((l) => (l?.stage === 'streaming' ? null : l)), 2500);
        return;
    }
  });

  useEffect(
    () =>
      onNavCommand((cmd) => {
        if (cmd === 'voice') setVoiceOpen(true);
        if (cmd === 'home') navigate('home');
        if (cmd === 'back' && !document.querySelector('[data-nav-scope]')) {
          const prev = history.current.pop();
          if (prev) setPage(prev);
          else if (page !== 'home') setPage('home');
          else focusFirst(mainRef.current ?? undefined);
        }
      }),
    [navigate, page],
  );

  const closeVoice = useCallback(() => setVoiceOpen(false), []);

  return (
    <HearthContext.Provider value={hearth}>
      <div className="shell">
        <nav className="topbar" data-nav-group>
          <div className="brand">
            <span className="brand-mark" />
            {info?.name ?? 'Hearth'}
          </div>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`tab ${page === t.id ? 'tab-active' : ''}`} data-nav onClick={() => navigate(t.id)}>
                <Icon name={t.icon} size="1.2em" />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="topbar-right">
            <button className="icon-btn" data-nav onClick={() => setVoiceOpen(true)} aria-label="Voice">
              <Icon name="mic" />
            </button>
            <button className={`icon-btn ${page === 'settings' ? 'tab-active' : ''}`} data-nav onClick={() => navigate('settings')} aria-label="Settings">
              <Icon name="settings" />
            </button>
            <div className="clock">{formatTime(now, info?.clock24h ?? false)}</div>
          </div>
        </nav>

        <main className="main" ref={mainRef}>
          {page === 'home' && <HomePage />}
          {page === 'tv' && <LiveTvPage />}
          {page === 'apps' && <AppsPage />}
          {page === 'games' && <GamesPage />}
          {page === 'smarthome' && <SmartHomePage />}
          {page === 'lab' && <LabPage />}
          {page === 'settings' && <SettingsPage />}
        </main>

        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.level}`}>
              {t.message}
            </div>
          ))}
        </div>

        {kbmFor ? (
          <KbmPrompt
            title={kbmFor.title}
            onCancel={() => setKbmFor(null)}
            onLaunch={() => {
              const g = kbmFor;
              setKbmFor(null);
              startGame(g);
            }}
          />
        ) : null}
        {launch ? <GameLaunch progress={launch} onClose={() => setLaunch(null)} /> : null}
        {voiceOpen ? <VoiceOverlay onAction={runAction} onClose={closeVoice} /> : null}
      </div>
    </HearthContext.Provider>
  );
}
