// Timing microbenches (tinybench) over cases.ts, bundled with profiling stripped. Prints a table
// and fails only if a case throws.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bench } from 'tinybench';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const dir = mkdtempSync(join(tmpdir(), 'tnmicro-'));
const out = join(dir, 'cases.mjs');
await build({
  entryPoints: [join(here, 'cases.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __DEV__: 'false', __TN_PROFILE__: 'false' },
  logLevel: 'warning',
});
const { makeCases } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const cases = makeCases();

// Short windows: these only need to surface order-of-magnitude regressions.
const bench = new Bench({ time: 200, warmupTime: 50, warmup: true, throws: true });
for (const c of cases) bench.add(c.name, c.fn);

let failed = 0;
try {
  await bench.run();
} catch (err) {
  console.error(`micro: FAIL  a case threw during run\n    ${err?.message ?? err}`);
  failed++;
}

const rows = bench.tasks.map((t) => ({
  name: t.name,
  'ops/s': t.result ? Math.round(t.result.hz) : 0,
  'mean ms': t.result ? Number(t.result.mean.toFixed(5)) : 0,
  samples: t.result ? (t.result.samples?.length ?? 0) : 0,
}));
console.table(rows);

for (const t of bench.tasks) {
  if (!t.result || t.result.error) {
    console.error(`micro: FAIL  ${t.name}\n    ${t.result?.error?.message ?? 'no result'}`);
    failed++;
  }
}
if (failed > 0) {
  console.error(`\nmicro: ${bench.tasks.length - failed}/${bench.tasks.length} cases ran clean.`);
  process.exit(1);
}
console.log(`\nmicro: all ${bench.tasks.length} timing cases ran clean (soft drift gates, §9.4).`);
process.exit(0);
