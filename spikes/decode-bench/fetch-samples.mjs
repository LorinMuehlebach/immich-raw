// Downloads CC0 sample RAW files from raw.pixls.us for the M0 decode benchmark.
// Usage: node fetch-samples.mjs <target-dir>
// Keep the target outside OneDrive / the repo: the files are 50-120 MB each.
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SAMPLES = [
  { file: 'sony-a7rv.ARW', url: 'https://raw.pixls.us/data/Sony/ILCE-7RM5/7RM5-LosslessCompressedLarge.ARW' },
  { file: 'nikon-z7.NEF', url: 'https://raw.pixls.us/data/Nikon/Z%207/3-Nikon-Z7-RAW-14bit-lossless-compressed-L.NEF' },
  { file: 'canon-r5.CR3', url: 'https://raw.pixls.us/data/Canon/EOS%20R5/Canon_EOS_R5_RAW_ISO_100_nocrop_nodual.CR3' },
  { file: 'fuji-xt5.RAF', url: 'https://raw.pixls.us/data/Fujifilm/X-T5/DSCF0021.RAF' },
  { file: 'leica-q2.DNG', url: 'https://raw.pixls.us/data/Leica/Q2/L1000750.DNG' },
];

const target = process.argv[2];
if (!target) {
  console.error('Usage: node fetch-samples.mjs <target-dir>');
  process.exit(1);
}
mkdirSync(target, { recursive: true });

for (const { file, url } of SAMPLES) {
  const dest = join(target, file);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`skip ${file} (exists)`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAIL ${file}: HTTP ${res.status} ${url}`);
    continue;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`ok   ${file} ${(statSync(dest).size / 1e6).toFixed(1)} MB`);
}
