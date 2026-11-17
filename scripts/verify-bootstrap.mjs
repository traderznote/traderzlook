// Runs the layer/type check and LOC budgets, then prints the module layer graph.
import { execSync } from 'node:child_process';

/** Allowed cross-module imports (mirrors .dependency-cruiser.cjs). */
const ALLOWED = {
  core: [],
  fmt: ['core'],
  gfx: ['core'],
  data: ['core', 'fmt'],
  model: ['core', 'fmt', 'data'],
  views: ['core', 'fmt', 'data', 'model', 'gfx'],
  'backend-canvas': ['core', 'gfx'],
  host: ['core', 'fmt', 'gfx', 'data', 'model', 'views'],
  api: ['core', 'fmt', 'gfx', 'data', 'model', 'views', 'host', 'backend-canvas'],
  extras: ['api', 'gfx', 'core', 'fmt'],
  'index.ts': ['api', 'extras'],
};

function step(label, cmd) {
  process.stdout.write(`\n=== ${label} ===\n`);
  execSync(cmd, { stdio: 'inherit' });
}

console.log('Traderzlook M0 — repository bootstrap verification');
step('layer + type check (tsc -b + dependency-cruiser)', 'bun run verify');
step('LOC budgets (architecture §11)', 'bun run loc');

console.log('\n=== eleven-module layer graph (architecture §3.1) ===');
for (const [m, deps] of Object.entries(ALLOWED)) {
  console.log(`  ${m.padEnd(16)} -> ${deps.length ? deps.join(', ') : '(imports nothing)'}`);
}
console.log('\nM0 bootstrap verified.');
