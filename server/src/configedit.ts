import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';

/** The file as a document; an empty file starts as an empty block-style one (not inline `{}`). */
const open = (text: string) => (text.trim() ? parseDocument(text) : new Document({}));

export type ListEdit =
  | { op: 'add'; item: unknown }
  | { op: 'replace'; old: unknown; item: unknown }
  | { op: 'remove'; old: unknown };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Change one list in config.yaml text (e.g. lab.services) and return the new text. Everything else,
 * comments included, stays as you wrote it. Items are found by their content, since untouched
 * example entries in the file are skipped when Hearth loads it and so don't line up by position.
 */
export function editConfigList(text: string, path: string[], edit: ListEdit): string {
  const doc = open(text);
  if (doc.errors.length) throw new Error(`config.yaml has an error to fix first: ${doc.errors[0].message.split('\n')[0]}`);
  if (!isMap(doc.contents)) throw new Error('config.yaml isn’t a list of settings');

  // Make sure each parent (e.g. `lab:`) is a map; an empty `lab:` loads as null.
  for (let i = 1; i < path.length; i++) {
    const parent = path.slice(0, i);
    if (!isMap(doc.getIn(parent, true))) doc.setIn(parent, doc.createNode({}));
  }
  let seq = doc.getIn(path, true);
  if (!isSeq(seq)) {
    if (edit.op !== 'add') throw new Error('That item isn’t in config.yaml any more');
    doc.setIn(path, doc.createNode([edit.item]));
    return doc.toString();
  }

  if (edit.op === 'add') {
    seq.add(doc.createNode(edit.item));
    return doc.toString();
  }
  const index = seq.items.findIndex((node) => same((node as { toJSON?: () => unknown })?.toJSON?.() ?? node, edit.old));
  if (index < 0) throw new Error('That item isn’t in config.yaml any more (was it changed there?)');
  if (edit.op === 'replace') seq.set(index, doc.createNode(edit.item));
  else seq.delete(index);
  return doc.toString();
}

/**
 * Set (or with `undefined`, remove) values in config.yaml text, e.g. [['plex'], { url, token }] or
 * [['ui', 'name'], 'Den']. Like editConfigList, everything else and its comments stay as written.
 */
export function setConfigValues(text: string, changes: Array<[path: string[], value: unknown]>): string {
  const doc = open(text);
  if (doc.errors.length) throw new Error(`config.yaml has an error to fix first: ${doc.errors[0].message.split('\n')[0]}`);
  if (!isMap(doc.contents)) throw new Error('config.yaml isn’t a list of settings');
  for (const [path, value] of changes) {
    if (value === undefined) {
      if (doc.hasIn(path)) doc.deleteIn(path);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const parent = path.slice(0, i);
      if (!isMap(doc.getIn(parent, true))) doc.setIn(parent, doc.createNode({}));
    }
    // Change a plain value in place so a comment beside it stays.
    const node = doc.getIn(path, true);
    if (isScalar(node) && (value === null || typeof value !== 'object')) node.value = value;
    else doc.setIn(path, doc.createNode(value));
  }
  return doc.toString();
}
