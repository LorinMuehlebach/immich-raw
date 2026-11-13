# Spikes

Throwaway experiments for milestone M0. Results are in [../docs/spike-results.md](../docs/spike-results.md).
Run `npm install` in the repo root first.

## decode-bench

Benchmarks libraw-wasm, the WebGL2 proxy and JPEG encoding in headless Microsoft Edge
(Playwright, `channel: 'msedge'`; set `BROWSER_CHANNEL=chrome` to use Chrome instead).

```sh
cd spikes/decode-bench
node fetch-samples.mjs <samples-dir>           # ~320 MB of CC0 RAWs; keep this outside OneDrive
node run-bench.mjs <samples-dir> <out-dir>     # decode timings, clip points, memory, previews
Q=0,1,2 node run-bench.mjs <samples-dir> <out-dir> fuji   # compare demosaic quality levels
Q= WARM=1 TILES=2 node run-bench.mjs <samples-dir> <out-dir>  # worker start-up, decodes split in stripes
node run-gpu.mjs <samples-dir> <out-dir> sony-a7rv.ARW     # WebGL2 proxy frame times
node run-page.mjs encode <samples-dir> <out-dir>           # color check + JPEG encode times
```

To try the GPU page by hand: `SAMPLES_DIR=<samples-dir> npx vite` in `spikes/decode-bench`, then open
`http://localhost:5173/gpu.html` and drag the sliders.

## immich-api

Checks the Immich behaviour the save flow and inject script depend on. It runs against the throwaway
instance in `e2e/` (Immich v3.3.6 behind nginx on http://127.0.0.1:8088; admin `admin@example.com` /
`raw-editor-e2e`):

```sh
docker compose -f e2e/docker-compose.immich.yml up -d            # IMMICH_HELMET_FILE=true for the CSP variant
node spikes/immich-api/check.mjs <raw-file> <jpeg-file> <out-dir> [label]
docker compose -f e2e/docker-compose.immich.yml stop             # pause; `down -v` deletes it and its data
```
