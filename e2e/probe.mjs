// Debug tool: opens the editor with ?debug and prints pixel values of each render stage.
// Usage: node e2e/probe.mjs <raw-asset-id>
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8088';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext();
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 300)));
await page.goto(`${BASE}/immich-raw/?asset=${process.argv[2]}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
const out = await page.evaluate(() => {
  const ed = globalThis.__editor; const r = ed.renderer; const gl = r.gl;
  const read = (t, x, y) => {
    if (!t) return 'missing';
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    const isFloat = t.format !== gl.RGBA8;
    const buf = isFloat ? new Float32Array(4) : new Uint8Array(4);
    gl.readPixels(Math.floor(t.width * x), Math.floor(t.height * y), 1, 1, gl.RGBA, isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, buf);
    return `${t.width}x${t.height} ` + Array.from(buf).map((v) => +v.toFixed(4)).join(',');
  };
  const T = r.t;
  return {
    err: gl.getError(),
    camera: { camMul: ed.camera.camMul, asShot: ed.camera.asShot, flip: ed.camera.flip, camToWork: ed.camera.camToWork },
    half: { w: ed.session.half.width, h: ed.session.half.height, sample: Array.from(ed.session.half.data.subarray(3 * (ed.session.half.width * 1500 + 2000), 3 * (ed.session.half.width * 1500 + 2000) + 3)) },
    proxy: read(r.proxy, 0.5, 0.5),
    an: read(T.an, 0.5, 0.5), ab: read(T.ab, 0.5, 0.5),
    dev: read(T.dev, 0.5, 0.5), blurB: read(T.blurB, 0.5, 0.5), fin: read(T.fin, 0.5, 0.5),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
