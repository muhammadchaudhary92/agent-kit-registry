#!/usr/bin/env node
// agent-kit-registry engine. Zero dependencies, Node >= 18. All output is JSON (for the AI) unless noted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitError } from './lib/errors.mjs';
import { getEnv } from './lib/env.mjs';
import { loadRegistry } from './lib/registry.mjs';
import { validateRegistry } from './lib/validate.mjs';
import { detectAgents, detectProject, toolchain } from './lib/detect.mjs';
import { findItem, isVisible, itemDetail } from './lib/query.mjs';
import { agentStep, kindStep, categoryStep, itemStep, toolStep } from './lib/wizard.mjs';
import { buildPlan, presentPlan } from './lib/plan.mjs';
import { applyPlan } from './lib/exec.mjs';
import { drive, applyReport } from './lib/driver.mjs';
import { prepareDemo } from './lib/demo.mjs';
import { scaffoldItem, scaffoldTool, scaffoldCategory } from './lib/scaffold.mjs';
import { parseRepo, repoInfo } from './lib/github.mjs';

const KIT_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(KIT_FILE), '..');
const BOOL = new Set(['includeDrafts', 'compact', 'dryRun', 'strict', 'allowOutside', 'allowSecretsInProject', 'folder', 'help', 'text', 'demo', 'json']);
const NEEDS_DECISION = new Set(['missing_inputs', 'conflict', 'hash_required', 'hash_mismatch', 'guided_plan']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const a = { _: [], input: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const eq = t.indexOf('=');
    const key = camel(t.slice(2, eq < 0 ? undefined : eq));
    let val = eq < 0 ? undefined : t.slice(eq + 1);
    if (BOOL.has(key)) { a[key] = val === undefined ? true : val !== 'false'; continue; }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) throw new KitError('usage', `${t} needs a value`);
    }
    if (key === 'input') {
      const j = val.indexOf('=');
      if (j < 1) throw new KitError('usage', '--input expects NAME=value');
      a.input[val.slice(0, j)] = val.slice(j + 1);
    } else a[key] = val;
  }
  return a;
}

const HELP = {
  ok: true,
  usage: 'node engine/kit.mjs <command> [options]',
  to_install_something: 'Run: node engine/kit.mjs start   (it prints ONE question at a time; show it to the user, then run the command it prints). Add --demo to preview the whole flow with sample items.',
  wizard_commands: {
    start: 'The wizard. Prints the next question as ready-to-show text plus the exact command that takes the answer. [--self <agent-id>] [--demo] [--json]',
    next: 'Same as start; carries the answers so far: --agent --kind --category --search --item --input NAME=v --tools --pick <number|name>',
    detect: 'OS, toolchain, project platform, installed agents + pre-selection  [--self <agent-id>] [--project <dir>]',
    agents: 'Step 1 list: agent (single select + Other)',
    kinds: 'Step 2 list: kind  --agent <id>',
    categories: 'Step 3 list: category (+ search)  --agent --kind [--search q] [--platform p]',
    items: 'Step 4 list: items  --agent --kind [--category id|*] [--search q] [--platform p]',
    show: 'Full detail of one item  --agent --kind --item',
    tools: 'Step 6 list: inner tools of an MCP (multi select)  --agent --kind mcp --item',
    plan: 'Dry plan, nothing is written  --agent --kind --item [--scope user|project] [--project dir] [--tools all|a,b] [--input NAME=value] [--inputs-file f.json] [--on-conflict replace|skip] [--config-path f] [--skills-dir d] [--method cli|config-file]',
    apply: 'Execute the plan: same arguments as plan + --confirm <hash> [--dry-run]',
  },
  owner_commands: {
    validate: 'Check the whole registry  [--strict] [--text]',
    scaffold: 'scaffold item --kind mcp --id x [--template http] [--category c] [--from-github owner/repo] | scaffold tool --item x --id t | scaffold category --id c',
    'github-info': 'github-info <owner/repo>: stars, author, license, description',
    'refresh-stars': 'Update stars (and missing author/license) of every item from GitHub  [--dry-run]',
  },
  global_options: {
    '--registry <dir>': 'registry folder (default: ./registry, or KIT_REGISTRY)',
    '--include-drafts': 'owner testing: also show/install items whose status is "draft"',
    '--os windows|linux|macos': 'plan for another OS (preview only)',
    '--compact': 'single-line JSON',
  },
  exit_codes: { 0: 'ok', 1: 'error', 3: 'needs a decision or input (see error.code and error.details)' },
};

/** How the commands printed by `next` are written: short form when run from the repo root, absolute path otherwise. */
function cliPrefix(env) {
  if (path.relative(process.cwd(), KIT_FILE) === path.join('engine', 'kit.mjs')) return 'node engine/kit.mjs';
  const q = env.os === 'windows' ? (v) => `"${v}"` : (v) => `'${v.replace(/'/g, "'\\''")}'`;
  return `node ${/^[\w@%+=:,./\\-]+$/.test(KIT_FILE) ? KIT_FILE : q(KIT_FILE)}`;
}

function planArgs(a) {
  const inputs = { ...a.input };
  if (a.inputsFile) {
    try { Object.assign(inputs, JSON.parse(fs.readFileSync(a.inputsFile, 'utf8'))); }
    catch (e) { throw new KitError('usage', `Cannot read --inputs-file: ${e.message}`); }
  }
  if (a.onConflict && !['replace', 'skip'].includes(a.onConflict)) throw new KitError('usage', '--on-conflict must be replace or skip');
  return { agent: a.agent, kind: a.kind, item: a.item, scope: a.scope, project: a.project, tools: a.tools, inputs, method: a.method, configPath: a.configPath, skillsDir: a.skillsDir, onConflict: a.onConflict, allowOutside: a.allowOutside, allowSecretsInProject: a.allowSecretsInProject };
}

const need = (a, ...names) => {
  for (const n of names) if (!a[n]) throw new KitError('usage', `--${n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
};
const needAgent = (a, db) => {
  need(a, 'agent');
  if (!db.agents.has(a.agent)) throw new KitError('unknown_agent', `Unknown agent '${a.agent}'. Use --agent other for an agent that is not listed.`, { known: [...db.agents.keys()] });
};
const needItem = (a, db) => {
  need(a, 'kind', 'item');
  const rec = findItem(db, a.kind, a.item);
  if (!rec || !isVisible(db, rec)) throw new KitError('item_not_found', `No ${a.kind} item '${a.item}' (is it verified?)`);
  return rec;
};

const COMMANDS = {
  next({ a, env, db }) {
    return drive(db, env, a, { cli: cliPrefix(env), demo: !!env.demo, inputs: planArgs(a).inputs });
  },
  start(c) {
    return COMMANDS.next(c);
  },
  detect({ a, env, db }) {
    const det = detectAgents(db, env, { self: a.self });
    return {
      ok: true,
      step: 'detect',
      hint: 'This command only reports facts. To run the wizard use: node engine/kit.mjs start',
      os: env.os,
      arch: env.arch,
      wsl: env.wsl,
      shell: env.shell,
      home: env.home,
      state_dir: env.stateDir,
      toolchain: toolchain(env),
      project: env.isReal ? detectProject(path.resolve(a.project || process.cwd())) : null,
      agents: det.agents,
      preselect: det.preselect,
      agent_step: agentStep(db, det),
    };
  },
  agents({ a, env, db }) {
    return { ok: true, ...agentStep(db, detectAgents(db, env, { self: a.self })) };
  },
  kinds({ a, db, ctx }) {
    needAgent(a, db);
    return { ok: true, ...kindStep(db, a.agent, ctx) };
  },
  categories({ a, db, ctx }) {
    needAgent(a, db);
    need(a, 'kind');
    return { ok: true, ...categoryStep(db, a.agent, a.kind, ctx, { search: a.search, platform: a.platform }) };
  },
  items({ a, db, ctx }) {
    needAgent(a, db);
    need(a, 'kind');
    return { ok: true, ...itemStep(db, a.agent, a.kind, ctx, { category: a.category, search: a.search, platform: a.platform }) };
  },
  show({ a, env, db, ctx }) {
    needAgent(a, db);
    return { ok: true, item: itemDetail(db, needItem(a, db), a.agent, ctx, env) };
  },
  tools({ a, db }) {
    needAgent(a, db);
    return { ok: true, ...toolStep(needItem(a, db)) };
  },
  plan({ a, env, db }) {
    const { plan, secrets } = buildPlan(db, env, planArgs(a));
    const next = plan.mode !== 'auto'
      ? 'Guided plan: show the manual steps, or confirm the real path with the user and plan again with --config-path / --skills-dir.'
      : plan.decisions.length
        ? 'Ask the user what to do about plan.decisions (replace or keep), then plan again with --on-conflict replace|skip.'
        : `Show this plan to the user. After they approve, run apply with the same arguments plus --confirm ${plan.hash}`;
    return { ok: true, plan: presentPlan(plan, secrets), next };
  },
  async apply({ a, env, db }) {
    const { plan, secrets } = buildPlan(db, env, planArgs(a));
    if (!a.confirm) throw new KitError('hash_required', `apply needs --confirm <hash> of the plan the user approved (current hash: ${plan.hash})`, { hash: plan.hash });
    if (a.confirm !== plan.hash) throw new KitError('hash_mismatch', 'The plan changed since it was approved (different arguments or files changed). Show the new plan again.', { expected: plan.hash });
    const res = await applyPlan(plan, env, { secrets, dryRun: !!a.dryRun || !!env.demo });
    return { ...res, report: applyReport(plan, res, { demo: !!env.demo }) };
  },
  validate({ a, db }) {
    const res = validateRegistry(db);
    const ok = res.errors.length === 0 && !(a.strict && res.warnings.length);
    if (a.text) {
      for (const e of res.errors) console.log(`ERROR   ${e.file}: ${e.message}`);
      for (const w of res.warnings) console.log(`WARNING ${w.file}: ${w.message}`);
      console.log(`${ok ? 'OK' : 'FAILED'}: ${res.errors.length} error(s), ${res.warnings.length} warning(s); ${JSON.stringify(res.counts)}`);
      process.exitCode = ok ? 0 : 1;
      return null;
    }
    return { ok, strict: !!a.strict, ...res };
  },
  async scaffold({ a, registryRoot }) {
    const what = a._[1];
    const templatesDir = path.join(ROOT, 'templates');
    if (what === 'item') {
      need(a, 'kind', 'id');
      const info = a.fromGithub ? await repoInfo(a.fromGithub) : {};
      const r = scaffoldItem({ root: registryRoot, templatesDir, kind: a.kind, id: a.id, template: a.template, category: a.category, folder: a.folder, info, name: a.name });
      return { ok: true, created: path.relative(ROOT, r.file), next: 'Fill every TODO, add tools/*.json for an MCP, set status to "verified" only after you tested the install, then run: node engine/kit.mjs validate --strict' };
    }
    if (what === 'tool') {
      need(a, 'item', 'id');
      return { ok: true, created: path.relative(ROOT, scaffoldTool({ root: registryRoot, templatesDir, itemId: a.item, id: a.id, name: a.name }).file) };
    }
    if (what === 'category') {
      need(a, 'id');
      return { ok: true, created: path.relative(ROOT, scaffoldCategory({ root: registryRoot, templatesDir, id: a.id, name: a.name }).file) };
    }
    throw new KitError('usage', 'scaffold item | tool | category');
  },
  async 'github-info'({ a }) {
    const ref = a._[1] || a.repo;
    if (!ref) throw new KitError('usage', 'github-info <owner/repo>');
    return { ok: true, info: await repoInfo(parseRepo(ref)) };
  },
  async 'refresh-stars'({ a, db }) {
    const today = new Date().toISOString().slice(0, 10);
    const changed = [];
    const failed = [];
    for (const rec of db.items) {
      const repo = rec.data.source && rec.data.source.repo;
      if (!repo || /TODO/.test(repo)) continue;
      try {
        const info = await repoInfo(parseRepo(repo));
        const before = rec.data.stars && rec.data.stars.count;
        rec.data.stars = { count: info.stars, as_of: today };
        if (!rec.data.author && info.author) rec.data.author = info.author;
        if (!rec.data.source.license && info.license) rec.data.source.license = info.license;
        if (!a.dryRun) fs.writeFileSync(rec.file, `${JSON.stringify(rec.data, null, 2)}\n`);
        changed.push({ item: `${rec.kind}/${rec.id}`, from: before ?? null, to: info.stars, archived: info.archived });
      } catch (e) {
        failed.push({ item: `${rec.kind}/${rec.id}`, error: e.message });
        if (e.code === 'github_rate_limit') break;
      }
    }
    return { ok: failed.length === 0, dry_run: !!a.dryRun, updated: changed, failed };
  },
  help() {
    return HELP;
  },
};

function out(obj, a) {
  if (obj === null || obj === undefined) return;
  if (typeof obj.__text === 'string') {
    if (!(a && a.json)) {
      process.stdout.write(`${obj.__text}\n`);
      return;
    }
    const { __text, ...rest } = obj; // eslint-disable-line no-unused-vars
    obj = rest;
  }
  process.stdout.write(`${JSON.stringify(obj, null, a && a.compact ? 0 : 2)}\n`);
}

export async function main(argv) {
  let a = { compact: false };
  try {
    a = parseArgs(argv);
    const cmd = a._[0];
    if (!cmd || a.help) return out(HELP, a);
    const handler = COMMANDS[cmd];
    if (!handler) throw new KitError('usage', `Unknown command '${cmd}'. Run: node engine/kit.mjs help`);
    const demo = a.demo ? prepareDemo(ROOT) : null;
    const env = getEnv({ os: a.os, arch: a.arch, home: a.home || (demo && demo.home), stateDir: a.stateDir || (demo && demo.stateDir) });
    if (demo) env.demo = true;
    const registryRoot = demo ? demo.registry : path.resolve(a.registry || process.env.KIT_REGISTRY || path.join(ROOT, 'registry'));
    const db = loadRegistry(registryRoot, { includeDrafts: !!a.includeDrafts });
    const res = await handler({ a, env, db, registryRoot, ctx: { agent: a.agent, os: env.os, arch: env.arch } });
    out(res, a);
    if (res && res.ok === false) process.exitCode = process.exitCode || 1;
  } catch (e) {
    const known = e instanceof KitError;
    out({ ok: false, error: { code: known ? e.code : 'internal', message: e.message, details: known ? e.details : undefined } }, a);
    process.exitCode = known && NEEDS_DECISION.has(e.code) ? 3 : 1;
    if (!known && process.env.KIT_DEBUG) console.error(e.stack);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
