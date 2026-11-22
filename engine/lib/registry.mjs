import fs from 'node:fs';
import path from 'node:path';
import { listDir, readJson } from './util.mjs';

const skip = (name) => name.startsWith('.') || name.startsWith('_');

function loadTable(root, sub, db, map) {
  const dir = path.join(root, sub);
  for (const e of listDir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.json') || skip(e.name)) continue;
    const file = path.join(dir, e.name);
    const id = e.name.slice(0, -5);
    try {
      map.set(id, { id, file, data: readJson(file) });
    } catch (err) {
      db.errors.push({ file, message: `Invalid JSON: ${err.message}` });
    }
  }
}

function loadItem(db, kind, id, file, dir) {
  let data;
  try {
    data = readJson(file);
  } catch (err) {
    db.errors.push({ file, message: `Invalid JSON: ${err.message}` });
    return;
  }
  const rec = { kind, id, file, dir, data, tools: [] };
  if (dir) {
    for (const t of listDir(path.join(dir, 'tools'))) {
      if (!t.isFile() || !t.name.endsWith('.json') || skip(t.name)) continue;
      const tf = path.join(dir, 'tools', t.name);
      try {
        rec.tools.push({ id: t.name.slice(0, -5), file: tf, data: readJson(tf) });
      } catch (err) {
        db.errors.push({ file: tf, message: `Invalid JSON: ${err.message}` });
      }
    }
    rec.tools.sort((a, b) => (a.data.order ?? 100) - (b.data.order ?? 100) || a.id.localeCompare(b.id));
  }
  db.items.push(rec);
}

/**
 * Load the registry as a small relational database.
 * agents / kinds / categories are one JSON file per row; items live in items/<kind>/<id>[/item.json];
 * tools (child rows of an item) live in items/<kind>/<id>/tools/<tool>.json.
 */
export function loadRegistry(root, opts = {}) {
  const db = {
    root,
    agents: new Map(),
    kinds: new Map(),
    categories: new Map(),
    items: [],
    errors: [],
    includeDrafts: !!opts.includeDrafts,
  };
  loadTable(root, 'agents', db, db.agents);
  loadTable(root, 'kinds', db, db.kinds);
  loadTable(root, 'categories', db, db.categories);
  const itemsDir = path.join(root, 'items');
  for (const k of listDir(itemsDir)) {
    if (!k.isDirectory() || skip(k.name)) continue;
    const kdir = path.join(itemsDir, k.name);
    for (const e of listDir(kdir)) {
      if (skip(e.name)) continue;
      if (e.isFile() && e.name.endsWith('.json')) {
        loadItem(db, k.name, e.name.slice(0, -5), path.join(kdir, e.name), null);
      } else if (e.isDirectory()) {
        const idir = path.join(kdir, e.name);
        const f = path.join(idir, 'item.json');
        if (fs.existsSync(f)) loadItem(db, k.name, e.name, f, idir);
        else db.errors.push({ file: idir, message: 'Item folder has no item.json' });
      }
    }
  }
  return db;
}
