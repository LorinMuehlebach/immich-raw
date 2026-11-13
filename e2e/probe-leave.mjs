// Leaving with unsaved changes: nothing asks; they stay as a draft that the photo opens with next
// time, until Discard (or a save) drops it. Usage: node e2e/probe-leave.mjs <asset-id> [yes]
//   yes: also saves an edit (a JPEG in Immich) and checks that the draft is gone afterwards.
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
  errors.push(`native dialog: ${d.message()}`);
  void d.dismiss();
});
const open = async () => {
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
};
const leave = async (how) => {
  if (how === 'esc') await page.keyboard.press('Escape');
  else await page.locator('button.back').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 20000 });
  return new URL(page.url()).pathname;
};
const change = () => page.evaluate(() => globalThis.__editor.setParam({ path: 'basic.contrast', label: 'Contrast', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, 23, true));
const contrast = () => page.evaluate(() => ({ contrast: globalThis.__editor.recipe.basic.contrast, dirty: globalThis.__editor.dirty }));
const result = {};

await open();
// Not dirty: Esc leaves straight away.
result.cleanLeave = await leave('esc');

// Dirty: Esc leaves straight away too, and the photo opens with the draft.
await open();
await change();
result.dirtyLeave = await leave('esc');
await open();
result.afterDraft = await contrast();

// Discard: back to the saved edit; the draft is gone after leaving.
await page.locator('.sub button.discard').click();
result.afterDiscard = await contrast();
result.discardLeave = await leave('back');
await open();
result.reopenedAfterDiscard = await contrast();

if (withYes === 'yes') {
  await change();
  await page.keyboard.press('Control+s');
  await page.locator('.toast', { hasText: 'Saved to Immich' }).waitFor({ timeout: 300000 });
  result.saveLeave = await leave('esc');
  await open();
  result.afterSave = await contrast();
}
result.ok =
  result.afterDraft.contrast === 23 &&
  result.afterDraft.dirty &&
  result.afterDiscard.contrast !== 23 &&
  !result.afterDiscard.dirty &&
  result.reopenedAfterDiscard.contrast === result.afterDiscard.contrast &&
  !result.reopenedAfterDiscard.dirty &&
  (withYes !== 'yes' || (result.afterSave.contrast === 23 && !result.afterSave.dirty)) &&
  errors.length === 0;
result.errors = errors;
console.log(JSON.stringify(result, null, 1));
await browser.close();
