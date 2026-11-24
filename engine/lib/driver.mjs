// Wizard driver: turns the stateless engine into a question-by-question conversation.
// `next` prints the next question (ready to show to the user) and the exact command that takes the answer.
// The AI only relays the question, so the flow does not depend on how well a model follows a long spec.
// Nothing in this file is data: every list, text and count comes from the registry.
import { KitError } from './errors.mjs';
import { toArray } from './util.mjs';
import { findItem, listItems, listKinds, listCategories, itemSummary, toolSummary, itemLabel, kindSingular } from './query.mjs';
import { detectAgents } from './detect.mjs';
import { agentStep, EMPTY } from './wizard.mjs';
import { buildPlan, presentPlan } from './plan.mjs';

const RULES = 'Do NOT run tests, do NOT summarize this repo, do NOT answer for the user.';

const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const kStars = (s) => {
  const n = s && s.count;
  if (n === undefined || n === null) return null;
  return `★ ${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n}`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Quote one shell argument for the OS the commands are printed for. */
function quoter(env) {
  if (env.os === 'windows') return (v) => (/^[\w@%+=:,./\\-]+$/.test(String(v)) ? String(v) : `"${String(v).replace(/"/g, '\\"')}"`);
  return (v) => (/^[\w@%+=:,./-]+$/.test(String(v)) ? String(v) : `'${String(v).replace(/'/g, "'\\''")}'`);
}

/** Resolve an answer to one option: a number, an id, or (part of) a label. */
export function choose(pick, options, { allowOther = false, preselect = null } = {}) {
  const s = String(pick).trim();
  if (!s) return { error: 'The answer was empty.' };
  if (preselect && /^(ok|yes|y|default|next)$/i.test(s)) return { value: preselect };
  if (/^\d+$/.test(s)) {
    const o = options[Number(s) - 1];
    return o ? { value: o.value } : { error: `There is no option ${s}.` };
  }
  const low = s.toLowerCase();
  let m = options.filter((o) => o.value.toLowerCase() === low || String(o.label).toLowerCase() === low);
  if (!m.length) m = options.filter((o) => o.value.toLowerCase().includes(low) || String(o.label).toLowerCase().includes(low));
  if (m.length === 1) return { value: m[0].value };
  if (m.length > 1) return { error: `'${s}' matches several options (${m.map((o) => o.label).join(', ')}). Use the number.` };
  return allowOther ? { value: 'other', typed: s } : { error: `No option matches '${s}'.` };
}

/** Tool selection: "all", "default", numbers ("1,3") or tool ids. */
export function parseTools(pick, tools) {
  const s = String(pick).trim().toLowerCase();
  const all = tools.map((t) => t.id);
  const done = (ids) => (ids.length === all.length ? { value: 'all' } : ids.length ? { value: ids.join(',') } : { error: 'Select at least one tool.' });
  if (s === 'all') return { value: 'all' };
  if (s === 'default' || s === 'recommended') return done(tools.filter((t) => t.data.default !== false).map((t) => t.id));
  const ids = [];
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const t = /^\d+$/.test(part) ? tools[Number(part) - 1] : tools.find((x) => x.id === part || String(x.data.name).toLowerCase() === part);
    if (!t) return { error: `There is no tool '${part}'.` };
    if (!ids.includes(t.id)) ids.push(t.id);
  }
  return done(ids);
}

function describeAction(x) {
  switch (x.type) {
    case 'json-merge':
    case 'toml-append': {
      const name = x.key || x.name;
      if (x.status === 'noop') return `"${name}" is already in ${x.file} (no change)`;
      return `${x.status === 'conflict' ? `Replace "${name}" in` : `Add "${name}" to`} ${x.file}${x.backup ? ' (a backup is made first)' : ''}`;
    }
    case 'command': return `Run: ${[x.command, ...(x.args || [])].join(' ')}`;
    case 'install-skill': return `Copy skill "${x.name}" (${x.source.type}${x.source.repo ? ` ${x.source.repo}` : ''}) into ${x.dest}`;
    case 'write-file': return `Write ${x.file}`;
    case 'copy-bundled': return `Copy bundled files into ${x.to}`;
    case 'fetch-dir': return `Download ${x.source.repo || x.source.url || 'files'} into ${x.to}`;
    default: return x.instruction || x.type;
  }
}

/** Plain-text result of `apply`, so the AI can relay it without interpreting raw JSON. */
export function applyReport(plan, res, { demo = false } = {}) {
  const L = [];
  if (!res.ok) {
    const bad = (res.results || [])[res.failed_at];
    L.push(`INSTALL FAILED at step ${res.failed_at + 1}: ${bad ? bad.error : 'unknown error'}`, 'Nothing after the failed step was run.');
    if (res.hint) L.push(res.hint);
    return L.join('\n');
  }
  if (res.dry_run) {
    L.push(demo ? 'DEMO: nothing was installed or changed. A real run would do this:' : 'DRY RUN: nothing was installed or changed. A real run would do this:');
    for (const w of res.would_run || []) L.push(`- ${w.type}: ${w.target}`);
    return L.join('\n');
  }
  L.push(`Installed ${plan.item_name} (${plan.kind}) into ${plan.agent_name}.`);
  for (const r of res.results || []) {
    const target = r.file || r.dest || '';
    L.push(`- ${r.type}: ${r.status}${target ? ` → ${target}` : ''}${r.backup ? ` (backup: ${r.backup})` : ''}`);
  }
  if (res.post_install) L.push(res.post_install);
  else if (res.restart_required) L.push(`Restart ${plan.agent_name} so it picks this up.`);
  if ((res.env_to_set || []).length) L.push(`Set before starting the agent: ${res.env_to_set.map((e) => e.name).join(', ')}`);
  return L.join('\n');
}

/**
 * Compute the next question (or the plan) from the answers given so far.
 * `a` holds the parsed CLI arguments, `o` = { cli, demo, inputs }.
 */
export function drive(db, env, a, o = {}) {
  const cli = o.cli || 'node engine/kit.mjs';
  const demo = !!o.demo;
  const q = quoter(env);
  const given = { ...(o.inputs || {}) };
  const st = { agent: a.agent, kind: a.kind, category: a.category, search: a.search, platform: a.platform, item: a.item, tools: a.tools, scope: a.scope, project: a.project, method: a.method, configPath: a.configPath, skillsDir: a.skillsDir, onConflict: a.onConflict };
  const notices = [];
  let pick = a.pick;
  const take = () => { const p = pick; pick = undefined; return p; };

  // An input is echoed in printed commands only when the item says it is NOT secret; unknown names count as secret.
  const plainIds = (s) => {
    const rec = s.kind && s.item ? findItem(db, s.kind, s.item) : null;
    return new Set(toArray(rec && rec.data.inputs).filter((i) => !i.secret).map((i) => i.id));
  };
  const secretIds = (s) => {
    const plain = plainIds(s);
    return { has: (id) => !plain.has(id) };
  };
  const globalFlags = () => {
    const f = [];
    if (demo) f.push('--demo');
    if (a.registry && !demo) f.push('--registry', q(a.registry));
    if (a.includeDrafts) f.push('--include-drafts');
    if (a.os) f.push('--os', a.os);
    if (a.arch) f.push('--arch', a.arch);
    if (a.home && !demo) f.push('--home', q(a.home));
    if (a.stateDir && !demo) f.push('--state-dir', q(a.stateDir));
    return f;
  };
  const flagsFor = (s) => {
    const f = globalFlags();
    if (s.agent) f.push('--agent', s.agent);
    else if (a.self) f.push('--self', a.self);
    if (s.kind) f.push('--kind', s.kind);
    if (s.category !== undefined) f.push('--category', q(s.category));
    if (s.search) f.push('--search', q(s.search));
    if (s.platform) f.push('--platform', q(s.platform));
    if (s.item) f.push('--item', s.item);
    if (a.inputsFile) f.push('--inputs-file', q(a.inputsFile));
    const secret = secretIds(s);
    for (const [id, v] of Object.entries(a.input || {})) f.push('--input', secret.has(id) ? `${id}=<same-secret-as-before>` : q(`${id}=${v}`));
    if (s.tools !== undefined) f.push('--tools', q(s.tools));
    if (s.scope) f.push('--scope', s.scope);
    if (s.project) f.push('--project', q(s.project));
    if (s.method) f.push('--method', s.method);
    if (s.configPath) f.push('--config-path', q(s.configPath));
    if (s.skillsDir) f.push('--skills-dir', q(s.skillsDir));
    if (s.onConflict) f.push('--on-conflict', s.onConflict);
    if (a.allowOutside) f.push('--allow-outside');
    if (a.allowSecretsInProject) f.push('--allow-secrets-in-project');
    return f;
  };
  const nextCmd = (s, extra = []) => [cli, 'next', ...flagsFor(s), ...extra].join(' ');
  const demoCmd = [cli, 'start', '--demo'].join(' ');

  const screen = ({ step, n, title, show, ai, next, nextLabel, ui, extra }) => {
    const head = `AGENT KIT${demo ? ' [DEMO: sample items, nothing real is installed]' : ''} · ${n ? `step ${n}/4 · ` : ''}${title}`;
    const lines = [head, '', '[SHOW THE USER]', ...notices.map((x) => `ℹ ${x}`), ...show, '', '[FOR THE AI]', ...ai.map((x) => `- ${x}`)];
    if (next) lines.push(`- ${nextLabel || 'NEXT COMMAND'} (replace every <...> placeholder): ${next}`);
    const say = lines.join('\n');
    return { ok: true, step, ...(ui ? { ui } : {}), ...(extra || {}), next_command: next || null, say, __text: say };
  };

  const choiceScreen = ({ step, n, title, question, options, preselect, error, extraShow = [], extraAi = [], next }) => screen({
    step,
    n,
    title,
    show: [...(error ? [`⚠ ${error}`, ''] : []), question, ...options.map((x, i) => `${i + 1}. ${x.line}${x.value === preselect ? '  ← detected' : ''}`), ...extraShow],
    ai: [
      `Ask this question NOW and wait for the user's answer. ${RULES}`,
      'Use a popup / single-choice tool if you have one (same options, same order). Otherwise print the list and let the user reply with a number.',
      ...extraAi,
    ],
    next: next || nextCmd(st, ['--pick', '<number>']),
    ui: { behavior: 'SINGLE_SELECT', title: question, preselect: preselect || null, options: options.map((x, i) => ({ n: i + 1, value: x.value, label: x.label, description: x.desc || '', ...(x.kind ? { kind: x.kind } : {}) })) },
  });

  const notFound = ({ why, back, backLabel }) => screen({
    step: 'not_found',
    title: 'Data not found',
    show: [EMPTY, why],
    ai: [
      'Tell the user exactly this. Do not search the web or suggest other repos: only the registry owner adds items.',
      `Let the user choose again (${backLabel}): ${nextCmd(back)}`,
      ...(demo ? [] : [`To preview the whole flow with sample items (nothing real is installed): ${demoCmd}`]),
    ],
    extra: { empty: true, message: EMPTY },
  });

  // ------------------------------------------------------------ 1. agent
  const aui = agentStep(db, detectAgents(db, env, { self: a.self })).ui;
  const agentOpts = aui.options.map((x) => ({ value: x.value, label: x.label, desc: x.description, line: `${x.label}${x.value !== aui.preselect && x.detected ? '  (also found on this machine)' : ''}` }));
  const askAgent = (error) => choiceScreen({
    step: 'agent',
    n: 1,
    title: 'Agent',
    question: 'Which AI agent should this be installed into? (pick ONE)',
    options: agentOpts,
    preselect: aui.preselect,
    error,
    extraAi: [
      aui.preselect ? 'The detected agent is pre-selected: the user only confirms (OK / Next) or picks another one.' : 'No agent was detected: ask the user to choose. If you know which agent you are, re-run with --self <id> to pre-select it.',
      'A typed name (Other) is fine as an answer.',
    ],
    next: nextCmd({}, ['--pick', '<number-or-name>']),
  });
  if (!st.agent) {
    if (pick === undefined) return askAgent();
    const r = choose(take(), agentOpts, { allowOther: true, preselect: aui.preselect });
    if (r.error) return askAgent(r.error);
    st.agent = r.value;
    if (r.typed) notices.push(`"${r.typed}" is not in the list: using the generic adapter "other" (guided install).`);
  } else if (!db.agents.has(st.agent)) return askAgent(`Unknown agent '${st.agent}'.`);
  const agentName = db.agents.get(st.agent).data.name;
  const cx = { agent: st.agent, os: env.os, arch: env.arch };
  const reset = (keep) => ({ ...keep, project: st.project });

  // ------------------------------------------------------------ 2. kind
  const kinds = listKinds(db, st.agent, cx);
  const kindOpts = kinds.map((k) => ({
    value: k.id,
    label: k.name,
    desc: k.description,
    line: `${k.name} — ${k.support === 'none' ? `not supported by ${agentName}` : k.count ? `${k.count} available` : 'Data not found (0 available)'}\n   ${k.description}`,
  }));
  const askKind = (error) => choiceScreen({
    step: 'kind',
    n: 2,
    title: 'Kind',
    question: `What do you want to install into ${agentName}? (pick ONE)`,
    options: kindOpts,
    error,
    extraAi: [
      'Show each kind with its full description.',
      ...(kinds.every((k) => !k.count) && !demo ? [`The registry has no verified items for this agent yet, so every choice ends in "${EMPTY}". Say so, and offer the sample-data preview: ${demoCmd}`] : []),
    ],
  });
  if (!st.kind) {
    if (pick === undefined) return askKind();
    const r = choose(take(), kindOpts);
    if (r.error) return askKind(r.error);
    st.kind = r.value;
  } else if (!db.kinds.has(st.kind)) return askKind(`Unknown kind '${st.kind}'.`);
  const kind = kinds.find((k) => k.id === st.kind);
  if (!kind.count) {
    return notFound({
      why: kind.support === 'none' ? `${agentName} does not support ${kind.name}.` : `There are no verified ${kind.name} for ${agentName} in this registry yet.`,
      back: reset({ agent: st.agent }),
      backLabel: 'pick another kind, or run the wizard again for another agent',
    });
  }

  // ------------------------------------------------------------ 3. category (+ search)
  const cats = listCategories(db, st.agent, st.kind, cx, { search: st.search, platform: st.platform });
  if (!cats.total) {
    return notFound({
      why: st.search ? `Nothing matches "${st.search}".` : `There are no ${kind.name} for ${agentName} with these filters.`,
      back: reset({ agent: st.agent, kind: st.kind }),
      backLabel: 'try another search word or kind',
    });
  }
  const catOpts = [{ value: '*', label: 'All categories', line: `All categories (${cats.total})` }, ...cats.categories.map((c) => ({ value: c.id, label: c.name, desc: c.description, line: `${c.name} (${c.count})${c.description ? ` — ${clip(c.description, 110)}` : ''}` }))];
  const askCategory = (error) => choiceScreen({
    step: 'category',
    n: 3,
    title: 'Category',
    question: `Pick a category${st.search ? ` (search: "${st.search}")` : ''}`,
    options: catOpts,
    error,
    extraShow: ['Optional: the user can type a search word instead (for example "figma").'],
    extraAi: [`If the user types a search word, do not ask again; run: ${nextCmd(st, ['--search', '<word>'])}`],
  });
  if (st.category === undefined) {
    if (pick === undefined) return askCategory();
    const r = choose(take(), catOpts);
    if (r.error) return askCategory(r.error);
    st.category = r.value;
  } else if (!catOpts.some((x) => x.value === st.category)) return askCategory(`Unknown category '${st.category}'.`);

  // ------------------------------------------------------------ 4. item
  const found = listItems(db, st.agent, st.kind, cx, { category: st.category, search: st.search, platform: st.platform });
  if (!found.length) {
    return notFound({ why: 'Nothing matches these filters.', back: reset({ agent: st.agent, kind: st.kind }), backLabel: 'change the category or search' });
  }
  const itemOpts = found.map(({ rec, compat }) => {
    const s = itemSummary(rec, compat);
    const meta = [kStars(s.stars), s.author ? `by ${s.author}` : null, s.mode === 'auto' ? 'auto-install' : 'guided install'].filter(Boolean).join(' · ');
    const needs = [
      s.inputs.filter((i) => i.required).map((i) => `${i.label}${i.secret ? ' (secret)' : ''}`).join(', ') || null,
      s.tools_count ? plural(s.tools_count, 'tool') : null,
      s.platforms[0] !== 'any' ? `platforms: ${s.platforms.join(', ')}` : null,
    ].filter(Boolean);
    // The label always says what the item is (MCP server / skill / ...), even when the registry name does not.
    const label = itemLabel(db, st.kind, s.name);
    const line = [`${label} · ${meta}`, `   What: ${clip(s.description || s.summary)}`, s.how_it_works ? `   How: ${clip(s.how_it_works)}` : null, needs.length ? `   Needs: ${needs.join(' · ')}` : null].filter(Boolean).join('\n');
    return { value: s.id, label, desc: s.summary || '', line, kind: st.kind };
  });
  const itemList = found.length > 1 ? [...itemOpts, { value: 'ai', label: 'Let the AI choose for me', line: 'Let the AI choose for me (it picks ONE item from this list only)' }] : itemOpts;
  const askItem = (error, aiChoose) => choiceScreen({
    step: 'item',
    n: 4,
    title: kind.name,
    question: `Which ${kindSingular(db, st.kind)} for ${agentName}? Pick one (${found.length} found)`,
    options: itemList,
    error,
    extraShow: aiChoose ? ['The user asked the AI to choose.'] : [],
    extraAi: [
      'Show every item with name, what it does, how it works, stars and author, exactly as listed.',
      `More detail on one item: ${[cli, 'show', ...globalFlags(), '--agent', st.agent, '--kind', st.kind, '--item', '<id>'].join(' ')}`,
      ...(aiChoose
        ? ['NOW choose exactly ONE item from this list yourself (never from outside the registry): prefer one whose platforms match the user\'s project, then more stars. Tell the user which one and why in one line, then run the NEXT COMMAND with its number.']
        : found.length > 1
          ? ['If the user takes "Let the AI choose": pick exactly ONE item from this list (never from outside the registry), prefer a platform match with their project, then more stars; tell them which and why in one line, and let them veto it.']
          : []),
    ],
  });
  if (!st.item) {
    if (pick === undefined) return askItem();
    const r = choose(take(), itemList);
    if (r.error) return askItem(r.error);
    if (r.value === 'ai') return askItem(undefined, true);
    st.item = r.value;
  } else if (!found.some(({ rec }) => rec.id === st.item)) return askItem(`'${st.item}' is not in this list.`);
  const rec = findItem(db, st.kind, st.item);

  // ------------------------------------------------------------ 5. inputs (credentials)
  const spec = toArray(rec.data.inputs);
  const has = (s) => (given[s.id] !== undefined && given[s.id] !== '') || !!env.vars[`KIT_INPUT_${s.id}`] || (s.default !== undefined && s.default !== '');
  const askInputs = (list, error) => screen({
    step: 'inputs',
    title: 'Credentials',
    show: [
      ...(error ? [`⚠ ${error}`, ''] : []),
      `${rec.data.name} needs ${plural(list.length, 'value')} before it can be installed:`,
      ...list.flatMap((s) => [`• ${s.label}${s.secret ? ' (secret)' : ''}${s.help ? ` — ${s.help}` : ''}${s.example ? `  e.g. ${s.example}` : ''}`]),
    ],
    ai: [
      `Ask the user for each value now. ${RULES}`,
      'Use a text prompt (a masked prompt for secrets if you have one). NEVER repeat, log or store a secret.',
      'Add the same --input flags (secrets included) to every later command; the engine does not keep them.',
      ...(env.os === 'windows' ? [] : ['To keep a secret out of shell history you may set the environment variable KIT_INPUT_<ID> instead of --input.']),
    ],
    next: nextCmd(st, list.map((s) => `--input ${s.id}=<value>`)),
    extra: { inputs: list.map((s) => ({ id: s.id, label: s.label, secret: !!s.secret, behavior: s.secret ? 'SECRET_INPUT' : 'TEXT_INPUT', help: s.help || null, example: s.example || null })) },
  });
  const missing = spec.filter((s) => s.required !== false && !has(s));
  if (missing.length) return askInputs(missing);
  for (const s of spec) {
    const v = given[s.id] !== undefined && given[s.id] !== '' ? given[s.id] : env.vars[`KIT_INPUT_${s.id}`];
    if (v && s.pattern && !new RegExp(s.pattern).test(String(v))) {
      return askInputs([s], `${s.label} does not match the expected format${s.example ? ` (example: ${s.example})` : ''}.`);
    }
  }

  // ------------------------------------------------------------ 6. tools of an MCP (multi select)
  if (rec.kind === 'mcp' && rec.tools.length) {
    const askTools = (error) => screen({
      step: 'tools',
      title: 'Tools',
      show: [
        ...(error ? [`⚠ ${error}`, ''] : []),
        `Which tools of "${rec.data.name}" should be enabled? (you may pick several)`,
        ...rec.tools.map((t, i) => {
          const s = toolSummary(t);
          return `${i + 1}. [${s.default ? 'x' : ' '}] ${s.name}${s.risk ? ` (${s.risk})` : ''}${s.description ? ` — ${s.description}` : ''}`;
        }),
        'Answer: default (the [x] ones) · all · or numbers like 1,3',
      ],
      ai: [
        `Ask this MULTI-select question NOW. ${RULES}`,
        'Use a multi-choice / checkbox popup if you have one (pre-select the [x] tools). Otherwise print the list and let the user reply.',
        'If the agent cannot restrict tools, the plan will say so in its warnings: tell the user honestly.',
      ],
      next: nextCmd({ ...st, tools: undefined }, ['--pick', '<default|all|1,3>']),
      ui: { behavior: 'MULTI_SELECT', title: `Which tools of "${rec.data.name}" should be enabled?`, options: rec.tools.map((t, i) => { const s = toolSummary(t); return { n: i + 1, value: s.id, label: s.name, description: s.description, risk: s.risk, preselected: s.default }; }) },
    });
    let answer = st.tools;
    if (answer === undefined) {
      if (pick === undefined) return askTools();
      answer = take();
    }
    const r = parseTools(answer, rec.tools);
    if (r.error) return askTools(r.error);
    st.tools = r.value;
  }

  // ------------------------------------------------------------ 7. plan
  const planArgs = () => ({ agent: st.agent, kind: st.kind, item: st.item, scope: st.scope, project: st.project, tools: st.tools, inputs: given, method: st.method, configPath: st.configPath, skillsDir: st.skillsDir, onConflict: st.onConflict, allowOutside: a.allowOutside, allowSecretsInProject: a.allowSecretsInProject });
  let plan;
  let p;
  const build = () => {
    const built = buildPlan(db, env, planArgs());
    plan = built.plan;
    p = presentPlan(built.plan, built.secrets);
  };
  try {
    build();
  } catch (e) {
    if (e instanceof KitError && e.code === 'missing_inputs') return askInputs(e.details.missing.map((m) => spec.find((s) => s.id === m.id) || m));
    if (e instanceof KitError && e.code === 'invalid_input') return askInputs(spec.filter((s) => s.required !== false), e.message);
    throw e;
  }

  if (p.decisions.length && !st.onConflict) {
    const opts = [
      { value: 'replace', label: 'Replace', line: 'Replace it (a backup is made first)' },
      { value: 'skip', label: 'Keep existing', line: 'Keep what is there (skip this part)' },
      { value: 'cancel', label: 'Cancel', line: 'Cancel (nothing is changed)' },
    ];
    const askConflict = (error) => choiceScreen({
      step: 'conflict',
      title: 'Already exists',
      question: `Something already exists with a different content:\n${p.decisions.map((d) => `• ${d.target} (${d.status})`).join('\n')}\nWhat should I do?`,
      options: opts,
      error,
    });
    if (pick === undefined) return askConflict();
    const r = choose(take(), opts);
    if (r.error) return askConflict(r.error);
    if (r.value === 'cancel') return screen({ step: 'cancelled', title: 'Cancelled', show: ['Cancelled. Nothing was changed.'], ai: ['Tell the user nothing was changed.'] });
    st.onConflict = r.value;
    build();
  }

  if (p.mode !== 'auto') {
    const manual = p.actions.filter((x) => x.type === 'manual');
    const fileHint = st.kind === 'mcp' ? ['--config-path', '<real-config-file>'] : st.kind === 'skill' ? ['--skills-dir', '<real-skills-folder>'] : null;
    return screen({
      step: 'guided',
      title: 'Guided install',
      show: [
        `${p.item_name} cannot be written automatically into ${p.agent_name} on this machine (the file layout is not verified).`,
        ...manual.flatMap((x) => [`• ${x.instruction}`, ...(x.snippet ? [`  ${x.snippet.note || ''}`, `  File: ${x.snippet.file || '(unknown)'}`, '```', x.snippet.content, '```'] : [])]),
        ...manual.flatMap((x) => toArray(x.reasons).map((r) => `  (why: ${r})`)),
        'Is the file/folder above the right one? Tell me the real path and I will write it safely (backup first), or apply the snippet yourself.',
      ],
      ai: [
        `Show this to the user. ${RULES}`,
        'Ask the user to confirm the REAL path (you may check the agent\'s docs to help find it). Never guess.',
        ...(JSON.stringify(p.actions).includes('***') ? ['Secrets are shown as *** in the snippet on purpose. To write the real value, plan again with the path below: the engine writes it safely.'] : []),
        ...(fileHint ? [`Then plan again with the path: ${nextCmd(st, fileHint)}`] : ['This kind has manual steps only: walk the user through them.']),
      ],
      extra: { plan: p },
    });
  }

  // ------------------------------------------------------------ 8. confirm
  const applyCmd = [cli, 'apply', ...flagsFor({ ...st, category: undefined, search: undefined, platform: undefined }), '--confirm', plan.hash].join(' ');
  const secretGiven = Object.keys(a.input || {}).some((id) => secretIds(st).has(id));
  return screen({
    step: 'confirm',
    title: 'Confirm',
    show: [
      `Ready to install: ${p.item_name} (${p.kind}) into ${p.agent_name}`,
      `Scope: ${p.scope} · OS: ${p.os} · mode: ${p.mode}`,
      ...(p.tools ? [`Tools: ${p.tools.all ? `all ${p.tools.total}` : `${p.tools.selected.length} of ${p.tools.total} (${p.tools.selected.join(', ')})`}`] : rec.kind === 'mcp' ? [`Tools: ${EMPTY} (all tools of the server stay enabled)`] : []),
      'What will happen:',
      ...p.actions.map((x) => `• ${describeAction(x)}`),
      ...(p.warnings.length ? ['Heads-up:', ...p.warnings.map((w) => `• ${w}`)] : []),
      ...(p.env_to_set.length ? ['Set before use:', ...p.env_to_set.map((e) => `• ${e.name} — ${e.label}`)] : []),
      ...p.notes.map((x) => `Note: ${x}`),
      '',
      demo ? 'Apply? (DEMO: this only shows what would happen)' : 'Apply this? Nothing has been changed yet.',
      '1. Yes, install',
      '2. No, cancel',
    ],
    ai: [
      `Ask this yes/no question NOW. ${RULES}`,
      'If NO, stop and tell the user that nothing was changed.',
      ...(secretGiven ? ['Replace the secret placeholder in the apply command with the real value, and never print it.'] : []),
      'After apply: tell the user in 2-3 lines what was installed, where, the backup path (if any) and the next step (usually restart the agent). Use the "report" field of the apply result.',
    ],
    next: applyCmd,
    nextLabel: 'ONLY IF THE USER SAYS YES, RUN',
    extra: { plan: p, hash: plan.hash },
  });
}
