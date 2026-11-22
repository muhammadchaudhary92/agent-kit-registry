import fs from 'node:fs';
import path from 'node:path';
import { expandPath, commandInfo } from './env.mjs';
import { toArray, listDir, readJson } from './util.mjs';

const envMatch = (vars, pattern) => (pattern.endsWith('*') ? Object.keys(vars).some((k) => k.startsWith(pattern.slice(0, -1))) : !!vars[pattern]);

/** Score every agent adapter by evidence of being installed / currently running. */
export function detectAgents(db, env, opts = {}) {
  const rows = [];
  for (const rec of db.agents.values()) {
    const det = rec.data.detect || {};
    const evidence = [];
    let score = 0;
    if (opts.self && opts.self === rec.id) { score += 1000; evidence.push('reported by the running AI'); }
    for (const p of toArray(det.env)) if (envMatch(env.vars, p)) { score += 80; evidence.push(`env ${p}`); break; }
    for (const c of toArray(det.commands)) if (env.find(c)) { score += 40; evidence.push(`command ${c}`); break; }
    for (const p of toArray(det.paths)) {
      try {
        if (fs.existsSync(expandPath(p, env))) { score += 20; evidence.push(`path ${p}`); break; }
      } catch { /* ignore unreadable path */ }
    }
    rows.push({ id: rec.id, name: rec.data.name, order: rec.data.order ?? 1000, installed: score > 0, score, evidence });
  }
  const ranked = [...rows].sort((a, b) => b.score - a.score || a.order - b.order);
  const [top, second] = ranked;
  const preselect = top && top.score >= 40 && (!second || second.score < top.score) ? top.id : null;
  return { agents: rows.sort((a, b) => a.order - b.order), preselect };
}

/** Guess the target platform(s) of a project folder (used to filter "AI choose" candidates). */
export function detectProject(dir) {
  if (!dir) return null;
  const names = new Set(listDir(dir).map((e) => e.name));
  const has = (n) => names.has(n);
  const platforms = new Set();
  const evidence = [];
  const add = (p, why) => { platforms.add(p); evidence.push(`${p}: ${why}`); };
  if (has('AndroidManifest.xml') || (has('app') && (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')))) add('android', 'Android Gradle project');
  if ([...names].some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace')) || has('Podfile') || has('Package.swift')) add('ios', 'Xcode/Swift project');
  if (has('pubspec.yaml')) { add('android', 'Flutter'); add('ios', 'Flutter'); }
  if (has('package.json')) {
    let pkg = {};
    try { pkg = readJson(path.join(dir, 'package.json')); } catch { /* keep empty */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const dep = (re) => Object.keys(deps).some((k) => re.test(k));
    if (dep(/^react-native$|^expo$/)) { add('android', 'React Native'); add('ios', 'React Native'); }
    else if (dep(/^electron$|^@tauri-apps\//)) add('desktop', 'Electron/Tauri');
    else if (dep(/^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|vite|@angular\/core|astro|solid-js)$/)) add('web', 'web framework in package.json');
    else add('backend', 'Node project');
  }
  if (has('index.html')) add('web', 'index.html');
  for (const f of ['composer.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile']) if (has(f)) add('backend', f);
  return { dir, platforms: [...platforms], evidence };
}

export function toolchain(env) {
  const t = {};
  for (const c of ['node', 'npm', 'npx', 'git', 'uv', 'uvx', 'python3', 'python', 'docker']) t[c] = commandInfo(c, env);
  t.node = { found: true, path: process.execPath, version: process.versions.node };
  return t;
}
