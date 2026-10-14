import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary, installErrorReporting } from './components/ErrorBoundary';
import { AlertPage, CameraPage } from './components/Alerts';
import { PairPage } from './components/Pairing';
import { LoadingCoverPage } from './components/LoadingCover';
import { AdminPage } from './admin/Admin';
import { RemotePage } from './pages/Remote';
import { Setup } from './setup/Setup';
import './styles.css';

// One bundle, three entry points: the TV shell, the phone remote, and the alert window
// the server opens over other apps.
const path = location.pathname;
const SetupPage = () => <Setup onPhone />;
const Root = path.startsWith('/setup') ? SetupPage : path.startsWith('/admin') ? AdminPage : path.startsWith('/remote') ? RemotePage : path.startsWith('/alert') ? AlertPage : path.startsWith('/pair') ? PairPage : path.startsWith('/launching') ? LoadingCoverPage : path.startsWith('/camera') ? CameraPage : App;
if (path.startsWith('/remote')) document.body.classList.add('is-remote');
if (path.startsWith('/alert')) document.body.classList.add('is-alert');
if (path.startsWith('/setup')) document.body.classList.add('is-setup', 'mouse-active');

installErrorReporting();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);

// Fade out the boot logo (index.html) once the app has painted.
const splash = document.getElementById('splash');
if (splash) {
  setTimeout(() => {
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 450);
  }, 250);
}
