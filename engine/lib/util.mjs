import fs from 'node:fs';
import crypto from 'node:crypto';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
export const canonical = (v) => JSON.stringify(sortKeys(v));
export const deepEqual = (a, b) => canonical(a) === canonical(b);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const OS_KEYS = ['windows', 'linux', 'macos', 'unix', 'all', 'default'];
export const isOsMap = (v) => isObj(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OS_KEYS.includes(k));

/** Pick the value for an OS from a plain value or an OS map ({windows, linux, macos, unix, all}). */
export function pickOs(v, os) {
  if (!isOsMap(v)) return v;
  if (v[os] !== undefined) return v[os];
  if (os !== 'windows' && v.unix !== undefined) return v.unix;
  return v.all !== undefined ? v.all : v.default;
}

/** Replace {token} placeholders (nesting allowed). resolve(inner) returns a string, or undefined to keep the text as is. */
export function expandTemplate(str, resolve) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] !== '{') {
      out += str[i++];
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < str.length && depth > 0) {
      if (str[j] === '{') depth++;
      else if (str[j] === '}') depth--;
      j++;
    }
    if (depth !== 0) {
      out += str.slice(i);
      break;
    }
    const inner = str.slice(i + 1, j - 1);
    const val = resolve(inner);
    out += val === undefined ? str.slice(i, j) : val;
    i = j;
  }
  return out;
}

export function findTokens(str) {
  const found = [];
  expandTemplate(str, (inner) => {
    found.push(inner);
    return undefined;
  });
  return found;
}

/** Replace every secret value (>= 3 chars) with *** inside any string of a JSON-like value. */
export function maskDeep(v, secrets) {
  if (!secrets || !secrets.length) return v;
  if (typeof v === 'string') {
    let s = v;
    for (const x of secrets) if (x && x.length >= 3) s = s.split(x).join('***');
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, secrets));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, secrets)]));
  return v;
}

export function versionGte(actual, min) {
  const a = String(actual).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

export const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k)]));
