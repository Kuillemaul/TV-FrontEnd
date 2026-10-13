import { execFile } from 'node:child_process';

/** Wi-Fi from the couch, through NetworkManager's nmcli (install.sh installs it and lets Hearth use it). */

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
  inUse: boolean;
  saved: boolean;
}

export interface WifiStatus {
  available: boolean;
  error?: string;
  enabled: boolean;
  device: string | null;
  connected: { ssid: string; signal: number; ip: string | null } | null;
  networks: WifiNetwork[];
}

/** Split one line of `nmcli -t` output: fields are ':'-separated, with '\:' and '\\' escaped. */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) cur += line[++i];
    else if (ch === ':') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` → one entry per network name, strongest first. */
export function parseNetworks(text: string, saved: Set<string>): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = splitTerse(line);
    if (!ssid) continue; // hidden networks
    const n: WifiNetwork = { ssid, signal: Number(signal) || 0, secure: Boolean(security && security !== '--'), inUse: inUse === '*', saved: saved.has(ssid) };
    const prev = best.get(ssid);
    if (!prev || n.inUse || (!prev.inUse && n.signal > prev.signal)) best.set(ssid, { ...n, inUse: n.inUse || Boolean(prev?.inUse) });
  }
  return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

function nmcli(args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('nmcli', args, { timeout }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error('Wi-Fi needs NetworkManager. On the TV run: cd ~/hearth && git pull && sudo ./os/install.sh'));
      }
      if (err) return reject(new Error(friendly(stderr || err.message)));
      resolve(stdout);
    });
  });
}

function friendly(msg: string): string {
  const m = msg.replace(/^Error:\s*/i, '').trim();
  if (/Secrets were required|802-1x|wrong password|psk/i.test(m)) return 'Wrong password, or the network refused to connect';
  if (/not authorized|insufficient privileges/i.test(m)) return 'Hearth isn’t allowed to change Wi-Fi yet. On the TV run: sudo ./os/install.sh (from ~/hearth)';
  if (/No network with SSID/i.test(m)) return 'That network is out of range';
  if (/timeout|timed out/i.test(m)) return 'The network didn’t answer in time. Try again closer to the router.';
  return m.split('\n')[0] || 'Wi-Fi error';
}

export class WifiControl {
  private async device(): Promise<string | null> {
    const out = await nmcli(['-t', '-f', 'DEVICE,TYPE', 'device']);
    for (const line of out.split('\n')) {
      const [dev, type] = splitTerse(line);
      if (type === 'wifi') return dev;
    }
    return null;
  }

  private async savedNames(): Promise<Set<string>> {
    const out = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']).catch(() => '');
    return new Set(
      out
        .split('\n')
        .map(splitTerse)
        .filter(([, type]) => type === '802-11-wireless' || type === 'wifi')
        .map(([name]) => name),
    );
  }

  async status(rescan = false): Promise<WifiStatus> {
    const empty = { enabled: false, device: null, connected: null, networks: [] };
    try {
      const device = await this.device();
      if (!device) return { available: false, error: 'No Wi-Fi adapter found. It may need firmware: sudo apt install firmware-iwlwifi, then reboot.', ...empty };
      const enabled = (await nmcli(['radio', 'wifi'])).trim() === 'enabled';
      if (!enabled) return { available: true, ...empty, device };
      const saved = await this.savedNames();
      const list = await nmcli(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], 30_000);
      const networks = parseNetworks(list, saved);
      const current = networks.find((n) => n.inUse);
      let ip: string | null = null;
      if (current) {
        const show = await nmcli(['-t', '-f', 'IP4.ADDRESS', 'device', 'show', device]).catch(() => '');
        ip = /IP4\.ADDRESS\[1\]:([\d.]+)/.exec(show)?.[1] ?? null;
      }
      return { available: true, enabled, device, connected: current ? { ssid: current.ssid, signal: current.signal, ip } : null, networks };
    } catch (err) {
      return { available: false, error: (err as Error).message, ...empty };
    }
  }

  async radio(on: boolean): Promise<void> {
    await nmcli(['radio', 'wifi', on ? 'on' : 'off']);
  }

  /** Join a network: a saved one by name, or a new one with its password. */
  async connect(ssid: string, password?: string): Promise<void> {
    if (!ssid || ssid.length > 32) throw new Error('Pick a network');
    const saved = await this.savedNames();
    if (saved.has(ssid) && !password) {
      await nmcli(['connection', 'up', 'id', ssid], 45_000);
      return;
    }
    if (saved.has(ssid)) await nmcli(['connection', 'delete', 'id', ssid]).catch(() => undefined);
    const dev = await this.device();
    const args = ['device', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    if (dev) args.push('ifname', dev);
    try {
      await nmcli(args, 45_000);
    } catch (err) {
      // A failed first try leaves a half-made profile behind; drop it so the next try starts clean.
      await nmcli(['connection', 'delete', 'id', ssid]).catch(() => undefined);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const dev = await this.device();
    if (dev) await nmcli(['device', 'disconnect', dev]);
  }

  async forget(ssid: string): Promise<void> {
    await nmcli(['connection', 'delete', 'id', ssid]);
  }
}
