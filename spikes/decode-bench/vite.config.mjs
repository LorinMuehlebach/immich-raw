import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defineConfig } from 'vite';

// The libraw-wasm build uses pthreads (shared WebAssembly.Memory), so the page must be
// cross-origin isolated. These are the same headers the production container will send.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Serves RAW files from SAMPLES_DIR at /samples/<name>, and the file list at /samples/index.json.
function samplesPlugin() {
  const dir = process.env.SAMPLES_DIR;
  return {
    name: 'samples',
    configureServer(server) {
      server.middlewares.use('/samples', (req, res, next) => {
        if (!dir || !existsSync(dir)) return next();
        const name = basename(decodeURIComponent(req.url.split('?')[0]));
        if (name === 'index.json') {
          const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(files));
        }
        const path = join(dir, name);
        if (!existsSync(path)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', statSync(path).size);
        for (const [k, v] of Object.entries(isolationHeaders)) res.setHeader(k, v);
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [samplesPlugin()],
  server: { headers: isolationHeaders },
  // Pre-bundling would break libraw-wasm's `new URL('./worker.js', import.meta.url)`.
  optimizeDeps: { exclude: ['libraw-wasm'] },
});
