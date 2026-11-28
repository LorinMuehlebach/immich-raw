// Leaving for Immich with drafts: the editor asks whether to save them (they only live while the
// page is open). Cancel stays, Discard leaves without them, Save saves and then leaves. Without
// drafts it leaves at once. Usage: node e2e/probe-leave.mjs <asset-id> [yes]
//   yes: also saves an edit (a JPEG in Immich) with the question's Save, and removes it again
//        (its JPEG and settings), so only use it on a photo without a saved edit.
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [id, withYes] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => {
  errors.push(`native dialog: ${d.type()} ${d.message()}`);
  void d.dismiss();
});
const open = async () => {
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
};
const left = () => page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 300000 }).then(() => new URL(page.url()).pathname);
const question = () => page.getByRole('alertdialog');
const change = () => page.evaluate(() => globalThis.__editor.setParam({ path: 'basic.contrast', label: 'Contrast', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, 23, true));
const contrast = () => page.evaluate(() => ({ contrast: globalThis.__editor.recipe.basic.contrast, dirty: globalThis.__editor.dirty }));
const result = {};

await open();
// No drafts: Esc leaves straight away.
await page.keyboard.press('Escape');
result.cleanLeave = await left();

// A draft: Esc asks. Cancel stays, with the draft.
await open();
await change();
await page.keyboard.press('Escape');
await question().waitFor({ timeout: 10000 });
result.questionText = (await question().innerText()).replace(/\s+/g, ' ');
await question().getByRole('button', { name: 'Cancel' }).click();
result.stayed = { url: new URL(page.url()).pathname, ...(await contrast()) };

// Discard: leaves without the browser's own question, and the photo opens without the draft.
await page.locator('button.back').click();
await question().getByRole('button', { name: 'Discard' }).click();
result.discardLeave = await left();
await open();
result.afterDiscard = await contrast();

const api = async (method, path, data) => {
  const res = await ctx.request.fetch(`${BASE}/api${path}`, { method, data });
  return res.ok() && res.headers()['content-type']?.includes('json') ? res.json() : null;
};
const recipe = async () => (await api('GET', `/assets/${id}/metadata`))?.find((i) => i.key === 'raw-editor.recipe')?.value ?? null;
if (withYes === 'yes') {
  if (await recipe()) throw new Error('yes: the photo has a saved edit already');
  await change();
  await page.keyboard.press('Escape');
  await question().getByRole('button', { name: 'Save' }).click();
  result.saveLeave = await left();
  await open();
  result.afterSave = await contrast();
  // Put the photo back: the JPEG and settings the save made go.
  const saved = await recipe();
  if (saved?.render?.assetId) await api('DELETE', '/assets', { ids: [saved.render.assetId], force: true });
  for (const key of ['raw-editor.recipe', 'raw-editor.history']) await api('DELETE', `/assets/${id}/metadata/${key}`);
}
result.ok =
  !!result.questionText?.includes('unsaved changes') &&
  result.stayed.url.startsWith('/immich-raw/') &&
  result.stayed.contrast === 23 &&
  result.stayed.dirty &&
  result.afterDiscard.contrast !== 23 &&
  !result.afterDiscard.dirty &&
  (withYes !== 'yes' || (result.afterSave.contrast === 23 && !result.afterSave.dirty)) &&
  errors.length === 0;
result.errors = errors;
console.log(JSON.stringify(result, null, 1));
await browser.close();
