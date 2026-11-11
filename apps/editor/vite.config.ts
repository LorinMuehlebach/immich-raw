import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// URL path the editor is served under, next to Immich (the proxy configs in deploy/ use the same).
const BASE = '/immich-raw/';
const here = dirname(fileURLToPath(import.meta.url));
const librawDist = resolve(here, '../../node_modules/libraw-wasm/dist');
const injectJs = resolve(here, '../../packages/inject/dist/inject.js');
const userscript = resolve(here, '../../packages/inject/dist/immich-raw.user.js');
const nodeModules = resolve(here, '../../node_modules');
/**
 * AI masks: the runtimes load from the editor's own origin, unbundled, under names ending in
 * .js (every server knows that MIME type). ONNX Runtime's threads start its loader by URL,
 * so it can't live inside a bundle. The models themselves come from their CDNs.
 */
const aiRuntime: { name: string; path: string }[] = [
  { name: 'ort/ort.webgpu.min.js', path: join(nodeModules, 'onnxruntime-web/dist/ort.webgpu.min.mjs') },
  { name: 'ort/ort-wasm-simd-threaded.asyncify.js', path: join(nodeModules, 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs') },
  { name: 'ort/ort-wasm-simd-threaded.asyncify.wasm', path: join(nodeModules, 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm') },
  { name: 'mediapipe/vision_bundle.js', path: join(nodeModules, '@mediapipe/tasks-vision/vision_bundle.mjs') },
  { name: 'mediapipe/vision_wasm_module_internal.js', path: join(nodeModules, '@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js') },
  { name: 'mediapipe/vision_wasm_module_internal.wasm', path: join(nodeModules, '@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm') },
];

// libraw-wasm uses SharedArrayBuffer (pthreads), so every response must be cross-origin
// isolated. The production nginx sends the same headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };

const repoRoot = resolve(here, '../..');

/**
 * The page behind the editor's ⓘ link: our licence and source link, the third-party notices
 * and every licence text from licenses/. Starts with a BOM so browsers read it as UTF-8 even
 * when the server sends no charset.
 */
function licensesText(): string {
  const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const pkg = JSON.parse(read('package.json')) as { repository?: string | { url?: string } };
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const source = repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : 'the immich-raw repository';
  const rule = '='.repeat(78);
  const section = (title: string, body: string) => `\n\n${rule}\n${title}\n${rule}\n\n${body}`;
  const texts = readdirSync(resolve(repoRoot, 'licenses'))
    .sort()
    .map((f) => section(`licenses/${f}`, read(`licenses/${f}`)));
  return (
    '﻿' +
    [
      'immich-raw: licences and source code',
      '',
      'immich-raw is free software, licensed under the GNU Affero General Public License v3.0',
      `(full text at the end). Source code: ${source}`,
      section('THIRD-PARTY-NOTICES.md', read('THIRD-PARTY-NOTICES.md')),
      ...texts,
      section('Lensfun lens database (apps/editor/public/lensfun/LICENSE.md)', read('apps/editor/public/lensfun/LICENSE.md')),
      section('LICENSE: immich-raw, GNU Affero General Public License v3.0', read('LICENSE')),
    ].join('\n') +
    '\n'
  );
}

/**
 * Ships libraw-wasm unbundled under /immich-raw/libraw/ (it resolves its worker and
 * libraw.wasm relative to itself) and the Immich button script as /immich-raw/inject.js.
 */
function staticRuntimeFiles(): Plugin {
  const files = (): { name: string; path: string }[] => [
    ...readdirSync(librawDist)
      .filter((f) => !f.endsWith('.map') && !f.endsWith('.d.ts'))
      .map((f) => ({ name: `libraw/${f}`, path: join(librawDist, f) })),
    ...(existsSync(injectJs) ? [{ name: 'inject.js', path: injectJs }] : []),
    // Installable from <immich>/immich-raw/immich-raw.user.js when the proxy can't add the button.
    ...(existsSync(userscript) ? [{ name: 'immich-raw.user.js', path: userscript }] : []),
    ...aiRuntime,
  ];
  return {
    name: 'immich-raw-static-runtime',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (url === `${BASE}licenses.txt`) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
          res.end(licensesText());
          return;
        }
        const hit = files().find((f) => url === `${BASE}${f.name}`);
        if (!hit) return next();
        res.setHeader('Content-Type', MIME[extname(hit.path)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', statSync(hit.path).size);
        for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
        createReadStream(hit.path).pipe(res);
      });
    },
    generateBundle() {
      if (!existsSync(injectJs)) this.warn('packages/inject/dist/inject.js missing: run `npm run build -w @immich-raw/inject` first');
      for (const f of files()) this.emitFile({ type: 'asset', fileName: f.name, source: readFileSync(f.path) });
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: licensesText() });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [svelte(), staticRuntimeFiles()],
  server: {
    port: 5173,
    headers: isolation,
    // Dev: talk to the test Immich (e2e/docker-compose.immich.yml) through the Vite server; the
    // culler is reached through the same nginx.
    proxy: {
      '/api': { target: process.env.IMMICH_URL ?? 'http://127.0.0.1:8088', changeOrigin: false },
      [`${BASE}culler`]: { target: process.env.IMMICH_URL ?? 'http://127.0.0.1:8088', changeOrigin: false },
    },
  },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
