/**
 * Local voice intents: things the TV itself should handle ("open Netflix",
 * "play Elden Ring", "watch channel 4"). Anything that doesn't match is passed
 * on to Home Assistant's conversation agent ("turn off the kitchen lights").
 */

export type PageId = 'home' | 'tv' | 'apps' | 'games' | 'requests' | 'smarthome' | 'lab' | 'settings' | 'search' | 'morning';

export interface MediaRef {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
}

export type UiAction =
  | { type: 'navigate'; page: PageId }
  | { type: 'launch-app'; id: string; name: string }
  | { type: 'launch-game'; hostId: string; gameId: string; title: string; requiresKbm: boolean }
  | { type: 'watch-channel'; id: string; name: string }
  | { type: 'tv-power'; on: boolean }
  | { type: 'tv-input'; id: string; name: string }
  | { type: 'stop' }
  /** "Request Dune Part Three": the server looks it up in Seerr and turns it into request-open. */
  | { type: 'request-search'; query: string }
  | { type: 'request-open'; media: MediaRef }
  /** "What's downloading?" (answered by the server, then shows Requests). */
  | { type: 'downloads' }
  /** "Pin this": pin whatever was focused when you started talking. */
  | { type: 'pin-focused' }
  /** minutes > 0 sets, 0 cancels, -1 asks how long is left. Handled by the server. */
  | { type: 'sleep-timer'; minutes: number }
  /** Camera picture-in-picture; entity null hides it. */
  | { type: 'camera'; entity: string | null; name?: string }
  /** "Search for Dune": the Search page with results from everywhere. */
  | { type: 'search'; query: string };

export interface IntentCatalog {
  apps: Array<{ id: string; name: string }>;
  games: Array<{ id: string; hostId: string; title: string; requiresKbm: boolean }>;
  channels: Array<{ id: string; number: number; name: string }>;
  /** Other HDMI inputs (Xbox, Apple TV…) the TV can switch to. */
  inputs?: Array<{ id: string; name: string }>;
  /** Home Assistant cameras, for "show the front door camera". */
  cameras?: Array<{ id: string; name: string }>;
  /** The doorbell's camera, for "who's at the door". */
  doorbellCamera?: string;
}

export interface IntentMatch {
  action: UiAction;
  speech: string;
}

const PAGES: Array<[RegExp, PageId, string]> = [
  [/^(home|home screen|main menu)$/, 'home', 'Home'],
  [/^(live tv|tv|guide|tv guide|recordings|dvr)$/, 'tv', 'Live TV'],
  [/^(apps|my apps|streaming)$/, 'apps', 'Apps'],
  [/^(games|my games|game library|library)$/, 'games', 'Games'],
  [/^(requests|request|seerr|downloads|downloading)$/, 'requests', 'Requests'],
  [/^(smart home|home dashboard|dashboard|devices)$/, 'smarthome', 'Smart Home'],
  [/^(lab|home ?lab|servers|server status)$/, 'lab', 'Home Lab'],
  [/^(settings|system)$/, 'settings', 'Settings'],
  [/^(search|search page)$/, 'search', 'Search'],
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
  a: 1, an: 1, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

/** "one hour", "an hour and a half", "90 minutes", "1.5 hours", "half an hour", "forty five mins" → minutes. */
export function parseDuration(text: string): number | null {
  const t = text.replace(/^(for|in) /, '').trim();
  if (/^half an hour$/.test(t)) return 30;
  const num = (words: string): number | null => {
    if (/^\d+(\.\d+)?$/.test(words)) return Number(words);
    const parts = words.split(' ').filter((w) => w !== 'and');
    if (!parts.length || parts.some((w) => NUMBER_WORDS[w] === undefined)) return null;
    return parts.reduce((sum, w) => sum + NUMBER_WORDS[w], 0);
  };
  let total = 0;
  let matched = false;
  const h = /^([a-z0-9. ]+?) hours?( and a half)?(?: and ([a-z0-9 ]+?) min(?:ute)?s?)?$/.exec(t);
  if (h) {
    const n = num(h[1]);
    if (n === null) return null;
    total = n * 60 + (h[2] ? 30 : 0) + (h[3] ? (num(h[3]) ?? 0) : 0);
    matched = true;
  } else {
    const m = /^([a-z0-9. ]+?)( min(?:ute)?s?)?$/.exec(t);
    if (m) {
      const n = num(m[1]);
      if (n === null) return null;
      total = n;
      matched = true;
    }
  }
  return matched && total > 0 && total <= 12 * 60 ? Math.round(total) : null;
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)\.(\d)/g, '$1d0t$2') // keep decimals ("1.5 hours") through the clean-up below
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => ROMAN[w] ?? w)
    .join(' ')
    .replace(/(\d)d0t(\d)/g, '$1.$2');
}

const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };

/** Similarity of a spoken query to a title, 0..1. */
export function score(query: string, title: string): number {
  const q = normalise(query);
  const t = normalise(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(q) || q.startsWith(t)) return 0.9;
  if (t.includes(q)) return 0.8;
  const qt = q.split(' ');
  const tt = new Set(t.split(' '));
  const hits = qt.filter((w) => tt.has(w)).length;
  // Mostly "how much of what was said matched", lightly penalising long titles.
  return 0.75 * (hits / qt.length) * (0.5 + 0.5 * (hits / tt.size));
}

function best<T>(query: string, items: T[], title: (t: T) => string, min = 0.45): T | undefined {
  let top: T | undefined;
  let topScore = min;
  for (const item of items) {
    const s = score(query, title(item));
    if (s > topScore) {
      top = item;
      topScore = s;
    }
  }
  return top;
}

export function matchIntent(text: string, catalog: IntentCatalog): IntentMatch | null {
  const t = normalise(text).replace(/^(hey |ok |okay )?(hearth |tv )?(please )?/, '').replace(/ please$/, '');
  if (!t) return null;

  const power = t.match(/^(?:turn|switch|power) (?:the )?(?:tv|television|screen) (on|off)$|^(?:turn|switch|power) (on|off) (?:the )?(?:tv|television|screen)$/);
  if (power) {
    const on = (power[1] ?? power[2]) === 'on';
    return { action: { type: 'tv-power', on }, speech: on ? 'Turning the TV on' : 'Turning the TV off' };
  }

  const input = t.match(/^(?:switch|change|go) (?:the tv )?(?:over )?to (?:the )?(.+?)(?: input)?$/);
  if (input && catalog.inputs?.length) {
    const hit = best(input[1], catalog.inputs, (i) => i.name, 0.6);
    if (hit) return { action: { type: 'tv-input', id: hit.id, name: hit.name }, speech: `Switching to ${hit.name}` };
  }

  // Sleep timer: "sleep timer one hour", "turn off in 30 minutes", "cancel the sleep timer"
  if (/^(cancel|stop|clear|turn off|remove)( the)? sleep timer$/.test(t)) {
    return { action: { type: 'sleep-timer', minutes: 0 }, speech: 'Sleep timer cancelled' };
  }
  if (/^how (long|much time)( is)?( left)?( on)?( the)? sleep timer$|^when (will|does) (the )?tv (turn off|sleep)$/.test(t)) {
    return { action: { type: 'sleep-timer', minutes: -1 }, speech: '' };
  }
  const sleep = t.match(/^(?:set (?:a |the )?)?sleep timer(?: for| to| in)? (.+)$|^(?:turn (?:the tv )?off|switch (?:the tv )?off|go to sleep|sleep|shut (?:the tv )?down)(?: the tv)? in (.+)$/);
  if (sleep) {
    const minutes = parseDuration(sleep[1] ?? sleep[2]);
    if (minutes) return { action: { type: 'sleep-timer', minutes }, speech: '' };
  }

  // "What's downloading?"
  if (/^(whats|what is|what are|anything|is anything) (downloading|coming down|still downloading)|^(show )?(me )?(the )?downloads$|^how (are|is) (the )?downloads?( going| doing)?$/.test(t)) {
    return { action: { type: 'downloads' }, speech: '' };
  }

  // "Pin this", "unpin that"
  if (/^(un)?pin (this|that|it)( to (the )?home( screen)?)?$/.test(t)) {
    return { action: { type: 'pin-focused' }, speech: '' };
  }

  // Cameras: "show the front door camera", "who's at the door", "hide the camera"
  if (/^(hide|close|dismiss|turn off|stop)( the)? cameras?( feed)?$/.test(t)) {
    return { action: { type: 'camera', entity: null }, speech: 'Hiding the camera' };
  }
  if (/^(whos|who is) (at )?the (front )?door$|^show( me)?( the)? (doorbell|front door)$/.test(t) && catalog.doorbellCamera) {
    return { action: { type: 'camera', entity: catalog.doorbellCamera, name: 'Front door' }, speech: 'Here’s the front door' };
  }
  const cam = t.match(/^(?:show|open|view|put up|display)(?: me)?(?: the)? (.+?) camera$|^(?:show|open|view)(?: me)?(?: the)? camera (?:for |of )?(?:the )?(.+)$/);
  if (cam && catalog.cameras?.length) {
    const q = cam[1] ?? cam[2];
    const hit = best(q, catalog.cameras, (c) => c.name.replace(/ camera$/i, ''), 0.5);
    if (hit) return { action: { type: 'camera', entity: hit.id, name: hit.name }, speech: `Showing ${hit.name}` };
  }

  // "Good morning", "what's on today": the morning screen
  if (/^(good morning|whats on today|what is on today|whats happening today|my day|show my day|show (me )?today)$/.test(t)) {
    return { action: { type: 'navigate', page: 'morning' }, speech: 'Good morning' };
  }

  // "Search for Dune", "find Bluey", "look for the cricket"
  const search = t.match(/^(?:search for|search|find|look for|look up)(?: me)? (.+)$/);
  if (search && !/^(a |the )?(app|game|camera)s?$/.test(search[1])) {
    return { action: { type: 'search', query: search[1] }, speech: `Searching for ${search[1]}` };
  }

  // "Request Dune Part Three" (looked up in Seerr by the server)
  const req = t.match(/^(?:can you |could you )?(?:request|get me|download|add) (.+?)(?: (?:to|on|in) (?:plex|seerr|the library|my library))?(?: for me)?$/);
  // "Add milk to the shopping list" is a Home Assistant to-do, not a film request.
  if (req && !/^(a |the )?(app|game)/.test(req[1]) && !/ (to|on|onto) (my |the |our )?[\w ]*list$/.test(req[1])) {
    return { action: { type: 'request-search', query: req[1] }, speech: `Looking for ${req[1]}` };
  }

  if (/^(stop|exit|quit|close)( (it|this|that|the app|the game|watching|playing))?$/.test(t) || t === 'go back home') {
    return { action: { type: 'stop' }, speech: 'Closing' };
  }

  let m = t.match(/^(go to|show( me)?|open)( the| my)? (.+?)( page| screen)?$/);
  const pageQuery = m ? m[4] : t.match(/^go (home)$/)?.[1];
  if (pageQuery) {
    const page = PAGES.find(([re]) => re.test(pageQuery));
    if (page) return { action: { type: 'navigate', page: page[1] }, speech: `Opening ${page[2]}` };
  }

  // "watch channel 4", "put on NBC", "tune to channel seven"
  m = t.match(/^(watch|put on|tune to|switch to|change to|go to|turn on) (channel )?(.+)$/);
  if (m) {
    const q = m[3];
    const num = Number(q) || NUMBER_WORDS[q];
    const ch =
      (num ? catalog.channels.find((c) => c.number === num) : undefined) ??
      (m[2] || m[1] !== 'turn on' ? best(q, catalog.channels, (c) => c.name, 0.85) : undefined);
    if (ch) return { action: { type: 'watch-channel', id: ch.id, name: ch.name }, speech: `Tuning to ${ch.name}` };
  }

  // "play Elden Ring", "launch Netflix", "open Plex"
  m = t.match(/^(play|launch|start|open|run|load)( up)? (.+?)( on .+)?$/);
  if (m) {
    const q = m[3].replace(/^the game /, '');
    if (m[1] !== 'play') {
      const app = best(q, catalog.apps, (a) => a.name, 0.6);
      if (app) return { action: { type: 'launch-app', id: app.id, name: app.name }, speech: `Opening ${app.name}` };
    }
    const game = best(q, catalog.games, (g) => g.title, 0.5);
    if (game) {
      return {
        action: { type: 'launch-game', hostId: game.hostId, gameId: game.id, title: game.title, requiresKbm: game.requiresKbm },
        speech: game.requiresKbm ? `${game.title} needs a keyboard and mouse. Get them ready.` : `Starting ${game.title}`,
      };
    }
    const app = best(q, catalog.apps, (a) => a.name, 0.6);
    if (app) return { action: { type: 'launch-app', id: app.id, name: app.name }, speech: `Opening ${app.name}` };
  }

  return null;
}
