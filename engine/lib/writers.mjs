import fs from 'node:fs';
import { isObj, deepEqual } from './util.mjs';

// ---------------------------------------------------------------- generic file helpers
export function readTextLoose(file) {
  try {
    return { exists: true, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '' };
    throw e;
  }
}

// ---------------------------------------------------------------- JSON
export function readJsonLoose(file) {
  const t = readTextLoose(file);
  if (!t.exists) return { exists: false, data: {}, indent: 2, eol: '\n' };
  const raw = t.text.replace(/^﻿/, '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  if (!raw.trim()) return { exists: true, data: {}, indent: 2, eol, empty: true };
  try {
    const data = JSON.parse(raw);
    if (!isObj(data)) return { exists: true, error: 'top-level value is not a JSON object' };
    const m = /\n([ \t]+)"/.exec(raw);
    const indent = m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
    return { exists: true, data, indent, eol };
  } catch (e) {
    return { exists: true, error: `not strict JSON (${e.message}); comments or trailing commas?` };
  }
}

export function renderJson(data, f = {}) {
  const s = JSON.stringify(data, null, f.indent ?? 2);
  return f.eol === '\r\n' ? `${s.replace(/\n/g, '\r\n')}\r\n` : `${s}\n`;
}

function descend(doc, root, create) {
  let cur = doc;
  for (const k of root) {
    if (!isObj(cur[k])) {
      if (!create) return undefined;
      if (cur[k] !== undefined) throw new Error(`'${k}' exists but is not an object`);
      cur[k] = {};
    }
    cur = cur[k];
  }
  return cur;
}

/** Check what an upsert would do without changing anything: add | noop | conflict | blocked. */
export function jsonInspect(data, root, key, value) {
  let cur = data;
  for (const k of root) {
    if (cur === undefined) break;
    if (!isObj(cur)) return { status: 'blocked', reason: `${root.join('.')} is not an object` };
    cur = cur[k];
  }
  if (cur !== undefined && !isObj(cur)) return { status: 'blocked', reason: `${root.join('.')} is not an object` };
  if (!cur || cur[key] === undefined) return { status: 'add' };
  return deepEqual(cur[key], value) ? { status: 'noop' } : { status: 'conflict', existing: cur[key] };
}

export function jsonApply(data, root, key, value) {
  const doc = structuredClone(data);
  descend(doc, root, true)[key] = value;
  return doc;
}

const SHAPE_KEYS = new Set(['command', 'args', 'argv', 'env', 'url', 'headers', 'name', 'transport']);
/** Build an agent-specific entry from a template: "{args}" keeps typed values, empty args/env/headers are dropped. */
export function shape(tpl, def) {
  if (typeof tpl === 'string') {
    const m = /^\{(\w+)\}$/.exec(tpl);
    if (m && SHAPE_KEYS.has(m[1])) return def[m[1]];
    return tpl.replace(/\{(\w+)\}/g, (all, k) => (SHAPE_KEYS.has(k) && def[k] !== undefined ? String(def[k]) : all));
  }
  if (Array.isArray(tpl)) return tpl.map((x) => shape(x, def)).filter((x) => x !== undefined);
  if (isObj(tpl)) {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) {
      const r = shape(v, def);
      if (r === undefined) continue;
      const exact = typeof v === 'string' && /^\{\w+\}$/.test(v);
      if (exact && ((Array.isArray(r) && !r.length) || (isObj(r) && !Object.keys(r).length))) continue;
      out[k] = r;
    }
    return out;
  }
  return tpl;
}

// ---------------------------------------------------------------- TOML (append-only, line based)
const BARE = /^[A-Za-z0-9_-]+$/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const tomlKey = (k) => (BARE.test(k) ? k : JSON.stringify(k));

export function tomlValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (isObj(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ')} }`;
  throw new Error(`Unsupported TOML value type: ${typeof v}`);
}

export function tomlRenderTable(parts, obj) {
  const lines = [`[${parts.map(tomlKey).join('.')}]`];
  const subs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isObj(v)) subs.push([k, v]);
    else lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  let text = lines.join('\n');
  for (const [k, v] of subs) text += `\n\n${tomlRenderTable([...parts, k], v)}`.replace(/\n$/, '');
  return `${text}\n`;
}

export function tomlRenderArrayTable(parts, obj) {
  const lines = [`[[${parts.map(tomlKey).join('.')}]]`];
  for (const [k, v] of Object.entries(obj)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  return `${lines.join('\n')}\n`;
}

/** spec: { table: [...] } or { array_table: [...], name_field } */
export function tomlRender(spec, name, entry) {
  return spec.table ? tomlRenderTable([...spec.table, name], entry) : tomlRenderArrayTable(spec.array_table, entry);
}

const segRe = (parts) => parts.map((p) => `\\s*(?:"${esc(p)}"|${esc(p)})\\s*`).join('\\.');

export function tomlFind(text, spec, name) {
  const lines = text.split(/\r?\n/);
  const isHeader = (l) => /^\s*\[/.test(l);
  const trimEnd = (start, end) => { let e = end; while (e > start + 1 && !lines[e - 1].trim()) e--; return e; };
  if (spec.table) {
    const seg = segRe([...spec.table, name]);
    const re = new RegExp(`^\\s*\\[${seg}\\]\\s*(?:#.*)?$`);
    const sub = new RegExp(`^\\s*\\[${seg}\\.`);
    const start = lines.findIndex((l) => re.test(l));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !(isHeader(lines[end]) && !sub.test(lines[end]))) end++;
    return { start, end: trimEnd(start, end), lines };
  }
  const arr = new RegExp(`^\\s*\\[\\[${segRe(spec.array_table)}\\]\\]\\s*(?:#.*)?$`);
  const nameRe = new RegExp(`^\\s*${esc(spec.name_field || 'name')}\\s*=\\s*"${esc(name)}"\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (!arr.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end])) end++;
    if (lines.slice(i + 1, end).some((l) => nameRe.test(l))) return { start: i, end: trimEnd(i, end), lines };
    i = end - 1;
  }
  return null;
}

const norm = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

export function tomlInspect(text, spec, name, block) {
  const f = tomlFind(text, spec, name);
  if (!f) return { status: 'add' };
  const existing = f.lines.slice(f.start, f.end).join('\n');
  return norm(existing) === norm(block) ? { status: 'noop' } : { status: 'conflict', existing };
}

export function tomlApply(text, spec, name, block, replace) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = block.replace(/\r?\n$/, '');
  const f = tomlFind(text, spec, name);
  if (f && replace) {
    const lines = [...f.lines.slice(0, f.start), ...body.split('\n'), ...f.lines.slice(f.end)];
    const out = lines.join(eol);
    return out.endsWith(eol) ? out : out + eol;
  }
  const sep = !text ? '' : text.endsWith('\n') ? eol : eol + eol;
  return `${text}${sep}${body.split('\n').join(eol)}${eol}`;
}
