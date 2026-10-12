import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameLaunch, type LaunchProgress } from './components/GameLaunch';
import { Icon } from './components/Icon';
import { AppOrderEditor } from './components/AppOrderEditor';
import { KbmPrompt } from './components/KbmPrompt';
import { Avatar, ProfileEditor, ProfileMenu, ProfilePicker, saveProfile } from './components/Profiles';
import { ThemeMenu } from './components/ThemeMenu';
import { VoiceOverlay } from './components/VoiceOverlay';
import { formatTime, get, post, useServerEvents, type Info, type PageId, type Profile, type ProfilesState, type UiAction } from './lib/api';
import { applyTheme } from './lib/theme';
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

/** Pages a kid profile can reach. */
const kidPages = (p: Profile): PageId[] => ['home', ...(p.liveTv ? (['tv'] as PageId[]) : []), 'apps', 'games'];

type Overlay = null | { type: 'menu' } | { type: 'theme' } | { type: 'apps' } | { type: 'editProfile'; id: string };

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
  const [profiles, setProfiles] = useState<ProfilesState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const profile = profiles?.profiles.find((p) => p.id === profiles.activeId) ?? null;
  const isKid = profile?.kind === 'kid';
  const allowed: PageId[] | null = profile && isKid ? kidPages(profile) : null;

  const loadProfiles = useCallback(async (initial = false) => {
    const next = await get<ProfilesState>('/api/profiles');
    setProfiles((prev) => {
      if (prev && prev.activeId !== next.activeId) {
        history.current = [];
        setPage('home');
      }
      return next;
    });
    const active = next.profiles.find((p) => p.id === next.activeId);
    if (active) applyTheme(active.theme);
    if (initial && next.profiles.length > 1) setPickerOpen(true);
  }, []);

  useEffect(() => {
    void loadProfiles(true);
  }, [loadProfiles]);

  // A kid profile can't stay on a page it isn't allowed to see.
  useEffect(() => {
    if (allowed && !allowed.includes(page)) setPage('home');
  }, [allowed, page]);

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
      profiles,
      profile,
      isKid,
      editProfile: (id) => setOverlay({ type: 'editProfile', id }),
      editApps: () => setOverlay({ type: 'apps' }),
      openTheme: () => setOverlay({ type: 'theme' }),
    }),
    [info, page, navigate, toast, startGame, profiles, profile, isKid],
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
      case 'profiles':
        return void loadProfiles();
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
            {TABS.filter((t) => !allowed || allowed.includes(t.id)).map((t) => (
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
            {!isKid ? (
              <button className={`icon-btn ${page === 'settings' ? 'tab-active' : ''}`} data-nav onClick={() => navigate('settings')} aria-label="Settings">
                <Icon name="settings" />
              </button>
            ) : null}
            {profile ? (
              <button className="icon-btn avatar-btn" data-nav onClick={() => setOverlay({ type: 'menu' })} aria-label={`Profile: ${profile.name}`}>
                <Avatar profile={profile} size="sm" />
              </button>
            ) : null}
            <div className="clock">{formatTime(now, info?.clock24h ?? false)}</div>
          </div>
        </nav>

        {/* Remount pages when the profile or its curation changes so they refetch. */}
        <main className="main" ref={mainRef} key={profile ? `${profile.id}|${profile.apps}|${profile.games}|${profile.liveTv}` : 'none'}>
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

        {overlay?.type === 'menu' ? (
          <ProfileMenu
            onClose={() => setOverlay(null)}
            onSwitch={() => {
              setOverlay(null);
              setPickerOpen(true);
            }}
            onTheme={() => setOverlay({ type: 'theme' })}
          />
        ) : null}
        {overlay?.type === 'theme' && profile ? (
          <ThemeMenu
            title={`${profile.name}'s theme`}
            initial={profile.theme}
            onSave={(theme) => {
              void saveProfile(profile.id, { theme });
              setOverlay(null);
            }}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {overlay?.type === 'apps' && profile ? (
          <AppOrderEditor
            title={`${profile.name}'s apps`}
            order={profile.apps}
            onChange={(apps) => void saveProfile(profile.id, { apps })}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {overlay?.type === 'editProfile' ? <ProfileEditor profileId={overlay.id} onClose={() => setOverlay(null)} /> : null}
        {pickerOpen ? <ProfilePicker canClose={Boolean(profile)} onDone={() => setPickerOpen(false)} /> : null}
      </div>
    </HearthContext.Provider>
  );
}
