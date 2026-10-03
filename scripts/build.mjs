/**
 * Production build: esbuild bundles TS -> extension/dist, HTML/CSS/manifest copied.
 * Load extension/dist as the unpacked extension in Chrome.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension', 'src');
const dist = join(root, 'extension', 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Compile-time feature flag: PT_LIVE_BRIDGE=1 enables the ChessTempo live
// bridge (local calibration only). Default OFF: no live adapter runs and all
// bridge UI stays hidden; the CSV-history workflow is unaffected.
const liveBridge = process.env.PT_LIVE_BRIDGE === '1' ? '1' : '';
console.log(`CHESSTEMPO_LIVE_BRIDGE: ${liveBridge === '1' ? 'ENABLED (local dev only)' : 'disabled'}`);

for (const entry of ['ui/popup.ts', 'ui/dataset.ts', 'background/service-worker.ts', 'integrations/chessTempo/content-script.ts', 'trainer/trainer.ts']) {
  buildSync({
    entryPoints: [join(src, entry)],
    bundle: true,
    format: 'esm',
    target: 'chrome114',
    sourcemap: false,
    minify: false,
    define: { PT_LIVE_BRIDGE: JSON.stringify(liveBridge) },
    outdir: dist,
    logLevel: 'info',
  });
}

// esbuild emits dist/ui/popup.js etc. — flatten to dist root for manifest paths.
for (const [from, to] of [
  ['ui/popup.js', 'popup.js'],
  ['trainer/trainer.js', 'trainer.js'],
  ['ui/dataset.js', 'dataset.js'],
  ['background/service-worker.js', 'service-worker.js'],
  ['integrations/chessTempo/content-script.js', 'content-script.js'],
]) {
  const a = join(dist, from);
  const b = join(dist, to);
  if (existsSync(a)) {
    cpSync(a, b);
  }
}
rmSync(join(dist, 'ui'), { recursive: true, force: true });
rmSync(join(dist, 'background'), { recursive: true, force: true });
rmSync(join(dist, 'integrations'), { recursive: true, force: true });
rmSync(join(dist, 'trainer'), { recursive: true, force: true });
for (const file of ['trainer.html', 'trainer.css']) cpSync(join(src, 'trainer', file), join(dist, file));
for (const file of ['pilot-pool.json', 'pilot-source-rows.csv']) cpSync(join(root, 'extension/assets', file), join(dist, file));
cpSync(join(root, 'node_modules/chess.js/LICENSE'), join(dist, 'CHESS_JS_LICENSE.txt'));

for (const f of ['ui/popup.html', 'ui/popup.css', 'ui/dataset.html']) {
  cpSync(join(src, f), join(dist, f.split('/')[1]));
}
// Side panel reuses the popup bundle + markup (same domain logic, no duplication).
cpSync(join(src, 'ui/popup.html'), join(dist, 'sidepanel.html'));
cpSync(join(dist, 'popup.js'), join(dist, 'sidepanel.js'));
{
  const html = readFileSync(join(dist, 'sidepanel.html'), 'utf8').replace('src="popup.js"', 'src="sidepanel.js"');
  writeFileSync(join(dist, 'sidepanel.html'), html);
}

// Manifest: point to flattened files.
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
buildSync({entryPoints:[join(root,'scripts/analyze-dataset.ts')],outfile:join(dist,'analyze-dataset.mjs'),bundle:true,format:'esm',platform:'node',target:'node20',logLevel:'warning'});
console.log('Build complete -> extension/dist');
