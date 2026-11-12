// Speed of the AI upscaler candidates on onnxruntime-web's WebGPU backend, in Edge.
// node spikes/ai-masks/upscale-bench-webgpu.mjs <models dir>
// Serves ONNX Runtime and the models on localhost (a secure context, so WebGPU is there) and
// times a few tiles of each model. Set HEADED=1 to watch.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node spikes/ai-masks/upscale-bench-webgpu.mjs <models dir>');
const require = createRequire(import.meta.url);
const ortDist = join(dirname(require.resolve('onnxruntime-web')), '..', 'dist');

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import * as ort from '/ort/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = '/ort/';
ort.env.logLevel = 'error';
const out = { adapter: null, results: [] };
const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
out.adapter = a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description, fallback: a.isFallbackAdapter ?? a.info?.isFallbackAdapter } : null;
for (const [name, file, side] of [['real-esrgan x4v3 (128)', 'realesr-general-x4v3.onnx', 128], ['real-esrgan x4v3 (256)', 'realesr-general-x4v3.onnx', 256], ['realplksr x2 (512)', 'model_x2.onnx', 512], ['realplksr x4 (256)', 'model_x4.onnx', 256]]) {
  try {
    const bytes = new Uint8Array(await (await fetch('/models/' + file)).arrayBuffer());
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    const data = new Float32Array(3 * side * side).map((_, i) => (i % 251) / 251);
    const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, side, side]) };
    let r = await s.run(feeds);
    await r[s.outputNames[0]].getData();
    const N = 3;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { r = await s.run(feeds); await r[s.outputNames[0]].getData(); }
    const t = (performance.now() - t0) / N;
    const perMp = (t / (side * side)) * 1e6;
    out.results.push(name + ': tile ' + (t / 1000).toFixed(3) + 's, ' + (perMp / 1000).toFixed(2) + ' s/MP in, 24 MP: ' + ((perMp * 24) / 60000).toFixed(1) + ' min');
    await s.release();
  } catch (e) { out.results.push(name + ' FAILED ' + String(e).slice(0, 300)); }
}
window.__done = out;
</script>`;

const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    const [, root, file] = url.pathname.match(/^\/(ort|models)\/([\w.-]+)$/) ?? [];
    if (!root) return res.writeHead(404).end();
    const body = readFileSync(join(root === 'ort' ? ortDist : dir, file));
    res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-webgpu'] });
const tab = await browser.newPage();
tab.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
await tab.goto(`http://localhost:${port}/`);
const result = await tab.waitForFunction(() => window.__done, null, { timeout: 0, polling: 1000 }).then((h) => h.jsonValue());
console.log('adapter', JSON.stringify(result.adapter));
for (const line of result.results) console.log(line);
await browser.close();
server.close();
