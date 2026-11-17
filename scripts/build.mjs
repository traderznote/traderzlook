// Builds the published bundles into dist/ (dev-only code and profiling counters stripped).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const define = { __DEV__: 'false', __TN_PROFILE__: 'false' };
const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define,
  logLevel: 'warning',
};

rmSync('dist', { recursive: true, force: true });

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs' });
await build({ ...shared, entryPoints: ['src/gfx/index.ts'], outfile: 'dist/gfx.mjs' });

await build({ ...shared, entryPoints: ['src/extras/index.ts'], outfile: 'dist/extras.mjs' });

// Plugins are bundled with the engine modules external, so their size caps measure only the
// plugin's own code (its marginal cost over an app that already loads the engine).
const ENGINE_EXTERNAL = ['../../gfx', '../../core', '../../fmt', '../../api', '../shared'];
const pluginShared = { ...shared, external: ENGINE_EXTERNAL };
await build({ ...pluginShared, entryPoints: ['src/extras/markers/series-markers.ts'], outfile: 'dist/extras/series-markers.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/markers/up-down-markers.ts'], outfile: 'dist/extras/up-down-markers.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/watermark/text-watermark.ts'], outfile: 'dist/extras/text-watermark.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/watermark/image-watermark.ts'], outfile: 'dist/extras/image-watermark.mjs' });

await build({ ...pluginShared, entryPoints: ['src/extras/tools/tool-host.ts'], outfile: 'dist/extras/tool-host.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/sync/sync-group.ts'], outfile: 'dist/extras/sync-group.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/indicators/ema.ts'], outfile: 'dist/extras/ema.mjs' });
// Both behaviors share one module; a per-behavior entry lets tree-shaking isolate each one's cost.
const behaviorsDir = 'src/extras/behaviors';
await build({ ...pluginShared, stdin: { contents: "export { priceAxisBehavior } from './price-axis-behavior';", resolveDir: behaviorsDir, sourcefile: 'price-axis-entry.ts', loader: 'ts' }, outfile: 'dist/extras/price-axis.mjs' });
await build({ ...pluginShared, stdin: { contents: "export { yieldCurveBehavior } from './price-axis-behavior';", resolveDir: behaviorsDir, sourcefile: 'yield-curve-entry.ts', loader: 'ts' }, outfile: 'dist/extras/yield-curve.mjs' });

console.log('build: dist/index.mjs (E1), dist/gfx.mjs (E5), dist/extras.mjs + 4 plugin + 5 M13-seam increments');
