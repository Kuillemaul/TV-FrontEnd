import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import type { EventBus } from '../bus.js';
import { editConfigList, type ListEdit } from '../configedit.js';
import { loadConfig, type HearthConfig, type LabAction, type LabService } from '../config.js';
import { PermissionError } from '../profiles.js';
import type { DemoHome } from '../providers/demohome.js';
import type { HomeAssistant } from '../providers/homeassistant.js';
import type { LabMonitor } from '../providers/lab.js';
import { validateConfigText, writeConfig } from './admin.js';

export interface LabEditContext {
  config: HearthConfig;
  configPath: string;
  bus: EventBus;
  lab: LabMonitor;
  ha?: HomeAssistant;
  demoHome?: DemoHome;
  log: { info: (m: string) => void };
  fail: (err: unknown) => { ok: boolean; error: string };
  isKid: () => boolean;
}

type Kind = 'services' | 'sensors' | 'actions';
const KINDS: Kind[] = ['services', 'sensors', 'actions'];

const httpUrl = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw new Error(`${what} should be a full address, like http://192.168.1.20:8006`);
  return s;
};
const name = (v: unknown): string => {
  const s = String(v ?? '').trim().slice(0, 40);
  if (!s) throw new Error('Give it a name');
  return s;
};
const entityId = (v: unknown): string => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(s)) throw new Error('Pick a Home Assistant entity (like sensor.proxmox_cpu)');
  return s;
};

/** Turn what the form sent into a config entry, keeping fields the form doesn't show (headers, body…). */
export function cleanLabItem(kind: Kind, body: any, old?: any): unknown {
  if (kind === 'sensors') return entityId(body);
  if (kind === 'services') {
    const svc: LabService = { ...(old ?? {}), name: name(body?.name), url: httpUrl(body?.url, 'The address') };
    if (body?.check) svc.check = httpUrl(body.check, 'The check address');
    else delete svc.check;
    if (body?.open) svc.open = true;
    else delete svc.open;
    return svc;
  }
  const action: LabAction = { name: name(body?.name) };
  if (body?.ha) {
    const service = String(body.ha.service ?? '').trim();
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(service)) throw new Error('Pick what to do, like button.press');
    action.ha = { service, data: { ...(old?.ha?.data ?? {}), ...(body.ha.data ?? {}) } };
    if (body.ha.data?.entity_id !== undefined) action.ha.data!.entity_id = entityId(body.ha.data.entity_id);
  } else if (body?.http) {
    const method = String(body.http.method ?? 'POST').toUpperCase();
    if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error('Use GET, POST or PUT');
    action.http = { ...(old?.http ?? {}), url: httpUrl(body.http.url, 'The web address'), method };
  } else throw new Error('Choose a Home Assistant button/script or a web address');
  return action;
}

/**
 * Add, change and remove home lab services, sensors and actions from the TV or phone. Changes go
 * into config.yaml (comments kept, previous version backed up) and apply straight away.
 */
export function registerLabEdit(app: FastifyInstance, ctx: LabEditContext): void {
  const { config, configPath, bus, lab, ha, demoHome, log, fail, isKid } = ctx;

  const guard = () => {
    if (isKid()) throw new PermissionError('Ask a parent to change the home lab');
  };

  const apply = (kind: Kind, edit: ListEdit) => {
    const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const next = editConfigList(text, ['lab', kind], edit);
    const error = validateConfigText(next, configPath);
    if (error) throw new Error(error);
    writeConfig(configPath, next);
    const fresh = loadConfig(configPath).lab;
    config.lab.services = fresh.services;
    config.lab.sensors = fresh.sensors;
    config.lab.actions = fresh.actions;
    lab.reload();
    ha?.watch(fresh.sensors);
    bus.emit({ type: 'lab' });
    log.info(`home lab ${kind} changed (${edit.op})`);
  };

  const item = (kind: Kind, index: string) => {
    const list: unknown[] = config.lab[kind];
    const found = list[Number(index)];
    if (found === undefined) throw new Error('That item has gone; reopen the list');
    return found;
  };

  const run = async (fn: () => void) => {
    try {
      fn();
      return { ok: true, ...view() };
    } catch (err) {
      return fail(err);
    }
  };

  const view = () => ({ services: config.lab.services, sensors: config.lab.sensors, actions: config.lab.actions });

  app.get('/api/lab/config', async () => ({ ...view(), homeassistant: Boolean(ha || demoHome) }));

  app.post<{ Params: { kind: Kind }; Body: { item: unknown } }>('/api/lab/config/:kind', async (req) =>
    run(() => {
      guard();
      const kind = req.params.kind;
      if (!KINDS.includes(kind)) throw new Error('Unknown list');
      const next = cleanLabItem(kind, req.body?.item);
      if (kind === 'sensors' && config.lab.sensors.includes(next as string)) throw new Error('That sensor is already on the Lab page');
      apply(kind, { op: 'add', item: next });
    }),
  );

  app.put<{ Params: { kind: Kind; index: string }; Body: { item: unknown } }>('/api/lab/config/:kind/:index', async (req) =>
    run(() => {
      guard();
      const kind = req.params.kind;
      if (!KINDS.includes(kind)) throw new Error('Unknown list');
      const old = item(kind, req.params.index);
      apply(kind, { op: 'replace', old, item: cleanLabItem(kind, req.body?.item, old) });
    }),
  );

  app.delete<{ Params: { kind: Kind; index: string } }>('/api/lab/config/:kind/:index', async (req) =>
    run(() => {
      guard();
      const kind = req.params.kind;
      if (!KINDS.includes(kind)) throw new Error('Unknown list');
      apply(kind, { op: 'remove', old: item(kind, req.params.index) });
    }),
  );

  /** Home Assistant entities to pick from, e.g. ?domains=sensor or ?domains=button,script. */
  app.get<{ Querystring: { domains?: string } }>('/api/ha/pick', async (req) => {
    const domains = String(req.query.domains ?? 'sensor').split(',').filter((d) => /^[a-z_]+$/.test(d));
    const list = ha ? ha.byDomain(domains) : (demoHome?.byDomain(domains) ?? []);
    return list
      .map((e) => ({
        id: e.entity_id,
        name: String(e.attributes.friendly_name ?? e.entity_id),
        state: e.state,
        unit: e.attributes.unit_of_measurement ? String(e.attributes.unit_of_measurement) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}
