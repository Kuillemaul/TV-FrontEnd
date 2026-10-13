import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { EventBus } from '../bus.js';
import { loadConfig, type HearthConfig } from '../config.js';
import { ELEVATE_HEADER, ELEVATE_SECRET, isElevated, isPrivateAddress } from '../elevate.js';
import { hardExit } from '../exit.js';

/**
 * The network editor: a second web server on config.admin.port (default 8780) for your laptop or
 * phone. No login, but it only answers addresses on your home network. It serves the /admin page
 * and passes every /api call to the TV's own server as a parent ("elevated"), so all the TV's
 * rules and live updates apply. A few admin-only endpoints (config file, background images,
 * restart) live on the main server and refuse anything that isn't elevated.
 */

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const KEEP_BACKUPS = 10;

export interface AdminContext {
  config: HearthConfig;
  configPath: string;
  bus: EventBus;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export const backgroundsDir = (config: HearthConfig) => join(config.stateDir, 'backgrounds');

/** Check a config.yaml text the way Hearth will load it. Returns a friendly error or null. */
export function validateConfigText(text: string, configPath: string): string | null {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    return `${line ? `Line ${line}: ` : ''}${e.message.split('\n')[0]}`;
  }
  // Load it for real (from a file next to config.yaml, so the example-skipping works the same).
  const probe = join(dirname(configPath), '.config.check.yaml');
  writeFileSync(probe, text);
  try {
    loadConfig(probe);
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      /* already gone */
    }
  }
}

/** Admin-only endpoints on the main server (they need the elevated context the editor sets). */
export function registerAdminApi(app: FastifyInstance, ctx: AdminContext): void {
  const { config, configPath, log } = ctx;
  const bgDir = backgroundsDir(config);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/admin/') && !isElevated()) return reply.code(403).send({ error: 'Use the network editor' });
  });

  app.get('/api/admin/config', async () => ({
    path: configPath,
    yaml: existsSync(configPath) ? readFileSync(configPath, 'utf8') : '',
    ignoredExamples: config.ignoredExamples,
    backups: listBackups(configPath),
  }));

  app.post<{ Body: { yaml: string } }>('/api/admin/config/check', async (req) => {
    const error = validateConfigText(String(req.body?.yaml ?? ''), configPath);
    return { ok: !error, error };
  });

  app.put<{ Body: { yaml: string; restart?: boolean } }>('/api/admin/config', async (req, reply) => {
    const text = String(req.body?.yaml ?? '');
    const error = validateConfigText(text, configPath);
    if (error) return reply.code(400).send({ ok: false, error });
    // Keep the previous versions, newest first, so a bad edit can be rolled back.
    if (existsSync(configPath)) {
      const dir = join(dirname(configPath), 'backups');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `config-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`), readFileSync(configPath));
      for (const old of listBackups(configPath).slice(KEEP_BACKUPS)) unlinkSync(join(dir, old));
    }
    const tmp = `${configPath}.new`;
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
    log.info('config.yaml saved from the network editor');
    if (req.body.restart) scheduleRestart(log);
    return { ok: true, restarting: Boolean(req.body.restart) };
  });

  app.get<{ Params: { name: string } }>('/api/admin/config/backups/:name', async (req, reply) => {
    const name = basename(req.params.name);
    const file = join(dirname(configPath), 'backups', name);
    if (!name.endsWith('.yaml') || !existsSync(file)) return reply.code(404).send({ error: 'No such backup' });
    return { yaml: readFileSync(file, 'utf8') };
  });

  app.post('/api/admin/restart', async () => {
    scheduleRestart(log);
    return { ok: true };
  });

  /* ---------- updates (os/update.sh, run as root by hearth-update.service) ---------- */

  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const git = (args: string[]) =>
    new Promise<string>((resolve) => execFile('git', ['-C', repoRoot, ...args], { timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));

  app.get('/api/admin/update', async () => {
    const [head, branch] = await Promise.all([git(['log', '-1', '--format=%h%x09%cI%x09%s']), git(['rev-parse', '--abbrev-ref', 'HEAD'])]);
    const [sha, date, subject] = head.split('\t');
    let status: unknown = null;
    try {
      status = JSON.parse(readFileSync(join(config.stateDir, 'update.json'), 'utf8'));
    } catch {
      /* never run yet */
    }
    return { current: sha ? { sha, date, subject } : null, branch: branch || null, status };
  });

  app.post('/api/admin/update', async (_req, reply) => {
    // Preferred: hearth-update.path (install.sh) starts the updater when this file changes.
    if (existsSync('/etc/systemd/system/hearth-update.path')) {
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(join(config.stateDir, 'update-request'), `${Date.now()}\n`);
      return { ok: true };
    }
    const err = await new Promise<string | null>((resolve) =>
      execFile('systemctl', ['start', '--no-block', 'hearth-update.service'], { timeout: 10_000 }, (e, _out, stderr) => resolve(e ? stderr.trim() || e.message : null)),
    );
    if (err) return reply.code(500).send({ ok: false, error: `Couldn't start the updater (${err}). On the TV run: cd ~/hearth && git pull && sudo ./os/install.sh` });
    return { ok: true };
  });

  app.get('/api/admin/backgrounds', async () => ({ files: listImages(bgDir) }));
  // The TV's theme menu lists uploaded photos too.
  app.get('/api/backgrounds', async () => ({ files: listImages(bgDir) }));

  app.post<{ Body: { name: string; data: string } }>('/api/admin/backgrounds', { bodyLimit: 22 * 1024 * 1024 }, async (req, reply) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(String(req.body?.data ?? ''));
    if (!m) return reply.code(400).send({ ok: false, error: 'Upload a JPG, PNG or WebP image' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) return reply.code(400).send({ ok: false, error: 'That image is over 15 MB' });
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[m[1]]!;
    const stem = basename(String(req.body.name ?? 'background'), extname(String(req.body.name ?? '')))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'background';
    mkdirSync(bgDir, { recursive: true });
    let file = `${stem}${ext}`;
    for (let i = 2; existsSync(join(bgDir, file)); i++) file = `${stem}-${i}${ext}`;
    writeFileSync(join(bgDir, file), bytes);
    return { ok: true, file };
  });

  app.delete<{ Params: { file: string } }>('/api/admin/backgrounds/:file', async (req, reply) => {
    const file = basename(req.params.file);
    const path = join(bgDir, file);
    if (!IMAGE_TYPES[extname(file).toLowerCase()] || !existsSync(path)) return reply.code(404).send({ ok: false, error: 'No such image' });
    unlinkSync(path);
    return { ok: true };
  });

  // The TV (and the editor's previews) load background images from here.
  app.get<{ Params: { file: string } }>('/backgrounds/:file', async (req, reply) => {
    const file = basename(req.params.file);
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    const path = join(bgDir, file);
    if (!type || !existsSync(path)) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=86400').type(type).send(readFileSync(path));
  });
}

function listBackups(configPath: string): string[] {
  const dir = join(dirname(configPath), 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^config-.*\.yaml$/.test(f))
    .sort()
    .reverse();
}

function listImages(dir: string): Array<{ file: string; size: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_TYPES[extname(f).toLowerCase()])
    .map((file) => ({ file, size: statSync(join(dir, file)).size }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Exit and let systemd start Hearth again (Restart=always), picking up the new config. */
function scheduleRestart(log: AdminContext['log']): void {
  log.info('restarting to apply the new settings');
  setTimeout(hardExit, 600);
}

/** Start the network editor's own web server. */
export async function startAdminServer(main: FastifyInstance, ctx: AdminContext, webDist: string): Promise<void> {
  const { config, log } = ctx;
  if (!config.admin.enabled) return;
  const admin = Fastify({ bodyLimit: 25 * 1024 * 1024 });
  // Pass bodies through untouched to the main server.
  admin.removeAllContentTypeParsers();
  admin.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  admin.addHook('onRequest', async (req, reply) => {
    if (!isPrivateAddress(req.ip)) return reply.code(403).send('Hearth’s editor only answers devices on your home network.');
  });

  const forward = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const headers: Record<string, string> = { [ELEVATE_HEADER]: ELEVATE_SECRET };
    for (const h of ['content-type', 'accept', 'if-none-match']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const res = await main.inject({ method: req.method as 'GET', url: req.url, headers, payload: (req.body as Buffer | undefined) ?? undefined });
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined && !['content-length', 'connection', 'transfer-encoding'].includes(k)) reply.header(k, v as string);
    }
    return reply.code(res.statusCode).send(res.rawPayload);
  };
  admin.all('/api/*', forward);
  admin.get('/backgrounds/*', forward);
  admin.get('/tiles/*', forward);

  if (existsSync(webDist)) {
    await admin.register(fastifyStatic, { root: webDist });
    admin.get('/', async (_req, reply) => reply.redirect('/admin'));
    admin.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  }
  await admin.listen({ port: config.admin.port, host: '0.0.0.0' });
  log.info(`Network editor on http://<this TV's address>:${config.admin.port} (home network only, no login)`);
}
