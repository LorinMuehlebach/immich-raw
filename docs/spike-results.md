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

## Still open
- Browser-reserved shortcuts (Ctrl+Shift+C/V): needs real key presses in a headed browser.
