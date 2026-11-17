// Converts Adobe camera profiles (.dcp, as Lightroom installs them) into the JSON files the editor
// loads, and keeps an index.json of them. The output stays out of git: the profiles are Adobe's.
//
// Usage (Node 22.18 or newer, which runs the TypeScript sources directly):
//   node packages/pipeline/scripts/convert-camera-profiles.mjs <out-dir> <file.dcp | folder> ...
// e.g. for the editor's own folder and one camera:
//   node packages/pipeline/scripts/convert-camera-profiles.mjs apps/editor/public/camera-profiles \
//     "C:/ProgramData/Adobe/CameraRaw/CameraProfiles/Adobe Standard/Fujifilm X-T30 Adobe Standard.dcp"
// A folder converts every .dcp directly inside it (that is a lot for Adobe's: name your cameras).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { parseDcp, cameraProfileToJson } = await import(pathToFileURL(join(here, '../src/color/camera-profile.ts')).href);

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('Usage: node convert-camera-profiles.mjs <out-dir> <file.dcp | folder> ...');
  process.exit(1);
}

const files = inputs.flatMap((p) => {
  if (!existsSync(p)) {
    console.error(`Not found: ${p}`);
    process.exitCode = 1;
    return [];
  }
  return statSync(p).isDirectory()
    ? readdirSync(p)
        .filter((f) => extname(f).toLowerCase() === '.dcp')
        .map((f) => join(p, f))
    : [p];
});

mkdirSync(out, { recursive: true });
const indexPath = join(out, 'index.json');
let entries = [];
if (existsSync(indexPath)) {
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8')).profiles ?? [];
  } catch {
    entries = [];
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
let converted = 0;
for (const file of files) {
  try {
    const profile = parseDcp(new Uint8Array(readFileSync(file)));
    if (!profile.model) throw new Error('the profile names no camera');
    const name = `${slug(profile.model)}--${slug(profile.name || basename(file, '.dcp'))}.json`;
    writeFileSync(join(out, name), cameraProfileToJson(profile));
    entries = entries.filter((e) => !(e.model === profile.model && e.name === profile.name));
    entries.push({ model: profile.model, name: profile.name, file: name });
    converted++;
    const parts = [profile.hueSat && 'hue/saturation map', profile.hueSat?.second && 'two illuminants', profile.look && 'look table'].filter(Boolean);
    console.log(`${basename(file)} -> ${name} (${parts.join(', ')})`);
  } catch (e) {
    console.error(`${basename(file)}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

entries.sort((a, b) => a.model.localeCompare(b.model) || a.name.localeCompare(b.name));
writeFileSync(indexPath, JSON.stringify({ profiles: entries }, null, 1) + '\n');
console.log(`${converted} converted, ${entries.length} in ${indexPath}`);
