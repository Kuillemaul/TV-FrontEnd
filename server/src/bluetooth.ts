import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Bluetooth from the couch: controllers, headphones, speakers, keyboards. Drives BlueZ's
 * bluetoothctl: one-off commands for status/connect/forget, and an interactive session (with a
 * "no input, no output" pairing agent, which suits controllers and headphones) for scanning and
 * pairing.
 */

export interface BtDevice {
  mac: string;
  name: string;
  /** BlueZ icon: input-gaming, audio-headset, audio-card, input-keyboard, input-mouse… */
  icon: string;
  paired: boolean;
  connected: boolean;
  trusted: boolean;
  battery: number | null;
}

export interface BtStatus {
  available: boolean;
  error?: string;
  powered: boolean;
  discovering: boolean;
  devices: BtDevice[];
}

// bluetoothctl colours its output; strip that before parsing.
const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const MAC = /([0-9A-F]{2}(?::[0-9A-F]{2}){5})/i;

export function parseShow(text: string): { powered: boolean; discovering: boolean } {
  const t = clean(text);
  return { powered: /Powered:\s*yes/.test(t), discovering: /Discovering:\s*yes/.test(t) };
}

/** `bluetoothctl devices` → [mac, name]. */
export function parseDevices(text: string): Array<[string, string]> {
  return clean(text)
    .split('\n')
    .map((l) => /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => [m[1].toUpperCase(), m[2].trim()]);
}

/** `bluetoothctl info <mac>` → device details. */
export function parseInfo(mac: string, text: string): BtDevice {
  const t = clean(text);
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(t)?.[1]?.trim();
  const battery = /Battery Percentage:\s*0x[0-9a-f]+\s*\((\d+)\)/i.exec(t)?.[1];
  return {
    mac,
    name: field('Alias') ?? field('Name') ?? mac,
    icon: field('Icon') ?? '',
    paired: field('Paired') === 'yes',
    connected: field('Connected') === 'yes',
    trusted: field('Trusted') === 'yes',
    battery: battery ? Number(battery) : null,
  };
}

/** A name worth showing in "add a device" (BlueZ lists nameless beacons as their MAC with dashes). */
export const hasRealName = (d: BtDevice) => d.name !== d.mac && !/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(d.name);

function ctl(args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bluetoothctl', args, { timeout }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('Bluetooth needs BlueZ: sudo apt install bluez'));
      // bluetoothctl often exits non-zero but still prints what we need.
      if (err && !stdout) return reject(new Error(clean(stderr).trim() || err.message));
      resolve(stdout);
    });
  });
}

/** An interactive bluetoothctl kept open while scanning/pairing. */
class Session {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiters: Array<{ re: RegExp[]; resolve: (line: string) => void }> = [];
  private idle?: NodeJS.Timeout;

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => this.feed(String(d)));
    proc.stderr.on('data', (d) => this.feed(String(d)));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on('error', () => undefined);
    this.proc = proc;
    proc.stdin.write('agent NoInputNoOutput\ndefault-agent\n');
    return proc;
  }

  private feed(chunk: string): void {
    this.buffer += clean(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      for (const w of [...this.waiters]) {
        if (w.re.some((r) => r.test(line))) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    }
  }

  /** Send a command and wait for a line matching one of `re` (or time out). */
  send(line: string, re: RegExp[] = [], timeout = 30_000): Promise<string | null> {
    const proc = this.ensure();
    this.touch();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const w = {
        re,
        resolve: (l: string) => {
          clearTimeout(timer);
          resolve(l);
        },
      };
      if (re.length) this.waiters.push(w);
      proc.stdin.write(`${line}\n`);
      if (!re.length) return resolve(null);
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeout);
    });
  }

  /** Close the session after a quiet minute. */
  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 60_000);
    this.idle.unref();
  }

  close(): void {
    clearTimeout(this.idle);
    if (this.proc && this.proc.exitCode === null) {
      const proc = this.proc;
      proc.stdin.write('scan off\nquit\n');
      proc.stdin.end();
      setTimeout(() => proc.kill(), 1000).unref();
    }
  }
}

export class BluetoothControl {
  private session = new Session();
  private scanTimer?: NodeJS.Timeout;

  async status(): Promise<BtStatus> {
    try {
      const show = parseShow(await ctl(['show']));
      const list = parseDevices(await ctl(['devices']));
      const devices = await Promise.all(list.map(async ([mac]) => parseInfo(mac, await ctl(['info', mac]).catch(() => ''))));
      devices.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name));
      return { available: true, ...show, devices };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        available: false,
        error: /No default controller|not available/i.test(msg) ? 'No Bluetooth adapter found. Plug in a USB Bluetooth adapter.' : msg,
        powered: false,
        discovering: false,
        devices: [],
      };
    }
  }

  async power(on: boolean): Promise<void> {
    await ctl(['power', on ? 'on' : 'off']);
  }

  /** Look for new devices for up to `seconds`. */
  async scan(on: boolean, seconds = 45): Promise<void> {
    clearTimeout(this.scanTimer);
    if (!on) {
      await this.session.send('scan off');
      return;
    }
    await ctl(['power', 'on']).catch(() => undefined);
    await this.session.send('scan on', [/Discovery started|SetDiscoveryFilter success|Failed to start discovery/i], 5000);
    this.scanTimer = setTimeout(() => void this.session.send('scan off'), seconds * 1000);
    this.scanTimer.unref();
  }

  /** Pair, trust (so it reconnects by itself) and connect. */
  async pair(mac: string): Promise<void> {
    if (!MAC.test(mac)) throw new Error('Not a Bluetooth address');
    const paired = await this.session.send(
      `pair ${mac}`,
      [/Pairing successful/i, /Failed to pair/i, /AlreadyExists/i, /not available/i],
      40_000,
    );
    if (!paired) throw new Error('No answer. Put the device in pairing mode and try again.');
    if (/Failed|not available/i.test(paired)) throw new Error(paired.replace(/^.*?(Failed|Device)/i, '$1').trim());
    await this.session.send(`trust ${mac}`, [/trust succeeded|Changing .* trust/i], 5000);
    const connected = await this.session.send(`connect ${mac}`, [/Connection successful/i, /Failed to connect/i], 20_000);
    if (connected && /Failed/i.test(connected)) throw new Error('Paired, but it didn’t connect. Press a button on it or choose Connect.');
    void this.session.send('scan off');
  }

  /** Stop scanning and close the bluetoothctl session (shutdown, tests). */
  close(): void {
    clearTimeout(this.scanTimer);
    this.session.close();
  }

  async connect(mac: string): Promise<void> {
    const out = clean(await ctl(['connect', mac], 25_000));
    if (!/Connection successful/i.test(out)) throw new Error('Couldn’t connect. Is it switched on and nearby?');
  }

  async disconnect(mac: string): Promise<void> {
    await ctl(['disconnect', mac]);
  }

  async forget(mac: string): Promise<void> {
    await ctl(['remove', mac]);
  }
}
