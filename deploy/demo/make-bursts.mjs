// Makes the culler's demo bursts from the sample RAWs, the same way e2e/cull.mjs makes its test
// bursts from Immich's previews: 5 DNGs, 3 RAW + JPEG pairs and 4 JPEGs, on 2015-06-01.
// Build time only (deploy/demo/Dockerfile); needs uv (Python with rawpy and OpenCV).
// Usage: node deploy/demo/make-bursts.mjs <samples-dir> <out-dir>
//   <out-dir> gets the files and bursts.json: [{ file, date }] in upload order.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDng } from '../../e2e/raw-burst.mjs';

const [samples, out] = process.argv.slice(2);
if (!samples || !out) {
  console.error('Usage: node deploy/demo/make-bursts.mjs <samples-dir> <out-dir>');
  process.exit(1);
}

// Scenes a–d come from these samples, in the order e2e/cull.mjs uses.
const SOURCES = ['sony-a7rv.ARW', 'fuji-xt5.RAF', 'nikon-z7.NEF', 'leica-q2.DNG'];
const T0 = Date.parse('2015-06-01T10:00:00.000Z'); // as in e2e/cull.mjs
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const python = (script, ...args) =>
  execFileSync(
    'uv',
    ['run', '--quiet', '--no-project', '--python', '3.12', '--with', 'rawpy', '--with', 'numpy', '--with', 'opencv-python-headless', 'python', script, ...args],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

const work = mkdtempSync(join(tmpdir(), 'bursts-'));
const src = join(work, 'src');
const burst = join(work, 'burst');
python(here('./previews.py'), src, ...SOURCES.map((f) => join(samples, f)));
python(here('../../services/culler/scripts/make_burst.py'), burst, ...SOURCES.map((_, i) => join(src, `${i}.jpg`)), '--linear16');

mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(burst, 'manifest.json'), 'utf8'));
const list = [];
const add = (from, file, date) => {
  copyFileSync(from, join(out, file));
  list.push({ file, date });
};
for (const [i, m] of manifest.entries()) {
  const taken = T0 + m.seconds * 1000;
  const date = new Date(taken).toISOString();
  // Scene a: RAWs only; b: RAW + camera JPEG pairs; c and d: JPEGs only.
  if (m.scene === 'a' || m.scene === 'b') add(await writeDng(burst, m, taken, i + 1), `${m.name}.dng`, date);
  if (m.scene !== 'a') add(join(burst, m.file), m.file, date);
}
writeFileSync(join(out, 'bursts.json'), `${JSON.stringify(list, null, 2)}\n`);
console.log(`wrote ${list.length} burst files to ${out}`);
