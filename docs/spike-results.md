# M0 spike results

Measured 2026-11-10 on the dev machine: Windows 11, 16 threads, AMD Radeon 780M (integrated),
Microsoft Edge (Chromium) driven by Playwright. Sample files are CC0 files from raw.pixls.us
(`spikes/decode-bench/fetch-samples.mjs`). The runners are in `spikes/decode-bench/`.

## Summary

| Item | Result | Decision |
|---|---|---|
| libraw-wasm 1.6.0 decodes CR3, NEF, ARW, RAF (X-Trans), DNG | **Go** | Keep libraw-wasm |
| Linear camera-RGB output | **Go, after a fix**: `gamm` must be a 6-value array | Pass `gamm: [1, 1, 0, 0, 0, 0]` |
| `highlight: 1` clip points = 65535 · mul_c / max(mul) | **Go**: exact on Leica, Nikon, Sony | Highlight reconstruction can rely on it |
| Metadata needed by the pipeline | **Go**: all present on all 5 files | — |
| Half-size decode as proxy source | **Go**: 1.3–1.9 s (X-Trans 2.7 s) | Editing starts on half-size |
| Full decode time | AHD 5–10 s; DHT 11–14 s; X-Trans 4–33 s | **AHD default** (not DHT); X-Trans default quality 2 |
| Peak memory / worker dispose | ≤ 2.4 GB browser total at 61 MP; terminating the worker frees it | Keep one worker per decode |
| Our camera → sRGB matrix math vs LibRaw | **Go**: mean ΔE76 0.01, 0 % of pixels > 2 | — |
| WebGL2 RGBA16F proxy (2560 px) | **Go**: 2.4 ms/frame edit pass; 31 ms with 12 full-res 31-tap blurs | WebGL2 stays; big filters must run on downscaled levels |
| JPEG encode at 45 MP | jSquash 5.5–19 s; native `convertToBlob` 1.4 s | **Native encoder by default**, jSquash as fallback |
| Immich API + browser checks (v3.3.6, CSP off and on) | **Go**: 13/13 in both runs | See "Immich" below |

## Details

### Decoding (`run-bench.mjs`, settings from the plan)

`outputColor: 0, outputBps: 16, gamm: [1,1,0,0,0,0], noAutoBright: true, useCameraWb: true, userFlip: 0, highlight: 1`

| File | MP | Half | Full DHT (q11) | Full AHD (q3) | Peak browser MB (DHT / AHD) |
|---|---|---|---|---|---|
| Canon R5 CR3 | 44.7 | 1.4 s | 13.2 s | 5.1 s | 1817 / 1350 |
| Fuji X-T5 RAF (X-Trans) | 40.1 | 2.9 s | 33.7 s | 32.9 s | 1277 / 1458 |
| Leica Q2 DNG | 47.3 | 1.4 s | 10.9 s | 5.2 s | 1973 / 1480 |
| Nikon Z7 NEF | 45.7 | 1.9 s | 11.6 s | 5.7 s | 1864 / 1390 |
| Sony A7R V ARW | 61.0 | 1.7 s | 13.8 s | 6.7 s | 2401 / 2354 |

- **X-Trans** ignores the Bayer algorithms. LibRaw uses 3-pass Markesteijn at quality ≥ 3 (33 s). Other quality
  levels measured: q0 4.1 s, q1 10.5 s, q2 16.7 s.
  Default: q2 in the background while the user edits on the half-size proxy; 3-pass only as an export option.
  Possible later speed-up: decode quarters in parallel workers via LibRaw's `cropbox`.
- **Decode times vary by up to 2×** between runs: Nikon AHD took 5.7 s in one run and 9.8–10.1 s in another.
  Treat the numbers as ranges.
- **Memory** is the total private memory of the headless Edge processes, sampled every 250 ms. It includes the
  page's own copies of the input file and the output image. After `dispose()` it falls back to 0.4–0.8 GB, so
  terminating the worker frees the WASM heap. At 61 MP the peak is 2.4 GB, which leaves little headroom for
  100 MP files (Fuji GFX 100, Hasselblad). The page must drop its own copies early.
- **`gamm` bug:** `libraw_wrapper.cpp` copies `gamm` only if `length === 6`, while `index.d.ts` types it as
  `[number, number]`. A 2-value array is silently ignored, and the output stays BT.709 gamma-encoded.
  `aber` has the same mismatch (4 vs 3). Worth reporting upstream; our decoder package must wrap the settings.
- **Clip points** with `highlight: 1`: measured channel maxima equal 65535 · mul_c / max(mul) exactly where the
  scene clips (Leica 65535/32109/47787, Nikon 65535/39107/54688, Sony 65535/26462/45946). The Canon and Fuji
  frames don't saturate every channel, so their maxima stay below the formula, as expected.
- **Metadata:** `cam_mul`, `pre_mul`, `rgb_cam`, `cam_xyz`, `black`, `maximum` are present for all files.
  The DNG also has `dng_color` with illuminants 17/23 (no ForwardMatrix in this file), `asshotneutral` and
  `baseline_exposure`.
- **DNG lens corrections:** the Leica Q2 preview shows strong vignetting and distortion. These DNGs rely on
  embedded opcodes (WarpRectilinear, FixVignetteRadial), which LibRaw doesn't apply. M4 must read and apply DNG
  opcode lists in addition to lensfun.

### Color math (`encode.js`, Nikon Z7, half size)
Our path (camera RGB × `rgb_cam`) vs LibRaw `outputColor: 1` (linear sRGB): mean ΔE76 0.01 over 1.6 M sampled
pixels, none above 2. The metadata matrix is exactly what LibRaw applies, and the channel order is right.
The previews (`*.preview.png` from `run-bench.mjs`) show correct white balance and color on all five cameras.

### GPU (`gpu.js`, Sony A7R V half-size → 2560×1706 RGBA16F)
- Renderer: ANGLE / D3D11 on the Radeon 780M. `EXT_color_buffer_float` and timer queries are available;
  max texture size is 16384.
- Upload + proxy build: 0.7 s, including a CPU Uint16 → Float32 conversion. Uploading half floats directly or
  using `EXT_texture_norm16` should be faster.
- Edit pass (WB, matrix, exposure, contrast, filmic curve, sRGB): 2.4 ms/frame.
- Edit pass + 12 full-resolution 31-tap blur passes (a deliberately pessimistic stand-in for multiscale work):
  31 ms/frame (32 fps).
- Conclusion: WebGL2 is fast enough, provided large-radius filters run on pyramid levels rather than full proxy
  resolution, and the 1280-px draft is used while dragging.

### JPEG encode (`encode.js`, 8288×5520 RGBA)
| Encoder | Time | Size |
|---|---|---|
| jSquash MozJPEG q92 4:4:4 progressive | 19.0 s | 8.2 MB |
| jSquash MozJPEG q92 4:4:4 baseline | 9.3 s | 8.4 MB |
| jSquash MozJPEG q92 4:2:0 baseline | 5.5 s | 5.0 MB |
| Native `OffscreenCanvas.convertToBlob` q0.92 | 1.4 s | 6.5 MB |

Decision: use the native encoder where the canvas size is allowed (Chromium and Firefox). Use jSquash baseline
4:4:4 for Safari's canvas-area limit and as a "maximum quality" export option. Either way, encoding runs in a
worker with progress shown.
The CPU RGBA8 conversion took 3.6 s. In the real export the GPU tiles produce RGBA8 directly.

### Immich (`spikes/immich-api/check.mjs` against `e2e/docker-compose.immich.yml`)
Throwaway Immich v3.3.6 + Postgres + Valkey behind nginx, set up as in the planned deployment: `/raw-editor/`
is served with COOP/COEP/CORP, and every other path goes to Immich, with `inject.js` added before `</head>`.
Run twice: with `IMMICH_HELMET_FILE=false` (the default) and with `IMMICH_HELMET_FILE=true`. All 13 checks
passed both times.

| Check | Result |
|---|---|
| Upload with the DTO `metadata` field | Works: send it as a JSON string. The key is readable right away via `GET /assets/{id}/metadata`. |
| Sidecar download | `GET /asset-files?assetId=&type=sidecar` → `/asset-files/{id}/download` returns the uploaded XMP. |
| Immich's own sidecar write (after a rating change) | Keeps the `crs:` data and adds the rating, so Lightroom settings survive. |
| `createStack([render, cameraStack.primary, raw])` | Render becomes primary; all 3 assets end up in one stack. The old stack is deleted (`GET` returns 400). |
| Re-save: new render on top, old one trashed | Works. Trashed assets disappear from the stack's asset list; the primary stays the new render. |
| Duplicate upload of a trashed asset | 200 `duplicate` with the **same id**, still trashed. `POST /trash/restore/assets` restores it. |
| Non-primary member passed to `createStack` | Moved to the new stack; its old stack is **left with 1 asset**. The stack planner must avoid this. |
| Metadata value size | 16 KB to 4 MB accepted; 16 MB → 500. The recipe budget (64 KB) has plenty of headroom. |
| UpdateAssetDto | rating 0 → 400; rating 5 → 200; latitude without longitude → 400; both → 200. |
| Same-origin cookie auth from `/raw-editor/` | `GET /api/users/me` → 200 with the session cookie, while the page is cross-origin isolated. The cookie is httpOnly (not visible to JS), as expected. |
| Inject script with CSP off and on | Runs and adds the button to `[data-testid="asset-viewer-navbar-actions"]`; no CSP errors. |

Things learned along the way:
- **Immich bug:** when the upload's `filename` field is set, `canUploadFile` (asset-media.service.ts) also
  validates the *sidecar* part against it, and rejects it with "Unsupported file type x.CR3". Workaround: omit
  `filename` when uploading a sidecar. The editor never uploads sidecars; only E2E seeding does.
- **Actual CSP:** with `IMMICH_HELMET_FILE=true`, the policy includes `script-src 'self' 'wasm-unsafe-eval'
  'unsafe-inline' https://www.gstatic.com` and `frame-ancestors 'self'`. A same-origin `src` script is fine
  either way.
- **Test tooling only:** Node's `fetch` on Windows fails on large multipart uploads (ENOBUFS / connection
  resets), so the check script uploads through curl.
- **nginx:** use `resolver 127.0.0.11` + a variable `proxy_pass`, so a restarted Immich container is found
  again. Immich also needs to wait for a healthy database.
- **Button styling:** copying the icon buttons' `className` makes a text link look dim and wrap. The M1 button
  should be an icon button with a tooltip, like Immich's own.

### Culler (`spikes/immich-api/cull-check.mjs`, Immich 3.4.0)

What the culler (services/culler) relies on. Measured 2026-11-11.

| Check | Result |
|---|---|
| `filter.createdAt` in `/search/metadata` | Is the upload time: the watcher finds new uploads with it. |
| Search results with `filter` | Include stacked members, but carry no `stack`, `tags` or `exifInfo` (unless `withExif`). `GET /assets/{id}` has them. |
| `PUT /tags` with `A/B/C` | Creates the parents too and returns the leaf tags. |
| `PUT /assets {ids, rating: -1}` | Accepted, readable right away, but **empty again ~2 s later**. Immich rewrites the sidecar and re-reads the metadata, and its reader only accepts 1–5 (`metadata.service.ts`: `validateRange(exifTags.Rating, 1, 5)`). Same for RAW files. |
| Stack left with one photo | Not deleted: the culler deletes it itself. |
| Removing a stack's primary | 400 "Cannot remove stack's primary asset". |
| `updateStack` to a non-member | 400 "Primary asset must be in the stack". |
| `size=fullsize` thumbnail | Same as `preview` (2161×1440 for a 61 MP RAW) unless full-size previews are turned on. |
| Bulk metadata (`PUT`/`DELETE /assets/metadata`) | Works. |
| Webhook workflow step | Fires once per photo for both `AssetCreate` and `AssetMetadataExtraction`. Body `{type, trigger, data: {asset: {id, ownerId, …}}}`, plus the configured header. |
| **RAW previews** (test DNGs, see `e2e/raw-burst.mjs`) | Immich renders them with LibRaw's automatic brightness: the preview of a frame 1.5 stops darker measured exactly like the normal one (0.00 EV), and +1.7 EV showed only +0.69 EV. Decoding the RAW with `no_auto_bright` gives −1.50 / +1.70 EV. **Decision:** the culler measures RAW exposure on the RAW file. |
| API key permissions | All the culler's calls work with `asset.read/view/download/update`, `album.read`, `user.read`, `stack.*` (create, read, update, delete), `tag.create/read/asset`. |

### Single-threaded LibRaw build (`e2e/probe-decoder-compare.mjs`, 2026-11-11)

The npm libraw-wasm 1.6.0 is linked with pthreads but never starts a thread. Its shared WebAssembly
memory is what made the editor need a cross-origin isolated page, and so HTTPS.
`packages/libraw` rebuilds it without pthreads (same Emscripten 5.0.7, sources and flags). Both
builds ran the editor's decodes in headless Edge on the same machine. The table shows the fastest
of 2 runs each; the half-size rows for Canon and Sony were re-run 6 times (first runs: +23 % and
+21 %, noise).

| File | Step | Size | Output | npm (ms) | new (ms) |
|---|---|---|---|---|---|
| Canon R5 CR3 | half | 4095×2731 | identical | 907 | 897 |
| | full (AHD) | 8191×5463 | identical | 5733 | 5113 |
| | sensor (lossless DNG) | 8191×5463 | identical | 1956 | 1797 |
| Fuji X-T5 RAF | half | 3876×2589 | identical | 2874 | 2885 |
| | full (q2) | 7752×5178 | identical | 14630 | 14690 |
| | best (3-pass, lossy DNG) | 7752×5178 | identical | 32035 | 29446 |
| | sensor | 7752×5178 | identical | 2746 | 2713 |
| Leica Q2 DNG | half | 4196×2816 | identical | 1167 | 1121 |
| | full | 8392×5632 | identical | 4563 | 4554 |
| | sensor | 8392×5632 | identical | 1810 | 1754 |
| Nikon Z7 NEF | half | 4144×2760 | identical | 1680 | 1711 |
| | full | 8288×5520 | identical | 4788 | 4904 |
| | sensor | 8288×5520 | identical | 2093 | 2064 |
| Sony A7R V ARW | half | 4783×3187 | identical | 1382 | 1390 |
| | full | 9566×6374 | identical | 5936 | 5885 |
| | sensor | 9566×6374 | identical | 2174 | 2052 |

"Identical" means the same bytes in the image (or raw sensor data) and in the full metadata.
Speed is unchanged within the run-to-run noise.

### Opening a photo: where the time goes (2026-11-12)

Same machine; the shared e2e Immich was running. Two measurements:
- **Bench:** `Q= WARM=1 TILES=2 node spikes/decode-bench/run-bench.mjs`, the npm libraw-wasm build in
  headless Edge.
- **Editor:** `e2e/probe-open-speed.mjs`, 3 opens per file and cache state, alternating between two
  editor builds. Timed from navigating to the editor until the photo shows.

**`open` only parses the file (35–170 ms). Unpacking and processing both happen in `imageData`.**
On a worker started 2 s earlier, `open` took 35–77 ms instead of 58–157 ms. So starting the worker
early saves 20–120 ms.

**Splitting a decode into 2 horizontal stripes (`cropbox`, 24 rows of overlap, 2 workers at once):**

| File | Half: whole | Half: 2 stripes | Full: whole | Full: 2 stripes | Stripes identical |
|---|---|---|---|---|---|
| Canon R5 CR3 | 1073 ms | 874 ms | 4286 ms | 2292 ms | no (see below) |
| Fuji X-T5 RAF (q2) | 2426 ms | 2296 ms | 14904 ms | 12357 ms | half yes, full no (130 of 5178 rows) |
| Leica Q2 DNG | 2527 ms | 2950 ms | 9665 ms | 3848 ms | yes |
| Nikon Z7 NEF | 1946 ms | 1931 ms | 5864 ms | 3644 ms | yes |
| Sony A7R V ARW | 1686 ms | 1758 ms | 5929 ms | 3858 ms | yes |

- **The half decode doesn't get faster.** Each worker still unpacks the whole file, and the unpacking is
  most of a half decode.
- **Bayer full decodes take 0.5–0.65× as long** (the Leica "whole" run was slow; earlier runs measured
  4.6–5.2 s).
- **X-Trans gains little:** 0.83×.
- **Canon CR3 fails the check** for two reasons:
  - its full decode is 8191×5463, while LibRaw's metadata says 8190×5462, so the stripes were cut
    1 pixel too narrow;
  - the half-size stripes are binned on a different colour-pattern phase.

  Stripe edges must be aligned in raw coordinates (`top_margin` + y), not just in image coordinates.
- **Memory:** with 2 stripes, the browser's peak was up to 0.4 GB higher than for one decode.

**Editor, median ms until the photo shows** (before: main; after: the original downloads alongside
the recipe, the worker starts early, the shaders compile during the decode, and a cache hit doesn't
wait for the cache index):

| File | Original | Before | After |
|---|---|---|---|
| Sony A7R V ARW | downloaded | 3432 | 3104 |
| | from cache | 2247 | 2290 |
| Canon CR3 | downloaded | 2189 | 2077 |
| | from cache | 1712 | 1616 |
| Fuji X-T5 RAF | downloaded | 3664 | 3702 |
| | from cache | 3308 | 3331 |

The editor's own timings (`immich-raw:*` measures, after):

| Step | Time |
|---|---|
| asset info | 10–30 ms |
| recipe and snapshots | 15–80 ms |
| download over localhost | 320–820 ms (cache hit: 45–160 ms) |
| renderer (shader compiling) | 50–100 ms |
| half decode (Canon, Sony, Fuji) | 1.0, 1.5–2.0, 2.3–2.7 s |
| first render | 40–50 ms (Fuji: 160–280 ms) |

**The half decode is 60–75 % of the time until the photo shows.** Reordering the steps around it
saves 0.1–0.3 s on this machine and network, mostly on downloads. Making the half decode itself
faster takes a faster unpack, i.e. threads in the decoder.

### Opening from the browser's cache and prefetching (2026-11-13)

`e2e/probe-open-speed.mjs`, 3 runs per file and case, alternating between two builds on the same
test Immich:
- **before:** the `testing` build, with none of the open speed-ups;
- **after:** `feature/decode-speed`.

The second case keeps the half-size image in the browser's storage, and the third case prefetches
the filmstrip's neighbours.

| File | Open | Before | After |
|---|---|---|---|
| Sony A7R V ARW (61 MP) | first | 4715 | 3884 |
| | again | 3601 | 1097 |
| Canon R5 CR3 (45 MP) | first | 2609 | 2235 |
| | again | 2023 | 841 |
| | → next (`canon-r5`) | 3372 | 997 |
| Fuji RAF (`DSCF7860`) | first | 2920 | 2808 |
| | again | 2710 | 851 |
| | → next | 4125 | 840 |

Median ms until the photo shows.
- **first:** a fresh browser profile.
- **again:** the same photo once more.
- **→ next:** the neighbour, after the editor had prefetched it.

The probe's browser keeps its shader cache between runs.

The editor's timings on a reopened or prefetched photo (`immich-raw:*`, medians):

| Step | Time |
|---|---|
| page start (navigation until the editor's code runs) | 100–140 ms |
| session, photo info, saved edit and snapshots | 60–90 ms |
| original from the cache | 170–260 ms |
| decoded image from the cache, at the same time | 190–270 ms |
| renderer (shader compiling), at the same time | 90–120 ms |
| first render | 40–70 ms |

- **The kept image is larger than the RAW:** 67 MB for the 45 MP Canon (its CR3 is 41 MB), and about
  92 MB at 61 MP. Reading it at 250–300 MB/s still beats decoding by 0.9–1.6 s.
- **Writing it** takes 0.14–0.27 s, after the photo shows.
- **Prefetching one 45 MP CR3** (download and half-size decode) took 3 s.
- **In a new browser profile, the shaders took 2.7–3.7 s to compile.**
  - Compiling while the original downloaded stalled the download, whose chunks are read on the
    page's thread: 41 MB took 3.1 s instead of 0.6 s.
  - Compiling right after the decode started stalled the decode between its round trips to the
    worker.
  - The editor now compiles once the worker has started unpacking, or, when both files are
    cached, while they are read.
- **Prefetching four neighbours** (`DSCF7860.RAF`, 26 MP Fuji):
  - The photo showed at 3.2 s, and its kept image was written by 3.7 s.
  - The four originals downloaded at 3.7–5.1 s, during the full-resolution decode, which ran until
    15.7 s.
  - The four half-size decodes followed, about 2 s each, until 23.7 s.
  - The cache then held 5 photos, 320 MB.
- **Compressing the cache** (in the page, after opening the photos; median of one run):

  | File | Size | Read as is | deflate | shuffle + deflate | delta + shuffle + deflate |
  |---|---|---|---|---|---|
  | Sony half-size image | 92 MB | 95 ms | 1.21×, 424–516 ms | 1.51×, 620–1119 ms | 1.57×, 572–614 ms |
  | Canon half-size image | 67 MB | 59 ms | 1.41×, 307–331 ms | 1.82×, 318–325 ms | 1.85×, 324–371 ms |
  | Fuji half-size image | 39 MB | 89 ms | 1.35×, 169–221 ms | 1.75×, 155–210 ms | 1.73×, 167–186 ms |
  | The RAW files | 25–86 MB | 27–57 ms | 1.01–1.03× | | |

  Each cell gives how much smaller the file gets, and the time to read and unpack it. The two times
  in a cell are gzip and deflate-raw, the formats Edge offers in `CompressionStream`.
  - **Shuffle:** the low bytes stored apart from the high bytes.
  - **Delta:** each value minus the one a pixel to the left.

  Compressing took 0.8–4 s per image, in the background.
  - **The RAW files are already compressed.**
  - **A photo's footprint shrinks 18–28 %**, because the original stays the same size.
  - **Unpacking adds 0.1–0.5 s** in this test, which unpacks on the page's thread.

  **The editor packs the decoded images** with shuffle + gzip, in a worker. Sony 92 → 61 MB and Fuji
  39 → 22 MB; five Fuji photos now take 235 MB instead of 320. In the editor
  (`probe-open-speed.mjs`, 3 runs; uncompressed from the run above):

  | File | Open | Uncompressed | Packed | Decoded image read and unpacked |
  |---|---|---|---|---|
  | Sony A7R V ARW | again | 1097 | 1157 | 272 → 543 ms |
  | Canon R5 CR3 | again | 841 | 1046 | 221 → 365 ms |
  | | → next | 997 | 985 | 206 → 373 ms |
  | Fuji RAF | again | 851 | 724 | 193 → 253 ms |
  | | → next | 840 | 637 | 194 → 228 ms |

  The middle columns are the median ms until the photo shows. Unpacking runs in the worker,
  alongside reading the original and compiling the shaders, so the photo shows at most 0.2 s later.
  The packed Fuji images are so much smaller to read that they open sooner.
- **Switching photos inside the page:** in one session, on the same cached Fuji photos,
  alternating:
  - **switching in the page:** 870, 861, 879, 533, 553 and 537 ms;
  - **loading the page with the photo:** 1387, 1523, 990, 1268, 885 and 873 ms.

  Each time is how long until the photo shows. A switch spends about 0.25 s reading and unpacking
  the decoded image. The first render takes 1–4 ms with the renderer's shaders already compiled.
  - **Memory:** over 12 switches between two photos in one tab, the browser stayed at 1.7–2.0 GB.
  - **One shared worker for packing and unpacking was a mistake:** an open's unpacking waited
    behind packing a neighbour (1–3 s). Each now has its own worker.
- **Smoke test (`e2e/smoke.mjs`, Sony):** 13/13 passed on both builds.
  - Opening took 5.3 s after and 10.5 s before.
  - Saving took 7.6 s after and 14.0 s before, with the PC short of memory.

### AI masks: model choice (2026-11-11)

Candidates had to have a permissive licence (MIT, Apache-2.0, BSD; no non-commercial weights),
run in onnxruntime-web, and be downloadable from a CDN that sends CORS headers (the editor is
cross-origin isolated). Quality was judged on the five samples, a public-domain group photo (NPS,
Bunsen Peak) and a CC BY portrait, with the scripts in [spikes/ai-masks/](../spikes/ai-masks/)
(Python and onnxruntime 1.31 for quality, onnxruntime-web 1.31.1 in Node for WASM speed).

| Masks | Tried | Result | Decision |
|---|---|---|---|
| Subject, Background | IS-Net general int8 (44 MB); ormbg int8 (44 MB, Apache-2.0); BiRefNet_lite fp16 (115 MB, MIT) | IS-Net: clean fruit, colour checker and ferry, 5 s/1 thread. ormbg: took two houses for the subject, 10 s. BiRefNet_lite: needs an 800 MB buffer at 1024 px, failed | **IS-Net** |
| Sky, Landscape | DETR-ResNet50 panoptic int8 (44 MB, Apache-2.0); UperNet ConvNeXt-Tiny ADE20K (238 MB, MIT) | DETR: patchy sky, river taken for sky, houses and tree canopy missed. UperNet: full sky with clouds, houses, river, grass, trees, mountains, ground; 4.4 s/1 thread at 512 px | **UperNet**; ADE20K has no snow: snow is found by colour inside ground/mountain/vegetation |
| People + parts | MediaPipe selfie multiclass (16 MB) + face landmarker (3.8 MB), Apache-2.0 | One pass over a whole group is too coarse (256 px); 256 px tiles over each group from UperNet's person class give clean hair, face skin, body skin and clothes for all 13 hikers. The landmarker's own face detector misses small faces: cropping each face-skin patch first found 18 faces. Lips, teeth, iris, eye whites and brows follow from the landmarks | **MediaPipe**, tiled |
| Objects | SlimSAM-77 int8 (14 MB, Apache-2.0) | Clicks select the lemon and a dead tree well. This export takes no box prompt, and turning a box into points picked the wrong parts. IS-Net on the box (plus 10 %) picks the ferry, a hiker and a solar roof | **SlimSAM for clicks, IS-Net for boxes** |

onnxruntime-web 1.31.1 WASM in Node (same machine as above), one run each:

| Model | 1 thread (plain HTTP) | 4 threads (HTTPS, isolated) | Peak memory |
|---|---|---|---|
| IS-Net 1024² | 13.4 s | 4.0 s | 0.8 GB |
| UperNet 512² | 20.9 s | 5.7 s | 1.3 GB |
| SlimSAM encoder 1024² | 9.6 s | 3.9 s | 2.0 GB |

WebGPU is used when the browser offers it. Every model runs once per photo; its output is kept
in IndexedDB, so reopening the photo or changing the mask doesn't run it again.

Lightroom's XMP codes for AI masks are not documented by Adobe. The ones used (MaskSubType 1 subject,
2 sky, 3 + MaskSubCategoryID for a part of everyone, 0 + 50001-50008 for landscape categories) come
from a Lightroom Classic plugin that recorded them from real catalogs (Automaat/lightroom-mcp).

### AI Upscale: model choice (2026-11-12)

Two permissive super-resolution models with ONNX exports were compared:
- Real-ESRGAN general x4v3 (SRVGGNetCompact, 4.9 MB, BSD-3-Clause, 4× only; dynamic input size).
- RealPLKSR, darktable 5.6's upscaler (30 MB each for 2× and 4×, MIT weights; fixed 512² and 256² input).

Speed was measured with [spikes/ai-masks/upscale-bench.mjs](../spikes/ai-masks/upscale-bench.mjs) (WASM in
Node) and [upscale-bench-webgpu.mjs](../spikes/ai-masks/upscale-bench-webgpu.mjs) (WebGPU in Edge). The
machine was a Ryzen 7 7840U with integrated Radeon 780M graphics, using onnxruntime-web 1.31.1.
Times are per megapixel of input; the right-hand column is a whole 24 MP photo.

| Model | 1 thread (plain HTTP) | 4 threads | WebGPU | 24 MP on WebGPU | Peak memory (WASM) |
|---|---|---|---|---|---|
| Real-ESRGAN x4v3 | 76 s/MP | 25 s/MP | 5.4 s/MP | 2.2 min | 0.2 GB |
| RealPLKSR 2× | 654 s/MP | 238 s/MP | 28 s/MP | 11.3 min | 1.1 GB |
| RealPLKSR 4× | 706 s/MP | 234 s/MP | 29 s/MP | 11.5 min | 1.1 GB |

Quality was compared on 200 px crops of the Leica Q2 and Sony A7R V samples, at 2× next to bicubic.
- Real-ESRGAN gives crisp, clean edges (a ship's mast and its wires) but smooths fine texture: grass
  looks slightly painted.
- RealPLKSR stays natural and keeps texture, with softer edges. It is about 5× slower on a GPU and
  9× slower on the CPU. Its fixed 512² tile alone takes almost 3 minutes on one thread.

**Decision:** Real-ESRGAN is the default ("Sharp"). RealPLKSR is offered as "Natural" for anyone
with a GPU and the patience. Without WebGPU (plain HTTP), one thread is about 80 s per megapixel of
model input. The tiles overlap, so a whole photo costs more: a 0.66 MP crop took 107 s from start to
file in the editor. A 24 MP photo would take about an hour even with Real-ESRGAN, so the tool keeps
to what fits in about 10 minutes there, crops of a few megapixels. Real-ESRGAN makes 2× by
upscaling 4× and averaging 2×2 blocks.

## Still open
- Lightroom's AI mask codes checked against a real sidecar written with AI masks (the importer
  uses codes recorded by a third-party plugin).
- Browser-reserved shortcuts (Ctrl+Shift+C/V): needs real key presses in a headed browser.
