# Decoding speed

How fast the editor opens and decodes a RAW, what has been done about it, and what could still be
improved. State on 2026-11-13. The measurements are in [spike-results.md](spike-results.md).

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
- **A photo opened before, or prefetched, skips the download and the decode.** Then the time goes
  to the page itself (0.1–0.14 s until the editor's code runs), the Immich calls (60–90 ms), reading
  the two cached files (0.2–0.3 s), compiling the shaders (0.1 s) and the first render (40–70 ms).
- **In a new browser profile, compiling the shaders takes 2.7–3.7 s** instead of 0.1 s, the first
  time only. The decode runs alongside it.

## What is done

Two branches, neither merged yet:

- **`feature/decode-speed`: fewer decodes, overlapping steps, and a loading screen that says what
  it is doing.**
  - **The steps around the decode overlap.**
    - The original downloads while the saved edit and the snapshots load.
    - The decoder's worker and its WebAssembly start before the file arrives (`prewarmDecoder()`).
    - The shaders compile while the worker decodes, not during the download: the download's chunks
      are read on the page's thread, which compiling blocks.
    - A cache hit no longer waits for the cache index to be written.

    Together this saves 0.1–0.3 s per open here; more on a slow network.
  - **A reopened photo skips the decode.** Its half-size image and LibRaw's metadata are kept in the
    browser's storage (OPFS), next to the cached originals
    (`apps/editor/src/lib/immich/decoded-cache.ts`). A full-resolution image is never kept.
    - **Size:** 36 MB per 24 MP photo, 67 MB at 45 MP and 92 MB at 61 MP, packed to 0.55–0.66 of
      that (see below).
    - **One limit for both:** originals and decoded images share 800 MB
      (`apps/editor/src/lib/immich/photo-cache.ts`; the originals had 2 GB of their own before),
      about 5–10 photos of 45–61 MP.
      - The least recently opened go first.
      - The photo being edited and the prefetched neighbours stay while the page is open.
      - A file that would only fit by pushing them out isn't kept.
    - **Validity:** keyed by Immich's checksum of the original. A file written by another `DECODER`
      or file format is ignored and replaced.
    - **Where it works:** on HTTPS and localhost, like the cache of originals.

    **Gain:** a photo opened before shows after 0.84–1.1 s instead of 2.0–3.6 s. The original and
    the kept image are read side by side in 0.2–0.3 s.
  - **The photos around the open one get ready in the background**
    (`apps/editor/src/lib/immich/prefetch.ts`): the filmstrip's next and previous photo, then the
    two after those. No further: 4 photos at most.
    - **Downloads** start as soon as the photo shows, one at a time, nearest first.
    - **Half-size decodes** wait until the open photo's full-resolution decode is done. Two decodes
      at once would slow that one down and need more memory.
    - **During a save,** both wait.
    - **Skipped:** on plain HTTP (no caches), with Data Saver on, on a mobile network, and when the
      browser reports less than 4 GB of memory.
    - **Only what fits:** a neighbour is fetched only if it fits in the cache next to the photos
      the page keeps, with room set aside for its decoded image. Its size is estimated from
      Immich's file size and sensor size.
    - **The decoded images are packed** (`apps/editor/src/lib/immich/pixel-pack.ts`):
      - **How:** the low bytes of the 16-bit values are stored apart from the high bytes, which
        repeat a lot, and the result is gzipped.
      - **Gain:** 1.5–1.8× smaller (Sony 92 → 61 MB, Fuji 39 → 22 MB), so about a quarter more
        photos fit.
      - **Where it runs:** in a worker, so neither packing (1.2–2.7 s, after the photo shows) nor
        unpacking blocks the page.
      - **Cost:** reading and unpacking a decoded image takes 0.25–0.55 s instead of 0.19–0.27 s.
        It overlaps reading the original and compiling the shaders, so a cached photo showed after
        0.64–1.16 s against 0.84–1.1 s unpacked. The small Fuji files even open sooner.
      - **The RAW files stay as they are:** they are compressed already and shrink only 1–3 %.
    - **Gain:** → and ← then open the photo from the caches, in 0.84–1.0 s instead of 3.4–4.1 s
      (with the page loaded again; see the next point). Getting one 45 MP photo ready took about
      3 s in the background.
  - **The filmstrip, ← and → switch photos inside the page** (`Editor.switchPhoto`), instead of
    loading the editor again.
    - **What stays:** the page and its scripts, the login, the renderer with its compiled shaders,
      the filmstrip and its list, the decoder's worker and the prefetch queue.
    - **What goes:** the open photo is put away first (`closePhoto`). Its running full-resolution
      decode, download and half-size decode are stopped, and everything that belongs to it is
      reset: edit, history, masks, lens data and the offers.
    - **Late results:** each open has a number. Background work that finishes later (the lens
      profile, the sidecar check, Immich's preview) checks it and drops its result if another
      photo is open by then.
    - **The address bar follows** (`history.pushState`), so reloading opens the same photo and the
      browser's Back and Forward go through the photos opened.
    - **Unsaved changes** asked first at the time, as when leaving; they now stay as a draft
      ([Workflow → Drafts](workflow.md#drafts)).
    - **Gain:** in one browser session, on the same cached Fuji photos, a switch inside the page
      showed the photo after 0.53–0.88 s (median 0.86 s). Loading the page with it took
      0.87–1.52 s (median 1.27 s).
      - **Where the rest goes:** about 0.25 s is reading and unpacking the decoded image.
      - **First render:** 1–4 ms, against 40–70 ms after loading the page.
    - **Memory:** 12 switches in one tab kept the browser at 1.7–2.0 GB, so the old photo's memory
      is freed.
  - **The loading screen lists the steps:** photo info, the original, the decode and the first
    render. Each step shows how long it took or should take, and the bar shows the time left
    (`apps/editor/src/lib/ui/OpenProgress.svelte`).
    - **Only for slow opens:** the list shows when an open should take more than a second, or
      after a second when it takes longer than expected. A quick switch shows none of it.
    - **Over a picture of the photo,** which sits where the photo will appear and at its size, so
      nothing moves when the photo is ready. The picture is the first of these
      (`Editor.showPreview`):
      1. **What the editor showed last time,** if the saved edit is still the same: a JPEG of the
         canvas, kept in the photo cache (`apps/editor/src/lib/immich/view-cache.ts`; 0.2–0.8 MB).
         It is taken right after a render that shows the saved edit plainly: no before view,
         clipping, mask overlay, zoom or crop tool, with the lens profile and the AI masks in place.
      2. **The saved JPEG's preview in Immich,** for a photo with a saved edit.
      3. **Immich's preview of the RAW.** It looks different from the editor's render: Immich
         converts the RAW its own way, brightening it automatically (or shows the camera's JPEG),
         in Display P3, and without the saved edit.
    - **Estimates** are moving averages of earlier opens in this browser, kept in `localStorage`
      (`apps/editor/src/lib/state/open-times.ts`).
      - **Decode times:** per camera (make, model, file type); a camera seen for the first time is
        estimated per MB of RAW file.
      - **Downloads:** the screen shows the megabytes and the speed, and the estimate follows the
        actual speed.
    - **Full resolution:** the title line counts down to the full-resolution image the same way.
  - **Measuring tools:**
    - the editor's `immich-raw:*` timings;
    - `e2e/probe-open-speed.mjs`, with a `next` case for the prefetched neighbour;
    - the bench's `WARM` and `TILES` options.
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
4. **Keep the neighbours' decoded images unpacked in memory.** A switch to a prefetched photo then
   skips reading and unpacking its decoded image (0.25 s of the 0.5 s), at 40–90 MB of memory per
   photo kept.
5. **Get the photo ready from Immich's own viewer.** The buttons script runs on Immich's pages, at
   the same address as the editor, so it shares the editor's storage. While a RAW is shown in
   Immich, it could download the original into the cache, so that Edit RAW skips the download.
   Decoding there too would need the decoder in Immich's page, which is heavier.
6. **Compile the shaders without blocking the page** (`KHR_parallel_shader_compile`). In a new
   browser profile the shaders took 2.7–3.7 s to compile, blocking the page's thread (0.1 s once
   the browser has them cached). The first open after installing or updating the browser waits for
   it. With the extension, the compile runs in the GPU process and the renderer checks for
   completion later, so the compile no longer blocks the page.
7. **Batch export could use the kept half-size images** for the photos opened before (see 2.).
8. **Start the full decode's worker early too**, like the half decode's. That saves 40–120 ms.
9. **Tune the thread counts.**
   - More than 4 threads per decode wasn't measured on our files.
   - A batch export started from the editor uses the editor's 4 threads per photo, with 4 photos at
     once.
   - `e2e/bench-export.mjs` can measure both.
10. **Limits inside LibRaw:**
    - The X-Trans demosaic stays on one thread, because LibRaw's OpenMP version of it has threads
      reading pixels that others are writing.
    - The Sony ARW and Nikon NEF decoders unpack on one thread.

    Both would need changes in LibRaw itself.
11. **One compiler for both builds.** The single-threaded build uses Emscripten 5.0.7, the threaded
    one 6.0.4. Their output is identical today. Building both with 6.x would simplify the Docker build;
    check it with `e2e/probe-decoder-compare.mjs` and bump `DECODER` if anything changes.
12. **Robustness:**
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
  - It opens each RAW three ways: in a fresh browser profile, again (from the caches), and its
    filmstrip neighbour after the prefetch (`canon-lr` and the `DSCF…` series have one).
  - The browser it starts keeps its shader cache across the runs, so only the first open of a run
    pays for compiling the shaders (2.7–3.7 s in a new profile).
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
