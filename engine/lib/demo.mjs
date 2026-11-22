import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KitError } from './errors.mjs';

/**
 * Demo mode: the real agents/kinds/categories plus the sample items from tests/fixtures, copied into a temp
 * folder, with a throw-away home directory. It lets anyone see the whole wizard (agent, kind, category, item,
 * credentials, tools, plan) before the registry has real items. Nothing real is read or written.
 */
export function prepareDemo(root) {
  const fixtures = path.join(root, 'tests', 'fixtures', 'items');
  if (!fs.existsSync(fixtures)) throw new KitError('demo_unavailable', 'Demo mode needs tests/fixtures/items (it is part of this repository).');
  const base = process.env.KIT_DEMO_DIR || path.join(os.tmpdir(), 'agent-kit-demo');
  const registry = path.join(base, 'registry');
  fs.rmSync(registry, { recursive: true, force: true });
  for (const d of ['agents', 'kinds', 'categories']) fs.cpSync(path.join(root, 'registry', d), path.join(registry, d), { recursive: true });
  fs.cpSync(fixtures, path.join(registry, 'items'), { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { registry, home, stateDir: path.join(base, 'state') };
}
