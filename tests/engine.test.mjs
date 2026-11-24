import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as W from '../engine/lib/writers.mjs';
import { expandTemplate, pickOs } from '../engine/lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'engine', 'kit.mjs');
const POSIX = process.platform !== 'win32';
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('KIT_')));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-'));
  const reg = path.join(dir, 'registry');
  for (const d of ['agents', 'kinds', 'categories']) fs.cpSync(path.join(ROOT, 'registry', d), path.join(reg, d), { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'items'), path.join(reg, 'items'), { recursive: true });
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const proj = path.join(dir, 'proj');
  for (const d of [home, bin, proj]) fs.mkdirSync(d);
  try { fs.symlinkSync(process.execPath, path.join(bin, 'node')); } catch { /* windows */ }
  const state = path.join(dir, 'state');
  const base = ['--registry', reg, '--home', home, '--state-dir', state, '--compact'];
  const envFor = (o = {}) => ({ ...CLEAN_ENV, PATH: o.path ?? bin, ...(o.env || {}) });
  const parse = (r) => { let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ } return { code: r.status ?? r.code, json, stdout: r.stdout, stderr: r.stderr }; };
  const run = (args, o = {}) => parse(spawnSync(process.execPath, [KIT, ...base, ...args], { encoding: 'utf8', cwd: o.cwd || proj, env: envFor(o) }));
  const runAsync = (args, o = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [KIT, ...base, ...args], { cwd: o.cwd || proj, env: envFor(o) });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve(parse({ status: code, stdout, stderr })));
  });
  const plan = (args, o) => run(['plan', ...args], o);
  const apply = (args, o) => {
    const p = plan(args, o);
    assert.equal(p.code, 0, p.stdout);
    return run(['apply', ...args, '--confirm', p.json.plan.hash], o);
  };
  const fakeExe = (name, body) => {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  };
  return { dir, reg, home, bin, state, proj, run, runAsync, plan, apply, fakeExe, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const STD = ['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_secret123'];
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ------------------------------------------------------------------ registry data
test('shipped registry has no errors or warnings (strict)', () => {
  const r = spawnSync(process.execPath, [KIT, 'validate', '--strict', '--compact'], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true, r.stdout);
  assert.equal(j.counts.agents, 20);
  // The shipped registry grows as the owner adds items, so only check the shape (kind -> positive count).
  assert.equal(typeof j.counts.items, 'object');
  for (const [kind, n] of Object.entries(j.counts.items)) {
    assert.ok(['mcp', 'skill', 'extension', 'plugin'].includes(kind), `unknown kind in counts: ${kind}`);
    assert.ok(Number.isInteger(n) && n > 0, `bad count for ${kind}: ${n}`);
  }
});

test('fixture registry validates; broken data is reported', () => {
  const s = sandbox();
  try {
    assert.equal(s.run(['validate']).json.ok, true);
    const bad = path.join(s.reg, 'items', 'mcp', 'bad-one');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'item.json'), JSON.stringify({
      id: 'wrong-id', kind: 'mcp', name: 'Bad', status: 'verified', summary: 's', description: 'd', how_it_works: 'h', author: 'a',
      source: { homepage: 'https://x.test' }, verified: { date: '2026-11-20', by: 't' }, categories: ['no-such-category'],
      install: { mcp: { transport: 'stdio', command: 'npx', args: ['{nonsense}', '{input:GHOST}'] } },
    }));
    const v = s.run(['validate']);
    const msgs = v.json.errors.map((e) => e.message).join('\n');
    assert.equal(v.json.ok, false);
    assert.match(msgs, /must equal the file\/folder name/);
    assert.match(msgs, /category 'no-such-category' does not exist/);
    assert.match(msgs, /unknown placeholder \{nonsense\}/);
    assert.match(msgs, /\{input:GHOST\} is used but not declared/);
    assert.equal(s.run(['validate']).code, 1);
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ wizard steps
test('wizard lists: kinds, categories, items, tools, "Data not found"', () => {
  const s = sandbox();
  try {
    const kinds = s.run(['kinds', '--agent', 'cursor']).json.ui.options;
    assert.deepEqual(kinds.map((k) => k.value), ['mcp', 'skill', 'plugin', 'extension']);
    assert.equal(kinds.find((k) => k.value === 'mcp').count, 4); // draft hidden
    assert.ok(kinds.every((k) => k.description.length > 60));
    const cats = s.run(['categories', '--agent', 'cursor', '--kind', 'mcp']).json;
    assert.equal(cats.ui.options[0].value, '*');
    assert.ok(cats.ui.options.some((o) => o.value === 'ui' && o.count === 1));
    const found = s.run(['items', '--agent', 'cursor', '--kind', 'mcp', '--search', 'figma']).json;
    assert.deepEqual(found.ui.options.map((o) => o.value), ['demo-stdio']);
    assert.equal(found.ui.options[0].details.stars.count, 1200);
    assert.equal(found.ui.ai_choose.allowed, false);
    const android = s.run(['items', '--agent', 'cursor', '--kind', 'mcp', '--platform', 'android']).json;
    assert.ok(android.ui.options.map((o) => o.value).includes('demo-stdio'));
    assert.ok(android.ui.options.map((o) => o.value).includes('demo-filtered')); // platform "any" always matches
    const none = s.run(['items', '--agent', 'cursor', '--kind', 'mcp', '--search', 'zzzz-nothing']).json;
    assert.equal(none.empty, true);
    assert.equal(none.message, 'Data not found');
    assert.equal(s.run(['items', '--agent', 'cursor', '--kind', 'plugin']).json.message, 'Data not found'); // plugin kind: none for cursor
    const tools = s.run(['tools', '--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-stdio']).json.ui;
    assert.equal(tools.behavior, 'MULTI_SELECT');
    assert.equal(tools.options.length, 3);
    assert.equal(s.run(['tools', '--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-http']).json.message, 'Data not found');
    assert.equal(s.run(['items', '--agent', 'cursor', '--kind', 'mcp', '--include-drafts']).json.count, 5);
  } finally { s.cleanup(); }
});

test('compatibility follows the adapter (transport, support level)', () => {
  const s = sandbox();
  try {
    const codex = s.run(['items', '--agent', 'codex', '--kind', 'mcp']).json.ui.options.map((o) => o.value);
    assert.ok(!codex.includes('demo-sse'), 'codex cannot use sse');
    const q = s.run(['items', '--agent', 'vscode-copilot', '--kind', 'mcp']).json.ui.options;
    assert.ok(q.every((o) => o.details.install_mode === 'guided'));
    assert.equal(s.run(['plan', '--agent', 'nope', '--kind', 'mcp', '--item', 'demo-http']).json.error.code, 'unknown_agent');
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ detect
test('detect: self, command on PATH, env signature, project platform', { skip: !POSIX }, () => {
  const s = sandbox();
  try {
    assert.equal(s.run(['detect', '--self', 'cursor']).json.preselect, 'cursor');
    assert.equal(s.run(['detect']).json.preselect, null);
    s.fakeExe('cursor', 'exit 0');
    assert.equal(s.run(['detect']).json.preselect, 'cursor');
    assert.equal(s.run(['detect'], { env: { CLAUDE_CODE_TEST: '1' } }).json.preselect, 'claude-code');
    fs.mkdirSync(path.join(s.proj, 'app'));
    fs.writeFileSync(path.join(s.proj, 'build.gradle'), '');
    assert.ok(s.run(['detect', '--project', s.proj]).json.project.platforms.includes('android'));
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ plan / apply: JSON agents
test('plan masks secrets, asks for missing inputs, validates format', () => {
  const s = sandbox();
  try {
    const miss = s.plan(['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-stdio']);
    assert.equal(miss.code, 3);
    assert.equal(miss.json.error.code, 'missing_inputs');
    assert.equal(miss.json.error.details.missing[0].behavior, 'SECRET_INPUT');
    assert.equal(s.plan(['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=bad token']).json.error.code, 'invalid_input');
    const p = s.plan(STD);
    assert.equal(p.code, 0);
    assert.ok(!p.stdout.includes('demo_secret123'), 'secret must never be printed');
    assert.equal(p.json.plan.actions[0].value.env.DEMO_API_KEY, '***');
    assert.equal(p.json.plan.ready, true);
  } finally { s.cleanup(); }
});

test('cursor apply: add, preserve file, noop, conflict, replace + backup, hash guard', () => {
  const s = sandbox();
  try {
    const file = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{\n    "mcpServers": {\n        "existing": { "command": "x" }\n    },\n    "other": 1\n}\n');
    assert.equal(s.run(['apply', ...STD]).json.error.code, 'hash_required');
    assert.equal(s.run(['apply', ...STD, '--confirm', 'deadbeef']).json.error.code, 'hash_mismatch');
    const r = s.apply(STD);
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(r.json.results[0].status, 'added');
    const text = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc.mcpServers), ['existing', 'demo-stdio']);
    assert.equal(doc.other, 1);
    assert.match(text, /\n {4}"mcpServers"/, 'indentation preserved');
    assert.equal(doc.mcpServers['demo-stdio'].env.DEMO_API_KEY, 'demo_secret123');
    assert.equal(s.plan(STD).json.plan.actions[0].status, 'noop');
    const other = ['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_other999'];
    const c = s.plan(other).json.plan;
    assert.equal(c.actions[0].status, 'conflict');
    assert.equal(c.ready, false);
    assert.equal(s.run(['apply', ...other, '--confirm', c.hash]).json.error.code, 'conflict');
    assert.equal(s.run(['apply', ...other, '--confirm', c.hash]).code, 3);
    const rep = s.apply([...other, '--on-conflict', 'replace']);
    assert.equal(rep.json.results[0].status, 'replaced');
    assert.ok(fs.existsSync(rep.json.results[0].backup));
    assert.equal(readJson(file).mcpServers['demo-stdio'].env.DEMO_API_KEY, 'demo_other999');
    assert.ok(!rep.stdout.includes('demo_other999'));
    assert.equal(readJson(path.join(s.state, 'installed.json')).length, 2);
  } finally { s.cleanup(); }
});

test('a JSON file with comments is never rewritten: plan becomes guided', () => {
  const s = sandbox();
  try {
    const file = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// my servers\n{ "mcpServers": {} }\n');
    const p = s.plan(STD).json.plan;
    assert.equal(p.mode, 'guided');
    assert.equal(p.actions[0].type, 'manual');
    assert.match(p.actions[0].reasons.join(' '), /not strict JSON/);
    assert.equal(s.run(['apply', ...STD, '--confirm', p.hash]).json.error.code, 'guided_plan');
  } finally { s.cleanup(); }
});

test('guided agent becomes auto once the path is confirmed; unsafe paths are refused', () => {
  const s = sandbox();
  try {
    const args = ['--agent', 'vscode-copilot', '--kind', 'mcp', '--item', 'demo-http', '--input', 'HTTP_TOKEN=tok_123456'];
    const g = s.plan(args).json.plan;
    assert.equal(g.mode, 'guided');
    assert.match(g.actions[0].snippet.content, /"servers"/);
    const cfg = path.join(s.home, 'vscode-mcp.json');
    const r = s.apply([...args, '--config-path', cfg]);
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(readJson(cfg).servers['demo-http'].headers.Authorization, 'Bearer tok_123456');
    const out = s.plan([...args, '--config-path', '/etc/kit-test.json']);
    assert.equal(out.json.error.code, 'path_not_allowed');
    assert.equal(s.plan([...args, '--config-path', '/etc/kit-test.json', '--allow-outside']).code, 0);
  } finally { s.cleanup(); }
});

test('project scope stores env references, never raw secrets', () => {
  const s = sandbox();
  try {
    const args = ['--agent', 'gemini-cli', '--kind', 'mcp', '--item', 'demo-http', '--scope', 'project', '--project', s.proj, '--input', 'HTTP_TOKEN=tok_123456'];
    const p = s.plan(args).json.plan;
    assert.equal(p.actions[0].value.headers.Authorization, 'Bearer ${HTTP_TOKEN}');
    assert.equal(p.env_to_set[0].name, 'HTTP_TOKEN');
    const r = s.apply(args);
    assert.equal(r.json.ok, true);
    assert.ok(!fs.readFileSync(path.join(s.proj, '.gemini', 'settings.json'), 'utf8').includes('tok_123456'));
    const refused = s.plan(['--agent', 'kiro', '--kind', 'mcp', '--item', 'demo-http', '--scope', 'project', '--project', s.proj, '--input', 'HTTP_TOKEN=tok_123456']);
    assert.equal(refused.json.error.code, 'secret_in_project');
  } finally { s.cleanup(); }
});

test('project scope: an optional secret the user did not give is left out, never an unset ${VAR} reference', () => {
  const s = sandbox();
  try {
    const base = readJson(path.join(s.reg, 'items', 'mcp', 'demo-stdio', 'item.json'));
    fs.writeFileSync(path.join(s.reg, 'items', 'mcp', 'demo-opt-secret.json'), JSON.stringify({
      ...base, id: 'demo-opt-secret', name: 'Demo Optional Secret Server',
      inputs: [{ id: 'OPT_KEY', label: 'Optional key', secret: true, required: false }],
      install: { mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'demo-opt-secret'], env: { OPT_KEY: '{input:OPT_KEY}', STATIC: '1' }, server_name: 'demo-opt-secret' } },
    }));
    const at = (agent, ...more) => ['--agent', agent, '--kind', 'mcp', '--item', 'demo-opt-secret', '--scope', 'project', '--project', s.proj, ...more];

    // Not given: no env entry at all, nothing to set, and the plan says so.
    for (const agent of ['cursor', 'gemini-cli']) {
      const none = s.plan(at(agent)).json.plan;
      assert.deepEqual(none.actions[0].value.env, { STATIC: '1' }, agent);
      assert.deepEqual(none.env_to_set, [], agent);
      assert.equal(none.inputs[0].provided, false, agent);
      assert.match(none.inputs[0].stored_as, /^not set/, agent);
    }
    // Given: the config holds only the reference (each agent's own syntax) and the user is told to set the variable.
    const cur = s.plan(at('cursor', '--input', 'OPT_KEY=opt_secret123')).json.plan;
    assert.equal(cur.actions[0].value.env.OPT_KEY, '${env:OPT_KEY}');
    assert.deepEqual(cur.env_to_set.map((e) => e.name), ['OPT_KEY']);
    assert.equal(s.plan(at('gemini-cli', '--input', 'OPT_KEY=opt_secret123')).json.plan.actions[0].value.env.OPT_KEY, '${OPT_KEY}');
    // An agent without env-variable syntax: nothing to refuse while no secret is written, refused as soon as one would be.
    assert.equal(s.plan(at('kiro')).code, 0);
    assert.equal(s.plan(at('kiro', '--input', 'OPT_KEY=opt_secret123')).json.error.code, 'secret_in_project');
    // What lands on disk for the "not given" case.
    assert.equal(s.apply(at('cursor')).json.ok, true);
    const written = readJson(path.join(s.proj, '.cursor', 'mcp.json')).mcpServers['demo-opt-secret'];
    assert.deepEqual(written.env, { STATIC: '1' });
  } finally { s.cleanup(); }
});

test('tool selection: server flag, agent allow-list, all = no filter', () => {
  const s = sandbox();
  try {
    const f = (tools) => s.plan(['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-filtered', '--tools', tools]).json.plan;
    assert.deepEqual(f('tool-a,tool-c').actions[0].value.args, ['-y', 'demo-filtered', '--tools', 'tool_a,tool_c']);
    assert.deepEqual(f('all').actions[0].value.args, ['-y', 'demo-filtered']);
    assert.equal(s.plan(['--agent', 'cursor', '--kind', 'mcp', '--item', 'demo-filtered', '--tools', 'nope']).json.error.code, 'unknown_tool');
    const g = s.plan(['--agent', 'gemini-cli', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_abc', '--tools', 'get-file']).json.plan;
    assert.deepEqual(g.actions[0].value.includeTools, ['get_file']);
    assert.equal(g.tools.filter, 'agent-allowlist');
    const warn = s.plan([...STD, '--tools', 'get-file']).json.plan;
    assert.equal(warn.tools.filter, 'none');
    assert.match(warn.warnings.join(' '), /cannot restrict/);
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ TOML agents
test('codex / vibe: TOML blocks are appended, replaced and never duplicated', () => {
  const s = sandbox();
  try {
    const file = path.join(s.home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "keep"\n');
    const args = ['--agent', 'codex', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_secret123'];
    assert.equal(s.apply(args).json.ok, true);
    const t = fs.readFileSync(file, 'utf8');
    assert.ok(t.startsWith('model = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.demo-stdio]\ncommand = "npx"'));
    assert.match(t, /\[mcp_servers\.demo-stdio\.env\]\nDEMO_API_KEY = "demo_secret123"\n$/);
    assert.equal(s.plan(args).json.plan.actions[0].status, 'noop');
    const rep = s.apply(['--agent', 'codex', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_newtoken9', '--on-conflict', 'replace']);
    assert.equal(rep.json.results[0].status, 'replaced');
    const t2 = fs.readFileSync(file, 'utf8');
    assert.equal(t2.match(/\[mcp_servers\.demo-stdio\]/g).length, 1);
    assert.ok(t2.includes('[mcp_servers.keep]') && t2.includes('demo_newtoken9') && !t2.includes('demo_secret123'));
    const v = s.apply(['--agent', 'mistral-vibe', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_secret123']);
    assert.equal(v.json.ok, true);
    assert.match(fs.readFileSync(path.join(s.home, '.vibe', 'config.toml'), 'utf8'), /\[\[mcp_servers\]\]\nname = "demo-stdio"\ntransport = "stdio"\ncommand = "npx"/);
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ Claude Code CLI + fallback
test('claude-code: uses the claude CLI when present, edits ~/.claude.json otherwise', { skip: !POSIX }, () => {
  const s = sandbox();
  try {
    const args = ['--agent', 'claude-code', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_secret123'];
    const noCli = s.apply(args);
    assert.equal(noCli.json.ok, true, noCli.stdout);
    const cj = readJson(path.join(s.home, '.claude.json'));
    assert.equal(cj.mcpServers['demo-stdio'].type, 'stdio');
    assert.equal(cj.mcpServers['demo-stdio'].env.DEMO_API_KEY, 'demo_secret123');
    fs.rmSync(path.join(s.home, '.claude.json'));
    const log = path.join(s.dir, 'claude.log');
    s.fakeExe('claude', 'echo "--CALL--" >> "$KIT_LOG"; printf "%s\\n" "$@" >> "$KIT_LOG"');
    const withCli = s.apply(args, { env: { KIT_LOG: log } });
    assert.equal(withCli.json.ok, true, withCli.stdout);
    assert.ok(!withCli.stdout.includes('demo_secret123'));
    const lines = fs.readFileSync(log, 'utf8').split('\n');
    assert.deepEqual(lines.slice(0, 6), ['--CALL--', 'mcp', 'add-json', '--scope', 'user', 'demo-stdio']);
    assert.equal(JSON.parse(lines[6]).env.DEMO_API_KEY, 'demo_secret123');
    assert.ok(lines.includes('get'), 'verify call ran');
    assert.ok(!fs.existsSync(path.join(s.home, '.claude.json')), 'cli path does not touch the file itself');
    const p = s.plan(['--agent', 'claude-code', '--kind', 'mcp', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=demo_secret123', '--method', 'config-file'], { env: { KIT_LOG: log } });
    assert.equal(p.json.plan.method, 'config-file');
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ Windows simulation
test('Windows: paths, cmd /c npx wrapper; simulated plans cannot be applied', () => {
  const s = sandbox();
  try {
    const args = ['--os', 'windows', '--home', 'C:\\Users\\Ravi', ...STD];
    const p = s.plan(args).json.plan;
    assert.equal(p.os, 'windows');
    assert.equal(p.actions[0].file, 'C:\\Users\\Ravi\\.cursor\\mcp.json');
    assert.deepEqual(p.actions[0].value.args.slice(0, 3), ['/c', 'npx', '-y']);
    assert.equal(p.actions[0].value.command, 'cmd');
    const cline = s.plan(['--os', 'windows', '--home', 'C:\\Users\\Ravi', '--agent', 'cline', '--kind', 'mcp', '--item', 'demo-http', '--input', 'HTTP_TOKEN=tok_123456']).json.plan;
    assert.equal(cline.actions[0].file || cline.actions[0].snippet.file, 'C:\\Users\\Ravi\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json');
    const apply = s.run(['apply', ...args, '--confirm', p.hash]);
    assert.equal(apply.json.error.code, 'simulated_os');
    const mac = s.plan(['--os', 'macos', ...STD.filter((x) => x !== '--agent' && x !== 'cursor'), '--agent', 'cline']).json;
    assert.ok(mac.plan.actions[0].file.includes('/Library/Application Support/Code/User/globalStorage/') || mac.plan.actions[0].snippet.file.includes('/Library/Application Support/'));
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ skills
test('skill: bundled source, exists decision, replace with backup', () => {
  const s = sandbox();
  try {
    const args = ['--agent', 'claude-code', '--kind', 'skill', '--item', 'demo-skill'];
    const r = s.apply(args);
    assert.equal(r.json.ok, true, r.stdout);
    const dest = path.join(s.home, '.claude', 'skills', 'demo-skill');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')) && fs.existsSync(path.join(dest, 'refs', 'a.md')));
    const again = s.plan(args).json.plan;
    assert.equal(again.ready, false);
    assert.equal(again.decisions[0].status, 'exists');
    fs.writeFileSync(path.join(dest, 'local-edit.txt'), 'mine');
    const rep = s.apply([...args, '--on-conflict', 'replace']);
    assert.equal(rep.json.results[0].status, 'replaced');
    assert.ok(!fs.existsSync(path.join(dest, 'local-edit.txt')));
    assert.ok(fs.existsSync(path.join(rep.json.results[0].backup, 'local-edit.txt')), 'old folder is backed up');
    const skip = s.apply([...args, '--on-conflict', 'skip']);
    assert.equal(skip.json.results[0].status, 'skipped');
    const g = s.plan(['--agent', 'codex', '--kind', 'skill', '--item', 'demo-skill']).json.plan;
    assert.equal(g.mode, 'guided');
    const dir = path.join(s.home, 'codex-skills');
    assert.equal(s.apply(['--agent', 'codex', '--kind', 'skill', '--item', 'demo-skill', '--skills-dir', dir]).json.ok, true);
    assert.ok(fs.existsSync(path.join(dir, 'demo-skill', 'SKILL.md')));
  } finally { s.cleanup(); }
});

function mockGithub(files, port = 0) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const base = `http://127.0.0.1:${srv.address().port}`;
      const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (u.pathname.startsWith('/raw/')) {
        const p = decodeURIComponent(u.pathname.slice(5));
        if (p in files) return res.end(files[p]);
        res.statusCode = 404;
        return res.end();
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return json({ full_name: 'demo/skills', html_url: 'https://github.com/demo/skills', description: 'Demo repo', stargazers_count: 4321, owner: { login: 'demo' }, license: { spdx_id: 'MIT' }, default_branch: 'main', archived: false, pushed_at: '2026-11-01T00:00:00Z' });
      const m = /^\/repos\/[^/]+\/[^/]+\/contents\/?(.*)$/.exec(u.pathname);
      if (!m) return json({}, 404);
      const sub = decodeURIComponent(m[1]);
      if (sub in files) return json({ type: 'file', name: path.posix.basename(sub), path: sub, download_url: `${base}/raw/${encodeURIComponent(sub)}` });
      const prefix = sub ? `${sub}/` : '';
      const kids = new Map();
      for (const f of Object.keys(files)) if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); kids.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file'); }
      if (!kids.size) return json({ message: 'Not Found' }, 404);
      return json([...kids].map(([name, type]) => ({ type, name, path: prefix + name, download_url: type === 'file' ? `${base}/raw/${encodeURIComponent(prefix + name)}` : null })));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

test('skill from GitHub: downloads the folder; a source without SKILL.md installs nothing', async () => {
  const s = sandbox();
  const srv = await mockGithub({ 'skills/gh-skill/SKILL.md': '# gh skill', 'skills/gh-skill/scripts/run.sh': 'echo hi' });
  const env = { KIT_GITHUB_API: `http://127.0.0.1:${srv.address().port}` };
  try {
    const args = ['--agent', 'claude-code', '--kind', 'skill', '--item', 'demo-gh-skill'];
    const p = s.plan(args, { env });
    assert.equal(p.json.plan.actions[0].source.ref, '0123456789abcdef0123456789abcdef01234567');
    const r = await s.runAsync(['apply', ...args, '--confirm', p.json.plan.hash], { env });
    assert.equal(r.json.ok, true, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'gh-skill', 'scripts', 'run.sh'), 'utf8'), 'echo hi');
    fs.rmSync(path.join(s.home, '.claude', 'skills', 'gh-skill'), { recursive: true });
    srv.close();
    const srv2 = await mockGithub({ 'skills/gh-skill/README.md': 'no skill file here' });
    const env2 = { KIT_GITHUB_API: `http://127.0.0.1:${srv2.address().port}` };
    const r2 = await s.runAsync(['apply', ...args, '--confirm', p.json.plan.hash], { env: env2 });
    assert.equal(r2.json.ok, false);
    assert.equal(r2.json.results[0].code, 'skill_entry_missing');
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'skills', 'gh-skill')));
    srv2.close();
  } finally { s.cleanup(); }
});

test('github-info and refresh-stars use the GitHub API', async () => {
  const s = sandbox();
  const srv = await mockGithub({});
  const env = { KIT_GITHUB_API: `http://127.0.0.1:${srv.address().port}` };
  try {
    const info = await s.runAsync(['github-info', 'demo/skills'], { env });
    assert.equal(info.json.info.stars, 4321);
    assert.equal(info.json.info.license, 'MIT');
    const dry = await s.runAsync(['refresh-stars', '--dry-run'], { env });
    assert.ok(dry.json.updated.some((u) => u.item === 'mcp/demo-stdio' && u.from === 1200 && u.to === 4321));
    assert.equal(readJson(path.join(s.reg, 'items', 'mcp', 'demo-stdio', 'item.json')).stars.count, 1200, 'dry run changes nothing');
    await s.runAsync(['refresh-stars'], { env });
    assert.equal(readJson(path.join(s.reg, 'items', 'mcp', 'demo-stdio', 'item.json')).stars.count, 4321);
  } finally { srv.close(); s.cleanup(); }
});

// ------------------------------------------------------------------ plugin / extension steps
test('plugin and extension steps run and write files', { skip: !POSIX }, () => {
  const s = sandbox();
  try {
    const marker = path.join(os.tmpdir(), 'kit-plugin-marker.txt');
    fs.rmSync(marker, { force: true });
    const r = s.apply(['--agent', 'claude-code', '--kind', 'plugin', '--item', 'demo-plugin']);
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'plugin-ran');
    assert.equal(fs.readFileSync(path.join(s.home, '.demo-plugin', 'config.txt'), 'utf8'), `hello ${process.platform === 'darwin' ? 'macos' : 'linux'}\n`);
    assert.equal(s.apply(['--agent', 'gemini-cli', '--kind', 'extension', '--item', 'demo-ext']).json.ok, true);
    assert.equal(s.plan(['--agent', 'cursor', '--kind', 'extension', '--item', 'demo-ext']).json.error.code, 'incompatible');
    fs.rmSync(marker, { force: true });
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ owner tooling
test('scaffold creates a draft that validates (warnings only) and fails --strict', () => {
  const s = sandbox();
  try {
    const r = s.run(['scaffold', 'item', '--kind', 'mcp', '--id', 'qwxz', '--category', 'reverse-engineering']);
    assert.equal(r.json.ok, true, r.stdout);
    assert.ok(fs.existsSync(path.join(s.reg, 'items', 'mcp', 'qwxz', 'item.json')));
    assert.equal(s.run(['scaffold', 'tool', '--item', 'qwxz', '--id', 'scan-apk']).json.ok, true);
    assert.equal(s.run(['scaffold', 'item', '--kind', 'mcp', '--id', 'qwxz']).json.error.code, 'exists');
    const v = s.run(['validate']);
    assert.equal(v.json.ok, true, v.stdout);
    assert.ok(v.json.warnings.some((w) => /TODO|placeholder/.test(w.message)));
    assert.equal(s.run(['validate', '--strict']).code, 1);
    assert.equal(s.run(['items', '--agent', 'cursor', '--kind', 'mcp', '--search', 'qwxz']).json.message, 'Data not found'); // draft stays hidden
    assert.equal(s.run(['scaffold', 'category', '--id', 'games']).json.ok, true);
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------ unit: writers + util
test('writers: TOML rendering, quoting, block detection', () => {
  assert.equal(W.tomlValue('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(W.tomlValue(['x', 1, true]), '["x", 1, true]');
  assert.equal(W.tomlKey('mcp-server'), 'mcp-server');
  assert.equal(W.tomlKey('my server'), '"my server"');
  const spec = { table: ['mcp_servers'] };
  const block = W.tomlRender(spec, 'a', { command: 'x', args: ['1'], env: { K: 'v' } });
  assert.equal(block, '[mcp_servers.a]\ncommand = "x"\nargs = ["1"]\n\n[mcp_servers.a.env]\nK = "v"\n');
  const text = `${block}\n[other]\nz = 1\n`;
  const f = W.tomlFind(text, spec, 'a');
  assert.equal(f.lines.slice(f.start, f.end).join('\n').trim(), block.trim());
  assert.equal(W.tomlFind(text, spec, 'b'), null);
  assert.equal(W.tomlApply(text, spec, 'a', W.tomlRender(spec, 'a', { command: 'y' }), true), '[mcp_servers.a]\ncommand = "y"\n\n[other]\nz = 1\n');
  const arr = { array_table: ['mcp_servers'], name_field: 'name' };
  const t2 = `${W.tomlRender(arr, 'one', { name: 'one', command: 'a' })}\n${W.tomlRender(arr, 'two', { name: 'two', command: 'b' })}`;
  assert.equal(W.tomlInspect(t2, arr, 'two', W.tomlRender(arr, 'two', { name: 'two', command: 'b' })).status, 'noop');
  assert.equal(W.tomlInspect(t2, arr, 'two', W.tomlRender(arr, 'two', { name: 'two', command: 'c' })).status, 'conflict');
  assert.equal(W.tomlInspect(t2, arr, 'three', '').status, 'add');
});

test('writers: JSON inspect/apply and entry shapes', () => {
  const doc = { mcpServers: { a: { command: 'x' } } };
  assert.equal(W.jsonInspect(doc, ['mcpServers'], 'a', { command: 'x' }).status, 'noop');
  assert.equal(W.jsonInspect(doc, ['mcpServers'], 'a', { command: 'y' }).status, 'conflict');
  assert.equal(W.jsonInspect(doc, ['mcpServers'], 'b', {}).status, 'add');
  assert.equal(W.jsonInspect({ mcpServers: 5 }, ['mcpServers'], 'b', {}).status, 'blocked');
  assert.deepEqual(W.jsonApply({}, ['a', 'b'], 'k', 1), { a: { b: { k: 1 } } });
  const def = { transport: 'stdio', command: 'npx', args: [], env: {} };
  assert.deepEqual(W.shape({ command: '{command}', args: '{args}', env: '{env}' }, def), { command: 'npx' });
  assert.deepEqual(W.shape({ type: 'local', command: '{argv}' }, { argv: ['npx', '-y', 'x'] }), { type: 'local', command: ['npx', '-y', 'x'] });
  assert.deepEqual(W.shape({ url: '{url}', n: 'srv-{name}' }, { url: 'https://u', name: 'a' }), { url: 'https://u', n: 'srv-a' });
});

test('util: nested templates and OS maps', () => {
  const r = (t) => ({ home: '/h', 'env:X': undefined }[t]);
  assert.equal(expandTemplate('{home}/.x/{unknown}', r), '/h/.x/{unknown}');
  assert.equal(pickOs({ windows: 'w', unix: 'u' }, 'macos'), 'u');
  assert.equal(pickOs({ windows: 'w', all: 'a' }, 'linux'), 'a');
  assert.equal(pickOs('plain', 'linux'), 'plain');
});
