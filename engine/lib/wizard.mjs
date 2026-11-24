import { listKinds, listCategories, listItems, itemSummary, toolSummary, itemLabel, kindSingular } from './query.mjs';

export const EMPTY = 'Data not found';

const sup = (a, k) => {
  const s = a.kinds && a.kinds[k] && a.kinds[k].support;
  return s === 'auto' ? 'auto' : s === 'guided' ? 'guided' : 'no';
};

/** Step 1: agent (single select + Other, detected agent pre-selected). */
export function agentStep(db, detection) {
  const det = new Map(detection.agents.map((a) => [a.id, a]));
  const recs = [...db.agents.values()].sort((a, b) => (a.data.id === 'other') - (b.data.id === 'other') || (a.data.order ?? 1000) - (b.data.order ?? 1000) || a.data.name.localeCompare(b.data.name));
  const options = recs.map((r) => {
    const d = det.get(r.id);
    const matrix = `MCP: ${sup(r.data, 'mcp')} | Skills: ${sup(r.data, 'skill')} | Plugins: ${sup(r.data, 'plugin')} | Extensions: ${sup(r.data, 'extension')}`;
    return { value: r.id, label: r.data.name, description: [r.data.description, matrix].filter(Boolean).join(' - '), detected: !!(d && d.installed), evidence: d ? d.evidence : [] };
  });
  return {
    step: 'agent',
    ui: {
      behavior: 'SINGLE_SELECT',
      title: 'Which AI agent should this be installed into?',
      options,
      preselect: detection.preselect,
      allow_other: true,
      other_value: 'other',
      hint: detection.preselect ? 'Auto-detected agent is pre-selected; the user only confirms (OK / Next).' : 'No agent could be detected; ask the user to choose.',
    },
  };
}

/** Step 2: kind (single select, each with a complete description). */
export function kindStep(db, agentId, ctx) {
  const kinds = listKinds(db, agentId, ctx);
  return {
    step: 'kind',
    ui: {
      behavior: 'SINGLE_SELECT',
      title: 'What do you want to install?',
      options: kinds.map((k) => ({ value: k.id, label: k.name, description: k.description, count: k.count, support: k.support })),
      empty_message: EMPTY,
      hint: 'If the chosen kind has count 0, answer "Data not found" and let the user pick again.',
    },
  };
}

/** Step 3: category (single select) + optional search text. */
export function categoryStep(db, agentId, kind, ctx, f = {}) {
  const { total, categories } = listCategories(db, agentId, kind, ctx, f);
  if (!total) return { step: 'category', empty: true, message: EMPTY, ui: null };
  return {
    step: 'category',
    total,
    ui: {
      behavior: 'SINGLE_SELECT',
      title: 'Pick a category',
      options: [{ value: '*', label: 'All categories', description: `Show every ${kind} item`, count: total }, ...categories.map((c) => ({ value: c.id, label: c.name, description: c.description, count: c.count }))],
      search: { behavior: 'TEXT_INPUT', label: 'Search (optional)', param: '--search', optional: true },
    },
  };
}

/** Step 4: item (single select). Every option carries the full detail block. */
export function itemStep(db, agentId, kind, ctx, f = {}) {
  const items = listItems(db, agentId, kind, ctx, f);
  if (!items.length) return { step: 'item', empty: true, message: EMPTY, ui: null };
  const options = items.map(({ rec, compat }) => {
    const s = itemSummary(rec, compat);
    return {
      value: s.id,
      label: itemLabel(db, kind, s.name),
      kind,
      description: s.summary,
      details: { what_it_does: s.description, how_it_works: s.how_it_works, author: s.author, stars: s.stars, license: s.license, repo: s.source && s.source.repo, categories: s.categories, platforms: s.platforms, install_mode: s.mode, needs_input: s.inputs.filter((i) => i.required).map((i) => i.label), tools_count: s.tools_count },
    };
  });
  return {
    step: 'item',
    count: options.length,
    ui: {
      behavior: 'SINGLE_SELECT',
      title: `Pick one ${kindSingular(db, kind)} (${options.length} found)`,
      options,
      ai_choose: { allowed: options.length > 1, rule: 'The AI may pick exactly ONE option from this list (never from outside the registry) and must match the project platform.' },
    },
  };
}

/** Step 6: inner tools of an MCP (multi select, all pre-selected). */
export function toolStep(rec) {
  if (!rec.tools.length) return { step: 'tools', empty: true, message: EMPTY, can_continue: true, ui: null };
  return {
    step: 'tools',
    ui: {
      behavior: 'MULTI_SELECT',
      title: `Which tools of "${rec.data.name}" should be enabled?`,
      preselect_all: true,
      options: rec.tools.map((t) => {
        const s = toolSummary(t);
        return { value: s.id, label: s.name, description: s.description, risk: s.risk, preselected: s.default };
      }),
    },
  };
}
