import fs from 'node:fs';
import path from 'node:path';
import { KitError } from './errors.mjs';
import { ID_RE } from './util.mjs';

const TEMPLATE_FOR = { mcp: 'mcp-stdio', skill: 'skill', plugin: 'plugin', extension: 'extension' };

function fill(text, vars) {
  return text.replace(/__([A-Z_]+)__/g, (all, k) => (vars[k] !== undefined ? String(vars[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') : all));
}

function writeNew(file, data) {
  if (fs.existsSync(file)) throw new KitError('exists', `Already exists: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** Create a new draft item (and, for MCP, its tools/ folder) from the templates. */
export function scaffoldItem({ root, templatesDir, kind, id, template, category, folder, info = {}, name }) {
  if (!ID_RE.test(id || '')) throw new KitError('bad_id', 'id must be lowercase letters, digits and dashes');
  const tplName = template ? `${kind}-${template}` : TEMPLATE_FOR[kind] || 'plugin';
  const tplFile = path.join(templatesDir, `${tplName}.item.json`);
  if (!fs.existsSync(tplFile)) throw new KitError('no_template', `No template ${path.basename(tplFile)} in ${templatesDir}`);
  const today = new Date().toISOString().slice(0, 10);
  const vars = {
    ID: id,
    KIND: kind,
    NAME: name || info.name || id,
    DATE: today,
    CATEGORY: category || 'other',
    REPO: info.full_name || 'TODO-owner/TODO-repo',
    AUTHOR: info.author || 'TODO author',
    LICENSE: info.license || 'TODO license',
    DESCRIPTION: info.description || 'TODO: what this does, in 2-3 plain sentences',
  };
  const data = JSON.parse(fill(fs.readFileSync(tplFile, 'utf8'), vars));
  if (info.stars !== undefined && info.stars !== null) data.stars = { count: info.stars, as_of: today };
  if (info.description) data.summary = info.description.slice(0, 140);
  const asFolder = folder || kind === 'mcp';
  const file = asFolder ? path.join(root, 'items', kind, id, 'item.json') : path.join(root, 'items', kind, `${id}.json`);
  if (fs.existsSync(path.join(root, 'items', kind, `${id}.json`)) || fs.existsSync(path.join(root, 'items', kind, id))) throw new KitError('exists', `Item ${kind}/${id} already exists`);
  writeNew(file, data);
  return { file, folder: asFolder ? path.dirname(file) : null };
}

export function scaffoldTool({ root, templatesDir, itemId, id, name }) {
  if (!ID_RE.test(id || '')) throw new KitError('bad_id', 'tool id must be lowercase letters, digits and dashes');
  const dir = path.join(root, 'items', 'mcp', itemId);
  if (!fs.existsSync(path.join(dir, 'item.json'))) throw new KitError('item_not_found', `MCP item '${itemId}' must exist in folder form (items/mcp/${itemId}/item.json)`);
  const data = JSON.parse(fill(fs.readFileSync(path.join(templatesDir, 'tool.json'), 'utf8'), { ID: id, NAME: name || id.replace(/-/g, '_') }));
  return { file: writeNew(path.join(dir, 'tools', `${id}.json`), data) };
}

export function scaffoldCategory({ root, templatesDir, id, name }) {
  if (!ID_RE.test(id || '')) throw new KitError('bad_id', 'category id must be lowercase letters, digits and dashes');
  const data = JSON.parse(fill(fs.readFileSync(path.join(templatesDir, 'category.json'), 'utf8'), { ID: id, NAME: name || id }));
  return { file: writeNew(path.join(root, 'categories', `${id}.json`), data) };
}
