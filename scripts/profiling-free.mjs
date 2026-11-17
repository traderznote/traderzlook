// Proves profiling code compiles to zero bytes: the shipped bundle must equal one built from source
// with the profiling code stripped out, and must contain no profiling-only names.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const ENTRY = 'src/index.ts'; // the root entry reaches every __TN_PROFILE__ guard site
const DEFINE = { __DEV__: 'false', __TN_PROFILE__: 'false' };
// No identifier mangling: the mangler would name the stripped control source differently even when
// it is semantically identical. Whitespace and syntax minification (including DCE) still apply.
const SHARED = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
};

// Names used only by profiling code. `sourcesReEmitted`, `displayLists` and `onFrame` are left out
// because always-shipped code uses them too.
const PROFILING_NAMES = [
  'timelineRebuilds',
  'chunkRecomputes',
  'cachedListIdentityViolations',
  'bufferReallocs',
  'inputLagFrames',
  'replayMs',
  'sourcesCached',
  'createFrameCounters',
  'FrameCounters',
  'IFrameCounters',
];

/**
 * Removes profiling code the way esbuild's DCE does with the define false. Handles the three guard
 * forms in use: `if (__TN_PROFILE__ …) { … }`, `if (__TN_PROFILE__ …) stmt;` and
 * `__TN_PROFILE__ ? A : B` (folded to B).
 */
function stripProfiling(src) {
  let out = src;
  out = out.replace(/__TN_PROFILE__\s*\?[^:]+:\s*([A-Za-z0-9_.#]+)/g, '$1');

  let i;
  while ((i = out.indexOf('if (__TN_PROFILE__')) !== -1) {
    let depth = 0;
    let j = i + 3; // at the '(' of `if (`
    for (; j < out.length; j++) {
      const ch = out[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    let k = j + 1;
    while (k < out.length && /\s/.test(out[k])) k++;
    let end;
    if (out[k] === '{') {
      let bdepth = 0;
      for (; k < out.length; k++) {
        const ch = out[k];
        if (ch === '{') bdepth++;
        else if (ch === '}') {
          bdepth--;
          if (bdepth === 0) {
            end = k + 1;
            break;
          }
        }
      }
    } else {
      end = out.indexOf(';', k) + 1;
    }
    out = out.slice(0, i) + out.slice(end);
  }
  return out;
}

const stripPlugin = {
  name: 'strip-profiling',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      return { contents: stripProfiling(src), loader: 'ts' };
    });
  },
};

const shipped = await build({ ...SHARED, entryPoints: [ENTRY], define: DEFINE });
const control = await build({ ...SHARED, entryPoints: [ENTRY], define: DEFINE, plugins: [stripPlugin] });

const shippedBytes = shipped.outputFiles[0].contents;
const controlBytes = control.outputFiles[0].contents;
const shippedText = Buffer.from(shippedBytes).toString('utf8');

let failed = false;

const sameLength = shippedBytes.length === controlBytes.length;
let firstDiff = -1;
if (sameLength) {
  for (let i = 0; i < shippedBytes.length; i++) {
    if (shippedBytes[i] !== controlBytes[i]) {
      firstDiff = i;
      break;
    }
  }
}
const byteIdentical = sameLength && firstDiff === -1;
console.log(`profiling-free: shipped=${shippedBytes.length}B control=${controlBytes.length}B`);
if (byteIdentical) {
  console.log('profiling-free: byte-identical — profiling code DCEs to 0 bytes (§3.3.1). ✓');
} else {
  failed = true;
  console.error(
    sameLength
      ? `profiling-free: FAIL — same length but bytes differ at offset ${firstDiff}.`
      : `profiling-free: FAIL — length differs (${shippedBytes.length} vs ${controlBytes.length}); profiling code did NOT strip.`,
  );
}

const leaked = PROFILING_NAMES.filter((n) => shippedText.includes(n));
if (leaked.length === 0) {
  console.log('profiling-free: shipped bundle contains no profiling identifiers. ✓');
} else {
  failed = true;
  console.error(`profiling-free: FAIL — profiling identifiers leaked into the shipped bundle: ${leaked.join(', ')}`);
}

if (failed) process.exit(1);
console.log('\nprofiling-free: PASS (perf §3.3.1 — profiling symbols are free).');
