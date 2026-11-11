// Prepares the throwaway Immich: admin account, onboarding done, sample RAWs uploaded.
// Usage: node e2e/seed.mjs <samples-dir>
// Files already in Immich are reported as duplicates and skipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
export const ADMIN = { email: 'admin@example.com', password: 'raw-editor-e2e', name: 'E2E Admin' };

// Immich v3.3.6 RAW extensions (minus psd/ari/cin), same list as packages/inject.
const RAW_EXT = new Set(
  '.3fr .arw .cap .cr2 .cr3 .crw .dcr .dng .erf .fff .iiq .k25 .kdc .mrw .nef .nrw .orf .ori .pef .raf .raw .rw2 .rwl .sr2 .srf .srw .x3f'.split(' '),
);

const samplesDir = process.argv[2];
if (!samplesDir) {
  console.error('Usage: node e2e/seed.mjs <samples-dir>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/server/ping`)).ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`Immich at ${BASE} did not answer within 4 minutes`);
}

async function json(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// curl, not fetch: Node's fetch on Windows fails on large multipart uploads (ENOBUFS).
function upload(path, filename, token) {
  const bytes = readFileSync(path);
  const checksum = createHash('sha1').update(bytes).digest('base64');
  const date = statSync(path).mtime.toISOString();
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

await waitForServer();
const signUp = await json('POST', '/auth/admin-sign-up', ADMIN);
console.log(signUp.status === 201 ? 'created admin account' : 'admin account exists');
const login = await json('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password });
if (login.status !== 201) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
const token = login.body.accessToken;
await json('POST', '/system-metadata/admin-onboarding', { isOnboarded: true }, token);
await json('PUT', '/users/me/onboarding', { isOnboarded: true }, token);

const files = readdirSync(samplesDir).filter((f) => RAW_EXT.has(extname(f).toLowerCase()));
if (files.length === 0) console.log(`no RAW files in ${samplesDir}`);
for (const file of files) {
  const r = upload(join(samplesDir, file), file, token);
  if (r.status === 201 || r.status === 200) console.log(`${r.body.status.padEnd(9)} ${r.body.id}  ${file}`);
  else console.log(`FAILED    ${file}: ${r.status} ${JSON.stringify(r.body)}`);
}

console.log(`\nOpen ${BASE} and log in as ${ADMIN.email} / ${ADMIN.password}`);
