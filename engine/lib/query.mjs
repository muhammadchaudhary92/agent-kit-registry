import { isObj, toArray, versionGte } from './util.mjs';
import { commandInfo } from './env.mjs';

export const findItem = (db, kind, id) => db.items.find((i) => i.kind === kind && i.id === id) || null;
export const isVisible = (db, rec) => db.includeDrafts || rec.data.status === 'verified';
const byOrder = (a, b) => (a.order ?? 1000) - (b.order ?? 1000) || String(a.name).localeCompare(String(b.name));

export function whenMatches(when, ctx) {
  if (!isObj(when)) return true;
  for (const key of ['agent', 'os', 'arch']) {
    if (when[key] === undefined) continue;
    if (!toArray(when[key]).includes(ctx[key])) return false;
  }
  return true;
}

/** Resolve the install definition for one agent/OS: first matching variant wins. */
export function effective(rec, ctx) {
  const d = rec.data;
  const variant = toArray(d.variants).find((v) => whenMatches(v.when, ctx)) || null;
  const install = { ...(d.install || {}), ...((variant && variant.install) || {}) };
  const rawSteps = variant && variant.steps !== undefined ? variant.steps : d.steps;
  const steps = toArray(rawSteps).filter((s) => whenMatches(s.when, ctx));
  return { variant, install, steps };
}

export function compatibility(db, rec, agentId, ctx) {
  const agent = db.agents.get(agentId);
  if (!agent) return { compatible: false, mode: null, reasons: [`unknown agent '${agentId}'`] };
  const a = agent.data;
  const d = rec.data;
  const c = d.compat || {};
  const reasons = [];
  if (c.agents && !toArray(c.agents).includes(agentId)) reasons.push(`only for: ${toArray(c.agents).join(', ')}`);
  if (c.exclude_agents && toArray(c.exclude_agents).includes(agentId)) reasons.push(`not for ${a.name}`);
  if (d.os && !toArray(d.os).includes(ctx.os)) reasons.push(`not available on ${ctx.os}`);
  const { variant, install, steps } = effective(rec, ctx);
  if (variant && variant.unsupported) reasons.push(variant.note || `unsupported on ${a.name}/${ctx.os}`);
  const kc = a.kinds && a.kinds[rec.kind];
  if (!kc || kc.support === 'none') reasons.push(`${a.name} does not support ${rec.kind}`);
  if (reasons.length) return { compatible: false, mode: null, reasons };
  if (rec.kind === 'mcp') {
    const m = install.mcp;
    if (!m) reasons.push('no MCP definition');
    else if (toArray(kc.transports).length && !kc.transports.includes(m.transport)) reasons.push(`${a.name} cannot use ${m.transport} MCP servers`);
  } else if (rec.kind === 'skill') {
    if (!install.skill) reasons.push('no skill source');
  } else if (!steps.length) reasons.push(`no install steps for ${a.name} on ${ctx.os}`);
  if (reasons.length) return { compatible: false, mode: null, reasons };
  return {
    compatible: true,
    mode: kc.support === 'auto' ? 'auto' : 'guided',
    reasons: [],
    note: (variant && variant.note) || null,
    confidence: (kc.verified && kc.verified.confidence) || (a.verified && a.verified.confidence) || null,
  };
}

export function checkRequirements(rec, env) {
  return toArray(rec.data.requires && rec.data.requires.commands).map((r) => {
    const info = commandInfo(r.name, env, r.version_args || ['--version']);
    const versionOk = !r.min || !info.found || !info.version ? true : versionGte(info.version, r.min);
    return { command: r.name, min: r.min || null, hint: r.hint || null, found: info.found, version: info.version || null, ok: info.found && versionOk };
  });
}

export function itemSummary(rec, compat) {
  const d = rec.data;
  return {
    id: rec.id,
    kind: rec.kind,
    name: d.name,
    summary: d.summary,
    description: d.description,
    how_it_works: d.how_it_works || null,
    author: d.author || null,
    source: d.source || null,
    stars: d.stars || null,
    license: (d.source && d.source.license) || null,
    categories: toArray(d.categories),
    platforms: d.platforms ? toArray(d.platforms) : ['any'],
    tags: toArray(d.tags),
    status: d.status,
    mode: compat ? compat.mode : null,
    inputs: toArray(d.inputs).map((i) => ({ id: i.id, label: i.label, required: i.required !== false, secret: !!i.secret })),
    tools_count: rec.tools.length,
  };
}

export const toolSummary = (t) => ({ id: t.id, name: t.data.name, description: t.data.description || '', risk: t.data.risk || null, default: t.data.default !== false });

/** "MCP servers" -> "MCP server", "Skills" -> "skill": what ONE item of this kind is, from registry/kinds/<id>.json. */
export function kindSingular(db, kindId) {
  const rec = db.kinds && db.kinds.get(kindId);
  return String((rec && rec.data.name) || kindId).replace(/s$/i, '').replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
}

/**
 * The name a user sees in a list or popup. Two items of different kinds can share one product name
 * (the shadcn MCP server and the shadcn skill), so the kind must always be readable. A name that already says it
 * stays as written ("shadcn/ui MCP Server"); a bare one gets it added ("Playwright" -> "Playwright (MCP server)").
 */
export function itemLabel(db, kindId, name) {
  const word = String(kindId).replace(/[^a-z0-9]+/gi, '[- ]?');
  return new RegExp(`\\b${word}s?\\b`, 'i').test(name) ? String(name) : `${name} (${kindSingular(db, kindId)})`;
}

function matchesSearch(rec, q) {
  const d = rec.data;
  const hay = [rec.id, d.name, d.summary, d.description, ...toArray(d.tags), ...toArray(d.categories)].join(' ').toLowerCase();
  return String(q).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Visible + compatible items of one kind. Filters: category, search, platform. */
export function listItems(db, agentId, kind, ctx, f = {}) {
  const out = [];
  const want = f.platform ? toArray(f.platform).flatMap((p) => String(p).split(',')).map((p) => p.trim()).filter(Boolean) : [];
  for (const rec of db.items) {
    if (rec.kind !== kind || !isVisible(db, rec)) continue;
    const compat = compatibility(db, rec, agentId, ctx);
    if (!compat.compatible) continue;
    if (f.category && f.category !== '*' && !toArray(rec.data.categories).includes(f.category)) continue;
    if (f.search && !matchesSearch(rec, f.search)) continue;
    if (want.length) {
      const have = rec.data.platforms ? toArray(rec.data.platforms) : ['any'];
      if (!have.includes('any') && !want.some((p) => have.includes(p))) continue;
    }
    out.push({ rec, compat });
  }
  out.sort((x, y) => (x.rec.data.order ?? 1000) - (y.rec.data.order ?? 1000) || ((y.rec.data.stars && y.rec.data.stars.count) || 0) - ((x.rec.data.stars && x.rec.data.stars.count) || 0) || String(x.rec.data.name).localeCompare(String(y.rec.data.name)));
  return out;
}

export function listKinds(db, agentId, ctx) {
  const agent = db.agents.get(agentId);
  return [...db.kinds.values()]
    .map((k) => ({ id: k.id, ...k.data }))
    .sort(byOrder)
    .map((k) => ({
      id: k.id,
      name: k.name,
      description: k.description,
      count: listItems(db, agentId, k.id, ctx).length,
      support: (agent && agent.data.kinds && agent.data.kinds[k.id] && agent.data.kinds[k.id].support) || 'none',
    }));
}

export function listCategories(db, agentId, kind, ctx, f = {}) {
  const items = listItems(db, agentId, kind, ctx, { search: f.search, platform: f.platform });
  const counts = new Map();
  for (const { rec } of items) for (const c of toArray(rec.data.categories)) counts.set(c, (counts.get(c) || 0) + 1);
  const categories = [...counts.entries()]
    .map(([id, count]) => {
      const r = db.categories.get(id);
      return { id, name: r ? r.data.name : id, description: r ? r.data.description || '' : '', order: r ? r.data.order : 1000, count };
    })
    .sort(byOrder);
  return { total: items.length, categories };
}

export function itemDetail(db, rec, agentId, ctx, env) {
  const c = compatibility(db, rec, agentId, ctx);
  const d = rec.data;
  return {
    ...itemSummary(rec, c),
    compatibility: c,
    requirements: checkRequirements(rec, env),
    inputs: toArray(d.inputs).map((i) => ({
      id: i.id,
      label: i.label,
      help: i.help || null,
      example: i.example || null,
      required: i.required !== false,
      secret: !!i.secret,
      behavior: i.secret ? 'SECRET_INPUT' : 'TEXT_INPUT',
      default: i.secret ? null : i.default ?? null,
    })),
    tools: rec.tools.map(toolSummary),
    notes: d.notes || null,
    verified: d.verified || null,
  };
}
