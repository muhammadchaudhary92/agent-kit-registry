// Runs every tests/*.test.mjs with the built-in Node test runner (works on Node 18+, Windows included).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
