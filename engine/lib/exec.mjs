import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KitError } from './errors.mjs';
import { maskDeep, sha256 } from './util.mjs';
import * as W from './writers.mjs';
import { fetchDir, gitFetchDir, copyTree } from './github.mjs';

/** Quote one argument for cmd.exe (only used for .cmd/.bat shims). */
export const quoteWin = (s) => (/^[\w./:=@+,-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);

function writeAtomic(file, text, newMode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = newMode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const tmp = `${file}.kit-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

function makeBackup(file, env, stamp) {
  if (!fs.existsSync(file)) return null;
  const dest = path.join(env.stateDir, 'backups', stamp, `${sha256(file).slice(0, 8)}-${path.basename(file)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(file, dest, { recursive: true });
  return dest;
}

function runCommand(act, env, secrets) {
  const exe = act._exe || env.find(act.command);
  if (!exe) throw new KitError('command_not_found', `'${act.command}' was not found on PATH`);
  const opts = { cwd: act.cwd, env: { ...env.vars, ...(act.env || {}) }, encoding: 'utf8', timeout: (act.timeout_sec || 300) * 1000, maxBuffer: 16 * 1024 * 1024 };
  const isCmd = env.os === 'windows' && /\.(cmd|bat)$/i.test(exe);
  const r = isCmd ? spawnSync(`"${exe}" ${act.args.map(quoteWin).join(' ')}`, { ...opts, shell: true }) : spawnSync(exe, act.args, opts);
  const clip = (s) => String(maskDeep(String(s || ''), secrets)).trim().slice(-1500);
  const out = { exit_code: r.status, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  if (r.error) throw new KitError('command_failed', `${act.command}: ${r.error.message}`, out);
  if (r.status !== 0 && !act.allow_fail) throw new KitError('command_failed', `${act.command} exited with code ${r.status}`, out);
  return { status: r.status === 0 ? 'ok' : 'failed-allowed', ...out };
}

async function fetchInto(source, dest, env, o) {
  if (source.type === 'github') {
    try {
      return await fetchDir(source, dest, { fetchImpl: o.fetchImpl });
    } catch (e) {
      if (!['github_rate_limit', 'network'].includes(e.code) || !env.find('git')) throw e;
      return gitFetchDir(source, dest, { tmp: env.tmp });
    }
  }
  if (source.type === 'git') return gitFetchDir(source, dest, { tmp: env.tmp });
  throw new KitError('bad_source', `Unsupported source type ${source.type}`);
}

function replaceDir(dest, env, stamp) {
  if (!fs.existsSync(dest)) return null;
  const bak = path.join(env.stateDir, 'backups', stamp, `${sha256(dest).slice(0, 8)}-${path.basename(dest)}`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.cpSync(dest, bak, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  return bak;
}

async function doAction(act, env, ctx) {
  const { stamp, secrets, o } = ctx;
  switch (act.type) {
    case 'json-merge': {
      const cur = W.readJsonLoose(act.file);
      if (cur.error) throw new KitError('file_unreadable', `${act.file}: ${cur.error}`);
      const insp = W.jsonInspect(cur.data, act.root, act.key, act.value);
      if (insp.status === 'blocked') throw new KitError('file_unreadable', `${act.file}: ${insp.reason}`);
      if (insp.status === 'noop') return { status: 'noop', file: act.file };
      if (insp.status === 'conflict') {
        if (act.resolution === 'skip') return { status: 'skipped', file: act.file };
        if (act.resolution !== 'replace') throw new KitError('conflict', `'${act.key}' already exists in ${act.file} with a different definition`, { file: act.file });
      }
      const backup = cur.exists ? makeBackup(act.file, env, stamp) : null;
      writeAtomic(act.file, W.renderJson(W.jsonApply(cur.data, act.root, act.key, act.value), cur), 0o600);
      const back = W.readJsonLoose(act.file);
      if (back.error || W.jsonInspect(back.data, act.root, act.key, act.value).status !== 'noop') throw new KitError('verify_failed', `Read-back check failed for ${act.file}`);
      return { status: insp.status === 'conflict' ? 'replaced' : 'added', file: act.file, backup, verified: true };
    }
    case 'toml-append': {
      const cur = W.readTextLoose(act.file);
      const insp = W.tomlInspect(cur.text, act.spec, act.name, act.block);
      if (insp.status === 'noop') return { status: 'noop', file: act.file };
      if (insp.status === 'conflict') {
        if (act.resolution === 'skip') return { status: 'skipped', file: act.file };
        if (act.resolution !== 'replace') throw new KitError('conflict', `'${act.name}' already exists in ${act.file} with a different definition`, { file: act.file });
      }
      const backup = cur.exists ? makeBackup(act.file, env, stamp) : null;
      writeAtomic(act.file, W.tomlApply(cur.text, act.spec, act.name, act.block, insp.status === 'conflict'), 0o600);
      const back = W.readTextLoose(act.file);
      if (W.tomlInspect(back.text, act.spec, act.name, act.block).status !== 'noop') throw new KitError('verify_failed', `Read-back check failed for ${act.file}`);
      return { status: insp.status === 'conflict' ? 'replaced' : 'added', file: act.file, backup, verified: true };
    }
    case 'command':
      return runCommand(act, env, secrets);
    case 'install-skill': {
      const exists = fs.existsSync(act.dest);
      if (exists && act.resolution === 'skip') return { status: 'skipped', dest: act.dest };
      if (exists && act.resolution !== 'replace') throw new KitError('conflict', `${act.dest} already exists`, { dest: act.dest });
      const stage = fs.mkdtempSync(path.join(env.tmp, 'kit-skill-'));
      try {
        let info;
        if (act.source.type === 'bundled') {
          const from = path.join(act._itemDir || '', act.source.path || 'files');
          info = { files: copyTree(from, stage) };
        } else info = await fetchInto(act.source, stage, env, o);
        if (!fs.existsSync(path.join(stage, act.entry))) throw new KitError('skill_entry_missing', `The downloaded source has no ${act.entry}; nothing was installed.`);
        const backup = replaceDir(act.dest, env, stamp);
        copyTree(stage, act.dest);
        if (!fs.existsSync(path.join(act.dest, act.entry))) throw new KitError('verify_failed', `${act.entry} missing after install`);
        return { status: exists ? 'replaced' : 'added', dest: act.dest, files: info.files, ref: info.ref || null, backup, verified: true };
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
    case 'write-file': {
      const cur = W.readTextLoose(act.file);
      if (cur.exists && cur.text === act.content) return { status: 'noop', file: act.file };
      if (act.status === 'conflict') {
        if (act.resolution === 'skip') return { status: 'skipped', file: act.file };
        if (act.resolution !== 'replace') throw new KitError('conflict', `${act.file} already exists with different content`, { file: act.file });
      }
      const backup = cur.exists ? makeBackup(act.file, env, stamp) : null;
      writeAtomic(act.file, act.mode === 'append' && cur.exists ? cur.text + act.content : act.content, 0o644);
      return { status: cur.exists ? 'updated' : 'added', file: act.file, backup };
    }
    case 'copy-bundled':
    case 'fetch-dir': {
      const exists = fs.existsSync(act.to);
      if (exists && act.resolution === 'skip') return { status: 'skipped', dest: act.to };
      if (exists && act.resolution !== 'replace') throw new KitError('conflict', `${act.to} already exists`, { dest: act.to });
      const backup = exists ? replaceDir(act.to, env, stamp) : null;
      let files;
      if (act.type === 'copy-bundled') files = copyTree(path.join(act._itemDir || '', act.from), act.to);
      else files = (await fetchInto(act.source, act.to, env, o)).files;
      return { status: exists ? 'replaced' : 'added', dest: act.to, files, backup };
    }
    case 'manual':
      return { status: 'manual', instruction: act.instruction };
    default:
      throw new KitError('bad_action', `Unknown action type ${act.type}`);
  }
}

export async function applyPlan(plan, env, o = {}) {
  const secrets = o.secrets || [];
  if (!env.isReal) throw new KitError('simulated_os', `This run simulates ${env.os} on ${env.realOs}; plans can be previewed but not applied.`);
  if (plan.mode !== 'auto') throw new KitError('guided_plan', 'This plan is guided: follow the manual instructions, or confirm the real path and plan again with --config-path / --skills-dir.');
  const pending = plan.actions.map((a, i) => ({ a, i })).filter(({ a }) => (a.status === 'conflict' || a.status === 'exists') && !a.resolution);
  if (pending.length) throw new KitError('conflict', 'Something already exists. Ask the user: replace it or keep it? Then plan again with --on-conflict replace|skip.', { decisions: pending.map(({ a, i }) => ({ index: i, target: a.file || a.dest || a.to })) });
  if (o.dryRun) return { ok: true, dry_run: true, would_run: plan.actions.map((a) => ({ type: a.type, target: a.file || a.dest || a.to || a.command })) };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ctx = { stamp, secrets, o };
  const results = [];
  for (const [i, act] of plan.actions.entries()) {
    try {
      const r = await doAction(act, env, ctx);
      results.push({ index: i, type: act.type, ...maskDeep(r, secrets) });
    } catch (e) {
      results.push({ index: i, type: act.type, status: 'failed', code: e.code || 'error', error: String(maskDeep(e.message, secrets)), details: maskDeep(e.details, secrets) });
      return { ok: false, failed_at: i, results, hint: 'Nothing after the failed step was run. Backups (if any) are in ' + path.join(env.stateDir, 'backups', stamp) };
    }
  }
  try {
    const file = path.join(env.stateDir, 'installed.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    list.push({ at: new Date().toISOString(), agent: plan.agent, kind: plan.kind, item: plan.item, scope: plan.scope, os: plan.os, results: results.map((r) => ({ type: r.type, status: r.status, target: r.file || r.dest || null })) });
    fs.mkdirSync(env.stateDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(list.slice(-500), null, 2)}\n`);
  } catch { /* history is best effort */ }
  return { ok: true, results, restart_required: plan.restart_required, post_install: plan.post_install, env_to_set: plan.env_to_set };
}
