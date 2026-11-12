// M0: checks the Immich behaviour the save flow and the inject script depend on.
// Runs against the throwaway instance from e2e/docker-compose.immich.yml.
// Usage: node check.mjs <raw-file> <jpeg-file> <out-dir> [label]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium } from 'playwright-core';

const [rawPath, jpegPath, outDir, label = 'run'] = process.argv.slice(2);
if (!rawPath || !jpegPath || !outDir) {
  console.error('Usage: node check.mjs <raw-file> <jpeg-file> <out-dir> [label]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const ADMIN = { email: 'admin@example.com', password: 'raw-editor-e2e', name: 'E2E Admin' };
const results = [];
const record = (name, ok, details) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (buf) => createHash('sha1').update(buf).digest('base64');

let token;
async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

// Uploads go through curl: Node's fetch on Windows fails on large multipart bodies
// (ENOBUFS / connection resets). The browser editor is not affected.
const tmpDir = join(outDir, 'tmp');
mkdirSync(tmpDir, { recursive: true });
async function upload(bytes, filename, { metadata, sidecar } = {}) {
  const now = new Date().toISOString();
  const file = join(tmpDir, filename);
  writeFileSync(file, bytes);
  const args = ['-s', '-w', '\n%{http_code}', '-X', 'POST', `${BASE}/api/assets`,
    '-H', `Authorization: Bearer ${token}`, '-H', `x-immich-checksum: ${sha1(bytes)}`,
    '-F', `assetData=@${file};filename=${filename}`,
    '--form-string', `fileCreatedAt=${now}`, '--form-string', `fileModifiedAt=${now}`];
  // Immich 3.3.6 validates the sidecar part against body.filename when it is set
  // (asset-media.service.ts canUploadFile), so a sidecar upload must rely on the part names.
  if (!sidecar) args.push('--form-string', `filename=${filename}`);
  if (metadata) args.push('--form-string', `metadata=${JSON.stringify(metadata)}`);
  if (sidecar) {
    const sc = join(tmpDir, `${filename}.xmp`);
    writeFileSync(sc, sidecar);
    args.push('-F', `sidecarData=@${sc};filename=${filename}.xmp`);
  }
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1)), body: JSON.parse(out.slice(0, i) || 'null') };
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/server/ping`);
      if (r.ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error('Immich did not come up within 4 minutes');
}

async function setup() {
  await waitForServer();
  await fetch(`${BASE}/api/auth/admin-sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  }); // 400 once the admin exists; that's fine
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  token = (await login.json()).accessToken;
  await api('POST', '/system-metadata/admin-onboarding', { isOnboarded: true });
  await api('PUT', '/users/me/onboarding', { isOnboarded: true });
  const version = await api('GET', '/server/version');
  record('server version', version.status === 200, version.body);
}

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
 crs:Version="16.0" crs:ProcessVersion="15.4" crs:Exposure2012="+0.50" crs:Contrast2012="+20"/>
</rdf:RDF></x:xmpmeta>`;

async function apiChecks() {
  const runTag = Date.now().toString(36); // unique bytes per run, so reruns don't hit duplicates
  const rawBytes = Buffer.concat([readFileSync(rawPath), Buffer.from(`\n${runTag}`)]);
  const jpeg = readFileSync(jpegPath);
  const variant = (tag) => Buffer.concat([jpeg, Buffer.from(`\n${runTag}-${tag}`)]); // bytes after EOI are ignored by decoders

  // 1. Upload with `metadata` and `sidecarData`
  const raw = await upload(rawBytes, basename(rawPath), {
    metadata: [{ key: 'raw-editor.test', value: { hello: 'world' } }],
    sidecar: XMP,
  });
  record('upload RAW with metadata + sidecar', raw.status === 201, { status: raw.status, body: raw.body });
  if (raw.status !== 201) return {};
  const rawId = raw.body.id;
  const meta = await api('GET', `/assets/${rawId}/metadata`);
  const testItem = Array.isArray(meta.body) ? meta.body.find((m) => m.key === 'raw-editor.test') : undefined;
  record('metadata written at upload is readable', testItem?.value?.hello === 'world', { items: meta.body });

  // 2. Sidecar download via asset-files
  let sidecarText;
  for (let i = 0; i < 15 && !sidecarText; i++) {
    const files = await api('GET', `/asset-files?assetId=${rawId}&type=sidecar`);
    const file = Array.isArray(files.body) ? files.body[0] : undefined;
    if (file) {
      const dl = await fetch(`${BASE}/api/asset-files/${file.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
      sidecarText = await dl.text();
    } else await sleep(2000);
  }
  record('sidecar downloadable and contains crs:', !!sidecarText?.includes('crs:Exposure2012'), {
    length: sidecarText?.length ?? 0,
  });

  // 3. Does Immich's own sidecar write (after a rating change) keep Lightroom's crs: data?
  await api('PUT', `/assets/${rawId}`, { rating: 3 });
  await sleep(6000);
  const files2 = await api('GET', `/asset-files?assetId=${rawId}&type=sidecar`);
  const file2 = Array.isArray(files2.body) ? files2.body[0] : undefined;
  const after = file2
    ? await (await fetch(`${BASE}/api/asset-files/${file2.id}/download`, { headers: { Authorization: `Bearer ${token}` } })).text()
    : '';
  record('crs: survives Immich sidecar write (rating change)', after.includes('crs:Exposure2012'), {
    hasRating: /Rating[^0-9]*3/.test(after),
    length: after.length,
  });

  // 4. Camera RAW+JPEG stack, then a render stacked on top via the current primary
  const cam = await upload(variant('camera'), 'IMG_0001.JPG');
  const s1 = await api('POST', '/stacks', { assetIds: [cam.body.id, rawId] });
  const r1 = await upload(variant('render-1'), 'IMG_0001.edit.jpg', {
    metadata: [{ key: 'raw-editor.render', value: { sourceAssetId: rawId } }],
  });
  const s2 = await api('POST', '/stacks', { assetIds: [r1.body.id, s1.body.primaryAssetId, rawId] });
  const oldStack = await api('GET', `/stacks/${s1.body.id}`);
  record('createStack absorbs camera stack via its primary', s2.body?.primaryAssetId === r1.body.id && s2.body?.assets?.length === 3, {
    primaryIsRender: s2.body?.primaryAssetId === r1.body.id,
    assetCount: s2.body?.assets?.length,
    oldStackStatus: oldStack.status,
    oldStackAssets: oldStack.body?.assets?.length,
  });

  // 5. Re-save: new render on top, old render trashed
  const r2 = await upload(variant('render-2'), 'IMG_0001.edit.jpg', {
    metadata: [{ key: 'raw-editor.render', value: { sourceAssetId: rawId } }],
  });
  const s3 = await api('POST', '/stacks', { assetIds: [r2.body.id, s2.body.primaryAssetId, rawId] });
  const del = await api('DELETE', '/assets', { ids: [r1.body.id] });
  const s3after = await api('GET', `/stacks/${s3.body?.id}`);
  record('re-save: new primary, old render trashed', s3.body?.primaryAssetId === r2.body.id && del.status === 204, {
    deleteStatus: del.status,
    stackAssetsAfterTrash: s3after.body?.assets?.map((a) => a.originalFileName + (a.isTrashed ? ' (trashed)' : '')),
    primaryAfterTrash: s3after.body?.primaryAssetId === r2.body.id ? 'render-2' : s3after.body?.primaryAssetId,
  });

  // 6. Duplicate upload of a trashed asset
  const dup = await upload(variant('render-1'), 'IMG_0001.edit.jpg');
  const r1info = await api('GET', `/assets/${r1.body.id}`);
  const restore = await api('POST', '/trash/restore/assets', { ids: [r1.body.id] });
  const r1restored = await api('GET', `/assets/${r1.body.id}`);
  record('duplicate of trashed asset', dup.status === 200 && dup.body?.status === 'duplicate', {
    status: dup.status,
    body: dup.body,
    sameId: dup.body?.id === r1.body.id,
    isTrashedBeforeRestore: r1info.body?.isTrashed,
    restoreStatus: restore.status,
    isTrashedAfterRestore: r1restored.body?.isTrashed,
  });
  await api('DELETE', '/assets', { ids: [r1.body.id] });

  // 7. Non-primary member of another stack (the trap the stack planner must avoid)
  const x = await upload(variant('x'), 'x.jpg');
  const y = await upload(variant('y'), 'y.jpg');
  const z = await upload(variant('z'), 'z.jpg');
  const sxy = await api('POST', '/stacks', { assetIds: [x.body.id, y.body.id] });
  const szy = await api('POST', '/stacks', { assetIds: [z.body.id, y.body.id] });
  const sxyAfter = await api('GET', `/stacks/${sxy.body?.id}`);
  record('non-primary member moved out of another stack', true, {
    newStackAssets: szy.body?.assets?.length,
    oldStackStatus: sxyAfter.status,
    oldStackAssets: sxyAfter.body?.assets?.length,
  });

  // 8. Metadata value size limit
  const sizes = [16e3, 64e3, 256e3, 1e6, 4e6, 16e6];
  const sizeResults = {};
  for (const n of sizes) {
    const r = await api('PUT', `/assets/${rawId}/metadata`, { items: [{ key: 'raw-editor.size-test', value: { blob: 'x'.repeat(n) } }] });
    sizeResults[`${n / 1e3} KB`] = r.status;
  }
  await api('DELETE', `/assets/${rawId}/metadata/raw-editor.size-test`);
  record('metadata value size limit', sizeResults['64 KB'] === 200, sizeResults);

  // 9. UpdateAssetDto validation
  const rating0 = await api('PUT', `/assets/${r2.body.id}`, { rating: 0 });
  const rating5 = await api('PUT', `/assets/${r2.body.id}`, { rating: 5 });
  const latOnly = await api('PUT', `/assets/${r2.body.id}`, { latitude: 47.37 });
  const latLon = await api('PUT', `/assets/${r2.body.id}`, { latitude: 47.37, longitude: 8.54 });
  record('update validation (rating 0, lat without lon)', rating5.status === 200 && latLon.status === 200, {
    rating0: rating0.status,
    rating5: rating5.status,
    latOnly: latOnly.status,
    latLon: latLon.status,
  });

  return { rawId };
}

async function browserChecks(rawId) {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const login = await context.request.post(`${BASE}/api/auth/login`, { data: { email: ADMIN.email, password: ADMIN.password } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

    await page.goto(`${BASE}/raw-editor/auth-test.html`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 });
    const auth = await page.evaluate(() => window.__result);
    record('same-origin cookie auth from /raw-editor/', login.ok() && auth.usersMeStatus === 200 && auth.crossOriginIsolated, auth);

    const response = await page.goto(`${BASE}/photos/${rawId}`);
    const csp = response?.headers()['content-security-policy'] ?? null;
    await page.waitForSelector('[data-testid="asset-viewer-navbar-actions"]', { timeout: 45000 });
    const injected = await page.evaluate(() => window.__rawEditorInjected === true);
    const button = await page
      .waitForSelector('[data-testid="raw-editor-button"]', { timeout: 15000 })
      .then((el) => el.getAttribute('href'))
      .catch(() => null);
    await page.screenshot({ path: join(outDir, `viewer-${label}.png`) });
    record('inject script runs and adds the button', injected && !!button, {
      csp: csp ? `${csp.slice(0, 120)}…` : null,
      injected,
      buttonHref: button,
      cspErrors: consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)),
    });
  } finally {
    await browser.close();
  }
}

try {
  await setup();
  const { rawId } = await apiChecks();
  if (rawId) await browserChecks(rawId);
} catch (e) {
  record('fatal', false, { error: String(e?.stack ?? e) });
} finally {
  writeFileSync(join(outDir, `immich-checks-${label}.json`), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed -> ${join(outDir, `immich-checks-${label}.json`)}`);
}
