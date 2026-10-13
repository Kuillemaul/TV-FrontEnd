import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameLaunch, type LaunchProgress } from './components/GameLaunch';
import { Icon } from './components/Icon';
import { AlertStack, CameraPip } from './components/Alerts';
import { openMediaLater } from './pages/Requests';
import { AppOrderEditor } from './components/AppOrderEditor';
import { GameDetailsModal } from './components/GameDetails';
import { PinMenu, pinOf } from './components/Pins';
import { Screensaver } from './components/Screensaver';
import { TimeLeftChip, TimesUp } from './components/ScreenTime';
import { KbmPrompt } from './components/KbmPrompt';
import { Avatar, ProfileEditor, ProfileMenu, ProfilePicker, saveProfile } from './components/Profiles';
import { ThemeMenu } from './components/ThemeMenu';
import { VoiceOverlay } from './components/VoiceOverlay';
import {
  formatTime,
  get,
  post,
  useServerEvents,
  type Alert,
  type Game,
  type Info,
  type MutationResult,
  type PageId,
  type Pin,
  pinKey,
  type Profile,
  type ProfilesState,
  type ScreenTimeStatus,
  type TvSettings,
  type UiAction,
} from './lib/api';
import { useWakeWord } from './lib/wake';
import { applyTheme } from './lib/theme';
import { HearthContext, type Hearth, type PlayRequest } from './lib/hearth';
import { activateFocused, dispatchNav, ensureFocus, focusFirst, installNavigation, lastInputAt, markInput, move, onNavCommand, type Dir } from './nav/spatial';
import { GamesPage } from './pages/Games';
import { HomePage, useNow } from './pages/Home';
import { LiveTvPage } from './pages/LiveTv';
import { RequestsPage } from './pages/Requests';
import { AppsPage, LabPage, SettingsPage, SmartHomePage } from './pages/Other';

const TABS: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'tv', label: 'Live TV', icon: 'tv' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'games', label: 'Games', icon: 'gamepad' },
  { id: 'requests', label: 'Requests', icon: 'download' },
  { id: 'smarthome', label: 'Smart Home', icon: 'bulb' },
  { id: 'lab', label: 'Lab', icon: 'server' },
];

/** Pages a kid profile can reach. */
const kidPages = (p: Profile): PageId[] => ['home', ...(p.liveTv ? (['tv'] as PageId[]) : []), 'apps', 'games'];

type Overlay = null | { type: 'pin'; pin: Pin; label?: string } | { type: 'menu' } | { type: 'theme' } | { type: 'apps' } | { type: 'editProfile'; id: string } | { type: 'game'; game: Game };

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
  // What was focused when you started talking, for "pin this".
  const focusBeforeVoice = useRef<Element | null>(null);
  const openVoice = useCallback(() => {
    focusBeforeVoice.current = document.activeElement;
    setVoiceOpen(true);
  }, []);
  const [pip, setPip] = useState<{ entity: string; name?: string } | null>(null);
  const pipRef = useRef(pip);
  pipRef.current = pip;
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const [kbmFor, setKbmFor] = useState<PlayRequest | null>(null);
  const [launch, setLaunch] = useState<LaunchProgress | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const now = useNow();
  const [profiles, setProfiles] = useState<ProfilesState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [screenTime, setScreenTime] = useState<ScreenTimeStatus | null>(null);
  const [tvSettings, setTvSettings] = useState<TvSettings | null>(null);
  const [saver, setSaver] = useState(false);
  const [session, setSession] = useState(false);
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

  const loadScreenTime = useCallback(() => {
    get<{ active: ScreenTimeStatus }>('/api/screentime')
      .then((s) => setScreenTime(s.active))
      .catch(() => {});
  }, []);
  const loadSettings = useCallback(() => {
    get<TvSettings>('/api/settings').then(setTvSettings).catch(() => {});
  }, []);
  useEffect(() => {
    loadScreenTime();
    loadSettings();
    const t = setInterval(loadScreenTime, 60_000);
    return () => clearInterval(t);
  }, [loadScreenTime, loadSettings]);

  // Screensaver after a few idle minutes (never over a playing app); after a long idle,
  // waking up asks "Who's watching?" again.
  useEffect(() => {
    const idleMin = info?.screensaver.idleMinutes ?? 5;
    const t = setInterval(() => {
      const busy = session || voiceOpen || launch || overlay || pickerOpen;
      if (!saver && !busy && idleMin > 0 && Date.now() - lastInputAt() > idleMin * 60_000) setSaver(true);
    }, 10_000);
    return () => clearInterval(t);
  }, [info, session, voiceOpen, launch, overlay, pickerOpen, saver]);

  const wakeFromSaver = useCallback(() => {
    const idleFor = Date.now() - lastInputAt();
    markInput();
    setSaver(false);
    const pickerAfter = (info?.screensaver.pickerAfterMinutes ?? 30) * 60_000;
    if (pickerAfter > 0 && idleFor > pickerAfter && (profiles?.profiles.length ?? 0) > 1) setPickerOpen(true);
    requestAnimationFrame(ensureFocus);
  }, [info, profiles]);

  useWakeWord(Boolean(tvSettings?.wakeWord && info?.features.wakeWordAvailable), voiceOpen, () => {
    markInput();
    setSaver(false);
    openVoice();
  });

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
      void post(`/api/games/${encodeURIComponent(g.hostId)}/${encodeURIComponent(g.gameId)}/launch`, { title: g.title, art: g.art, players: g.players });
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
      openGame: (game) => setOverlay({ type: 'game', game }),
      togglePin: async (pin) => {
        const res = await post<MutationResult>('/api/pins', { pin });
        if (!res.ok) return toast(res.error ?? 'Couldn’t pin that', 'error');
        if (res.profiles) setProfiles(res as ProfilesState);
        const nowPinned = res.profiles?.find((p) => p.id === res.activeId)?.pins?.some((p) => pinKey(p) === pinKey(pin));
        toast(nowPinned ? 'Pinned to Home' : 'Removed from Home');
      },
      movePin: async (key, delta) => {
        const res = await post<MutationResult>('/api/pins/move', { key, delta });
        if (res.ok && res.profiles) setProfiles(res as ProfilesState);
      },
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
        case 'tv-power':
          return void post(`/api/tv-control/${a.on ? 'on' : 'off'}`);
        case 'tv-input':
          return hearth.launchApp(a.id);
        case 'stop':
          return void post('/api/session/stop');
        case 'request-open':
          navigate('requests');
          return openMediaLater(a.media);
        case 'downloads':
          return navigate('requests');
        case 'pin-focused': {
          const el = focusBeforeVoice.current;
          const pin = pinOf(el);
          if (!pin) return toast('Point at an app, game or channel first, then say “pin this”.');
          return void hearth.togglePin(pin);
        }
        case 'camera':
          return setPip(a.entity ? { entity: a.entity, name: a.name } : null);
        case 'sleep-timer':
        case 'request-search':
          return; // answered by the server
      }
    },
    [hearth, navigate],
  );

  useEffect(() => {
    void get<{ endsAt: number | null }>('/api/sleep').then((r) => setSleepEndsAt(r.endsAt)).catch(() => undefined);
  }, []);

  useServerEvents((e) => {
    switch (e.type) {
      case 'sleep':
        return setSleepEndsAt(e.endsAt);
      case 'pip':
        return setPip(e.entity ? { entity: e.entity, name: e.name } : null);
      case 'toast':
        return toast(e.message, e.level);
      case 'profiles':
        loadScreenTime();
        return void loadProfiles();
      case 'alert':
        // A new ring replaces an older doorbell card; keep at most three alerts on screen.
        return setAlerts((a) => [...a.filter((x) => !(x.kind === 'doorbell' && e.alert.kind === 'doorbell')), e.alert].slice(-3));
      case 'timesup':
      case 'screentime':
        return loadScreenTime();
      case 'settings':
        return loadSettings();
      case 'remote':
        return handleRemote(e.cmd, e.text);
      case 'home':
        setVoiceOpen(false);
        setKbmFor(null);
        setLaunch(null);
        return navigate('home');
      case 'session':
        setSession(Boolean(e.session));
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
        if (cmd === 'voice') openVoice();
        if (cmd === 'menu' && !document.querySelector('[data-nav-scope]')) {
          const el = document.activeElement;
          const pin = pinOf(el);
          if (pin) setOverlay({ type: 'pin', pin, label: el?.querySelector('.tile-title, .tile-wordmark')?.textContent ?? undefined });
        }
        if (cmd === 'home') navigate('home');
        if (cmd === 'back' && !document.querySelector('[data-nav-scope]') && pipRef.current) {
          setPip(null);
          return;
        }
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
  const expireAlert = useCallback((id: string) => setAlerts((a) => a.filter((x) => x.id !== id)), []);

  /** Phone remote buttons arrive as server events and drive the same navigation as a real remote. */
  function handleRemote(cmd: string, text?: string) {
    markInput();
    if (saver) return wakeFromSaver();
    if (['up', 'down', 'left', 'right'].includes(cmd)) return move(cmd as Dir);
    if (cmd === 'ok') return activateFocused();
    if (cmd === 'back' || cmd === 'voice') return dispatchNav(cmd);
    if (cmd === 'text' && text) {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) {
        // Set through the native setter so React sees the change.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, el.value + text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      void post<{ action?: UiAction; speech: string }>('/api/voice/text', { text }).then((r) => {
        if (r.action) runAction(r.action);
        else if (r.speech) toast(r.speech);
      });
    }
  }

  return (
    <HearthContext.Provider value={hearth}>
      <div className="shell">
        <nav className="topbar" data-nav-group>
          <div className="brand">
            <span className="brand-mark" />
            {info?.name ?? 'Hearth'}
          </div>
          <div className="tabs">
            {TABS.filter((t) => (!allowed || allowed.includes(t.id)) && (t.id !== 'requests' || info?.features.requests || info?.features.downloads)).map((t) => (
              <button key={t.id} className={`tab ${page === t.id ? 'tab-active' : ''}`} data-nav onClick={() => navigate(t.id)}>
                <Icon name={t.icon} size="1.2em" />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="topbar-right">
            <button className="icon-btn" data-nav onClick={openVoice} aria-label="Voice">
              <Icon name="mic" />
            </button>
            {!isKid ? (
              <button className={`icon-btn ${page === 'settings' ? 'tab-active' : ''}`} data-nav onClick={() => navigate('settings')} aria-label="Settings">
                <Icon name="settings" />
              </button>
            ) : null}
            {isKid ? <TimeLeftChip status={screenTime} /> : null}
            {sleepEndsAt ? (
              <button className="sleep-chip" data-nav onClick={() => void post('/api/sleep', { minutes: 0 })} title="Cancel the sleep timer">
                <Icon name="moon" size="1em" /> {Math.max(1, Math.ceil((sleepEndsAt - now) / 60_000))} min
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
          {page === 'requests' && <RequestsPage />}
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
        {overlay?.type === 'game' ? <GameDetailsModal game={overlay.game} onClose={() => setOverlay(null)} /> : null}
        {overlay?.type === 'pin' ? <PinMenu pin={overlay.pin} label={overlay.label} onClose={() => setOverlay(null)} /> : null}
        {isKid && screenTime?.blocked ? (
          <TimesUp reason={screenTime.blocked} onSwitch={() => setPickerOpen(true)} onClose={loadScreenTime} />
        ) : null}
        {pickerOpen ? (
          <ProfilePicker
            canClose={Boolean(profile)}
            onDone={() => {
              setPickerOpen(false);
              // Whatever is now on top (home, or the time's-up screen) gets the focus.
              setTimeout(ensureFocus, 50);
            }}
          />
        ) : null}
        <AlertStack alerts={alerts} onExpire={expireAlert} />
        {pip ? <CameraPip entity={pip.entity} name={pip.name} onClose={() => setPip(null)} /> : null}
        {saver ? <Screensaver clock24h={info?.clock24h ?? false} onWake={wakeFromSaver} /> : null}
      </div>
    </HearthContext.Provider>
  );
}
