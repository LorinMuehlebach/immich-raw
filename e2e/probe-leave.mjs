// Leaving with unsaved changes: the dialog appears; No leaves without saving, Cancel stays,
// Yes saves and then leaves. Usage: node e2e/probe-leave.mjs <asset-id> [yes]
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
const change = () => page.evaluate(() => globalThis.__editor.setParam({ path: 'basic.contrast', label: 'Contrast', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, 23, true));
const result = {};

await open();
// Not dirty: Esc leaves straight away.
await page.keyboard.press('Escape');
await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 20000 });
result.cleanLeave = new URL(page.url()).pathname;

// Dirty: Esc asks; Cancel stays.
await open();
await change();
await page.keyboard.press('Escape');
await page.getByRole('alertdialog').waitFor();
result.dialogText = await page.getByRole('alertdialog').innerText();
await page.getByRole('button', { name: 'Cancel' }).click();
result.stayed = page.url().includes('/immich-raw/') && (await page.evaluate(() => globalThis.__editor.dirty));

// No: leaves without saving and without the browser's own prompt.
await page.locator('button.back').click();
await page.getByRole('button', { name: 'No' }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 20000 });
result.discardLeave = new URL(page.url()).pathname;
await open();
result.contrastAfterNo = await page.evaluate(() => globalThis.__editor.recipe.basic.contrast);

if (withYes === 'yes') {
  await change();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 300000 });
  result.saveLeave = new URL(page.url()).pathname;
  await open();
  result.contrastAfterYes = await page.evaluate(() => globalThis.__editor.recipe.basic.contrast);
}
result.errors = errors;
console.log(JSON.stringify(result, null, 1));
await browser.close();
