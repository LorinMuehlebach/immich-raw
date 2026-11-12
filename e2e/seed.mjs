// Prepares the throwaway Immich: admin account, onboarding done, sample RAWs uploaded.
// Usage: node e2e/seed.mjs <samples-dir>
// Files already in Immich are reported as duplicates and skipped. The try-it demo's seed
// (deploy/demo/seed.mjs) imports the functions below.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
export const ADMIN = { email: 'admin@example.com', password: 'raw-editor-e2e', name: 'E2E Admin' };

// Immich v3.3.6 RAW extensions (minus psd/ari/cin), same list as packages/inject.
export const RAW_EXT = new Set(
  '.3fr .arw .cap .cr2 .cr3 .crw .dcr .dng .erf .fff .iiq .k25 .kdc .mrw .nef .nrw .orf .ori .pef .raf .raw .rw2 .rwl .sr2 .srf .srw .x3f'.split(' '),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/server/ping`)).ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`Immich at ${BASE} did not answer within 4 minutes`);
}

/** Calls Immich's API with a session token or, as `{ apiKey }`, an API key. */
export async function json(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (typeof token === 'string') headers.Authorization = `Bearer ${token}`;
  else if (token?.apiKey) headers['x-api-key'] = token.apiKey;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/**
 * Uploads one file; `date` (ISO) is the capture time Immich falls back to when the file has
 * none of its own, by default the file's modification time.
 * curl, not fetch: Node's fetch on Windows fails on large multipart uploads (ENOBUFS).
 */
export function upload(path, filename, token, date = statSync(path).mtime.toISOString()) {
  const bytes = readFileSync(path);
  const checksum = createHash('sha1').update(bytes).digest('base64');
  const out = execFileSync(
    'curl',
    [
      '-s', '-w', '\n%{http_code}', '-X', 'POST', `${BASE}/api/assets`,
      '-H', `Authorization: Bearer ${token}`, '-H', `x-immich-checksum: ${checksum}`,
      '-F', `assetData=@${path};filename=${filename}`,
      '--form-string', `fileCreatedAt=${date}`, '--form-string', `fileModifiedAt=${date}`,
      // Only safe without sidecarData: Immich 3.3.6 validates the sidecar part against `filename`.
      '--form-string', `filename=${filename}`,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 20 },
  );
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1)), body: JSON.parse(out.slice(0, i) || 'null') };
}

/** Prints one upload's outcome; returns the asset id, or undefined if it failed. */
export function report(r, file) {
  if (r.status === 201 || r.status === 200) {
    console.log(`${r.body.status.padEnd(9)} ${r.body.id}  ${file}`);
    return r.body.id;
  }
  console.log(`FAILED    ${file}: ${r.status} ${JSON.stringify(r.body)}`);
  return undefined;
}

/** Creates the admin account (once), logs in and skips Immich's onboarding; returns the token. */
export async function setUpAdmin(admin = ADMIN) {
  const signUp = await json('POST', '/auth/admin-sign-up', admin);
  console.log(signUp.status === 201 ? 'created admin account' : 'admin account exists');
  const login = await json('POST', '/auth/login', { email: admin.email, password: admin.password });
  if (login.status !== 201) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = login.body.accessToken;
  await json('POST', '/system-metadata/admin-onboarding', { isOnboarded: true }, token);
  await json('PUT', '/users/me/onboarding', { isOnboarded: true }, token);
  return token;
}

/** Uploads every RAW file in `dir`; returns the asset ids of those that uploaded. */
export function uploadRaws(dir, token) {
  const files = readdirSync(dir)
    .filter((f) => RAW_EXT.has(extname(f).toLowerCase()))
    .sort();
  if (files.length === 0) console.log(`no RAW files in ${dir}`);
  return files.map((file) => report(upload(join(dir, file), file, token), file)).filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const samplesDir = process.argv[2];
  if (!samplesDir) {
    console.error('Usage: node e2e/seed.mjs <samples-dir>');
    process.exit(1);
  }
  await waitForServer();
  const token = await setUpAdmin();
  uploadRaws(samplesDir, token);
  console.log(`\nOpen ${BASE} and log in as ${ADMIN.email} / ${ADMIN.password}`);
}
