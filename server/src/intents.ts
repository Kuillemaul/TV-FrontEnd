/**
 * Local voice intents: things the TV itself should handle ("open Netflix",
 * "play Elden Ring", "watch channel 4"). Anything that doesn't match is passed
 * on to Home Assistant's conversation agent ("turn off the kitchen lights").
 */

export type PageId = 'home' | 'tv' | 'apps' | 'games' | 'smarthome' | 'lab' | 'settings';

export type UiAction =
  | { type: 'navigate'; page: PageId }
  | { type: 'launch-app'; id: string; name: string }
  | { type: 'launch-game'; hostId: string; gameId: string; title: string; requiresKbm: boolean }
  | { type: 'watch-channel'; id: string; name: string }
  | { type: 'stop' };

export interface IntentCatalog {
  apps: Array<{ id: string; name: string }>;
  games: Array<{ id: string; hostId: string; title: string; requiresKbm: boolean }>;
  channels: Array<{ id: string; number: number; name: string }>;
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
  [/^(smart home|home dashboard|dashboard|devices)$/, 'smarthome', 'Smart Home'],
  [/^(lab|home ?lab|servers|server status)$/, 'lab', 'Home Lab'],
  [/^(settings|system)$/, 'settings', 'Settings'],
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
};

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => ROMAN[w] ?? w)
    .join(' ');
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
