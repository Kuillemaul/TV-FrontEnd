import { post } from './api';

/** Home lab entries as config.yaml holds them (see server/src/config.ts). */
export interface LabServiceItem {
  name: string;
  url: string;
  check?: string;
  open?: boolean;
}
export interface LabActionItem {
  name: string;
  ha?: { service: string; data?: Record<string, unknown> };
  http?: { url: string; method?: string };
}
export interface LabConfigView {
  services: LabServiceItem[];
  sensors: string[];
  actions: LabActionItem[];
  homeassistant: boolean;
}
export type LabKind = 'services' | 'sensors' | 'actions';

export interface HaPick {
  id: string;
  name: string;
  state: string;
  unit?: string;
}

/** What a Home Assistant entity does when used as a lab action, by its domain. */
export const ACTION_SERVICES: Record<string, string> = {
  button: 'button.press',
  input_button: 'input_button.press',
  script: 'script.turn_on',
  scene: 'scene.turn_on',
  automation: 'automation.trigger',
  switch: 'switch.toggle',
};
export const ACTION_DOMAINS = Object.keys(ACTION_SERVICES).join(',');

/** One line about what an action does. */
export function describeAction(a: LabActionItem): string {
  if (a.ha) return `${a.ha.service}${a.ha.data?.entity_id ? ` → ${String(a.ha.data.entity_id)}` : ''}`;
  if (a.http) return `${a.http.method ?? 'POST'} ${a.http.url}`;
  return '';
}

type Reply = Partial<LabConfigView> & { ok: boolean; error?: string };

/** Add (index undefined), change or remove (item null) a lab entry. */
export function saveLabItem(kind: LabKind, index: number | undefined, item: unknown): Promise<Reply> {
  if (item === null) return post<Reply>(`/api/lab/config/${kind}/${index}`, {}, 'DELETE');
  return index === undefined ? post<Reply>(`/api/lab/config/${kind}`, { item }) : post<Reply>(`/api/lab/config/${kind}/${index}`, { item }, 'PUT');
}
