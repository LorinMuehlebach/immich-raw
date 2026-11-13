# Development

Everything runs locally against a throwaway Immich in Docker:

```sh
npm install
npm run build                                          # builds the button script and the editor
docker compose -f e2e/docker-compose.immich.yml up -d  # test Immich on http://127.0.0.1:8088
node spikes/decode-bench/fetch-samples.mjs <folder>    # five CC0 sample RAWs (~320 MB)
node e2e/seed.mjs <folder>                             # uploads them
```

Open http://127.0.0.1:8088 and log in with `admin@example.com` / `raw-editor-e2e`. `npm run dev` starts
the editor with hot reload on http://localhost:5173/immich-raw/, using the test Immich's API.

The [try-it demo](../deploy/demo/README.md) is the same instance from the published images, with the
photos already uploaded; `deploy/demo/compose.build.yml` builds it from a checkout instead.

- `npm test`: unit tests (vitest); `npm run check`: type checks.
- `node e2e/smoke.mjs <out-dir>`: end-to-end test (open, edit, save, export, reopen, re-save).
- `node e2e/probe-ai-masks.mjs <out-dir> <asset-id>`: the AI masks on one photo, then an export
  (needs internet for the models).
- `node e2e/probe-profiles.mjs <out-dir> <asset-ids>`: the profiles: the tone-only ones against a
  baseline build, the Fujifilm Provia look against a RAF's own JPEG, contact sheets
  ([e2e/README.md](../e2e/README.md#variants)).
- `node e2e/export.mjs <out-dir>`: the export options (PNG, TIFF, print size, file names), an album
  export as a ZIP (two photos at once), the export button for photos selected in Immich (including
  select all), a saved edit exported from its RAW, WebP, AVIF and JPEG XL with their metadata, and a
  logo watermark.
- `node e2e/probe-colour.mjs <out-dir> [--baseline]`: exports in sRGB, Display P3, Adobe RGB,
  ProPhoto and 16 bits. Run `--baseline` with a build from before a renderer change; without it,
  the sRGB export must be unchanged and the other spaces must show the same picture.
- `node e2e/bench-export.mjs <out-dir> [mixed|xt30] [1,2,4,8,16] [preset] [format]`: times the batch
  export at several photos at once and samples the browser's memory
  ([Export speed](export-speed.md)); `format` changes the preset's file type (e.g. `avif`).
- [Decoding speed](decode-speed.md): how fast a RAW opens and decodes, how to measure it, and what
  could still be improved.
- `node e2e/screenshots.mjs [section ...]`: regenerates the screenshots of the guides in `docs/`
  ([e2e/README.md](../e2e/README.md#screenshots)).
- Culler:
  - `cd services/culler && uv run pytest`: its unit tests;
  - `node e2e/culler-up.mjs`: starts it next to the test Immich;
  - `node e2e/cull.mjs <out-dir>`: its end-to-end test, on RAW and JPEG bursts.
- [e2e/README.md](../e2e/README.md) describes the test setup; [deploy/README.md](../deploy/README.md) the
  deployment files.

Project layout:

- `apps/editor/`: the Svelte editor.
- `packages/`:
  - `ai`: AI masks (the models, the worker that runs them, turning their output into masks);
  - `decoder`: RAW decoding with LibRaw;
  - `libraw`: LibRaw for WebAssembly (libraw-wasm built without threads, see its README);
  - `pipeline`: WebGL2 renderer, colour maths;
  - `recipe`: edit settings;
  - `xmp`: Lightroom import/export;
  - `lens`: Lensfun profiles, DNG lens data, CA measurement;
  - `dng`: DNG writer;
  - `inject`: the Immich button.
- `services/culler/`: the optional culler (Python).
- `deploy/`: Dockerfile, reverse-proxy snippets and the try-it demo.
- `e2e/`: test Immich, seed, smoke-test and screenshot scripts.
- `licenses/`: third-party licence texts.
- `docs/`: the guides for each feature, and measurements.
- `spikes/`: early experiments.

