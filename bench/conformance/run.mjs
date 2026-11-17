// Renders the conformance fixtures in Chromium and diffs them against snapshots/ (the first run
// records baselines). Exits 0 when Playwright or Chromium is unavailable.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const snapDir = join(here, 'snapshots');
const root = resolve(here, '..', '..');

// Anti-aliasing slack: per-channel tolerance and max fraction of differing pixels.
const CHANNEL_TOLERANCE = 8;
const MAX_DIFF_FRACTION = 0.02;

function ciGatedExit(reason) {
  console.log(`conformance: ${reason}`);
  console.log('conformance: Chromium not installed — conformance is CI-gated. Skipped (exit 0).');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    ciGatedExit('playwright not resolvable');
  }
}

let execPath;
try {
  execPath = chromium.executablePath();
} catch {
  ciGatedExit('chromium.executablePath() unavailable');
}
if (!execPath || !existsSync(execPath)) {
  ciGatedExit(`chromium executable not found at ${execPath ?? '(none)'}`);
}

const { build } = await import('esbuild');
const bundle = await build({
  entryPoints: [join(here, 'driver.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  target: 'es2022',
  define: { __DEV__: 'false', __TN_PROFILE__: 'false' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const driverJs = bundle.outputFiles[0].text;

function decodePngFromDataUrl(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Buffer.from(b64, 'base64');
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  ciGatedExit(`chromium.launch failed: ${(err && err.message) || err}`);
}

const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: driverJs });

const names = await page.evaluate(() => window.__tnConformance.fixtureNames());
mkdirSync(snapDir, { recursive: true });

let failed = 0;
let recorded = 0;
let gated = 0;

// Decode PNGs to RGBA in the page so the runner needs no image library.
async function rgbaOf(dataUrl) {
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { width: c.width, height: c.height, data: Array.from(d) };
  }, dataUrl);
}

function diffFraction(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let diff = 0;
  const n = a.data.length;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > CHANNEL_TOLERANCE) diff++;
  }
  return diff / n;
}

for (const name of names) {
  const result = await page.evaluate((n) => window.__tnConformance.render(n), name);
  const png = decodePngFromDataUrl(result.dataUrl);
  const baselinePath = join(snapDir, `${name}.png`);
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, png);
    console.log(`conformance: recorded baseline ${name}.png (${png.length} bytes, ${result.width}x${result.height})`);
    recorded++;
    continue;
  }
  const baselineUrl = `data:image/png;base64,${readFileSync(baselinePath).toString('base64')}`;
  const [a, b] = await Promise.all([rgbaOf(result.dataUrl), rgbaOf(baselineUrl)]);
  const frac = diffFraction(a, b);
  if (frac > MAX_DIFF_FRACTION) {
    console.error(`conformance: FAIL ${name} — diff fraction ${(frac * 100).toFixed(2)}% > ${(MAX_DIFF_FRACTION * 100).toFixed(0)}%`);
    writeFileSync(join(snapDir, `${name}.actual.png`), png);
    failed++;
  } else {
    console.log(`conformance: PASS ${name} — diff ${(frac * 100).toFixed(3)}%`);
    gated++;
  }
}

await browser.close();
console.log(`conformance: ${recorded} recorded, ${gated} gated, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
