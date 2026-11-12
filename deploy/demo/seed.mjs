// The try-it demo's seed (deploy/demo/compose.yml), in the immich-raw-demo-seed image:
//   node seed.mjs samples   admin account, the sample RAWs in an album, the culler's API key
//   node seed.mjs bursts    the culler's demo bursts in an album (profile "culler")
// Safe to run again: files already in Immich are skipped, and a working API key is kept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADMIN, json, report, setUpAdmin, upload, uploadRaws, waitForServer } from '../../e2e/seed.mjs';

const env = process.env;
const SAMPLES = env.DEMO_SAMPLES_DIR ?? '/demo/samples';
const BURSTS = env.DEMO_BURSTS_DIR ?? '/demo/bursts';
const KEY_FILE = env.CULLER_KEY_FILE ?? '/secrets/culler-api-key';
const KEY_NAME = 'immich-raw demo culler';
const PORT = env.DEMO_PORT ?? '8088';
const admin = { email: env.DEMO_EMAIL || ADMIN.email, password: env.DEMO_PASSWORD || ADMIN.password, name: 'Demo' };

const mode = process.argv[2];
if (mode !== 'samples' && mode !== 'bursts') {
  console.error('Usage: node seed.mjs samples|bursts');
  process.exit(1);
}

/** Puts the assets into the album `name`, making it if needed. */
async function album(name, ids, token) {
  if (ids.length === 0) return;
  const albums = (await json('GET', '/albums', undefined, token)).body ?? [];
  const found = albums.find((a) => a.albumName === name);
  const r = found
    ? await json('PUT', `/albums/${found.id}/assets`, { ids }, token)
    : await json('POST', '/albums', { albumName: name, assetIds: ids }, token);
  if (r.status >= 300) throw new Error(`album "${name}": ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`album "${name}": ${ids.length} photos`);
}

/**
 * The culler reads its Immich API key from KEY_FILE. A key that still works is kept; otherwise
 * a new one replaces it. Like e2e/culler-up.mjs, the old keys go only once the new one is saved.
 */
async function cullerKey(token) {
  if (existsSync(KEY_FILE)) {
    const secret = readFileSync(KEY_FILE, 'utf8').trim();
    if (secret && (await json('GET', '/users/me', undefined, { apiKey: secret })).status === 200) {
      console.log('culler API key: kept');
      return;
    }
  }
  const old = ((await json('GET', '/api-keys', undefined, token)).body ?? []).filter((k) => k.name === KEY_NAME);
  // All permissions, as for the test instance (e2e/culler-up.mjs); docs/culler.md lists the ones it needs.
  const key = await json('POST', '/api-keys', { name: KEY_NAME, permissions: ['all'] }, token);
  if (!key.body?.secret) throw new Error(`could not create the culler's API key: ${key.status} ${JSON.stringify(key.body)}`);
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, `${key.body.secret}\n`, { mode: 0o644 });
  for (const k of old) await json('DELETE', `/api-keys/${k.id}`, undefined, token);
  console.log('culler API key: created');
}

await waitForServer();
let token;
try {
  token = await setUpAdmin(admin);
} catch (e) {
  console.error(`${e.message}\nThe account already exists with another password: start with the first DEMO_PASSWORD, or remove the demo with \`down -v\`.`);
  process.exit(1);
}

if (mode === 'samples') {
  await album('immich-raw samples', uploadRaws(SAMPLES, token), token);
  await cullerKey(token);
  console.log(
    [
      '',
      'The demo is ready:',
      `  on this computer:  http://localhost:${PORT}`,
      `  on other devices:  http://<this computer's address>:${PORT}`,
      `  log in as          ${admin.email} / ${admin.password}`,
      'Open a RAW and click the iris button (Edit RAW) in the viewer.',
    ].join('\n'),
  );
} else {
  const list = JSON.parse(readFileSync(join(BURSTS, 'bursts.json'), 'utf8'));
  const ids = list.map((b) => report(upload(join(BURSTS, b.file), b.file, token, b.date), b.file)).filter(Boolean);
  await album('immich-raw bursts', ids, token);
  console.log('\nBursts on 2015-06-01: open one of their RAWs from the album, then Auto-stack… in the filmstrip.');
}
