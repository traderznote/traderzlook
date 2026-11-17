// Runs the headless bench gates in sequence. Run from the repo root.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gates = [
  ['structural', join('bench', 'structural.mjs')],
  ['scenarios-structural', join('bench', 'scenarios', 'structural.mjs')],
  // Checks how the frame-time scenarios are authored; their timings run only in the browser runner.
  ['scenarios-frametime', join('bench', 'scenarios', 'frametime-smoke.mjs')],
  // Needs --expose-gc for gc() between heap probes.
  ['scenarios-mem', join('bench', 'scenarios', 'node-mem.mjs'), ['--expose-gc']],
  ['goldens', join('bench', 'micro', 'goldens.mjs')],
  // Self-skips with exit 0 when Chromium is not installed.
  ['frametime-playwright', join('bench', 'run.mjs')],
];

let failed = 0;
for (const [name, script, nodeArgs = []] of gates) {
  console.log(`\nbench: === ${name} (${script}) ===`);
  const r = spawnSync(process.execPath, [...nodeArgs, script], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`bench: ${name} FAILED (exit ${r.status}).`);
    failed++;
  }
}

console.log(`\nbench: ${gates.length - failed}/${gates.length} node gate group(s) passed.`);
process.exit(failed > 0 ? 1 : 0);
