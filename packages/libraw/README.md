# @immich-raw/libraw

LibRaw 0.22.1 for WebAssembly: [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) 1.6.0, built
without threads. The npm release of libraw-wasm is linked with pthreads, so it allocates shared
WebAssembly memory. Browsers only allow that on cross-origin isolated pages, which also means HTTPS
(or localhost). It never starts a second thread, though. This build drops the pthreads link and changes
nothing else (Emscripten 5.0.7, the same sources and optimisation flags), so the editor also works when
Immich is opened on plain `http://`. The decoded pixels are byte-identical to the npm build:
`node e2e/probe-decoder-compare.mjs <samples-dir>` checks this.

`lib/` holds the built files and is committed, so a normal `npm ci && npm run build` needs no
Emscripten. The editor serves them unbundled at `/immich-raw/libraw/`, keeping `libraw.wasm` a
separate, replaceable file (LGPL-2.1).

| File | |
|---|---|
| `lib/index.js` | the `LibRaw` class (unchanged from libraw-wasm) |
| `lib/worker.js` | the worker each `LibRaw` instance runs in |
| `lib/libraw.wasm` | LibRaw, Little CMS and libjpeg |
| `lib/index.d.ts` | types (unchanged from libraw-wasm) |

## Rebuilding

Needs Docker with BuildKit (Docker Desktop has it):

```sh
npm run build:libraw -w @immich-raw/libraw
```

[build/Dockerfile](build/Dockerfile) starts from `emscripten/emsdk:5.0.7`, and
[build/build.sh](build/build.sh) clones libraw-wasm at v1.6.0 (commit `32fd36a9`). It applies
[build/no-pthreads.patch](build/no-pthreads.patch), builds Little CMS and LibRaw from source with
libraw-wasm's `compileLibraw.sh`, and writes the four files to `lib/`. It takes about 3 minutes.

The patch:
- configures LibRaw with `--disable-openmp` (OpenMP was never compiled in anyway);
- removes `-s USE_PTHREADS=1`, `-pthread` and `-lpthread` from the link.

After a rebuild, run the comparison probe and the e2e smoke test. If the decoder changes, also
update `DECODER` in `packages/decoder/src/libraw.ts`; it is stored with every recipe.

## Not done: a multi-threaded build

LibRaw can spread parts of a decode, mainly the demosaic of the full-resolution image, over several
CPU cores with OpenMP. In the browser those threads need shared memory, so such a build would
only run on cross-origin isolated pages (HTTPS or localhost). It would be a second build next to this
one, picked when `crossOriginIsolated` is true. The editor keeps sending the COOP/COEP headers for
that reason.

- **Gain:** mostly the full-resolution decode, which 100 % zoom, saving and DNG export wait for. The
  half-size decode that editing starts on would gain little. Upstream's draft
  ([libraw-wasm PR #30](https://github.com/ybouane/LibRaw-Wasm/pull/30), not merged) measured 2-3×
  faster decodes with 4 threads on its own test files. Our files and settings would need their own
  measurement.
- **Cost:** a second patch to maintain (OpenMP flags and a thread pool), several workers started per
  decode, and less memory headroom at 60 MP and more. The draft also drops `-ffast-math`, which
  changes pixels. A build here would keep the current flags and pass `e2e/probe-decoder-compare.mjs`.

Not planned for now.
