import { useEffect, useState } from 'react';
import { post, useServerEvents } from '../lib/api';

/**
 * /launching: shown above the stream while a game starts on the PC, so you see the game's art
 * instead of the PC desktop. The server takes it down once the game is running; Back reveals the
 * stream straight away.
 */
export function LoadingCoverPage() {
  const q = new URLSearchParams(location.search);
  const title = q.get('title') ?? 'Your game';
  const art = q.get('art');
  const [message, setMessage] = useState(`Starting ${title}…`);
  useServerEvents((e) => {
    if (e.type === 'game-status' && e.gameId === q.get('game') && e.stage !== 'streaming') setMessage(e.message);
  });

  useEffect(() => {
    const reveal = () => void post('/api/games/loading/close');
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') && reveal();
    window.addEventListener('keydown', onKey);
    let frame = 0;
    const poll = () => {
      if (navigator.getGamepads().some((g) => g?.buttons[1]?.pressed)) return reveal();
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="cover-page">
      {art ? <img className="cover-bg" src={art} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
      <div className="cover-shade" />
      <div className="cover-content">
        <div className="cover-poster">
          <span className="tile-poster-title">{title}</span>
          {art ? <img src={art} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
        </div>
        <div className="cover-text">
          <div className="cover-title">{title}</div>
          <div className="cover-status">
            <span className="cover-dots">
              <span />
              <span />
              <span />
            </span>
            {message}
          </div>
        </div>
      </div>
      <div className="pair-hint">Press Back to show the PC now</div>
    </div>
  );
}
