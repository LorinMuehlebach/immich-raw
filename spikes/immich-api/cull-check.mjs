// M0 for the culler: checks the Immich behaviour the auto-stacking service depends on.
// Runs against the throwaway instance from e2e/docker-compose.immich.yml and cleans up after itself.
// Usage: node spikes/immich-api/cull-check.mjs <out-dir>
// Needs one seeded photo (e2e/seed.mjs): its preview is reused as the test image.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node spikes/immich-api/cull-check.mjs <out-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 18099);
// How the Immich container reaches this machine (Docker Desktop).
const HOOK_HOST = process.env.HOOK_HOST ?? 'host.docker.internal';
const TAG_ROOT = `CullSpike${Date.now().toString(36)}`;

const results = [];
const record = (name, ok, details) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'INFO'}  ${name}  ${JSON.stringify(details)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** JPEG width/height from the first SOF marker. */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

const tmpDir = join(outDir, 'tmp');
mkdirSync(tmpDir, { recursive: true });
// curl, not fetch: Node's fetch on Windows fails on multipart uploads (see check.mjs).
function upload(bytes, filename, date) {
  const file = join(tmpDir, filename);
  writeFileSync(file, bytes);
  const checksum = createHash('sha1').update(bytes).digest('base64');
  const out = execFileSync(
    'curl',
    ['-s', '-w', '\n%{http_code}', '-X', 'POST', `${BASE}/api/assets`, '-H', `Authorization: Bearer ${token}`,
      '-H', `x-immich-checksum: ${checksum}`, '-F', `assetData=@${file};filename=${filename}`,
      '--form-string', `fileCreatedAt=${date}`, '--form-string', `fileModifiedAt=${date}`, '--form-string', `filename=${filename}`],
    { encoding: 'utf8' },
  );
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1)), body: JSON.parse(out.slice(0, i) || 'null') };
}

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}

// --- webhook receiver -------------------------------------------------------------------------
const hooks = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = body;
    try {
      json = JSON.parse(body);
    } catch {}
    hooks.push({ at: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body: json });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => server.listen(HOOK_PORT, '0.0.0.0', r));

const cleanup = { assets: [], tags: [], workflows: [] };
try {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'raw-editor-e2e' }),
  });
  token = (await login.json()).accessToken;

  // Test image: the preview of any seeded photo. Trailing bytes after the JPEG end marker make
  // each copy a distinct asset (different checksum) with identical pixels.
  const seed = await api('POST', '/search/metadata', { size: 1, filter: { trashedAt: { eq: null }, type: { eq: 'IMAGE' } } });
  const seedAsset = seed.body.assets.items[0];
  if (!seedAsset) throw new Error('No photo in the test Immich: run e2e/seed.mjs first');
  const previewRes = await fetch(`${BASE}/api/assets/${seedAsset.id}/thumbnail?size=preview`, { headers: { Authorization: `Bearer ${token}` } });
  const preview = Buffer.from(await previewRes.arrayBuffer());
  record('preview of a seeded photo', previewRes.ok, {
    file: seedAsset.originalFileName,
    type: previewRes.headers.get('content-type'),
    bytes: preview.length,
    size: jpegSize(preview),
  });
  const fullRes = await fetch(`${BASE}/api/assets/${seedAsset.id}/thumbnail?size=fullsize`, { headers: { Authorization: `Bearer ${token}` } });
  const full = Buffer.from(await fullRes.arrayBuffer());
  record('fullsize thumbnail of a seeded photo', fullRes.ok, {
    status: fullRes.status,
    type: fullRes.headers.get('content-type'),
    bytes: full.length,
    size: fullRes.ok && fullRes.headers.get('content-type')?.includes('jpeg') ? jpegSize(full) : null,
  });

  // --- webhook workflow (set up before the uploads so their events are caught) --------------------
  const wfBody = (trigger) => ({
    trigger,
    name: `cull-check ${trigger}`,
    enabled: true,
    logging: true,
    steps: [
      {
        method: 'immich-plugin-core#webhook',
        config: { url: `http://${HOOK_HOST}:${HOOK_PORT}/hook/${trigger}`, method: 'POST', headerName: 'X-Culler-Secret', headerValue: 'spike-secret' },
      },
    ],
  });
  for (const trigger of ['AssetCreate', 'AssetMetadataExtraction']) {
    const wf = await api('POST', '/workflows', wfBody(trigger));
    record(`create webhook workflow (${trigger})`, wf.status === 201, { status: wf.status, body: wf.status === 201 ? { id: wf.body.id } : wf.body });
    if (wf.body?.id) cleanup.workflows.push(wf.body.id);
  }

  // --- uploads -------------------------------------------------------------------------------------
  const uploadStart = new Date(Date.now() - 5000).toISOString();
  const base = Date.parse('2015-06-01T10:00:00.000Z');
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.concat([preview, randomBytes(16)]);
    const r = upload(bytes, `cullspike_${i}.jpg`, new Date(base + i * 1000).toISOString());
    if (r.body?.id) {
      ids.push(r.body.id);
      cleanup.assets.push(r.body.id);
    }
  }
  record('upload 4 copies', ids.length === 4, { ids });

  const ready = await waitFor(async () => {
    const infos = await Promise.all(ids.map((id) => api('GET', `/assets/${id}`)));
    return infos.every((r) => r.body?.thumbhash) ? infos.map((r) => r.body) : null;
  });
  record('previews generated (thumbhash set)', !!ready, {});
  const info0 = ready?.[0] ?? (await api('GET', `/assets/${ids[0]}`)).body;
  record('asset info fields', true, {
    keys: Object.keys(info0).sort(),
    tags: info0.tags,
    stack: info0.stack,
    rating: info0.exifInfo?.rating,
    dateTimeOriginal: info0.exifInfo?.dateTimeOriginal,
    fileCreatedAt: info0.fileCreatedAt,
  });

  // --- search ------------------------------------------------------------------------------------
  const byUpload = await api('POST', '/search/metadata', { size: 50, filter: { createdAt: { gte: uploadStart }, trashedAt: { eq: null } } });
  const found = byUpload.body?.assets?.items?.map((a) => a.id) ?? [];
  record('filter.createdAt selects by upload time', ids.every((id) => found.includes(id)), { status: byUpload.status, found: found.length });
  const byTaken = await api('POST', '/search/metadata', {
    size: 50,
    withExif: true,
    filter: { takenAt: { gte: '2015-06-01T09:59:00.000Z', lte: '2015-06-01T10:01:00.000Z' } },
  });
  const item = byTaken.body?.assets?.items?.[0];
  record('filter.takenAt + withExif', byTaken.body?.assets?.items?.length === 4, {
    count: byTaken.body?.assets?.items?.length,
    hasExif: !!item?.exifInfo,
    hasStack: item && 'stack' in item,
    hasTags: item && 'tags' in item,
  });

  // --- stacks ------------------------------------------------------------------------------------
  const st = await api('POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] });
  record('createStack', st.status === 201, { status: st.status, primary: st.body?.primaryAssetId === ids[0] });
  const stackId = st.body?.id;
  const inSearch = await api('POST', '/search/metadata', { size: 50, filter: { createdAt: { gte: uploadStart } } });
  record('stacked members still returned by filter search', (inSearch.body?.assets?.items ?? []).length >= 4, {
    count: inSearch.body?.assets?.items?.length,
  });
  const info1 = (await api('GET', `/assets/${ids[1]}`)).body;
  record('member asset info carries stack', !!info1.stack, { stack: info1.stack });
  const nonMember = await api('PUT', `/stacks/${stackId}`, { primaryAssetId: ids[3] });
  record('updateStack to a non-member', true, { status: nonMember.status, body: nonMember.body });
  const upd = await api('PUT', `/stacks/${stackId}`, { primaryAssetId: ids[1] });
  record('updateStack to a member', upd.status === 200, { status: upd.status, primary: upd.body?.primaryAssetId });
  const bySearch = await api('GET', `/stacks?primaryAssetId=${ids[1]}`);
  record('searchStacks by primary', bySearch.status === 200, { status: bySearch.status, count: bySearch.body?.length });
  const rm = await api('DELETE', `/stacks/${stackId}/assets/${ids[2]}`);
  const afterRm = await api('GET', `/stacks/${stackId}`);
  record('removeAssetFromStack (3 → 2)', rm.status === 204, { status: rm.status, remaining: afterRm.body?.assets?.length });
  const rm2 = await api('DELETE', `/stacks/${stackId}/assets/${ids[0]}`);
  const afterRm2 = await api('GET', `/stacks/${stackId}`);
  record('removeAssetFromStack (2 → 1): is the stack deleted?', true, {
    status: rm2.status,
    stackGet: afterRm2.status,
    remaining: afterRm2.body?.assets?.length,
  });
  const rmPrimary = await api('DELETE', `/stacks/${stackId}/assets/${ids[1]}`);
  record('remove the primary from a stack', true, { status: rmPrimary.status, body: rmPrimary.body });
  await api('DELETE', `/stacks/${stackId}`);

  // --- tags --------------------------------------------------------------------------------------
  const up = await api('PUT', '/tags', { tags: [`${TAG_ROOT}/Rejected/Blur`, `${TAG_ROOT}/Best`] });
  record('upsertTags with paths', up.status === 200, { status: up.status, body: up.body?.map?.((t) => ({ id: t.id, name: t.name, value: t.value, parentId: t.parentId })) });
  const all = await api('GET', '/tags');
  const mine = (all.body ?? []).filter((t) => t.value.startsWith(TAG_ROOT));
  cleanup.tags.push(...mine.map((t) => t.id));
  record('parent tags created', mine.some((t) => t.value === `${TAG_ROOT}/Rejected`), { values: mine.map((t) => t.value) });
  const blur = mine.find((t) => t.value === `${TAG_ROOT}/Rejected/Blur`);
  const tagged = await api('PUT', '/tags/assets', { tagIds: [blur.id], assetIds: [ids[2], ids[3]] });
  record('bulkTagAssets', tagged.status === 200, { status: tagged.status, body: tagged.body });
  const tagInfo = (await api('GET', `/assets/${ids[2]}`)).body;
  record('asset info carries tags', (tagInfo.tags ?? []).some((t) => t.id === blur.id), { tags: tagInfo.tags?.map((t) => t.value) });
  const byTag = await api('POST', '/search/metadata', { size: 50, filter: { tagIds: { any: [blur.id] } } });
  record('filter.tagIds', byTag.body?.assets?.items?.length === 2, { count: byTag.body?.assets?.items?.length });
  const untag = await api('DELETE', `/tags/${blur.id}/assets`, { ids: [ids[3]] });
  record('untagAssets', untag.status === 200, { status: untag.status, body: untag.body });

  // --- rating -1 ---------------------------------------------------------------------------------
  const rej = await api('PUT', '/assets', { ids: [ids[2]], rating: -1 });
  const rejInfo = (await api('GET', `/assets/${ids[2]}`)).body;
  record('bulk rating -1', rej.status === 204 && rejInfo.exifInfo?.rating === -1, { status: rej.status, rating: rejInfo.exifInfo?.rating });
  const byRating = await api('POST', '/search/metadata', { size: 50, filter: { rating: { eq: -1 }, createdAt: { gte: uploadStart } } });
  record('filter.rating eq -1', byRating.body?.assets?.items?.length === 1, { count: byRating.body?.assets?.items?.length });
  const clr = await api('PUT', '/assets', { ids: [ids[2]], rating: null });
  const clrInfo = (await api('GET', `/assets/${ids[2]}`)).body;
  record('bulk rating null clears it', clrInfo.exifInfo?.rating == null, { status: clr.status, rating: clrInfo.exifInfo?.rating });

  // --- metadata ----------------------------------------------------------------------------------
  const value = { v: 1, role: 'rejected', reason: 'blur', metrics: { sharpPct: 54 } };
  const meta = await api('PUT', '/assets/metadata', { items: [{ assetId: ids[2], key: 'raw-editor.cull', value }] });
  const metaList = await api('GET', `/assets/${ids[2]}/metadata`);
  record('bulk metadata upsert + list', meta.status === 200 && JSON.stringify(metaList.body).includes('sharpPct'), {
    status: meta.status,
    list: metaList.body,
  });
  const metaDel = await api('DELETE', '/assets/metadata', { items: [{ assetId: ids[2], key: 'raw-editor.cull' }] });
  record('bulk metadata delete', metaDel.status === 204, { status: metaDel.status });

  // --- webhook payload ---------------------------------------------------------------------------
  await waitFor(async () => hooks.length >= ids.length * 2, 30000);
  record('webhook calls received', hooks.length > 0, {
    count: hooks.length,
    byTrigger: hooks.reduce((m, h) => ((m[h.url] = (m[h.url] ?? 0) + 1), m), {}),
  });
  if (hooks[0]) {
    const h = hooks.find((x) => x.url.endsWith('AssetMetadataExtraction')) ?? hooks[0];
    record('webhook request', true, { method: h.method, headers: h.headers, body: h.body });
  }
  for (const id of cleanup.workflows) {
    const logs = await api('GET', `/workflows/${id}/logs?limit=5`);
    record('workflow logs', true, { id, status: logs.status, body: logs.body });
  }
} catch (e) {
  record('error', false, { message: String(e?.stack ?? e) });
} finally {
  for (const id of cleanup.workflows) await api('DELETE', `/workflows/${id}`);
  if (cleanup.assets.length) await api('DELETE', '/assets', { ids: cleanup.assets, force: true });
  for (const id of cleanup.tags) await api('DELETE', `/tags/${id}`);
  server.close();
  writeFileSync(join(outDir, 'cull-check.json'), JSON.stringify({ results, hooks }, null, 2));
  console.log(`\nwrote ${join(outDir, 'cull-check.json')}`);
}
