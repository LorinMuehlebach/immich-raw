#!/usr/bin/env node
// Builds apps/editor/public/lensfun/lensfun.json (+ LICENSE.md) from the Lensfun database
// XML files at a pinned commit. Plain Node (>= 22), no dependencies.
//
//   node packages/lens/scripts/build-lensfun.mjs            download from GitHub
//   node packages/lens/scripts/build-lensfun.mjs --src DIR  use local copies of data/db/*.xml
//
// The XML semantics mirror libs/lensfun/database.cpp at the same commit: defaults
// (rectilinear, crop 1, aspect 1.5), multi-language <maker>/<model>, the per-lens
// <cropfactor>/<aspect-ratio> as calibration attributes (lfLens::GetCalibrationSetForAttributes
// folds everything into Calibrations[0] with the lens's crop factor), and "first model
// wins" per correction type (lfLens::Interpolate* skip entries of a different model).
// The format is documented in packages/lens/src/lensfun.ts (LensfunJson).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Master is far ahead of the last release (v0.3.95 from 2020): pin a recent commit.
const REPO = 'lensfun/lensfun';
const COMMIT = '52cf1a7b0e82e07e0ecaa3391ee5106a6dd1ee54';
const COMMIT_DATE = '2026-11-04';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../../../apps/editor/public/lensfun');

// ---------------------------------------------------------------------------------------
// Input

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'raw-editor-lensfun-build' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.text();
}

async function loadXmlFiles(srcDir) {
  if (srcDir) {
    const names = (await readdir(srcDir)).filter((f) => f.endsWith('.xml')).sort();
    return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(srcDir, name), 'utf8') })));
  }
  const listing = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/contents/data/db?ref=${COMMIT}`));
  const names = listing.filter((f) => f.type === 'file' && f.name.endsWith('.xml')).map((f) => f.name).sort();
  const files = [];
  for (const name of names) {
    files.push({ name, text: await fetchText(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/data/db/${name}`) });
  }
  return files;
}

// ---------------------------------------------------------------------------------------
// A small XML reader: the database files are regular (elements, attributes, text,
// comments, a DOCTYPE), so a tokenizer is enough.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );

function parseXml(text, file) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const find = (s, from) => {
    const at = text.indexOf(s, from);
    if (at < 0) throw new Error(`${file}: unterminated markup at ${from}`);
    return at;
  };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (chunk.trim()) stack.at(-1).text += decode(chunk);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      i = find('-->', lt) + 3;
    } else if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      i = find('>', lt) + 1;
    } else if (text[lt + 1] === '/') {
      const end = find('>', lt);
      const name = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (top.name !== name) throw new Error(`${file}: </${name}> closes <${top.name}>`);
      i = end + 1;
    } else {
      const end = find('>', lt);
      let body = text.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const name = body.match(/^[^\s]+/)[0];
      const attrs = {};
      for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decode(m[3] ?? m[4]);
      const el = { name, attrs, children: [], text: '' };
      stack.at(-1).children.push(el);
      if (!selfClosing) stack.push(el);
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`${file}: <${stack.at(-1).name}> not closed`);
  return root;
}

// ---------------------------------------------------------------------------------------
// Conversion

const warnings = [];
const num = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};
// Lensfun stores every number in a float: the shortest decimal that reads back as the
// same float keeps exactly what Lensfun computes with.
const round = (v) => {
  const f = Math.fround(v);
  for (let p = 1; p < 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === f) return s;
  }
  return Number(v.toPrecision(9));
};

/** Default string plus translations, as Lensfun's lfMLstr; one string stays a string. */
function mlstr(elements) {
  const def = elements.filter((e) => !e.attrs.lang).at(-1)?.text.trim();
  const all = [def, ...elements.filter((e) => e.attrs.lang).map((e) => e.text.trim())].filter((s) => s);
  const uniq = [...new Set(all)];
  return uniq.length <= 1 ? uniq[0] : uniq;
}

const TYPES = new Set(['rectilinear', 'fisheye', 'panoramic', 'equirectangular', 'orthographic', 'stereographic', 'equisolid', 'fisheye_thoby']);
const DIST_TERMS = { poly3: ['k1'], poly5: ['k1', 'k2'], ptlens: ['a', 'b', 'c'] };

function trimZeros(row, keep) {
  while (row.length > keep && row.at(-1) === 0) row.pop();
  return row;
}

function convertLens(el, file, mountIndex) {
  const kids = (n) => el.children.filter((c) => c.name === n);
  const model = mlstr(kids('model'));
  const maker = mlstr(kids('maker'));
  const mounts = kids('mount').map((m) => m.text.trim()).filter(Boolean);
  const label = `${file}: ${Array.isArray(model) ? model[0] : model}`;
  if (!model || !mounts.length) {
    warnings.push(`${label}: skipped (no model or mount)`);
    return null;
  }
  const lens = { m: maker, n: model, mt: mounts.map(mountIndex) };

  // Lens-level attributes double as the calibration attributes (database.cpp).
  let crop = 1;
  let aspect = 1.5;
  let type = 'rectilinear';
  for (const c of el.children) {
    if (c.name === 'cropfactor') crop = num(c.text);
    else if (c.name === 'aspect-ratio') {
      const t = c.text.trim();
      const colon = t.indexOf(':');
      aspect = colon >= 0 ? num(t) / num(t.slice(colon + 1)) : num(t);
    } else if (c.name === 'type') type = c.text.trim().toLowerCase();
    else if (c.name === 'focal') {
      const a = c.attrs;
      lens.f = a.value !== undefined ? [num(a.value), num(a.value)] : [num(a.min ?? '0'), num(a.max ?? '0')];
    } else if (c.name === 'aperture') {
      const a = c.attrs;
      lens.a = a.value !== undefined ? [num(a.value), num(a.value)] : [num(a.min ?? '0'), num(a.max ?? '0')];
    } else if (c.name === 'center') {
      const x = num(c.attrs.x ?? '0');
      const y = num(c.attrs.y ?? '0');
      if (x || y) lens.ctr = [x, y];
    }
  }
  if (!TYPES.has(type)) {
    warnings.push(`${label}: unknown type ${type}, skipped`);
    return null;
  }
  if (!(crop > 0) || !(aspect >= 1)) {
    warnings.push(`${label}: invalid crop factor or aspect ratio, skipped`);
    return null;
  }
  lens.c = round(crop);
  if (Math.abs(aspect - 1.5) > 1e-6) lens.ar = round(aspect);
  if (type !== 'rectilinear') lens.t = type;

  let dm = null;
  let tm = null;
  let vm = null;
  const d = [];
  const tc = [];
  const v = [];
  for (const cal of kids('calibration')) {
    if (cal.attrs.cropfactor || cal.attrs['aspect-ratio']) {
      // Lensfun at this commit ignores these and uses the lens's own values.
      warnings.push(`${label}: <calibration> attributes ignored like Lensfun does`);
    }
    for (const c of cal.children) {
      const a = c.attrs;
      if (c.name === 'distortion') {
        if (a.model === 'none') continue;
        if (!DIST_TERMS[a.model]) {
          warnings.push(`${label}: distortion model ${a.model} not supported`);
          continue;
        }
        dm ??= a.model;
        if (a.model !== dm) {
          warnings.push(`${label}: second distortion model ignored (Lensfun uses the first)`);
          continue;
        }
        const row = [round(num(a.focal)), ...DIST_TERMS[dm].map((k) => round(num(a[k] ?? '0')))];
        if (a['real-focal'] !== undefined && num(a['real-focal']) > 0) row.push(round(num(a['real-focal'])));
        d.push(row);
      } else if (c.name === 'tca') {
        if (a.model === 'none') continue;
        if (a.model !== 'linear' && a.model !== 'poly3') {
          warnings.push(`${label}: TCA model ${a.model} not supported`);
          continue;
        }
        tm ??= a.model;
        if (a.model !== tm) {
          warnings.push(`${label}: second TCA model ignored (Lensfun uses the first)`);
          continue;
        }
        const row =
          tm === 'linear'
            ? [num(a.focal), num(a.kr ?? '1'), num(a.kb ?? '1')]
            : [num(a.focal), num(a.vr ?? '1'), num(a.vb ?? '1'), num(a.cr ?? '0'), num(a.cb ?? '0'), num(a.br ?? '0'), num(a.bb ?? '0')];
        tc.push(trimZeros(row.map(round), 3));
      } else if (c.name === 'vignetting') {
        if (a.model !== 'pa') {
          warnings.push(`${label}: vignetting model ${a.model} not supported`);
          continue;
        }
        vm ??= a.model;
        v.push([a.focal, a.aperture, a.distance, a.k1, a.k2, a.k3].map((x) => round(num(x ?? '0'))));
      }
    }
  }
  if (d.length) {
    lens.dm = dm;
    lens.d = d;
  }
  if (tc.length) {
    lens.tm = tm;
    lens.tc = tc;
  }
  if (v.length) lens.v = mergeDistances(v);
  return lens;
}

/**
 * Most vignetting calibrations repeat the same terms for distance 10 and 1000. Rows that
 * differ only in distance become one row with a distance list: [f, a, [d1, d2], k1, k2, k3].
 * The reader expands them again, so the interpolation sees every original entry.
 */
function mergeDistances(rows) {
  const out = [];
  const byTerms = new Map();
  for (const [f, a, d, k1, k2, k3] of rows) {
    const key = [f, a, k1, k2, k3].join();
    const hit = byTerms.get(key);
    if (hit) {
      hit[2] = [...[hit[2]].flat(), d];
    } else {
      const row = [f, a, d, k1, k2, k3];
      byTerms.set(key, row);
      out.push(row);
    }
  }
  return out;
}

function convert(files) {
  const mounts = new Map(); // name -> compat[]
  const mountNames = [];
  const mountIndex = (name) => {
    let i = mountNames.indexOf(name);
    if (i < 0) i = mountNames.push(name) - 1;
    return i;
  };
  const cameras = [];
  const lenses = [];
  for (const { name: file, text } of files) {
    const doc = parseXml(text, file);
    const db = doc.children.find((c) => c.name === 'lensdatabase');
    if (!db) {
      warnings.push(`${file}: no <lensdatabase>`);
      continue;
    }
    for (const el of db.children) {
      const kids = (n) => el.children.filter((c) => c.name === n);
      if (el.name === 'mount') {
        const names = mlstr(kids('name'));
        const name = Array.isArray(names) ? names[0] : names;
        if (!name) continue;
        mounts.set(name, [...(mounts.get(name) ?? []), ...kids('compat').map((c) => c.text.trim())]);
      } else if (el.name === 'camera') {
        const maker = mlstr(kids('maker'));
        const model = mlstr(kids('model'));
        const mount = kids('mount')[0]?.text.trim();
        const crop = num(kids('cropfactor')[0]?.text ?? '0');
        if (!maker || !model || !mount || !(crop > 0)) {
          warnings.push(`${file}: camera ${model} skipped (lfCamera::Check)`);
          continue;
        }
        const cam = [maker, model, mountIndex(mount), round(crop)];
        const variant = mlstr(kids('variant'));
        if (variant) cam.push(variant);
        cameras.push(cam);
      } else if (el.name === 'lens') {
        const lens = convertLens(el, file, mountIndex);
        if (lens) lenses.push(lens);
      }
    }
  }
  // Compat lists by mount index; mounts only referenced through compat get an index too.
  const compat = {};
  for (const [name, list] of mounts) {
    const i = mountIndex(name);
    compat[i] = [...new Set(list)].map(mountIndex);
  }
  return { mounts: mountNames, compat, cameras, lenses };
}

// ---------------------------------------------------------------------------------------

const LICENSE = `# Lensfun database

\`lensfun.json\` is generated by \`packages/lens/scripts/build-lensfun.mjs\` from the Lensfun
lens database (\`data/db/*.xml\`) at commit
[\`${COMMIT}\`](https://github.com/${REPO}/tree/${COMMIT}/data/db) (${COMMIT_DATE}).

The Lensfun database is © the Lensfun project and its contributors
(https://lensfun.github.io/) and is licensed under the
[Creative Commons Attribution-ShareAlike 3.0 license](https://creativecommons.org/licenses/by-sa/3.0/)
(CC BY-SA 3.0). The full license text is in Lensfun's repository at
[\`data/COPYING.CC_BY-SA_3.0\`](https://github.com/${REPO}/blob/${COMMIT}/data/COPYING.CC_BY-SA_3.0).

Changes made: the XML files were converted to a compact JSON form (short keys, numbers
rounded to the single-precision accuracy Lensfun itself reads them with, unused fields
dropped). The calibration data itself is unchanged. \`lensfun.json\` is therefore an
adaptation of the database and is distributed under the same CC BY-SA 3.0 license.
`;

async function main() {
  const srcAt = process.argv.indexOf('--src');
  const files = await loadXmlFiles(srcAt > 0 ? process.argv[srcAt + 1] : undefined);
  const db = convert(files);
  const json = {
    format: 1,
    source: { repo: `https://github.com/${REPO}`, commit: COMMIT, date: COMMIT_DATE, license: 'CC-BY-SA-3.0' },
    ...db,
  };
  const text = JSON.stringify(json);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'lensfun.json'), text);
  await writeFile(join(OUT_DIR, 'LICENSE.md'), LICENSE);
  const counted = new Map();
  for (const w of warnings) counted.set(w.replace(/^[^:]+: [^:]+: /, ''), (counted.get(w.replace(/^[^:]+: [^:]+: /, '')) ?? 0) + 1);
  for (const [w, n] of counted) console.warn(`warning (${n}x): ${w}`);
  const calibrated = db.lenses.filter((l) => l.d || l.tc || l.v).length;
  console.log(
    `${files.length} files: ${db.cameras.length} cameras, ${db.lenses.length} lenses (${calibrated} with calibration data), ${db.mounts.length} mounts`,
  );
  console.log(`lensfun.json: ${(text.length / 1024).toFixed(0)} KiB, gzip ${(gzipSync(text, { level: 9 }).length / 1024).toFixed(0)} KiB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
