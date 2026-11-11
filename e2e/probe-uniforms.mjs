// Debug tool: prints the develop uniforms the renderer sends for the loaded recipe.
// Usage: node e2e/probe-uniforms.mjs <raw-asset-id>
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8088';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext();
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
await page.goto(`${BASE}/immich-raw/?asset=${process.argv[2]}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
const out = await page.evaluate(() => {
  const ed = globalThis.__editor; const r = ed.renderer;
  const recipe = JSON.parse(JSON.stringify(ed.recipe));
  const frame = r.frameFor(recipe, 'edit');
  const u = r.developBase(recipe, ed.camera, frame);
  const plain = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, ArrayBuffer.isView(v) ? Array.from(v) : v]));
  const p = r.p.analysis; const gl = r.gl;
  const active = [];
  for (let i = 0; i < gl.getProgramParameter(p.handle, gl.ACTIVE_UNIFORMS); i++) { const a = gl.getActiveUniform(p.handle, i); active.push(`${a.name}:${a.type}`); }
  return { recipeBasic: recipe.basic, frame: { w: frame.width, h: frame.height, tToS: frame.tToS }, uniforms: plain, active };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
