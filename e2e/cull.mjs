// End-to-end test of the culler (services/culler) against the test Immich, on RAW files.
// Needs: the test Immich running and seeded (e2e/seed.mjs), the editor built (npm run build),
// Docker, and uv (to make the test bursts). Starts the culler itself (e2e/culler-up.mjs) and
// removes everything it uploaded at the end. Usage: node e2e/cull.mjs <out-dir>
//
// Test photos, made from the seeded photos' previews (services/culler/scripts/make_burst.py):
//   A  RAW-only burst (DNG): normal, 1.5 stops darker, blurred, shifted, 1.7 stops brighter
//   B  camera RAW + JPEG pairs (same name and time): normal, blurred, shifted
//   C  one JPEG on its own
//   D  JPEG-only burst: normal, blurred, shifted
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ADMIN, COMPOSE, cullerUp } from './culler-up.mjs';
import { writeDng } from './raw-burst.mjs';

const [outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/cull.mjs <out-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const CULLER = `${BASE}/immich-raw/culler/api/v1`;
const OTHER = { email: 'culler-other@example.com', password: 'culler-other-e2e', name: 'Other' };
const DAY = '2015-06-01';
const T0 = Date.parse(`${DAY}T10:00:00.000Z`);

const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok: !!ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { method = 'GET', token, cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = `immich_access_token=${cookie}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const login = async (who) => (await request(`${BASE}/api/auth/login`, { method: 'POST', body: who })).body?.accessToken;
let token;
const api = (method, path, body) => request(`${BASE}/api${path}`, { method, token, body });
const culler = (method, path, body, as = token) =>
  request(`${CULLER}${path}`, { method, cookie: as, body, headers: method === 'GET' ? {} : { 'X-Raw-Editor': '1' } });

async function waitRun(runId) {
  for (let i = 0; i < 600; i++) {
    const r = await culler('GET', `/runs/${runId}`);
    if (r.body?.status === 'done' || r.body?.status === 'failed') return r.body;
    await sleep(500);
  }
  throw new Error(`run ${runId} did not finish`);
}

async function startRun(body) {
  const r = await culler('POST', '/runs', body);
  if (r.status !== 202) throw new Error(`run not accepted: ${r.status} ${JSON.stringify(r.body)}`);
  if (!body.dryRun) cleanup.runs.push(r.body.runId);
  return waitRun(r.body.runId);
}

// curl, not fetch: Node's fetch on Windows fails on multipart uploads (see e2e/seed.mjs).
function upload(path, filename, date) {
  const checksum = createHash('sha1').update(readFileSync(path)).digest('base64');
  const out = execFileSync(
    'curl',
    ['-s', '-w', '\n%{http_code}', '-X', 'POST', `${BASE}/api/assets`, '-H', `Authorization: Bearer ${token}`,
      '-H', `x-immich-checksum: ${checksum}`, '-F', `assetData=@${path};filename=${filename}`,
      '--form-string', `fileCreatedAt=${date}`, '--form-string', `fileModifiedAt=${date}`, '--form-string', `filename=${filename}`],
    { encoding: 'utf8' },
  );
  const i = out.lastIndexOf('\n');
  return JSON.parse(out.slice(0, i) || 'null');
}

const info = async (id) => (await api('GET', `/assets/${id}`)).body;
const cullTags = (asset) => (asset.tags ?? []).map((t) => t.value).filter((v) => v.startsWith('Culling/')).sort();

const cleanup = { assets: [], album: null, user: null, runs: [] };
let page;
let browser;
try {
  token = await login(ADMIN);
  check('login', !!token);
  const health = await cullerUp({ quiet: true });
  check('culler is up behind the proxy', health?.ok, health);

  // --- test photos ------------------------------------------------------------------------------
  const old = await api('POST', '/search/metadata', { originalFileName: 'burst_', size: 100, withDeleted: true });
  const leftovers = (old.body?.assets?.items ?? []).map((a) => a.id);
  if (leftovers.length) await api('DELETE', '/assets', { ids: leftovers, force: true });

  // Search each seeded photo by name: the library may hold more photos than one page of results.
  const pick = async (part) => {
    const found = (await api('POST', '/search/metadata', { originalFileName: part, size: 50 })).body?.assets?.items ?? [];
    return found.find((a) => a.originalFileName.toLowerCase().includes(part) && !a.originalFileName.includes('.edit.'));
  };
  const sources = await Promise.all(['sony', 'fuji', 'nikon', 'leica'].map(pick));
  if (sources.some((s) => !s)) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');
  const srcDir = join(outDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  const srcFiles = [];
  for (const s of sources) {
    const res = await fetch(`${BASE}/api/assets/${s.id}/thumbnail?size=preview`, { headers: { Authorization: `Bearer ${token}` } });
    const file = join(srcDir, `${s.originalFileName}.jpg`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    srcFiles.push(file);
  }
  const burstDir = join(outDir, 'burst');
  execFileSync('uv', ['run', '--quiet', '--project', 'services/culler', 'python', 'services/culler/scripts/make_burst.py', burstDir, ...srcFiles, '--linear16'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const manifest = JSON.parse(readFileSync(join(burstDir, 'manifest.json'), 'utf8'));
  const id = {}; // 'a0' -> asset id (the RAW where there is one); 'b0j' -> the camera JPEG of pair b0
  const nameOf = {};
  const add = (key, asset) => {
    id[key] = asset.id;
    nameOf[asset.id] = key;
    cleanup.assets.push(asset.id);
  };
  for (const [i, m] of manifest.entries()) {
    const taken = T0 + m.seconds * 1000;
    const date = new Date(taken).toISOString();
    const key = m.name.slice(6);
    if (m.scene === 'a' || m.scene === 'b') {
      add(key, upload(await writeDng(burstDir, m, taken, i + 1), `${m.name}.dng`, date));
      if (m.scene === 'b') add(`${key}j`, upload(join(burstDir, m.file), m.file, date));
    } else {
      add(key, upload(join(burstDir, m.file), m.file, date));
    }
  }
  check('upload 5 DNGs, 3 RAW+JPEG pairs and 4 JPEGs', Object.keys(id).length === 15, id);
  for (let i = 0; i < 180; i++) {
    const all = await Promise.all(Object.values(id).map(info));
    if (all.every((a) => a.thumbhash)) break;
    await sleep(1000);
  }

  // --- dry run ------------------------------------------------------------------------------------
  const scope = { kind: 'day', date: DAY };
  const dry = await startRun({ scope, dryRun: true });
  const report = (await culler('GET', `/runs/${dry.id}`)).body.report;
  const groups = report.groups.map((g) => g.frames.map((f) => nameOf[f.frameId]).sort()).sort();
  const expected = [['a0', 'a1', 'a2', 'a3', 'a4'], ['b0', 'b1', 'b2'], ['d0', 'd1', 'd2']];
  check('dry run finds the three bursts', JSON.stringify(groups) === JSON.stringify(expected), { groups });
  const role = Object.fromEntries(report.groups.flatMap((g) => g.frames.map((f) => [nameOf[f.frameId], f])));
  check('RAW frames are measured on the RAW file', ['a0', 'a1', 'a4', 'b0'].every((n) => role[n]?.exposureFrom === 'raw'), {
    a1: role.a1?.exposureFrom,
  });
  check('RAW too dark and too bright: rejected for lighting', role.a1?.reason === 'lighting' && role.a4?.reason === 'lighting', {
    a1: role.a1?.metrics,
    a4: role.a4?.metrics,
  });
  check('blurred RAW and JPEG frames: rejected for sharpness', ['a2', 'b1', 'd1'].every((n) => role[n]?.reason === 'blur'), {
    sharpPct: ['a2', 'b1', 'd1'].map((n) => role[n]?.metrics?.sharpPct),
  });
  const best = (scene) => [`${scene}0`, `${scene}${scene === 'a' ? 3 : 2}`].find((n) => role[n]?.role === 'best');
  const bestA = best('a');
  const bestB = best('b');
  check('the best of each burst is sharp and well exposed', bestA && bestB && best('d'), { bestA, bestB, bestD: best('d') });
  check('a RAW + JPEG pair is one capture, with the JPEG in front', role[bestB]?.assetIds?.length === 2 && role[bestB]?.faceId === id[`${bestB}j`]);
  check('the single photo is left alone', !role.c0);
  check('a dry run changes nothing', !(await info(id.a0)).stack);

  // --- apply --------------------------------------------------------------------------------------
  const applyId = (await culler('POST', `/runs/${dry.id}/apply`)).body.runId;
  cleanup.runs.push(applyId);
  const applied = await waitRun(applyId);
  check('apply', applied.status === 'done' && !applied.summary?.errors, applied.summary);
  const stackOf = async (key) => {
    const a = await info(id[key]);
    return a.stack ? (await api('GET', `/stacks/${a.stack.id}`)).body : null;
  };
  const stackA = await stackOf('a0');
  check('RAW burst: one stack, the best RAW in front', stackA?.primaryAssetId === id[bestA] && stackA.assets.length === 5, {
    primary: nameOf[stackA?.primaryAssetId],
  });
  const stackB = await stackOf('b0');
  check('pairs: one stack of 6 files, the best JPEG in front', stackB?.primaryAssetId === id[`${bestB}j`] && stackB.assets.length === 6, {
    primary: nameOf[stackB?.primaryAssetId],
    files: stackB?.assets?.length,
  });
  const tagsOf = Object.fromEntries(await Promise.all(Object.entries(id).map(async ([n, i]) => [n, cullTags(await info(i))])));
  check(
    'reason tags',
    tagsOf.a1.join() === 'Culling/Rejected/Lighting' &&
      tagsOf.a2.join() === 'Culling/Rejected/Blur' &&
      tagsOf[bestA].join() === 'Culling/Best' &&
      tagsOf.b1.join() === 'Culling/Rejected/Blur' &&
      tagsOf.b1j.join() === 'Culling/Rejected/Blur' &&
      tagsOf.c0.length === 0,
    tagsOf,
  );
  const ratings = Object.fromEntries(await Promise.all(Object.entries(id).map(async ([n, i]) => [n, (await info(i)).exifInfo?.rating ?? null])));
  // Immich 3.4.0 accepts rating -1 but empties it again when it re-reads the photo's metadata
  // (it only accepts 1-5 there), so a missing -1 is reported, not failed.
  const kept = Object.keys(id).filter((n) => !['a1', 'a2', 'a4', 'b1', 'b1j', 'd1'].includes(n));
  check('reject flag never on kept photos', kept.every((n) => ratings[n] === null), ratings);
  const flagged = ['a1', 'a2', 'a4', 'b1', 'd1'].filter((n) => ratings[n] === -1);
  console.log(`INFO  reject flag still set on ${flagged.length} of 5 rejected photos (Immich 3.4.0 empties -1 after its metadata refresh)`);
  const meta = (await api('GET', `/assets/${id.a2}/metadata`)).body?.find((m) => m.key === 'raw-editor.cull')?.value;
  check('details stored on the photo', meta?.reason === 'blur' && meta?.groupSize === 5, meta);

  const again = await startRun({ scope, dryRun: false });
  check('a second run changes nothing', again.summary?.changes === 0, again.summary);

  // --- the user's own choice wins -------------------------------------------------------------------
  const other = bestA === 'a0' ? 'a3' : 'a0';
  await api('PUT', `/stacks/${stackA.id}`, { primaryAssetId: id[other] });
  const afterPick = await startRun({ scope, dryRun: false });
  check('a front photo picked in Immich stays in front', (await info(id.a0)).stack?.primaryAssetId === id[other], { run: afterPick.summary });
  const pickTags = { [other]: cullTags(await info(id[other])), [bestA]: cullTags(await info(id[bestA])) };
  check('and gets the Best tag', pickTags[other].join() === 'Culling/Best' && pickTags[bestA].join() === 'Culling/Runner-up', {
    ...pickTags,
    changes: afterPick.report?.changes,
    errors: afterPick.report?.errors,
  });
  const lookup = (await culler('POST', '/assets/lookup', { ids: Object.values(id) })).body?.items ?? {};
  check('lookup for the filmstrip', lookup[id[other]]?.pinned === true && lookup[id.a2]?.reason === 'blur' && !lookup[id.c0]);

  // --- who may use it -------------------------------------------------------------------------------
  check('no login: 401', (await request(`${CULLER}/runs`)).status === 401);
  const created = await request(`${BASE}/api/admin/users`, { method: 'POST', token, body: OTHER });
  cleanup.user = created.body?.id ?? (await api('GET', '/admin/users')).body?.find((u) => u.email === OTHER.email)?.id;
  const otherToken = await login(OTHER);
  check("another user's login: 403", (await culler('GET', '/runs', undefined, otherToken)).status === 403);
  check('changes need the editor header', (await request(`${CULLER}/runs`, { method: 'POST', cookie: token, body: { scope, dryRun: true } })).status === 403);

  // --- the filmstrip --------------------------------------------------------------------------------
  // The editor opens the user's pick of the DNG burst, in an album with both culled RAW stacks.
  const album = await api('POST', '/albums', { albumName: 'culler-e2e', assetIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'b0', 'b1', 'b2'].map((k) => id[k]) });
  cleanup.album = album.body?.id;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: !process.env.HEADED });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.request.post(`${BASE}/api/auth/login`, { data: ADMIN });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/immich-raw/?asset=${id[other]}&ctx=album:${cleanup.album}`);
  await page.locator('.filmstrip .slot').first().waitFor({ timeout: 120000 });
  await page.locator('.filmstrip .badge').first().waitFor({ timeout: 30000 });
  const badges = await page.locator('.filmstrip .badge').count();
  const grouped = await page.locator('.filmstrip .slot.grouped').count();
  check('filmstrip shows both RAW stacks with badges', badges === 8 && grouped === 8, { badges, grouped });
  await page.locator('.title .cull').waitFor({ timeout: 30000 }).catch(() => {});
  const verdict = (await page.locator('.title .cull').textContent().catch(() => null))?.trim();
  check('the open DNG shows its verdict in the title', /best of 5 \(your pick\)/.test(verdict ?? ''), { verdict });
  await page.screenshot({ path: join(outDir, 'filmstrip.png') });
  await page.locator('.filmstrip .gcount').first().click();
  const firstWindow = page.locator('.window[role="dialog"]');
  await firstWindow.locator('.pos').waitFor({ timeout: 60000 });
  const firstTitle = (await firstWindow.locator('h2').textContent())?.trim();
  check("a stack's number opens the stack window", /^Stack · [35] shots$/.test(firstTitle ?? ''), { title: firstTitle });  await page.keyboard.press('Escape');
  await firstWindow.waitFor({ state: 'detached', timeout: 5000 });
  await page.getByRole('button', { name: 'Auto-stack…' }).click();
  await page.locator('.panel[role="dialog"]').waitFor();
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.locator('.panel[role="dialog"] p', { hasText: 'from' }).or(page.locator('.panel[role="dialog"] .err')).first().waitFor({ timeout: 120000 });
  await page.screenshot({ path: join(outDir, 'auto-stack-panel.png') });
  const panelText = await page.locator('.panel[role="dialog"]').textContent();
  check('Auto-stack panel previews the album', /2 stacks from \d+ photos/.test(panelText ?? '') && !(await page.locator('.panel[role="dialog"] .err').count()), {
    panel: panelText?.replace(/\s+/g, ' ').slice(0, 300),
  });
  check('no page errors', errors.length === 0, { errors });

  // --- undo, newest first ------------------------------------------------------------------------------
  const blocked = await culler('POST', `/runs/${applied.id}/undo`);
  const blockedRun = blocked.body?.runId ? await waitRun(blocked.body.runId) : null;
  check('an older run cannot be undone before a newer one', blockedRun?.status === 'failed', { error: blockedRun?.error });
  for (const run of [afterPick, applied]) {
    const u = await waitRun((await culler('POST', `/runs/${run.id}/undo`)).body?.runId);
    check(`undo the ${run === applied ? 'first' : 'second'} run`, u.status === 'done' && !u.summary?.errors, u.summary);
  }
  const back = await Promise.all(Object.values(id).map(info));
  check(
    'undo puts everything back',
    back.every((a) => !a.stack && cullTags(a).length === 0 && (a.exifInfo?.rating ?? null) === null),
    back.map((a) => ({ n: nameOf[a.id], stack: !!a.stack, tags: cullTags(a), rating: a.exifInfo?.rating })),
  );

  // --- the stack window -----------------------------------------------------------------------------------
  const reapplied = await startRun({ scope, dryRun: false });
  check('apply again for the stack window', reapplied.status === 'done' && !reapplied.summary?.errors, reapplied.summary);
  const burst = await stackOf('a0');
  const front = nameOf[burst?.primaryAssetId];
  const keepKey = ['a0', 'a3'].find((k) => k !== front);
  const shotsA = ['a0', 'a1', 'a2', 'a3', 'a4'];
  await page.goto(`${BASE}/immich-raw/?asset=${id[front]}&ctx=album:${cleanup.album}&return=${encodeURIComponent(`/photos/${id[front]}`)}`);
  await page.locator('.title button.cull').click({ timeout: 120000 });
  const win = page.locator('.window[role="dialog"]');
  await win.locator('.pos').waitFor({ timeout: 60000 });
  const pos = async (want) => {
    if (want) await win.locator('.pos', { hasText: want }).waitFor({ timeout: 5000 }).catch(() => {});
    return (await win.locator('.pos').textContent())?.trim();
  };
  const editorAt = page.url();
  check('the title line opens the stack window on the open photo', (await pos('1 of 5')) === '1 of 5' && /5 shots/.test((await win.locator('h2').textContent()) ?? ''), {
    front,
    pos: await pos(),
  });
  await page.keyboard.press('ArrowRight');
  check('→ shows the next shot and the editor stays', (await pos('2 of 5')) === '2 of 5' && page.url() === editorAt, { pos: await pos() });
  await page.keyboard.press('End');
  const lastRows = (await win.locator('dl').textContent())?.replace(/\s+/g, ' ');
  check('the last shot is a rejected one, its deciding measurement marked', (await pos('5 of 5')) === '5 of 5' && (await win.locator('dd.bad').count()) >= 2, { lastRows });

  await win.locator(`.thumb[title^="burst_${keepKey}.dng"]`).click();
  await win.getByRole('button', { name: '★ Make preferred' }).click();
  await win.getByRole('button', { name: '★ Preferred' }).waitFor({ timeout: 120000 });
  const picked = (await info(id.a0)).stack?.primaryAssetId;
  check('Make preferred puts the shot in front of the stack', picked === id[keepKey], { keepKey, front: nameOf[picked] });
  await page.screenshot({ path: join(outDir, 'stack-window.png') });

  await win.getByRole('button', { name: 'Delete others…' }).click();
  const confirm = win.locator('.confirm');
  await confirm.waitFor();
  const confirmText = (await confirm.textContent())?.replace(/\s+/g, ' ');
  check(
    'Delete others asks first and names the kept shot',
    !!confirmText?.includes(`Keep burst_${keepKey}.dng`) && confirmText.includes('other 4 shots (4 files') && confirmText.includes('open in the editor is one of them'),
    { confirmText },
  );
  await page.screenshot({ path: join(outDir, 'stack-delete.png') });
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await page.waitForURL((u) => u.searchParams.get('asset') === id[keepKey], { timeout: 180000 });
  check('the editor moves on to the kept shot', true);
  const recull = ((await culler('GET', '/runs?limit=10')).body?.runs ?? []).find((r) => r.origin === 'recull');
  if (recull) cleanup.runs.push(recull.id);
  const afterDelete = Object.fromEntries(await Promise.all(shotsA.map(async (k) => [k, await info(id[k])])));
  check(
    'the other shots are in the trash',
    shotsA.every((k) => afterDelete[k].isTrashed === (k !== keepKey)),
    Object.fromEntries(shotsA.map((k) => [k, afterDelete[k].isTrashed])),
  );
  check('the kept shot leaves the burst stack and its culling tags', !afterDelete[keepKey].stack && cullTags(afterDelete[keepKey]).length === 0, {
    stack: afterDelete[keepKey].stack,
    tags: cullTags(afterDelete[keepKey]),
    recull: recull?.status,
  });

  // From Immich's own viewer: the RAW + JPEG burst (b) is still stacked.
  await page.goto(`${BASE}/photos/${id.b0}`);
  const stackButton = page.locator('[data-raw-editor-stack]');
  await stackButton.waitFor({ timeout: 45000 });
  await page.waitForTimeout(800);
  if (await page.locator('[data-dialog-overlay][data-state="open"]').count()) await page.keyboard.press('Escape');
  check("Immich's viewer shows Compare stack on a culled burst", true);
  await page.screenshot({ path: join(outDir, 'immich-stack-button.png') });
  await stackButton.click();
  await page.waitForURL(/\/immich-raw\/\?stack=/, { timeout: 15000 });
  const pageWindow = page.locator('.window[role="dialog"]');
  await pageWindow.locator('.pos').waitFor({ timeout: 60000 });
  const pageTitle = (await pageWindow.locator('h2').textContent())?.trim();
  const pageFiles = (await pageWindow.locator('.files').textContent())?.trim();
  check('it opens the stack page, a shot with its RAW and JPEG', pageTitle === 'Stack · 3 shots' && /\.dng/i.test(pageFiles ?? '') && /\.jpg/i.test(pageFiles ?? ''), { pageTitle, pageFiles });
  await page.screenshot({ path: join(outDir, 'stack-page.png') });
  await page.keyboard.press('Escape');
  await page.waitForURL((u) => u.pathname === `/photos/${id.b0}`, { timeout: 15000 });
  check('Esc goes back to the same Immich page', true);
  await page.goto(`${BASE}/photos/${id.c0}`);
  await page.locator('[data-testid="asset-viewer-navbar-actions"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(3000);
  check('no Compare stack button on a photo outside a stack', (await page.locator('[data-raw-editor-stack]').count()) === 0);
  check('no page errors in the stack window', errors.length === 0, { errors });
} catch (e) {
  check('error', false, { message: String(e?.stack ?? e) });
  await page?.screenshot({ path: join(outDir, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  // Undo whatever is still applied, newest first.
  for (const runId of [...cleanup.runs].reverse()) {
    const run = (await culler('GET', `/runs/${runId}`)).body;
    if (run?.status !== 'done' || run.undoneAt || !run.summary?.changes) continue;
    const undo = await culler('POST', `/runs/${runId}/undo`);
    if (undo.body?.runId) await waitRun(undo.body.runId).catch(() => {});
  }
  if (cleanup.assets.length) await api('DELETE', '/assets', { ids: cleanup.assets, force: true });
  if (cleanup.album) await api('DELETE', `/albums/${cleanup.album}`);
  if (cleanup.user) await api('DELETE', `/admin/users/${cleanup.user}`, { force: true });
  const tags = (await api('GET', '/tags')).body ?? [];
  for (const t of tags.filter((t) => t.value === 'Culling')) await api('DELETE', `/tags/${t.id}`);
  writeFileSync(join(outDir, 'cull.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. The culler keeps running: docker ${COMPOSE.join(' ')} stop culler`);
  process.exitCode = failed ? 1 : 0;
}
