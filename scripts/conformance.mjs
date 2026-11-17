// Runs the backend conformance suite (bench/conformance/run.mjs); it exits 0 without Chromium.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, 'bench', 'conformance', 'run.mjs');
const r = spawnSync(process.execPath, [runner], { stdio: 'inherit' });
process.exit(r.status ?? 0);
