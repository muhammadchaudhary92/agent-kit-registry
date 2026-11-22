import fs from 'node:fs';
import path from 'node:path';
import { KitError } from './errors.mjs';
import { expandTemplate, pickOs, isObj, toArray, sha256, canonical, maskDeep } from './util.mjs';
import { tokenResolver, expandPath } from './env.mjs';
import { findItem, isVisible, compatibility, effective, checkRequirements } from './query.mjs';
import * as W from './writers.mjs';

const CMD_SHIMS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'pnpx']);
const UNSAFE_CMD_CHARS = /["%^&|<>!]/;

const deepExpand = (v, resolve) => {
  if (typeof v === 'string') return expandTemplate(v, resolve);
  if (Array.isArray(v)) return v.map((x) => deepExpand(x, resolve));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepExpand(x, resolve)]));
  return v;
};
const stripInternal = (v) => {
  if (Array.isArray(v)) return v.map(stripInternal);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripInternal(x)]));
  return v;
};
const dropEmpty = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '')) : o);
const needsDecision = (a) => (a.status === 'conflict' || a.status === 'exists') && !a.resolution;

function isAllowed(file, env, project) {
  const pm = env.pathMod;
  const f = pm.resolve(file);
  const roots = [env.home, env.appdata, env.localappdata, env.appsupport, env.xdgConfig, env.xdgData, project].filter(Boolean).map((p) => pm.resolve(p));
  return roots.some((r) => {
    const rel = pm.relative(r, f);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${pm.sep}`) && !pm.isAbsolute(rel));
  });
}

function selectTools(rec, arg) {
  if (!rec.tools.length) return null;
  let chosen;
  if (arg === undefined || arg === true || arg === 'all') chosen = rec.tools;
  else {
    const ids = Array.isArray(arg) ? arg : String(arg).split(',').map((s) => s.trim()).filter(Boolean);
    chosen = [...new Set(ids.map((id) => {
      const t = rec.tools.find((x) => x.id === id || x.data.name === id);
      if (!t) throw new KitError('unknown_tool', `Unknown tool '${id}' for ${rec.id}`, { known: rec.tools.map((x) => x.id) });
      return t;
    }))];
  }
  if (!chosen.length) throw new KitError('no_tools_selected', 'Select at least one tool (or use --tools all).');
  return { all: chosen.length === rec.tools.length, ids: chosen.map((t) => t.id), names: chosen.map((t) => t.data.name), chosen };
}

function applyItemToolMapping(def, ts, sel) {
  if (!ts) return false;
  if (ts.type === 'args-join') def.args = [...(def.args || []), ts.flag, sel.names.join(ts.sep || ',')];
  else if (ts.type === 'args-repeat') for (const n of sel.names) def.args = [...(def.args || []), ts.flag, n];
  else if (ts.type === 'env-join') def.env = { ...(def.env || {}), [ts.name]: sel.names.join(ts.sep || ',') };
  else if (ts.type === 'per-tool') {
    for (const t of sel.chosen) {
      const en = t.data.enable || {};
      if (en.args) def.args = [...(def.args || []), ...en.args];
      if (en.env) def.env = { ...(def.env || {}), ...en.env };
    }
  } else return false;
  return true;
}

function winWrap(def, env, kc) {
  if (env.os !== 'windows' || def.transport !== 'stdio' || kc.windows_wrap === 'none') return false;
  const base = String(def.command).replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(cmd|bat)$/, '');
  if (!CMD_SHIMS.has(base)) return false;
  def.args = ['/c', def.command, ...(def.args || [])];
  def.command = 'cmd';
  return true;
}

const nest = (root, key, value) => {
  const out = {};
  let cur = out;
  for (const k of root) { cur[k] = {}; cur = cur[k]; }
  cur[key] = value;
  return out;
};

/**
 * Build an install plan without touching anything. Returns { plan, secrets }.
 * Throws KitError for anything the caller must fix or decide (missing inputs, incompatible, ...).
 */
export function buildPlan(db, env, args) {
  const { agent: agentId, kind, item: itemId } = args;
  if (!agentId || !kind || !itemId) throw new KitError('usage', '--agent, --kind and --item are required');
  const agentRec = db.agents.get(agentId);
  if (!agentRec) throw new KitError('unknown_agent', `Unknown agent '${agentId}'`, { known: [...db.agents.keys()] });
  const a = agentRec.data;
  const rec = findItem(db, kind, itemId);
  if (!rec) throw new KitError('item_not_found', `No ${kind} item '${itemId}' in the registry`);
  if (!isVisible(db, rec)) throw new KitError('item_not_verified', `'${itemId}' is a draft. Only verified items can be installed (owner: set status "verified" after checking it).`);
  const ctx = { agent: agentId, os: env.os, arch: env.arch };
  const compat = compatibility(db, rec, agentId, ctx);
  if (!compat.compatible) throw new KitError('incompatible', `${rec.data.name} cannot be installed into ${a.name}: ${compat.reasons.join('; ')}`, { reasons: compat.reasons });
  const { variant, install, steps } = effective(rec, ctx);
  const kc = a.kinds[kind];
  const warnings = [];
  const notes = [];
  if (compat.note) notes.push(compat.note);
  if (rec.data.notes) notes.push(rec.data.notes);
  if (kc.notes) notes.push(kc.notes);

  // ---- scope + project ----
  const scopeList = kind === 'mcp' ? [...new Set(toArray(kc.methods).flatMap((m) => Object.keys(m.scopes || {})))] : kind === 'skill' ? Object.keys(kc.scopes || {}) : [];
  const scope = args.scope || kc.default_scope || (scopeList.includes('user') ? 'user' : scopeList[0] || 'user');
  if (scopeList.length && !scopeList.includes(scope) && !args.configPath && !args.skillsDir) throw new KitError('scope_unsupported', `${a.name} supports these scopes for ${kind}: ${scopeList.join(', ')}`, { scopes: scopeList });
  const projectArg = args.project || (env.isReal ? process.cwd() : null);
  if (scope === 'project' && !projectArg) throw new KitError('project_required', 'Pass --project <folder> for project scope.');
  const project = projectArg ? env.pathMod.resolve(projectArg) : null;
  if (scope === 'project' && env.isReal && !fs.existsSync(project)) throw new KitError('project_missing', `Project folder not found: ${project}`);

  // ---- inputs ----
  const spec = toArray(rec.data.inputs);
  const inputs = {};
  const missing = [];
  for (const s of spec) {
    let v = args.inputs && args.inputs[s.id];
    if (v === undefined || v === '') v = env.vars[`KIT_INPUT_${s.id}`];
    if (v === undefined || v === '') v = s.default;
    if (v === undefined || v === '') {
      if (s.required !== false) missing.push({ id: s.id, label: s.label, help: s.help || null, example: s.example || null, secret: !!s.secret, behavior: s.secret ? 'SECRET_INPUT' : 'TEXT_INPUT' });
      continue;
    }
    v = String(v);
    if (s.pattern && !new RegExp(s.pattern).test(v)) throw new KitError('invalid_input', `${s.label} does not match the expected format${s.example ? ` (example: ${s.example})` : ''}`);
    inputs[s.id] = v;
  }
  if (missing.length) throw new KitError('missing_inputs', 'Required inputs are missing', { missing });
  const secretIds = new Set(spec.filter((s) => s.secret).map((s) => s.id));
  const secrets = [...secretIds].map((id) => inputs[id]).filter(Boolean);

  const serverName = (install.mcp && install.mcp.server_name) || rec.id;
  const extra = { project, work: project || (env.isReal ? process.cwd() : null), name: serverName, scope };
  const baseResolve = tokenResolver(env, extra);
  const envToSet = new Map();
  let useEnvRef = false;
  if (kind === 'mcp' && scope === 'project') {
    const used = [...JSON.stringify(install.mcp).matchAll(/\{input:([A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((id) => secretIds.has(id));
    if (used.length) {
      if (kc.env_ref) useEnvRef = true;
      else if (!args.allowSecretsInProject) throw new KitError('secret_in_project', `${a.name} has no env-variable syntax, so secrets would be written into a project file that may be committed. Use --scope user, or confirm with --allow-secrets-in-project.`);
    }
  }
  const resolve = (inner) => {
    if (inner.startsWith('input:')) {
      const id = inner.slice(6);
      const s = spec.find((x) => x.id === id);
      if (!s) return undefined;
      if (s.secret && useEnvRef) { envToSet.set(id, s.label); return kc.env_ref.replace('__NAME__', id); }
      return inputs[id] ?? '';
    }
    return baseResolve(inner);
  };
  const guardPath = (file) => {
    if (!args.allowOutside && !isAllowed(file, env, project)) throw new KitError('path_not_allowed', `Refusing to write outside the home/config/project folders: ${file}. Use --allow-outside only if the user confirmed this exact path.`);
  };
  const guardSecret = (file, text) => {
    if (project && !args.allowSecretsInProject && secrets.some((s) => s.length >= 3 && text.includes(s)) && isAllowed(file, { ...env, home: project, appdata: null, localappdata: null, appsupport: null, xdgConfig: null, xdgData: null }, project)) {
      throw new KitError('secret_in_project', `Refusing to write a secret into ${file} (inside the project). Use user scope or --allow-secrets-in-project.`);
    }
  };
  const resolution = args.onConflict || null;
  const requirements = checkRequirements(rec, env);
  for (const r of requirements) if (!r.ok) warnings.push(`${r.command}${r.min ? ` >= ${r.min}` : ''} ${r.found ? `found (${r.version || '?'}) but too old` : 'not found'}${r.hint ? `: ${r.hint}` : ''}`);

  let mode = compat.mode;
  let chosen = null;
  let toolsInfo = null;
  const actions = [];

  // ============================================================ MCP
  if (kind === 'mcp') {
    const m = install.mcp;
    const def = { transport: m.transport };
    const x = deepExpand(m, resolve);
    if (m.transport === 'stdio') {
      def.command = x.command;
      def.args = x.args || [];
      const e = dropEmpty(x.env);
      if (e && Object.keys(e).length) def.env = e;
    } else {
      def.url = x.url;
      const h = dropEmpty(x.headers);
      if (h && Object.keys(h).length) def.headers = h;
    }
    const sel = selectTools(rec, args.tools);
    let filter = 'none';
    if (sel && !sel.all) {
      if (applyItemToolMapping(def, m.tool_selection, sel)) filter = 'server-args';
      else if (kc.tool_filter) filter = 'agent-allowlist';
      else warnings.push('This agent and this server cannot restrict individual tools: every tool of the server stays available. The selection is recorded only in this plan.');
    }
    toolsInfo = sel ? { selected: sel.ids, total: rec.tools.length, all: sel.all, filter } : null;
    const wrapped = winWrap(def, env, kc);
    if (wrapped) notes.push('Windows: npx is started through "cmd /c" so the agent can launch it.');
    const build = () => {
      const entry = W.shape(kc.shape[def.transport], { ...def, argv: def.command ? [def.command, ...(def.args || [])] : undefined, name: serverName });
      if (filter === 'agent-allowlist') entry[kc.tool_filter.allow_key] = sel.names;
      return entry;
    };
    const entry = build();
    const methods = toArray(kc.methods).filter((mt) => !(args.method || (args.configPath && 'config-file')) || mt.method === (args.configPath ? 'config-file' : args.method));
    const skipped = [];
    let guidedMethod = null;
    for (const mt of methods) {
      if (mt.method === 'config-file') {
        const sc = mt.scopes && mt.scopes[scope];
        if (!sc && !args.configPath) { skipped.push(`config-file: no ${scope} scope`); continue; }
        const suggested = sc ? expandPath(pickOs(sc.file, env.os), env, extra) : null;
        if (!guidedMethod) guidedMethod = { mt, suggested };
        const file = args.configPath ? env.pathMod.resolve(args.configPath) : suggested;
        if (/\{(project|work)\}/.test(file)) { skipped.push(`config-file: needs a project folder (${file})`); continue; }
        if (compat.mode !== 'auto' && !args.configPath) { skipped.push('config-file: path not verified for this agent'); continue; }
        guardPath(file);
        if (mt.require_dir && env.isReal && !env.demo && !args.configPath && !fs.existsSync(env.pathMod.dirname(file))) { skipped.push(`${env.pathMod.dirname(file)} does not exist (is ${a.name} installed?)`); continue; }
        if (mt.format === 'json') {
          const cur = W.readJsonLoose(file);
          if (cur.error) { skipped.push(`${file}: ${cur.error}`); continue; }
          const insp = W.jsonInspect(cur.data, mt.root, serverName, entry);
          if (insp.status === 'blocked') { skipped.push(`${file}: ${insp.reason}`); continue; }
          actions.push({ type: 'json-merge', file, root: mt.root, key: serverName, value: entry, status: insp.status, existing: insp.existing, resolution, backup: cur.exists });
        } else {
          const tspec = mt.table ? { table: mt.table } : { array_table: mt.array_table, name_field: mt.name_field };
          const block = W.tomlRender(tspec, serverName, entry);
          const cur = W.readTextLoose(file);
          const insp = W.tomlInspect(cur.text, tspec, serverName, block);
          actions.push({ type: 'toml-append', file, spec: tspec, name: serverName, block, status: insp.status, existing: insp.existing, resolution, backup: cur.exists });
        }
        chosen = mt;
        break;
      }
      if (mt.method === 'cli') {
        const cliScope = mt.scopes && mt.scopes[scope];
        if (cliScope === undefined) { skipped.push(`cli: no ${scope} scope`); continue; }
        if (compat.mode !== 'auto') { skipped.push('cli: not verified for this agent'); continue; }
        const exe = env.find(mt.command);
        if (!exe) { skipped.push(`cli: '${mt.command}' not found on PATH`); continue; }
        const vars = { name: serverName, scope: cliScope, json: JSON.stringify(entry), command: def.command, url: def.url, transport: def.transport };
        const argv = [];
        for (const t of mt.args) { if (t === '{args}') argv.push(...(def.args || [])); else argv.push(expandTemplate(t, (k) => vars[k])); }
        if (env.os === 'windows' && /\.(cmd|bat)$/i.test(exe) && argv.some((s) => UNSAFE_CMD_CHARS.test(s))) { skipped.push(`cli: ${path.basename(exe)} is a .cmd shim and the arguments need special quoting`); continue; }
        const cwd = scope === 'project' ? project : undefined;
        if (resolution === 'replace' && mt.replace_args) actions.push({ type: 'command', command: mt.command, args: mt.replace_args.map((t) => expandTemplate(t, (k) => vars[k])), cwd, allow_fail: true, description: 'Remove the old entry (if any)', _exe: exe });
        actions.push({ type: 'command', command: mt.command, args: argv, cwd, description: `Register MCP server '${serverName}' (${scope} scope)`, _exe: exe });
        if (mt.verify_args) actions.push({ type: 'command', command: mt.command, args: mt.verify_args.map((t) => expandTemplate(t, (k) => vars[k])), cwd, allow_fail: true, purpose: 'verify', description: 'Verify the registration', _exe: exe });
        chosen = mt;
        break;
      }
    }
    if (chosen) mode = 'auto';
    else {
      mode = 'guided';
      const gm = guidedMethod || { mt: toArray(kc.methods).find((mt) => mt.method === 'config-file') || null, suggested: null };
      let snippet;
      if (gm.mt && gm.mt.format === 'json') snippet = { format: 'json', file: gm.suggested, content: JSON.stringify(nest(gm.mt.root, serverName, entry), null, 2), note: `Merge this into the "${gm.mt.root.join('.')}" object of that file; keep the other entries.` };
      else if (gm.mt) snippet = { format: 'toml', file: gm.suggested, content: W.tomlRender(gm.mt.table ? { table: gm.mt.table } : { array_table: gm.mt.array_table, name_field: gm.mt.name_field }, serverName, entry), note: 'Append this block to that file.' };
      else snippet = { format: 'json', file: null, content: JSON.stringify({ [serverName]: entry }, null, 2), note: "Neutral definition: adapt it to the agent's own MCP config format." };
      actions.push({
        type: 'manual',
        instruction: `Add the MCP server '${serverName}' to ${a.name} by hand${gm.suggested ? ` (suggested file: ${gm.suggested}, not verified for this agent/OS)` : ''}.`,
        snippet,
        how_to_automate: 'Confirm the real config file path with the user, then run plan/apply again with --config-path <that file>.',
        reasons: skipped,
      });
    }
  }

  // ============================================================ SKILL
  else if (kind === 'skill') {
    const s = install.skill;
    const name = s.name || rec.id;
    const sc = kc.scopes && kc.scopes[scope];
    const suggested = sc ? expandPath(pickOs(sc.dir, env.os), env, extra) : null;
    const dir = args.skillsDir ? env.pathMod.resolve(args.skillsDir) : suggested;
    mode = (compat.mode === 'auto' || args.skillsDir) && dir && !/\{(project|work)\}/.test(dir) ? 'auto' : 'guided';
    if (mode === 'guided') {
      actions.push({
        type: 'manual',
        instruction: `Copy the skill '${name}' into ${a.name}'s skills folder${suggested ? ` (suggested: ${env.pathMod.join(suggested, name)}, not verified)` : ''}. Source: ${s.source.type} ${s.source.repo || s.source.url || 'bundled files'}${s.source.path ? ` / ${s.source.path}` : ''}${s.source.ref ? ` @ ${s.source.ref}` : ''}.`,
        how_to_automate: 'Confirm the agent\'s skills folder with the user, then run plan/apply again with --skills-dir <folder>.',
      });
    } else {
      guardPath(dir);
      const dest = env.pathMod.join(dir, name);
      const exists = env.isReal && fs.existsSync(dest);
      actions.push({ type: 'install-skill', source: s.source, name, dest, entry: s.entry || 'SKILL.md', status: exists ? 'exists' : 'new', resolution, _itemDir: rec.dir });
      chosen = { method: 'skill-folder' };
    }
  }

  // ============================================================ plugin / extension / custom kinds
  else {
    const x = (s) => expandTemplate(s, resolve);
    if (mode === 'guided') {
      for (const st of steps) {
        const text = st.type === 'command' ? `Run: ${st.command} ${toArray(st.args).map(x).join(' ')}` : st.type === 'manual' ? x(st.instruction) : `${st.type}: ${st.path || st.file || st.to || ''}`;
        actions.push({ type: 'manual', instruction: text });
      }
    } else {
      steps.forEach((st) => {
        if (st.type === 'command') actions.push({ type: 'command', command: st.command, args: toArray(st.args).map(x), cwd: st.cwd ? expandPath(st.cwd, env, extra) : undefined, allow_fail: !!st.allow_fail, timeout_sec: st.timeout_sec, description: st.description });
        else if (st.type === 'write-file') {
          const file = expandPath(st.path, env, extra);
          guardPath(file);
          const content = x(st.content);
          guardSecret(file, content);
          const cur = W.readTextLoose(file);
          const md = st.mode || 'create';
          const status = !cur.exists ? 'new' : cur.text === content ? 'noop' : md === 'create' ? 'conflict' : md;
          actions.push({ type: 'write-file', file, content, mode: md, status, resolution, backup: cur.exists });
        } else if (st.type === 'json-merge') {
          const file = expandPath(st.file, env, extra);
          guardPath(file);
          const value = deepExpand(st.value, resolve);
          guardSecret(file, JSON.stringify(value));
          const cur = W.readJsonLoose(file);
          if (cur.error) throw new KitError('file_unreadable', `${file}: ${cur.error}. Edit it by hand or fix the JSON first.`);
          const insp = W.jsonInspect(cur.data, st.root, st.key, value);
          if (insp.status === 'blocked') throw new KitError('file_unreadable', `${file}: ${insp.reason}`);
          actions.push({ type: 'json-merge', file, root: st.root, key: st.key, value, status: insp.status, existing: insp.existing, resolution, backup: cur.exists });
        } else if (st.type === 'copy-bundled') {
          const to = expandPath(st.to, env, extra);
          guardPath(to);
          actions.push({ type: 'copy-bundled', from: st.from, to, status: env.isReal && fs.existsSync(to) ? 'exists' : 'new', resolution, _itemDir: rec.dir });
        } else if (st.type === 'fetch-dir') {
          const to = expandPath(st.to, env, extra);
          guardPath(to);
          actions.push({ type: 'fetch-dir', source: st.source, to, status: env.isReal && fs.existsSync(to) ? 'exists' : 'new', resolution });
        } else actions.push({ type: 'manual', instruction: x(st.instruction) });
      });
      chosen = { method: 'steps' };
    }
  }

  const decisions = actions.map((act, i) => (needsDecision(act) ? { index: i, type: act.type, target: act.file || act.dest || act.to, status: act.status, existing: act.existing } : null)).filter(Boolean);
  const plan = {
    version: 1,
    agent: agentId,
    agent_name: a.name,
    kind,
    item: rec.id,
    item_name: rec.data.name,
    scope,
    os: env.os,
    arch: env.arch,
    mode,
    method: chosen ? chosen.method : null,
    variant: variant ? variant.note || 'variant applied' : null,
    project: scope === 'project' ? project : null,
    tools: toolsInfo,
    requirements,
    inputs: spec.map((s) => ({ id: s.id, label: s.label, secret: !!s.secret, provided: inputs[s.id] !== undefined, stored_as: s.secret ? (useEnvRef ? 'environment-variable reference' : 'value in the agent config') : 'plain value' })),
    env_to_set: [...envToSet].map(([name, label]) => ({ name, label, hint: 'Set this environment variable before starting the agent (the config only holds a reference).' })),
    actions,
    decisions,
    ready: mode === 'auto' && decisions.length === 0,
    warnings,
    notes,
    restart_required: kc.restart_required !== false,
    post_install: kc.post_install || null,
  };
  const masked = maskDeep(stripInternal(plan), secrets);
  plan.hash = sha256(`${canonical(masked)}|${sha256([...secrets].sort().join('\u0000'))}`).slice(0, 16);
  return { plan, secrets };
}

/** The plan as the user/AI may see it: secrets masked, internal fields removed. */
export function presentPlan(plan, secrets) {
  return maskDeep(stripInternal(plan), secrets);
}
