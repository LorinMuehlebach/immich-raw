// Virtual copies: making one (Ctrl+'), saving it into the RAW's stack beside the original's
// JPEG, switching between the original and copies (in the menu, after a reload, with unsaved
// changes), renaming and deleting. Saves to Immich: the copies and their JPEGs are removed again
// at the end, and a stack made only for them is taken apart. The original edit isn't saved.
// Usage: node e2e/probe-copies.mjs <out-dir> [filename-part]   (default: canon)
//   IMMICH_URL, INSECURE=1 as in smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'canon'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-copies.mjs <out-dir> [filename-part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
await loginOnPageOrigin(context, LOGIN);
const api = async (method, path, data) => {
  const r = await context.request.fetch(`${API_BASE}/api${path}`, { method, ...(data ? { data } : {}) });
  return r.status() === 204 ? null : r.json().catch(() => null);
};
const found = await api('POST', '/search/metadata', { originalFileName: namePart, size: 10 });
const raw = found?.assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName) && !a.isTrashed);
if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');
const metadata = async () => (await api('GET', `/assets/${raw.id}/metadata`)) ?? [];
const value = async (key) => (await metadata()).find((i) => i.key === key)?.value ?? null;
const before = {
  recipe: JSON.stringify(await value('raw-editor.recipe')),
  keys: new Set((await metadata()).map((i) => i.key)),
  stack: (await api('GET', `/assets/${raw.id}`))?.stack ?? null,
};
/** Renders this probe made, to delete for good at the end. */
const made = new Set();

try {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
  // Says which request a "Failed to load resource: 404" console error was.
  page.on('response', (r) => r.status() === 404 && console.log('404', r.request().method(), r.url()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const open = async (copy) => {
    await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}${copy ? `&copy=${copy}` : ''}&debug`);
    await page.waitForFunction(() => globalThis.__editor?.status === 'ready', null, { timeout: 240000 });
    await page.waitForTimeout(800);
  };
  const ed = (fn, arg) => page.evaluate(fn, arg);
  const state = () =>
    ed(() => {
      const e = globalThis.__editor;
      return { copyId: e.copyId, name: e.editName, copies: e.copies.map((c) => ({ ...c })), exposure: e.recipe.basic.exposure, dirty: e.dirty, url: location.search };
    });
  const menu = () => page.locator('.copies .switch');
  const pick = async (name) => {
    await menu().click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^.?${name}`) }).click();
    await page.waitForTimeout(800);
  };
  const setExposure = async (v) => {
    const input = page.locator('input[aria-label="Exposure"]').first();
    await input.fill(String(v));
    await input.press('Enter');
    await page.waitForTimeout(300);
  };

  await open(null);
  const original = await state();
  check('the original edit is open, the menu shows it', !original.copyId && (await menu().textContent()).includes('Original'), { name: original.name });

  // ---- a new copy (Ctrl+')
  await page.keyboard.press("Control+'");
  await page.waitForFunction((n) => globalThis.__editor.copies.length === n + 1 && !!globalThis.__editor.copyId, original.copies.length, { timeout: 10000 });
  const c1 = await state();
  const copy1 = c1.copies.at(-1);
  check("Ctrl+' makes a copy and opens it", c1.copyId === copy1.id && c1.url.includes(`copy=${copy1.id}`) && !c1.dirty, { name: c1.name, url: c1.url });
  check('the copy is stored on the RAW at once', !!(await value(`raw-editor.copy.${copy1.id}`)));

  // ---- save the copy
  await setExposure(1.2);
  const saved = await ed(() => globalThis.__editor.save());
  const stored = await value(`raw-editor.copy.${copy1.id}`);
  const renderId = stored?.recipe?.render?.assetId;
  if (renderId) made.add(renderId);
  const render = renderId ? await api('GET', `/assets/${renderId}`) : null;
  const renderMeta = renderId ? ((await api('GET', `/assets/${renderId}/metadata`)) ?? []).find((i) => i.key === 'raw-editor.render')?.value : null;
  check('saving the copy stores its JPEG in its own key', saved && !!renderId && stored.recipe.basic.exposure === 1.2, { renderId, error: await ed(() => globalThis.__editor.error) });
  check(`its JPEG is called ….copy-${copy1.index}.edit.jpg and names the copy`, render?.originalFileName?.endsWith(`.copy-${copy1.index}.edit.jpg`) && renderMeta?.copyId === copy1.id && renderMeta?.sourceAssetId === raw.id, {
    file: render?.originalFileName,
    meta: renderMeta,
  });
  const rawNow = await api('GET', `/assets/${raw.id}`);
  check("it is in the RAW's stack", !!rawNow.stack && render?.stack?.id === rawNow.stack.id, { stack: rawNow.stack });
  const originalRender = JSON.parse(before.recipe ?? 'null')?.render?.assetId;
  if (originalRender) check("the original's JPEG stays in front", rawNow.stack.primaryAssetId === originalRender, { primary: rawNow.stack.primaryAssetId });
  else check("with no original JPEG yet, the copy's is in front", rawNow.stack.primaryAssetId === renderId, { primary: rawNow.stack.primaryAssetId });
  check("the original's settings are untouched", JSON.stringify(await value('raw-editor.recipe')) === before.recipe);
  await page.screenshot({ path: join(outDir, '1-copy-saved.png') });

  // ---- switching
  await pick('Original');
  const back = await state();
  check('the menu switches to the original', !back.copyId && back.exposure === original.exposure && !back.url.includes('copy='), back);
  await pick(copy1.name);
  check('and back to the copy', (await state()).copyId === copy1.id && (await state()).exposure === 1.2);
  await open(copy1.id);
  check('a reload with ?copy= opens the copy', (await state()).copyId === copy1.id && (await state()).exposure === 1.2);

  // ---- a copy of the copy, renamed
  await menu().click();
  await page.getByRole('menuitem', { name: /New virtual copy/ }).click();
  await page.waitForFunction((n) => globalThis.__editor.copies.length === n, original.copies.length + 2, { timeout: 10000 });
  const c2 = (await state()).copies.at(-1);
  check('a copy made from a copy starts from its settings', (await state()).copyId === c2.id && (await state()).exposure === 1.2 && c2.index === copy1.index + 1, { c2 });
  await menu().click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.locator('input[aria-label="Name of the copy"]').fill('Warm version');
  await page.locator('input[aria-label="Name of the copy"]').press('Enter');
  await page.waitForTimeout(800);
  check('renaming is stored on the RAW', (await value(`raw-editor.copy.${c2.id}`))?.name === 'Warm version' && (await menu().textContent()).includes('Warm version'));
  await page.screenshot({ path: join(outDir, '2-menu.png') });
  await menu().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, '3-menu-open.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the menu, and stays in the editor', (await page.locator('.copies .menu').count()) === 0 && page.url().includes('/immich-raw/'), { url: page.url() });

  // ---- unsaved changes stay as the copy's draft
  await setExposure(-0.5);
  await pick('Original');
  check('switching with unsaved changes opens the original without asking', (await page.getByRole('alertdialog').count()) === 0 && !(await state()).copyId);
  check('the copy kept its stored settings', (await value(`raw-editor.copy.${c2.id}`))?.recipe?.basic?.exposure === 1.2);
  await pick('Warm version');
  check('the copy opens with its draft', (await state()).copyId === c2.id && (await state()).exposure === -0.5 && (await state()).dirty);
  await page.locator('.sub button.discard').click();
  await page.waitForTimeout(500);
  check('Discard goes back to its stored settings', (await state()).exposure === 1.2 && !(await state()).dirty);
  await pick('Original');

  // ---- delete both copies (the menu's two-step Delete)
  for (const c of [c2, copy1]) {
    await pick(c.id === c2.id ? 'Warm version' : c.name);
    await menu().click();
    await page.getByRole('menuitem', { name: 'Delete copy…' }).click();
    await page.getByRole('menuitem', { name: /^Delete .*\?$/ }).click();
    await page.waitForTimeout(1500);
  }
  const keys = (await metadata()).map((i) => i.key);
  check('deleting removes the copies and opens the original', !(await state()).copyId && !keys.some((k) => k === `raw-editor.copy.${copy1.id}` || k === `raw-editor.copy.${c2.id}`), { keys });
  check("the copy's JPEG went to the trash", (await api('GET', `/assets/${renderId}`))?.isTrashed === true);
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  // Put the RAW back: our copies' keys and JPEGs, and a stack that only they made.
  for (const i of await metadata()) {
    if (/^raw-editor\.(copy|history)\./.test(i.key) && !before.keys.has(i.key)) {
      const v = i.value;
      if (v?.recipe?.render?.assetId) made.add(v.recipe.render.assetId);
      await api('DELETE', `/assets/${raw.id}/metadata/${encodeURIComponent(i.key)}`);
    }
  }
  const now = (await api('GET', `/assets/${raw.id}`))?.stack;
  if (!before.stack && now?.id) await api('DELETE', `/stacks/${now.id}`);
  if (made.size) await api('DELETE', '/assets', { ids: [...made], force: true });
  await browser.close();
  writeFileSync(join(outDir, 'probe-copies.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
