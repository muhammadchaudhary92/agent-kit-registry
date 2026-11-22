// Tests for the `start` / `next` wizard driver. They play the role of a (weak) AI: read the printed screen,
// take the command from the NEXT COMMAND line, put the user's answer into the placeholder, run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { choose, parseTools } from '../engine/lib/driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'engine', 'kit.mjs');
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('KIT_')));
const SECRET = 'demo_secret123';

/** Minimal POSIX-like tokenizer for the commands the driver prints ('single', "double", backslash). */
function tokenize(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; has = true; } else if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else { cur += c; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

function box(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-drv-'));
  const reg = path.join(dir, 'registry');
  for (const d of ['agents', 'kinds', 'categories']) fs.cpSync(path.join(ROOT, 'registry', d), path.join(reg, d), { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'items'), path.join(reg, 'items'), { recursive: true });
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  fs.mkdirSync(home);
  const env = { ...CLEAN_ENV, KIT_DEMO_DIR: path.join(dir, 'demo'), ...extraEnv };
  const outputs = [];
  const kit = (args, o = {}) => {
    const r = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', cwd: o.cwd || ROOT, env: { ...env, ...(o.env || {}) } });
    outputs.push(r.stdout, r.stderr);
    return { code: r.status, text: r.stdout, err: r.stderr };
  };
  /** Run the command of the NEXT line, with the user's answer / the secret put into the placeholders. */
  const follow = (screen, { answer, secret = SECRET, cwd } = {}) => {
    const m = screen.text.match(/^- [^\n]*\(replace every <\.\.\.> placeholder\): (.+)$/m);
    assert.ok(m, `no command line in:\n${screen.text}`);
    const toks = tokenize(m[1]).map((t) => t.replace('<same-secret-as-before>', secret).replace('<value>', secret).replace(/<[^>]+>/, answer ?? ''));
    assert.equal(toks[0], 'node');
    assert.ok(!toks.some((t) => /<|>/.test(t)), `placeholder left in: ${toks.join(' ')}`);
    return kit(toks.slice(2), { cwd }); // drop `node` and the script path
  };
  const real = ['--registry', reg, '--home', home, '--state-dir', state];
  return { dir, reg, home, state, kit, follow, real, outputs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------ the first screens
test('start asks the agent question first (never tests, never a summary) and pre-selects the reported agent', () => {
  const b = box();
  try {
    const s = b.kit(['start', '--self', 'mistral-vibe']);
    assert.equal(s.code, 0, s.err);
    assert.match(s.text, /step 1\/4 · Agent/);
    assert.match(s.text, /\[SHOW THE USER\]/);
    assert.match(s.text, /\[FOR THE AI\]/);
    assert.match(s.text, /Do NOT run tests/);
    assert.match(s.text, /Mistral Vibe \(Code mode\)  ← detected/);
    assert.equal((s.text.match(/^\d+\. /gm) || []).length, 20); // 20 adapters, "Other" last
    assert.match(s.text, /20\. Other \(not listed\)/);
    assert.match(s.text, /--self mistral-vibe --pick <number-or-name>/);
  } finally { b.cleanup(); }
});

test('--self from the running AI beats every other evidence', () => {
  const b = box();
  try {
    const s = b.kit(['start', '--self', 'mistral-vibe'], { env: { CLAUDECODE: '1', CLAUDE_CODE_TEST: '1' } });
    assert.match(s.text, /Mistral Vibe \(Code mode\)  ← detected/);
    assert.doesNotMatch(s.text, /Claude Code  ← detected/);
  } finally { b.cleanup(); }
});

test('on the empty shipped registry every path ends in "Data not found" and offers the demo', () => {
  const b = box();
  try {
    const kind = b.follow(b.kit(['start', '--self', 'mistral-vibe']), { answer: 'ok' });
    assert.match(kind.text, /step 2\/4 · Kind/);
    for (const name of ['MCP servers', 'Skills', 'Plugins', 'Extensions']) assert.match(kind.text, new RegExp(`\\d\\. ${name} — `));
    assert.match(kind.text, /MCP \(Model Context Protocol\) servers give an AI agent new abilities/); // full description
    assert.match(kind.text, /Data not found \(0 available\)/);
    assert.match(kind.text, /not supported by Mistral Vibe/);
    assert.match(kind.text, /start --demo/);
    const nf = b.follow(kind, { answer: '1' });
    assert.equal(nf.code, 0);
    assert.match(nf.text, /Data not found/);
    assert.match(nf.text, /no verified MCP servers for Mistral Vibe/);
    assert.match(nf.text, /Do not search the web/);
  } finally { b.cleanup(); }
});

test('--json returns the same screen as data', () => {
  const b = box();
  try {
    const r = b.kit(['start', '--json', '--compact', '--self', 'cursor']);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    assert.equal(j.step, 'agent');
    assert.equal(j.ui.behavior, 'SINGLE_SELECT');
    assert.equal(j.ui.options.length, 20);
    assert.equal(j.ui.preselect, 'cursor');
    assert.match(j.next_command, /--pick/);
    assert.equal(j.__text, undefined);
    assert.match(j.say, /\[SHOW THE USER\]/);
  } finally { b.cleanup(); }
});

// ------------------------------------------------------------------ demo: the whole flow with sample items
test('demo mode: agent -> kind -> category -> item -> token -> tools -> confirm -> apply (nothing is written)', () => {
  const b = box();
  try {
    let s = b.kit(['start', '--demo', '--self', 'mistral-vibe']);
    assert.match(s.text, /DEMO: sample items/);
    s = b.follow(s, { answer: 'ok' });
    assert.match(s.text, /MCP servers — 3 available/);
    s = b.follow(s, { answer: '1' });
    assert.match(s.text, /step 3\/4 · Category/);
    assert.match(s.text, /1\. All categories \(3\)/);
    s = b.follow(s, { answer: '1' });
    assert.match(s.text, /step 4\/4 · MCP servers/);
    assert.match(s.text, /Pick one \(3 found\)/);
    assert.match(s.text, /Demo Design Server · ★ 1\.2k · by demo-author · auto-install/);
    assert.match(s.text, /What: Reads design files/);
    assert.match(s.text, /How: Runs locally through npx/);
    assert.match(s.text, /4\. Let the AI choose for me/);
    s = b.follow(s, { answer: '1' });
    assert.match(s.text, /Credentials/);
    assert.match(s.text, /Demo API token \(secret\)/);
    assert.match(s.text, /e\.g\. demo_abc123/);
    s = b.follow(s);
    assert.match(s.text, /Which tools of "Demo Design Server"/);
    assert.match(s.text, /1\. \[x\] get_file \(read\)/);
    assert.match(s.text, /3\. \[ \] delete_file \(destructive\)/);
    s = b.follow(s, { answer: 'default' });
    assert.match(s.text, /· Confirm/);
    assert.match(s.text, /Ready to install: Demo Design Server \(mcp\) into Mistral Vibe/);
    assert.match(s.text, /Tools: 2 of 3 \(get-file, get-image\)/);
    assert.match(s.text, /Add "demo-stdio" to .*config\.toml/);
    assert.match(s.text, /cannot restrict individual tools/); // honest warning for an agent without tool filtering
    assert.match(s.text, /ONLY IF THE USER SAYS YES, RUN/);
    s = b.follow(s);
    const demoReport = JSON.parse(s.text).report;
    assert.match(demoReport, /^DEMO: nothing was installed or changed/);
    assert.match(demoReport, /toml-append/);
    assert.equal(fs.existsSync(path.join(b.dir, 'demo', 'home', '.vibe', 'config.toml')), false);
    assert.ok(!b.outputs.join('\n').includes(SECRET), 'the secret was printed');
  } finally { b.cleanup(); }
});

test('demo apply never writes, even for an agent whose adapter has a real config path', () => {
  const b = box();
  try {
    let s = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', 'all']);
    assert.match(s.text, /· Confirm/);
    s = b.follow(s);
    assert.match(JSON.parse(s.text).report, /^DEMO: nothing was installed/);
    assert.equal(fs.existsSync(path.join(b.dir, 'demo', 'home', '.cursor', 'mcp.json')), false);
  } finally { b.cleanup(); }
});

// ------------------------------------------------------------------ real flow (sandbox registry + home)
test('real flow: global flags are carried, install happens, repeat is a no-op, conflict asks, replace backs up', () => {
  const b = box();
  try {
    let s = b.kit(['start', ...b.real, '--self', 'cursor']);
    s = b.follow(s, { answer: 'ok' }); // kind
    assert.match(s.text, new RegExp(`--registry ${b.reg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); // carried
    s = b.follow(s, { answer: '1' }); // MCP -> category
    s = b.follow(s, { answer: '1' }); // all -> item
    s = b.follow(s, { answer: '1' }); // Demo Design Server -> credentials
    s = b.follow(s); // token -> tools
    s = b.follow(s, { answer: 'all' }); // confirm
    assert.match(s.text, /Tools: all 3/);
    assert.match(s.text, /Add "demo-stdio" to .*[\\/]\.cursor[\\/]mcp\.json/);
    const apply = b.follow(s);
    const j = JSON.parse(fs.readFileSync(path.join(b.home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(j.mcpServers['demo-stdio'].env.DEMO_API_KEY, SECRET); // the real value is written to the config...
    assert.match(JSON.parse(apply.text).report, /^Installed Demo Design Server \(mcp\) into Cursor/);
    assert.ok(!b.outputs.join('\n').includes(SECRET), '...but never printed');

    // same install again: nothing to do
    const again = b.kit(['next', ...b.real, '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', 'all']);
    assert.match(again.text, /already in .*mcp\.json \(no change\)/);

    // someone changed the entry by hand: the wizard must ask before touching it
    j.mcpServers['demo-stdio'].args = ['different'];
    fs.writeFileSync(path.join(b.home, '.cursor', 'mcp.json'), JSON.stringify(j));
    const conflict = b.kit(['next', ...b.real, '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', 'all']);
    assert.match(conflict.text, /· Already exists/);
    assert.match(conflict.text, /mcp\.json \(conflict\)/);
    assert.match(conflict.text, /1\. Replace it/);
    assert.match(conflict.text, /3\. Cancel/);
    const cancel = b.follow(conflict, { answer: '3' });
    assert.match(cancel.text, /Cancelled\. Nothing was changed\./);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers['demo-stdio'].args, ['different']);
    let replace = b.follow(conflict, { answer: '1' });
    assert.match(replace.text, /Replace "demo-stdio" in/);
    assert.match(replace.text, /--on-conflict replace/);
    replace = b.follow(replace);
    assert.match(replace.text, /replaced/);
    assert.ok(fs.existsSync(path.join(b.state, 'backups')), 'backup folder missing');
    assert.notDeepEqual(JSON.parse(fs.readFileSync(path.join(b.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers['demo-stdio'].args, ['different']);
    assert.ok(!b.outputs.join('\n').includes(SECRET));
  } finally { b.cleanup(); }
});

test('hash guard still protects apply when the answers change after the user approved', () => {
  const b = box();
  try {
    const s = b.kit(['next', ...b.real, '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', 'all']);
    const m = s.text.match(/RUN \(replace every <\.\.\.> placeholder\): (.+)$/m);
    const args = tokenize(m[1]).slice(2).map((t) => t.replace('<same-secret-as-before>', 'demo_other999'));
    const r = b.kit(args);
    assert.match(r.text, /hash_mismatch/);
    assert.equal(fs.existsSync(path.join(b.home, '.cursor', 'mcp.json')), false);
  } finally { b.cleanup(); }
});

// ------------------------------------------------------------------ bad answers are re-asked, secrets stay hidden
test('wrong answers re-ask the same question with a warning', () => {
  const b = box();
  try {
    const kind = b.kit(['next', '--demo', '--agent', 'cursor']);
    assert.match(b.kit(['next', '--demo', '--agent', 'cursor', '--pick', '99']).text, /⚠ There is no option 99\./);
    assert.match(b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'nope']).text, /⚠ Unknown kind 'nope'\./);
    assert.match(b.kit(['next', '--demo', '--agent', 'nope']).text, /⚠ Unknown agent 'nope'\./);
    assert.match(b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', 'nope']).text, /⚠ Unknown category 'nope'\./);
    assert.match(b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'nope']).text, /⚠ 'nope' is not in this list\./);
    const bad = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', 'DEMO_TOKEN=wrong']);
    assert.match(bad.text, /⚠ Demo API token does not match the expected format/);
    assert.match(b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', '9']).text, /⚠ There is no tool '9'\./);
    assert.match(kind.text, /step 2\/4/);
  } finally { b.cleanup(); }
});

test('typed agent names: unknown -> generic "other", ambiguous -> asks again', () => {
  const b = box();
  try {
    const typed = b.kit(['next', '--demo', '--pick', 'Zed Preview']);
    assert.match(typed.text, /"Zed Preview" is not in the list: using the generic adapter "other"/);
    assert.match(typed.text, /into Other \(not listed\)/);
    assert.match(b.kit(['next', '--demo', '--pick', 'code']).text, /matches several options/);
    assert.match(b.kit(['next', '--demo', '--pick', 'cursor']).text, /step 2\/4 · Kind/);
  } finally { b.cleanup(); }
});

test('"Let the AI choose" tells the AI to pick exactly one item from the shown list', () => {
  const b = box();
  try {
    const t = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--pick', 'ai']);
    assert.match(t.text, /The user asked the AI to choose\./);
    assert.match(t.text, /choose exactly ONE item from this list yourself \(never from outside the registry\)/);
    const one = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', 'ui']); // a single match: no AI-choose option
    assert.doesNotMatch(one.text, /Let the AI choose/);
  } finally { b.cleanup(); }
});

test('secrets: never echoed, not even when the AI passes a wrong input name', () => {
  const b = box();
  try {
    const t = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', 'BOGUS=topsecretvalue']);
    assert.doesNotMatch(t.text, /topsecretvalue/);
    assert.match(t.text, /BOGUS=<same-secret-as-before>/);
    const ok = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`]);
    assert.doesNotMatch(ok.text, new RegExp(SECRET));
    assert.match(ok.text, /DEMO_TOKEN=<same-secret-as-before>/);
  } finally { b.cleanup(); }
});

test('guided agents: the screen asks for the real path and says secrets are masked on purpose', () => {
  const b = box();
  try {
    const t = b.kit(['next', '--demo', '--agent', 'other', '--kind', 'mcp', '--category', '*', '--item', 'demo-http', '--input', 'HTTP_TOKEN=abc123tok']);
    assert.match(t.text, /Guided install/);
    assert.match(t.text, /"mcpServers"/);
    assert.match(t.text, /Secrets are shown as \*\*\* in the snippet on purpose/);
    assert.match(t.text, /--config-path <real-config-file>/);
    assert.doesNotMatch(t.text, /abc123tok/);
  } finally { b.cleanup(); }
});

test('skills and plugins go through the same screens', () => {
  const b = box();
  try {
    const skill = b.kit(['next', '--demo', '--agent', 'claude-code', '--kind', 'skill', '--category', '*', '--item', 'demo-skill']);
    assert.match(skill.text, /Copy skill "demo-skill" \(bundled\) into .*skills/);
    const plugin = b.kit(['next', '--demo', '--agent', 'claude-code', '--kind', 'plugin', '--category', '*', '--item', 'demo-plugin']);
    assert.match(plugin.text, /Ready to install: Demo Plugin \(plugin\)/);
    assert.match(plugin.text, /• Run: node /);
  } finally { b.cleanup(); }
});

// ------------------------------------------------------------------ how the commands are printed
test('commands use the absolute script path outside the repo folder and quote "*" for the shell', () => {
  const b = box();
  try {
    const t = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp'], { cwd: os.tmpdir() });
    const line = t.text.match(/placeholder\): (.+)$/m)[1];
    assert.ok(line.startsWith(`node ${KIT}`), line);
    const inside = b.kit(['next', '--demo', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`]);
    assert.match(inside.text, /placeholder\): node engine\/kit\.mjs next --demo --agent cursor --kind mcp --category '\*' --item demo-stdio/);
    const winAsk = b.kit(['next', '--demo', '--os', 'windows', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`]);
    assert.match(winAsk.text, /--os windows/);
    assert.match(winAsk.text, /--category "\*"/); // cmd / PowerShell style quoting
    const win = b.kit(['next', '--demo', '--os', 'windows', '--agent', 'cursor', '--kind', 'mcp', '--category', '*', '--item', 'demo-stdio', '--input', `DEMO_TOKEN=${SECRET}`, '--tools', 'all']);
    assert.match(win.text, /Scope: user · OS: windows/);
    assert.match(win.text, /\\\.cursor\\mcp\.json/);
  } finally { b.cleanup(); }
});

// ------------------------------------------------------------------ units
test('choose(): numbers, ids, labels, shortcuts, Other', () => {
  const opts = [{ value: 'cursor', label: 'Cursor' }, { value: 'claude-code', label: 'Claude Code' }, { value: 'other', label: 'Other (not listed)' }];
  assert.deepEqual(choose('2', opts), { value: 'claude-code' });
  assert.deepEqual(choose('cursor', opts), { value: 'cursor' });
  assert.deepEqual(choose('claude', opts), { value: 'claude-code' });
  assert.deepEqual(choose('OK', opts, { preselect: 'cursor' }), { value: 'cursor' });
  assert.match(choose('9', opts).error, /no option 9/);
  assert.match(choose('c', opts).error, /several/);
  assert.deepEqual(choose('zzz', opts, { allowOther: true }), { value: 'other', typed: 'zzz' });
  assert.match(choose('zzz', opts).error, /No option matches/);
  assert.match(choose('  ', opts).error, /empty/);
});

test('parseTools(): all / default / numbers / ids', () => {
  const tools = [{ id: 'a', data: { name: 'tool_a' } }, { id: 'b', data: { name: 'tool_b' } }, { id: 'c', data: { name: 'tool_c', default: false } }];
  assert.deepEqual(parseTools('all', tools), { value: 'all' });
  assert.deepEqual(parseTools('default', tools), { value: 'a,b' });
  assert.deepEqual(parseTools('1,3', tools), { value: 'a,c' });
  assert.deepEqual(parseTools('1 2 3', tools), { value: 'all' });
  assert.deepEqual(parseTools('tool_b', tools), { value: 'b' });
  assert.match(parseTools('7', tools).error, /no tool '7'/);
});

// ------------------------------------------------------------------ entry points an AI reads first
test('entry files tell an AI to run the wizard, and package.json has start/demo', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.start, 'node engine/kit.mjs start');
  assert.equal(pkg.scripts.demo, 'node engine/kit.mjs start --demo');
  assert.match(read('README.md').split('\n').slice(0, 12).join('\n'), /node engine\/kit\.mjs start/); // visible, not an HTML comment
  assert.doesNotMatch(read('README.md').split('\n')[0], /^<!--/);
  assert.match(read('AGENTS.md'), /node engine\/kit\.mjs start/);
  assert.match(read('wizard/WIZARD.md'), /node engine\/kit\.mjs start/);
  for (const f of ['README.md', 'AGENTS.md', 'wizard/WIZARD.md']) assert.match(read(f), /(not|never)\W+run the tests/i, f);
  assert.equal(fs.existsSync(path.join(ROOT, '.github')), false); // the CI file lives in docs/ (a token without workflow scope cannot push it)
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'ci-validate.yml.example')));
});
