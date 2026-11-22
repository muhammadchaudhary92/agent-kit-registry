import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, isObj, toArray, findTokens, isOsMap } from './util.mjs';

const SUPPORT = ['auto', 'guided', 'none'];
const TRANSPORTS = ['stdio', 'http', 'sse'];
const STATUS = ['draft', 'verified'];
const PLATFORMS = ['any', 'web', 'android', 'ios', 'desktop', 'backend', 'cli', 'game', 'embedded', 'data'];
const OSES = ['windows', 'linux', 'macos'];
const ARCHES = ['x64', 'arm64', 'x86'];
const SCOPES = ['user', 'project'];
const STEP_TYPES = ['command', 'write-file', 'json-merge', 'copy-bundled', 'fetch-dir', 'manual'];
const SOURCE_TYPES = ['github', 'git', 'bundled'];
const TOOL_SEL = ['args-join', 'args-repeat', 'env-join', 'per-tool'];
const STATIC_TOKENS = new Set(['home', 'tmp', 'os', 'arch', 'sep', 'appdata', 'localappdata', 'appsupport', 'xdg_config', 'xdg_data', 'project', 'work', 'name', 'scope']);
const SHAPE_TOKENS = new Set(['command', 'args', 'argv', 'env', 'url', 'headers', 'name', 'transport']);
const CLI_TOKENS = new Set(['name', 'scope', 'json', 'command', 'args', 'url', 'transport']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_ID_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXE_RE = /^[A-Za-z0-9._-]+$/;
const looksLikeToken = (t) => /^[a-z_]+(:|$)/.test(t);

function walkStrings(v, fn) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (isObj(v)) Object.values(v).forEach((x) => walkStrings(x, fn));
}

export function validateRegistry(db) {
  const errors = db.errors.map((e) => ({ ...e }));
  const warnings = [];
  let cur = '';
  const E = (message) => errors.push({ file: cur, message });
  const W = (message) => warnings.push({ file: cur, message });
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const isStrMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');

  const checkTpl = (s, allowed, where) => {
    for (const t of findTokens(s)) {
      if (!looksLikeToken(t) || allowed.has(t) || t.startsWith('env:')) continue;
      E(`${where}: unknown placeholder {${t}}`);
    }
  };
  const checkPath = (val, where) => {
    for (const s of isOsMap(val) ? Object.values(val) : [val]) {
      if (!isStr(s)) E(`${where}: must be a path string or an OS map (windows|linux|macos|unix|all)`);
      else checkTpl(s, STATIC_TOKENS, where);
    }
  };
  const idCheck = (rec, data) => {
    if (!isObj(data)) return E('must be a JSON object'), false;
    if (data.id !== rec.id) E(`id '${data.id}' must equal the file/folder name '${rec.id}'`);
    if (!ID_RE.test(rec.id)) E('id must be lowercase letters, digits and dashes (max 63)');
    return true;
  };
  const kindIds = new Set(db.kinds.keys());

  // ---------- kinds ----------
  for (const rec of db.kinds.values()) {
    cur = rec.file;
    if (!idCheck(rec, rec.data)) continue;
    if (!isStr(rec.data.name)) E('name is required');
    if (!isStr(rec.data.description)) E('description is required (shown to the user in the wizard)');
  }

  // ---------- categories ----------
  for (const rec of db.categories.values()) {
    cur = rec.file;
    if (!idCheck(rec, rec.data)) continue;
    if (!isStr(rec.data.name)) E('name is required');
    if (!isStr(rec.data.description)) W('description is empty');
    if (rec.data.kinds !== undefined && !(isStrArr(rec.data.kinds) && rec.data.kinds.every((k) => kindIds.has(k)))) E('kinds must list existing kind ids');
  }

  // ---------- agents ----------
  const checkMcpAdapter = (kc) => {
    const w = 'kinds.mcp';
    if (kc.support === 'none') return;
    const transports = toArray(kc.transports);
    if (!transports.length || !transports.every((t) => TRANSPORTS.includes(t))) E(`${w}.transports must list some of ${TRANSPORTS.join('|')}`);
    if (!isObj(kc.shape)) E(`${w}.shape is required (entry layout per transport)`);
    else for (const t of transports) {
      if (!isObj(kc.shape[t])) E(`${w}.shape.${t} is missing for a supported transport`);
      else walkStrings(kc.shape[t], (s) => checkTpl(s, SHAPE_TOKENS, `${w}.shape.${t}`));
    }
    if (kc.env_ref !== undefined && !(typeof kc.env_ref === 'string' && kc.env_ref.includes('__NAME__'))) E(`${w}.env_ref must contain __NAME__`);
    if (kc.windows_wrap !== undefined && !['cmd', 'none'].includes(kc.windows_wrap)) E(`${w}.windows_wrap must be cmd or none`);
    if (kc.tool_filter !== undefined && !(isObj(kc.tool_filter) && isStr(kc.tool_filter.allow_key))) E(`${w}.tool_filter needs allow_key`);
    const methods = toArray(kc.methods);
    if (kc.support === 'auto' && !methods.length) E(`${w}.methods needs at least one method for auto support`);
    const scopes = new Set();
    methods.forEach((m, i) => {
      const mw = `${w}.methods[${i}]`;
      if (!isObj(m)) return E(`${mw} must be an object`);
      if (m.method === 'config-file') {
        if (!['json', 'toml'].includes(m.format)) E(`${mw}.format must be json or toml`);
        if (m.format === 'json' && !(isStrArr(m.root) && m.root.length)) E(`${mw}.root must be a non-empty string array`);
        if (m.format === 'toml' && !(isStrArr(m.table) || isStrArr(m.array_table))) E(`${mw}: toml needs table or array_table (string array)`);
        if (!isObj(m.scopes)) E(`${mw}.scopes must be an object`);
        for (const [s, sv] of Object.entries(m.scopes || {})) {
          if (!SCOPES.includes(s)) E(`${mw}.scopes.${s}: scope must be user or project`);
          scopes.add(s);
          if (!isObj(sv) || sv.file === undefined) E(`${mw}.scopes.${s}.file is required`);
          else checkPath(sv.file, `${mw}.scopes.${s}.file`);
        }
      } else if (m.method === 'cli') {
        if (!isStr(m.command) || !EXE_RE.test(m.command)) E(`${mw}.command must be a plain executable name`);
        if (!isStrArr(m.args) || !m.args.length) E(`${mw}.args must be a non-empty string array`);
        else m.args.forEach((s) => checkTpl(s, CLI_TOKENS, `${mw}.args`));
        if (!isStrMap(m.scopes)) E(`${mw}.scopes must map scope -> cli scope value`);
        Object.keys(m.scopes || {}).forEach((s) => scopes.add(s));
      } else E(`${mw}.method must be config-file or cli`);
    });
    if (kc.default_scope !== undefined && methods.length && !scopes.has(kc.default_scope)) E(`${w}.default_scope '${kc.default_scope}' is not offered by any method`);
  };
  const checkSkillAdapter = (kc) => {
    if (kc.support === 'none') return;
    if (!isObj(kc.scopes)) return E('kinds.skill.scopes is required (may be empty for guided support)');
    if (kc.support === 'auto' && !Object.keys(kc.scopes).length) return E('kinds.skill.scopes needs user and/or project for auto support');
    for (const [s, sv] of Object.entries(kc.scopes)) {
      if (!SCOPES.includes(s)) E(`kinds.skill.scopes.${s}: scope must be user or project`);
      if (!isObj(sv) || sv.dir === undefined) E(`kinds.skill.scopes.${s}.dir is required`);
      else checkPath(sv.dir, `kinds.skill.scopes.${s}.dir`);
    }
    if (kc.default_scope !== undefined && !kc.scopes[kc.default_scope]) E('kinds.skill.default_scope is not in scopes');
  };
  for (const rec of db.agents.values()) {
    cur = rec.file;
    const a = rec.data;
    if (!idCheck(rec, a)) continue;
    if (!isStr(a.name)) E('name is required');
    if (!isObj(a.kinds)) { E('kinds object is required'); continue; }
    for (const [k, kc] of Object.entries(a.kinds)) {
      if (!kindIds.has(k)) W(`kinds.${k}: there is no registry/kinds/${k}.json`);
      if (!isObj(kc) || !SUPPORT.includes(kc.support)) { E(`kinds.${k}.support must be one of ${SUPPORT.join('|')}`); continue; }
      if (k === 'mcp') checkMcpAdapter(kc);
      else if (k === 'skill') checkSkillAdapter(kc);
    }
    for (const k of kindIds) if (!a.kinds[k]) W(`kinds.${k} missing (treated as not supported)`);
    const v = a.verified;
    if (!isObj(v) || !DATE_RE.test(v.date || '') || !['high', 'medium', 'low'].includes(v.confidence)) W('verified.date and verified.confidence (high|medium|low) are missing');
  }

  // ---------- items ----------
  const seen = new Set();
  for (const rec of db.items) {
    cur = rec.file;
    const d = rec.data;
    const key = `${rec.kind}/${rec.id}`;
    if (seen.has(key)) E(`duplicate item ${key} (both items/${rec.kind}/${rec.id}.json and a folder exist)`);
    seen.add(key);
    if (!idCheck(rec, d)) continue;
    const verified = d.status === 'verified';
    const need = (ok, msg) => { if (!ok) (verified ? E : W)(msg); };
    if (!STATUS.includes(d.status)) E(`status must be one of ${STATUS.join('|')}`);
    if (d.kind !== rec.kind) E(`kind '${d.kind}' must equal its folder '${rec.kind}'`);
    if (!kindIds.has(rec.kind)) E(`folder items/${rec.kind}/ has no registry/kinds/${rec.kind}.json`);
    for (const f of ['name', 'summary', 'description']) if (!isStr(d[f])) E(`${f} is required`);
    need(isStr(d.how_it_works), 'how_it_works is required (shown to the user)');
    need(isStr(d.author), 'author is required');
    const cats = toArray(d.categories);
    if (!cats.length) E('categories needs at least one category id');
    for (const c of cats) {
      const cr = db.categories.get(c);
      if (!cr) E(`category '${c}' does not exist (add registry/categories/${c}.json)`);
      else if (Array.isArray(cr.data.kinds) && !cr.data.kinds.includes(rec.kind)) W(`category '${c}' is not meant for kind ${rec.kind}`);
    }
    if (d.platforms !== undefined) for (const p of toArray(d.platforms)) if (!PLATFORMS.includes(p)) W(`platform '${p}' is not in the standard list (${PLATFORMS.join(', ')})`);
    if (d.os !== undefined && !toArray(d.os).every((o) => OSES.includes(o))) E(`os must list some of ${OSES.join('|')}`);
    if (d.tags !== undefined && !isStrArr(d.tags)) E('tags must be a string array');
    if (d.source !== undefined && !isObj(d.source)) E('source must be an object');
    need(isObj(d.source) && (isStr(d.source.repo) || isStr(d.source.homepage)), 'source.repo or source.homepage is required');
    if (isObj(d.source) && d.source.repo !== undefined && !REPO_RE.test(String(d.source.repo).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''))) W('source.repo is not an owner/name GitHub reference');
    if (d.stars !== undefined && !(isObj(d.stars) && Number.isInteger(d.stars.count) && d.stars.count >= 0 && DATE_RE.test(d.stars.as_of || ''))) E('stars must be {"count": <int>, "as_of": "YYYY-MM-DD"}');
    if (verified) {
      if (!isObj(d.verified) || !DATE_RE.test(d.verified.date || '') || !isStr(d.verified.by)) E('status "verified" needs verified {"date":"YYYY-MM-DD","by":"<owner>"}');
    }
    const inputs = toArray(d.inputs);
    const declared = new Set();
    inputs.forEach((inp, i) => {
      const w = `inputs[${i}]`;
      if (!isObj(inp) || !INPUT_ID_RE.test(inp.id || '')) return E(`${w}.id must look like FIGMA_TOKEN (A-Z, 0-9, _)`);
      if (declared.has(inp.id)) E(`${w}: duplicate input id ${inp.id}`);
      declared.add(inp.id);
      if (!isStr(inp.label)) E(`${w}.label is required`);
      if (inp.pattern !== undefined) { try { new RegExp(inp.pattern); } catch { E(`${w}.pattern is not a valid regex`); } }
    });
    for (const [i, r] of toArray(d.requires && d.requires.commands).entries()) if (!isObj(r) || !isStr(r.name) || !EXE_RE.test(r.name)) E(`requires.commands[${i}].name must be a plain executable name`);

    // ---- install definitions ----
    const checkWhen = (when, where) => {
      if (when === undefined) return;
      if (!isObj(when)) return E(`${where}.when must be an object`);
      for (const [k, v] of Object.entries(when)) {
        if (!['agent', 'os', 'arch'].includes(k)) E(`${where}.when.${k}: use agent, os or arch`);
        if (k === 'agent') for (const a of toArray(v)) if (!db.agents.has(a)) W(`${where}.when: unknown agent '${a}'`);
        if (k === 'os' && !toArray(v).every((o) => OSES.includes(o))) E(`${where}.when.os must list ${OSES.join('|')}`);
        if (k === 'arch' && !toArray(v).every((o) => ARCHES.includes(o))) E(`${where}.when.arch must list ${ARCHES.join('|')}`);
      }
    };
    const checkSource = (src, where) => {
      if (!isObj(src) || !SOURCE_TYPES.includes(src.type)) return E(`${where}.type must be one of ${SOURCE_TYPES.join('|')}`);
      if (src.path !== undefined && (typeof src.path !== 'string' || src.path.includes('..') || path.isAbsolute(src.path))) E(`${where}.path must be a relative path without '..'`);
      if (src.type === 'github') {
        if (!isStr(src.repo) || !REPO_RE.test(src.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''))) E(`${where}.repo must be owner/name`);
        if (src.ref !== undefined && !isStr(src.ref)) E(`${where}.ref must be a string`);
        else if (verified && !/^[0-9a-f]{40}$/.test(src.ref || '')) W(`${where}.ref: pin a full commit SHA for reproducible installs`);
      } else if (src.type === 'git') {
        if (!(isStr(src.url) && src.url.startsWith('https://'))) E(`${where}.url must be an https:// git URL`);
      } else if (!rec.dir) E(`${where}: bundled sources need the folder form items/${rec.kind}/${rec.id}/item.json`);
      else {
        const p = src.path || 'files';
        if (!fs.existsSync(path.join(rec.dir, p))) E(`${where}: folder '${p}' not found next to item.json`);
      }
    };
    const checkStep = (s, where) => {
      if (!isObj(s) || !STEP_TYPES.includes(s.type)) return E(`${where}.type must be one of ${STEP_TYPES.join('|')}`);
      checkWhen(s.when, where);
      if (s.type === 'command') {
        if (!isStr(s.command) || !EXE_RE.test(s.command)) E(`${where}.command must be a plain executable name (use "sh -c" explicitly if a shell is needed)`);
        if (s.args !== undefined && !isStrArr(s.args)) E(`${where}.args must be a string array`);
      } else if (s.type === 'write-file') {
        checkPath(s.path, `${where}.path`);
        if (typeof s.content !== 'string') E(`${where}.content must be a string`);
        if (s.mode !== undefined && !['create', 'overwrite', 'append'].includes(s.mode)) E(`${where}.mode must be create|overwrite|append`);
      } else if (s.type === 'json-merge') {
        checkPath(s.file, `${where}.file`);
        if (!isStrArr(s.root)) E(`${where}.root must be a string array`);
        if (!isStr(s.key)) E(`${where}.key is required`);
        if (!isObj(s.value)) E(`${where}.value must be an object`);
      } else if (s.type === 'copy-bundled') {
        checkPath(s.to, `${where}.to`);
        if (!isStr(s.from) || s.from.includes('..') || path.isAbsolute(s.from)) E(`${where}.from must be relative to the item folder`);
        else if (!rec.dir || !fs.existsSync(path.join(rec.dir, s.from))) E(`${where}.from: '${s.from}' not found next to item.json`);
      } else if (s.type === 'fetch-dir') {
        checkSource(s.source, `${where}.source`);
        checkPath(s.to, `${where}.to`);
      } else if (!isStr(s.instruction)) E(`${where}.instruction is required`);
    };
    const checkMcp = (m, where) => {
      if (!isObj(m) || !TRANSPORTS.includes(m.transport)) return E(`${where}.transport must be one of ${TRANSPORTS.join('|')}`);
      if (m.transport === 'stdio') {
        if (!isStr(m.command)) E(`${where}.command is required for stdio`);
        if (m.args !== undefined && !isStrArr(m.args)) E(`${where}.args must be a string array`);
        if (m.env !== undefined && !isStrMap(m.env)) E(`${where}.env must map names to strings`);
      } else {
        if (!isStr(m.url) || !/^https?:\/\//.test(m.url)) E(`${where}.url must start with http(s)://`);
        else if (verified && m.url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(m.url)) W(`${where}.url: use https for remote servers`);
        if (m.headers !== undefined && !isStrMap(m.headers)) E(`${where}.headers must map names to strings`);
      }
      if (m.server_name !== undefined && !ID_RE.test(m.server_name)) E(`${where}.server_name must be lowercase letters, digits and dashes`);
      if (m.tool_selection !== undefined) {
        const t = m.tool_selection;
        if (!isObj(t) || !TOOL_SEL.includes(t.type)) E(`${where}.tool_selection.type must be one of ${TOOL_SEL.join('|')}`);
        else if (['args-join', 'args-repeat'].includes(t.type) && !isStr(t.flag)) E(`${where}.tool_selection.flag is required`);
        else if (t.type === 'env-join' && !isStr(t.name)) E(`${where}.tool_selection.name is required`);
      }
    };
    const checkInstall = (install, where, isBase) => {
      if (install === undefined) return;
      if (!isObj(install)) return E(`${where} must be an object`);
      if (install.mcp !== undefined) checkMcp(install.mcp, `${where}.mcp`);
      if (install.skill !== undefined) {
        const s = install.skill;
        if (!isObj(s)) E(`${where}.skill must be an object`);
        else {
          checkSource(s.source, `${where}.skill.source`);
          if (s.name !== undefined && !ID_RE.test(s.name)) E(`${where}.skill.name must be lowercase letters, digits and dashes`);
        }
      }
      if (isBase && rec.kind === 'mcp') need(install.mcp !== undefined, `${where}.mcp is required for kind mcp`);
      if (isBase && rec.kind === 'skill') need(install.skill !== undefined, `${where}.skill is required for kind skill`);
    };
    checkInstall(d.install, 'install', true);
    toArray(d.variants).forEach((v, i) => {
      const w = `variants[${i}]`;
      if (!isObj(v)) return E(`${w} must be an object`);
      checkWhen(v.when, w);
      if (!isObj(v.when) || !Object.keys(v.when).length) E(`${w}.when is required (agent/os/arch)`);
      checkInstall(v.install, `${w}.install`, false);
      if (v.steps !== undefined) { if (!Array.isArray(v.steps)) E(`${w}.steps must be an array`); else v.steps.forEach((s, j) => checkStep(s, `${w}.steps[${j}]`)); }
      if (v.unsupported !== undefined && typeof v.unsupported !== 'boolean') E(`${w}.unsupported must be true/false`);
    });
    if (d.steps !== undefined) { if (!Array.isArray(d.steps)) E('steps must be an array'); else d.steps.forEach((s, j) => checkStep(s, `steps[${j}]`)); }
    if (!['mcp', 'skill'].includes(rec.kind)) {
      const any = (Array.isArray(d.steps) && d.steps.length) || toArray(d.variants).some((v) => Array.isArray(v.steps) && v.steps.length);
      need(any, `kind ${rec.kind} needs install steps (steps[] or variants[].steps)`);
    }

    // ---- placeholders ----
    const used = new Set();
    walkStrings({ i: d.install, v: d.variants, s: d.steps }, (s) => {
      for (const t of findTokens(s)) {
        if (!looksLikeToken(t)) continue;
        if (t.startsWith('input:')) used.add(t.slice(6));
        else if (!STATIC_TOKENS.has(t) && !t.startsWith('env:')) E(`unknown placeholder {${t}}`);
      }
    });
    for (const u of used) if (!declared.has(u)) E(`{input:${u}} is used but not declared in inputs[]`);
    for (const dcl of declared) if (!used.has(dcl)) W(`input ${dcl} is declared but never used`);

    // ---- tools (child rows) ----
    if (rec.kind !== 'mcp' && rec.tools.length) W('tools/ only applies to kind mcp');
    const toolNames = new Set();
    for (const t of rec.tools) {
      cur = t.file;
      if (!isObj(t.data)) { E('must be a JSON object'); continue; }
      if (t.data.id !== undefined && t.data.id !== t.id) E(`id '${t.data.id}' must equal the file name '${t.id}'`);
      if (!ID_RE.test(t.id)) E('tool file name must be lowercase letters, digits and dashes');
      if (!isStr(t.data.name)) E('name is required (the exact MCP tool name)');
      else { if (toolNames.has(t.data.name)) E(`duplicate tool name ${t.data.name}`); toolNames.add(t.data.name); }
      need(isStr(t.data.description), 'description is required (shown in the tools list)');
      if (t.data.risk !== undefined && !['read', 'write', 'destructive'].includes(t.data.risk)) E('risk must be read|write|destructive');
      if (t.data.default !== undefined && typeof t.data.default !== 'boolean') E('default must be true/false');
    }
    cur = rec.file;
    let todo = false;
    walkStrings(d, (s) => { if (!todo && /\bTODO\b|CHANGE_ME/.test(s)) { todo = true; need(false, `placeholder text still present: "${s.slice(0, 40)}"`); } });
    if (verified && !rec.tools.length && rec.kind === 'mcp') W('no tools/ folder entries: the user will see "Data not found" in the tools step');
  }

  const rel = (x) => ({ file: path.relative(db.root, x.file).split(path.sep).join('/'), message: x.message });
  const counts = { agents: db.agents.size, kinds: db.kinds.size, categories: db.categories.size, items: {}, tools: 0 };
  for (const rec of db.items) { counts.items[rec.kind] = (counts.items[rec.kind] || 0) + 1; counts.tools += rec.tools.length; }
  return { errors: errors.map(rel), warnings: warnings.map(rel), counts };
}
