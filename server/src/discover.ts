import http from 'node:http';
import https from 'node:https';
import { connect, isIP } from 'node:net';

/**
 * Find what's running on your servers: give it an address (or scan the home network) and it checks
 * the usual ports, then works out what answered from the response itself (an app moved to another
 * port is still recognised). Used by setup, Settings → Connections and the Lab editor.
 */

/** Services Hearth can link to (setup / Connections), by their connection key. */
export type LinkKind = 'plex' | 'jellyfin' | 'emby' | 'homeassistant' | 'tvheadend' | 'seerr' | 'radarr' | 'sonarr' | 'lidarr';

export interface Found {
  host: string;
  port: number;
  url: string;
  /** What it is, e.g. "jellyfin", "proxmox", or "web" for an unknown page. */
  kind: string;
  /** Display name, e.g. "Jellyfin · Basement server". */
  name: string;
  /** Hearth can link to it (else it's for the Lab page). */
  link?: LinkKind;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** The usual ports for home servers and self-hosted apps. */
export const PORTS = [
  80, 443, 1880, 2283, 3000, 3001, 4533, 5000, 5055, 5076, 6767, 6789, 7575, 7878, 8000, 8006, 8080, 8081, 8085, 8096, 8112, 8123,
  8181, 8384, 8443, 8686, 8920, 8971, 8989, 9000, 9090, 9091, 9443, 9696, 9981, 13378, 19999, 32400, 61208,
];
const HTTPS_PORTS = new Set([443, 8006, 8443, 8920, 9443]);

/** Recognised by the page title (or body) when there's no better check. */
const BY_TITLE: Array<[RegExp, string, string, LinkKind?]> = [
  [/Proxmox Virtual Environment|pve-manager/i, 'proxmox', 'Proxmox'],
  [/Proxmox Backup Server/i, 'pbs', 'Proxmox Backup'],
  [/TrueNAS/i, 'truenas', 'TrueNAS'],
  [/Unraid/i, 'unraid', 'Unraid'],
  [/Portainer/i, 'portainer', 'Portainer'],
  [/Pi-hole/i, 'pihole', 'Pi-hole'],
  [/AdGuard Home/i, 'adguard', 'AdGuard Home'],
  [/Uptime Kuma/i, 'uptimekuma', 'Uptime Kuma'],
  [/Grafana/i, 'grafana', 'Grafana'],
  [/Tautulli/i, 'tautulli', 'Tautulli'],
  [/<title>\s*Radarr/i, 'radarr', 'Radarr', 'radarr'],
  [/<title>\s*Sonarr/i, 'sonarr', 'Sonarr', 'sonarr'],
  [/<title>\s*Lidarr/i, 'lidarr', 'Lidarr', 'lidarr'],
  [/<title>\s*Prowlarr/i, 'prowlarr', 'Prowlarr'],
  [/<title>\s*Readarr/i, 'readarr', 'Readarr'],
  [/<title>\s*Bazarr/i, 'bazarr', 'Bazarr'],
  [/qBittorrent/i, 'qbittorrent', 'qBittorrent'],
  [/Transmission Web/i, 'transmission', 'Transmission'],
  [/Deluge/i, 'deluge', 'Deluge'],
  [/SABnzbd/i, 'sabnzbd', 'SABnzbd'],
  [/NZBGet/i, 'nzbget', 'NZBGet'],
  [/Immich/i, 'immich', 'Immich'],
  [/Nextcloud/i, 'nextcloud', 'Nextcloud'],
  [/Node-RED/i, 'nodered', 'Node-RED'],
  [/Frigate/i, 'frigate', 'Frigate'],
  [/Audiobookshelf/i, 'audiobookshelf', 'Audiobookshelf'],
  [/Navidrome/i, 'navidrome', 'Navidrome'],
  [/Paperless/i, 'paperless', 'Paperless'],
  [/Vaultwarden|Bitwarden/i, 'vaultwarden', 'Vaultwarden'],
  [/Syncthing/i, 'syncthing', 'Syncthing'],
  [/Glances/i, 'glances', 'Glances'],
  [/Netdata/i, 'netdata', 'Netdata'],
  [/Homarr/i, 'homarr', 'Homarr'],
  [/Homepage/i, 'homepage', 'Homepage'],
  [/Nginx Proxy Manager/i, 'npm', 'Nginx Proxy Manager'],
  [/Cockpit/i, 'cockpit', 'Cockpit'],
  [/Synology|DiskStation/i, 'synology', 'Synology'],
  [/OpenMediaVault/i, 'omv', 'OpenMediaVault'],
  [/Tvheadend/i, 'tvheadend', 'Tvheadend', 'tvheadend'],
  [/Home Assistant/i, 'homeassistant', 'Home Assistant', 'homeassistant'],
  [/Jellyseerr|Overseerr|Seerr/i, 'seerr', 'Seerr', 'seerr'],
];

function get(url: string, timeoutMs: number, redirects = 2): Promise<Reply | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    // Home servers use self-signed certificates; only the page's content is read.
    const req = lib.get(u, { timeout: timeoutMs, rejectUnauthorized: false, headers: { Accept: 'application/json, text/html' } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        const next = new URL(loc, u);
        // Follow redirects on the same server only (e.g. / → /admin/ or /web/).
        if (next.hostname === u.hostname) return void get(next.toString(), timeoutMs, redirects - 1).then(resolve);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (body.length < 65_536) body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Reply | null): any => {
  try {
    return r ? JSON.parse(r.body) : null;
  } catch {
    return null;
  }
};
const title = (body: string) => body.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim();

/** What's answering at this address, or null if it isn't a web app. */
export async function identify(host: string, port: number, timeoutMs = 2500): Promise<Found | null> {
  const schemes = HTTPS_PORTS.has(port) ? ['https', 'http'] : ['http', 'https'];
  for (const scheme of schemes) {
    const base = `${scheme}://${host.includes(':') && isIP(host) === 6 ? `[${host}]` : host}${(scheme === 'http' && port === 80) || (scheme === 'https' && port === 443) ? '' : `:${port}`}`;
    const at = (kind: string, name: string, link?: LinkKind, path = ''): Found => ({ host, port, url: base + path, kind, name, link });

    // Apps with a tell-tale API (they also say who they are), all asked at once, plus the page itself.
    const [jfR, plex, seerrR, tvh, ha, page] = await Promise.all([
      get(`${base}/System/Info/Public`, timeoutMs),
      get(`${base}/identity`, timeoutMs),
      get(`${base}/api/v1/settings/public`, timeoutMs),
      get(`${base}/api/serverinfo`, timeoutMs),
      get(`${base}/manifest.json`, timeoutMs),
      get(`${base}/`, timeoutMs),
    ]);
    const jf = json(jfR);
    if (jf?.ProductName || jf?.ServerName) {
      const emby = /emby/i.test(jf.ProductName ?? '');
      return at(emby ? 'emby' : 'jellyfin', `${emby ? 'Emby' : 'Jellyfin'}${jf.ServerName ? ` · ${jf.ServerName}` : ''}`, emby ? 'emby' : 'jellyfin');
    }
    if (plex?.status === 200 && /machineIdentifier/.test(plex.body)) return at('plex', 'Plex Media Server', 'plex');
    const seerr = json(seerrR);
    if (seerr && ('applicationTitle' in seerr || 'mediaServerType' in seerr)) return at('seerr', seerr.applicationTitle || 'Seerr', 'seerr');
    if (tvh && (/"sw_version"|"api_version"/.test(tvh.body) || /tvheadend/i.test(String(tvh.headers['www-authenticate'] ?? '')))) return at('tvheadend', 'Tvheadend', 'tvheadend');
    if (ha?.status === 200 && /Home Assistant/i.test(ha.body)) return at('homeassistant', 'Home Assistant', 'homeassistant');

    if (!page) continue;
    const t = title(page.body) ?? '';
    const text = t ? `<title>${t}</title>` : page.body.slice(0, 4000);
    for (const [re, kind, name, link] of BY_TITLE) if (re.test(text)) return at(kind, name, link);
    // Pi-hole lives under /admin.
    if (port === 80 || port === 443) {
      const admin = await get(`${base}/admin/`, timeoutMs);
      if (admin && /Pi-hole/i.test(admin.body)) return at('pihole', 'Pi-hole', undefined, '/admin');
    }
    if (page.status && page.status < 500 && t) return at('web', t);
    if (page.status) return null;
  }
  return null;
}

/** Run jobs with at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Private addresses (and plain host names like nas.lan) only: this is for your own network. */
export function allowedHost(host: string): boolean {
  if (!/^[\w.:-]{1,253}$/.test(host)) return false;
  const v = isIP(host);
  if (!v) return !host.includes(':');
  if (v === 4) return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(host);
  return /^(fe80:|fc|fd|::1$)/i.test(host);
}

/** Every address on the same /24 as this machine (e.g. 192.168.1.1–254). */
export function subnetHosts(ip: string): string[] {
  const m = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`) : [];
}

/**
 * Scan hosts for services. `onFound` is called as each one turns up; `onProgress` with how far
 * along it is (0..1). Ports default to PORTS.
 */
export async function scan(
  hosts: string[],
  opts: { ports?: number[]; onFound?: (f: Found) => void; onProgress?: (done: number) => void; quick?: boolean } = {},
): Promise<Found[]> {
  const ports = opts.ports ?? PORTS;
  const pairs = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const found: Found[] = [];
  let done = 0;
  await pool(pairs, opts.quick ? 256 : 64, async ({ host, port }) => {
    if (await portOpen(host, port, opts.quick ? 400 : 900)) {
      const f = await identify(host, port);
      if (f && !found.some((x) => x.url === f.url)) {
        found.push(f);
        opts.onFound?.(f);
      }
    }
    done++;
    if (done % 25 === 0 || done === pairs.length) opts.onProgress?.(done / pairs.length);
  });
  // Linkable apps first, then by address.
  return found.sort((a, b) => Number(Boolean(b.link)) - Number(Boolean(a.link)) || a.host.localeCompare(b.host, undefined, { numeric: true }) || a.port - b.port);
}
