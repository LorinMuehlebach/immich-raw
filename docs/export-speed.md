# Export speed

A batch export (an album, or photos selected in Immich) renders every RAW in the browser:

1. **Download:** the original is downloaded, unless it is already in the browser's RAW cache.
2. **Decode:** LibRaw decodes the RAW in a Web Worker on one core. This is the slow step.
3. **Render:** the edit is applied on the GPU.
4. **Finish:** the result is resized, sharpened and encoded on the page.

Several photos can be in progress at once ("At once" in the export dialog). Each one decodes in a worker of
its own, so more at once uses more cores; the GPU still renders one photo at a time.

## Measured

`node e2e/bench-export.mjs` on 2026-11-11:
- **Computer:** a laptop with an AMD Ryzen 7 7840U (8 cores, 16 threads), 32 GB of RAM and the integrated
  Radeon 780M, running Edge 157 headless.
- **Test Immich:** on the same computer, so downloads cost almost nothing.
- **Preset:** High (full size, JPEG quality 95), with the originals already in the RAW cache.

Each figure comes from one run; decode times can vary by up to 2× between runs.

**16 × Fuji X-T30 RAF (26 MP, X-Trans):**

| At once | Time | Per photo | Speed-up | Browser memory |
|---|---|---|---|---|
| 1 | 270 s | 16.9 s | 1.0× | 3.4 GB |
| 2 | 129 s | 8.1 s | 2.1× | 3.9 GB |
| 4 | 69 s | 4.3 s | 3.9× | 4.3 GB |
| 8 | 66 s | 4.1 s | 4.1× | 7.0 GB |
| 16 | 74 s | 4.6 s | 3.6× | 10.7 GB (free RAM fell to 1.7 GB) |

**8 RAWs of 40–65 MP:** Sony A7R V, Fuji X-T5, Canon R5 (2), Leica Q2, Nikon Z 7 (NEF and 2 DNGs).

| At once | Time | Per photo | Speed-up | Browser memory |
|---|---|---|---|---|
| 1 | 139 s | 17.4 s | 1.0× | 4.3 GB |
| 2 | 80 s | 10.0 s | 1.7× | 5.0 GB |
| 4 | 51 s | 6.4 s | 2.7× | 6.4 GB |
| 8 | 40 s | 5.0 s | 3.5× | 10.9 GB |

- **Up to 4 at once, time falls almost in proportion.** 4 at once is 3.9× faster for the 26 MP files.
- **Beyond 4 it levels off at about 4–5 s per photo.** The GPU render and the page's own work (resizing,
  sharpening, encoding the file) handle one photo at a time and become the limit.
- **8 at once still pays off for large files,** where decoding takes longest: 23 % faster than 4 for the
  40–65 MP set, and 5 % for the 26 MP set.
- **16 at once was slower than 8.** It needed 10.7 GB, and Windows started moving memory to disk.
- **Memory:** each photo in progress adds about 0.5 GB (26 MP) to 1 GB (40–65 MP) of browser memory, on
  top of 3–4 GB for the page.

## The default

Unless you pick a number, the dialog picks one from the device:

| Device | At once |
|---|---|
| Computer | 4 |
| Phone or tablet | 2 (1 when the browser reports less than 4 GB of memory) |

4 is where the measured speed-up flattens out, at 4–6 GB of browser memory. On a computer with 16 or more
threads and plenty of memory, 8 can be up to a quarter faster for large RAWs. Your choice (1–16) is kept in
the browser. Too many at once can crash the browser tab or make Windows move memory to disk, which is slower.

## What HTTPS adds

The export runs on plain HTTP too, and the photos-at-once speed-up works there as well: it uses Web Workers,
which need no special page. HTTPS (or `localhost`) gives the browser more to work with:

- **RAW cache.** Downloaded originals are kept in the browser's private storage (up to 2 GB) and reused by
  the editor and later exports. Browsers only allow this storage on HTTPS. Over plain HTTP every export
  downloads every original again, 450 MB for the 8 RAWs above. Even with Immich on the same computer, 4 at
  once took 10 % longer over HTTP (56.5 s instead of 51.3 s; 1 at once: 139.4 s against 139.0 s). Over a
  network the gap grows with the download time: about 36 s more per export at 100 Mbit/s.
- **Memory figure.** Browsers report the device's memory (`navigator.deviceMemory`, Chrome and Edge) only on
  HTTPS; a phone that reports less than 4 GB exports one photo at a time. Edge 157 reports 32 GB on the
  computer above; older Chrome and Edge versions report at most 8 GB.
- **Writing into a folder** (Chrome and Edge). Over HTTP the photos are collected into one ZIP, which the
  browser holds until the export is done.

HTTPS doesn't make a single decode faster. LibRaw decodes a photo on one thread. The npm build of
libraw-wasm links WebAssembly threads, which need HTTPS and a cross-origin isolated page, but never
starts one, and it decoded no faster than our build without them
([spike results](spike-results.md#single-threaded-libraw-build-e2eprobe-decoder-comparemjs-2026-11-11)).
More cores help only by decoding more photos at once.

## Possible speed-ups with more cores

Neither of these needs HTTPS:
- **Do the page's work in workers.** Resizing, sharpening and encoding run on the page, one photo at a
  time; that is where 8 and more at once level off. In workers, more at once would keep paying off on
  computers with many cores.
- **Decode one photo in parts** on several workers (LibRaw's `cropbox`). This would also make single
  exports and opening a photo in the editor faster.
