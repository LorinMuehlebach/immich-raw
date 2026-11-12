# Decoding speed

How fast the editor opens and decodes a RAW, what has been done about it, and what could still be
improved. State on 2026-11-12. The measurements are in [spike-results.md](spike-results.md).

## Where the time goes

Opening a photo, on the dev machine (16 threads, test Immich on localhost):

| Step | Time |
|---|---|
| Photo info, saved edit, snapshots | 30–100 ms |
| Download of the original (cache hit) | 0.3–0.8 s (45–160 ms) |
| **Half-size decode, single-threaded** | **1.0–2.7 s** |
| Shader compiling (`new Renderer`) | 50–100 ms |
| First render | 40–50 ms (Fuji: 160–280 ms) |

- **The half-size decode is 60–75 % of the time until the photo shows.** LibRaw's `open()` only
  parses the file (35–170 ms). `imageData()` unpacks it and processes it, and for a half-size
  decode the unpacking is most of the time.
- **The full-resolution decode** (1:1 zoom, Save, export) runs in the background after the photo
  shows: 5–7 s for Bayer files, about 15 s for X-Trans, on one thread.

## What is done

Two branches, neither merged yet:

- **`feature/decode-speed`: the steps around the decode overlap.**
  - The original downloads while the saved edit and the snapshots load.
  - The decoder's worker and its WebAssembly start before the file arrives (`prewarmDecoder()`).
  - The shaders compile while the worker decodes.
  - A cache hit no longer waits for the cache index to be written.

  Together this saves 0.1–0.3 s per open here; more on a slow network. The branch also adds the
  measuring tools: the editor's `immich-raw:*` timings, `e2e/probe-open-speed.mjs`, and the bench's
  `WARM` and `TILES` options.
- **`feature/libraw-threaded`: a second LibRaw build with OpenMP threads** (Emscripten 6.0.4,
  [packages/libraw](../packages/libraw/README.md)). It decodes to the same bytes as the build
  without threads.
  - **Where it's used:** on cross-origin isolated pages (HTTPS or localhost). Plain HTTP keeps the
    single-threaded build.
  - **Threads:** up to 4 in the editor, and a share of the cores per photo in a batch export
    (`apps/editor/src/lib/decoder-setup.ts`).
  - **Fallback:** if the thread pool doesn't start, decoding switches to the single-threaded build.
  - **Gains:** the half-size decode is 10–48 % faster (CR3 and compressed RAF most), and the full
  decode 37–42 %. In the editor, a photo from the browser's cache shows 7–38 % sooner.
  - **Docs:** [HTTPS with Tailscale](installation.md#https-with-tailscale) describes one way to get
  HTTPS at home.

**Both branches change `packages/decoder/src/libraw.ts`.** `feature/decode-speed` keeps a started
instance in `takeLibRaw()`, and `feature/libraw-threaded` picks the build in `startLibRaw()`.
Whichever branch merges second has to make `prewarmDecoder()` and `takeLibRaw()` create their
instances with `startLibRaw()`.

## What could be improved

Roughly by gain for the effort.

1. **Unpack once for the half and the full decode.** The full decode starts after the half decode,
   in a new worker, and parses and unpacks the whole file again. That repeats 0.5–2.5 s of work
   before 1:1 zoom and Save are ready. There are two ways to avoid it:
   - Start both decodes at once. That needs to know first whether the file is X-Trans, and it costs
     about 1.5 GB more peak memory at 61 MP.
   - Let one LibRaw instance unpack once and process twice. That is a change to the wrapper in the
     build patches. LibRaw's API lets `dcraw_process()` run again with other settings after one
     `unpack()`, but whether the half-size path allows it needs checking.
2. **Batch export decodes every photo twice** (`apps/editor/src/lib/export/raw-render.ts`). The
   half-size decode is only used for the preview proxy that Auto tone and the AI masks analyse.
   Building the proxy from the full image would save 1–2.5 s per photo. The analysis would then see
   slightly different pixels than in the editor, so compare exports before and after.
3. **Decode one photo in parts** (LibRaw's `cropbox`, one worker per part). With 2 parts, the full
   decode of Bayer files took 0.5–0.65× as long, and the parts matched a whole decode byte for byte
   (Nikon, Sony, Leica). It doesn't speed up the half-size decode, and each part holds the whole
   raw file, so memory grows with the parts. With threads on HTTPS it mainly helps plain-HTTP setups.
   Before it can ship:
   - Align the part edges in raw coordinates (`top_margin + y`), not image coordinates (Canon CR3
     failed this).
   - Take the image size from a decode, not from the metadata: a full CR3 is 8191×5463, while the
     metadata says 8190×5462.
   - Expect little for X-Trans: 0.83× the time, and 130 rows differed at the seam with 24 rows of
     overlap.
4. **Keep the decoded half-size image** in the browser's storage (OPFS, keyed by checksum and
   `DECODER`), next to the cached originals. Reopening a photo would then skip the 1–2.7 s decode.
   It costs about 36 MB per 24 MP photo and 92 MB at 61 MP.
5. **Start the full decode's worker early too**, like the half decode's. That saves 40–120 ms.
6. **Tune the thread counts.**
   - More than 4 threads per decode wasn't measured on our files.
   - A batch export started from the editor uses the editor's 4 threads per photo, with 4 photos at
     once.
   - `e2e/bench-export.mjs` can measure both.
7. **Limits inside LibRaw:**
   - The X-Trans demosaic stays on one thread, because LibRaw's OpenMP version of it has threads
     reading pixels that others are writing.
   - The Sony ARW and Nikon NEF decoders unpack on one thread.

   Both would need changes in LibRaw itself.
8. **One compiler for both builds.** The single-threaded build uses Emscripten 5.0.7, the threaded
   one 6.0.4. Their output is identical today. Building both with 6.x would simplify the Docker build;
   check it with `e2e/probe-decoder-compare.mjs` and bump `DECODER` if anything changes.
9. **Robustness:**
   - One long probe run, all five files in one tab, crashed the tab while the PC was short of
     memory. It didn't happen again in 24 decodes in one tab or in the smoke runs.
   - The threaded build may grow to 4 GB; nothing has tested more than about 2.4 GB.
   - Killing the `docker build` client doesn't stop the build, so a memory watchdog for the LibRaw
     builds has to cancel the build itself.

Outside decoding, [Export speed](export-speed.md#possible-speed-ups-with-more-cores) lists moving
the export's resize, sharpen and encode into workers.

## How to measure

- **Opening in the editor:** `node e2e/probe-open-speed.mjs <out-dir> [sony,canon,fuji]` gives the
  median time until the photo shows and the editor's own step timings. `IMMICH_URLS=a,b` compares
  two editor builds ([e2e/README.md](../e2e/README.md)).
  - In the browser, the steps are the `immich-raw:*` entries in the DevTools Performance panel.
  - `e2e/smoke.mjs` prints them after opening.
- **One decode at a time, by LibRaw build:**
  - `node e2e/probe-decoder-compare.mjs <samples-dir>` checks that two builds decode to the same
    bytes and times them.
  - `OLD_LIBRAW`, `NEW_LIBRAW` and `NEW_THREADS` pick the builds and the thread count
    ([packages/libraw](../packages/libraw/README.md)).
- **Bench without the editor:** `node spikes/decode-bench/run-bench.mjs <samples-dir> <out-dir>`.
  - `WARM=1`: the worker start-up.
  - `TILES=2,4`: decoding in parts, checked row by row.
  - `Q=`: half-size decodes only.
- **Memory:** the PC these numbers come from runs short of commit memory when two test runs decode
  40–60 MP RAWs at once. Check free memory before long runs, and treat failures under memory
  pressure as suspect.
