import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KitError } from './errors.mjs';

export function parseRepo(input) {
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(String(input || '').trim());
  if (!m) throw new KitError('bad_repo', `Not a GitHub repo reference: ${input}`);
  return { owner: m[1], repo: m[2], ref: m[3], path: m[4] };
}

const apiBase = (o) => String(o.apiBase || process.env.KIT_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const authHeaders = (o) => {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-kit-registry' };
  const t = o.token || process.env.GITHUB_TOKEN;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
};

async function ghFetch(url, o, asJson) {
  const f = o.fetchImpl || fetch;
  let res;
  try {
    res = await f(url, { headers: authHeaders(o) });
  } catch (e) {
    throw new KitError('network', `Cannot reach GitHub (${e.message}). Check the network/proxy.`);
  }
  if (res.status === 403 || res.status === 429) throw new KitError('github_rate_limit', 'GitHub API rate limit or access denied. Set GITHUB_TOKEN and retry.', { status: res.status });
  if (res.status === 404) throw new KitError('github_not_found', `Not found on GitHub: ${url}`);
  if (!res.ok) throw new KitError('github_error', `GitHub answered HTTP ${res.status} for ${url}`);
  return asJson ? res.json() : Buffer.from(await res.arrayBuffer());
}

export async function repoInfo(repoRef, o = {}) {
  const r = typeof repoRef === 'string' ? parseRepo(repoRef) : repoRef;
  const j = await ghFetch(`${apiBase(o)}/repos/${r.owner}/${r.repo}`, o, true);
  return {
    full_name: j.full_name,
    html_url: j.html_url,
    description: j.description || '',
    stars: j.stargazers_count,
    author: j.owner && j.owner.login,
    license: (j.license && j.license.spdx_id) || null,
    default_branch: j.default_branch,
    archived: !!j.archived,
    pushed_at: j.pushed_at,
    homepage: j.homepage || null,
  };
}

const safeName = (n) => typeof n === 'string' && n !== '.' && n !== '..' && !/[\\/\0]/.test(n);

/** Download a directory (or single file) of a GitHub repo through the contents API. No git needed. */
export async function fetchDir(src, dest, o = {}) {
  const r = parseRepo(src.repo);
  const ref = src.ref || r.ref || (await repoInfo(r, o)).default_branch;
  const sub = String(src.path || r.path || '').replace(/^\/+|\/+$/g, '');
  const limits = { files: o.maxFiles || 500, bytes: o.maxBytes || 20 * 1024 * 1024 };
  const state = { files: 0, bytes: 0, skipped: [] };
  const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const listUrl = (p) => `${apiBase(o)}/repos/${r.owner}/${r.repo}/contents${p ? `/${enc(p)}` : ''}?ref=${encodeURIComponent(ref)}`;
  const f = o.fetchImpl || fetch;

  async function saveFile(entry, localPath) {
    if (!entry.download_url) { state.skipped.push(entry.path); return; }
    if (state.files + 1 > limits.files) throw new KitError('too_large', `More than ${limits.files} files; refusing to download.`);
    const buf = await ghFetch(entry.download_url, { ...o, fetchImpl: f }, false);
    state.bytes += buf.length;
    if (state.bytes > limits.bytes) throw new KitError('too_large', `More than ${limits.bytes} bytes; refusing to download.`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buf);
    state.files++;
  }
  async function walk(apiPath, localDir) {
    const listing = await ghFetch(listUrl(apiPath), o, true);
    if (!Array.isArray(listing)) {
      if (listing.type !== 'file') throw new KitError('github_error', `${apiPath} is not a directory or file`);
      if (!safeName(listing.name)) throw new KitError('unsafe_name', `Unsafe file name: ${listing.name}`);
      return saveFile(listing, path.join(localDir, listing.name));
    }
    for (const e of listing) {
      if (!safeName(e.name)) throw new KitError('unsafe_name', `Unsafe file name from GitHub: ${e.name}`);
      if (e.type === 'dir') await walk(e.path, path.join(localDir, e.name));
      else if (e.type === 'file') await saveFile(e, path.join(localDir, e.name));
      else state.skipped.push(e.path);
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  await walk(sub, dest);
  if (!state.files) throw new KitError('empty_source', `No files found at ${src.repo}${sub ? `/${sub}` : ''}@${ref}`);
  return { ref, files: state.files, bytes: state.bytes, skipped: state.skipped };
}

/** Copy a directory tree (skips .git, refuses to leave the source root). */
export function copyTree(from, to, o = {}) {
  const root = path.resolve(from);
  const skip = new Set(['.git', ...(o.skip || [])]);
  let count = 0;
  const walk = (src, dst) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(s, d); }
      else if (e.isFile()) {
        if (!path.resolve(s).startsWith(root)) throw new KitError('unsafe_path', `Path escapes the source folder: ${s}`);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        count++;
      }
    }
  };
  if (!fs.existsSync(root)) throw new KitError('source_missing', `Source folder not found: ${from}`);
  fs.mkdirSync(to, { recursive: true });
  walk(root, to);
  return count;
}

/** Fallback for non-GitHub hosts or when the API is rate limited: shallow git fetch. */
export function gitFetchDir(src, dest, o = {}) {
  const tmp = fs.mkdtempSync(path.join(o.tmp || os.tmpdir(), 'kit-git-'));
  try {
    const url = src.url || `https://github.com/${parseRepo(src.repo).owner}/${parseRepo(src.repo).repo}.git`;
    const run = (args) => {
      const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 180000 });
      if (r.error || r.status !== 0) throw new KitError('git_failed', `git ${args[0]} failed: ${String((r.error && r.error.message) || r.stderr || '').trim().slice(0, 300)}`);
    };
    run(['init', '-q']);
    run(['remote', 'add', 'origin', url]);
    run(['fetch', '--depth', '1', 'origin', src.ref || 'HEAD']);
    run(['checkout', '-q', 'FETCH_HEAD']);
    const from = path.join(tmp, src.path || '');
    if (!path.resolve(from).startsWith(path.resolve(tmp))) throw new KitError('unsafe_path', 'source.path escapes the repository');
    return { files: copyTree(from, dest), ref: src.ref || 'HEAD' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
