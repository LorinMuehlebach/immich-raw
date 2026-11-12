# Third-party notices

immich-raw is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
It includes the third-party components listed below. Their licence texts are in
[licenses/](licenses/). The built editor serves this file and all of those texts as one page at
`/immich-raw/licenses.txt`, linked from the ⓘ button in the editor's header.

This product includes DNG technology under license by Adobe.

This software is based in part on the work of the Independent JPEG Group.

## Shipped with the editor

| Component | Version | Licence | Source | Licence text |
|---|---|---|---|---|
| LibRaw (RAW decoding) | 0.22.1 | LGPL-2.1 (LibRaw is dual-licensed LGPL-2.1 / CDDL-1.0; used here under LGPL-2.1) | https://github.com/LibRaw/LibRaw/tree/0.22.1 | [LibRaw.txt](licenses/LibRaw.txt), [LGPL-2.1.txt](licenses/LGPL-2.1.txt) |
| libraw-wasm (LibRaw built for WebAssembly) | 1.6.0, built without threads by [packages/libraw/build](packages/libraw/build) | ISC | https://github.com/ybouane/LibRaw-Wasm/tree/v1.6.0 | [libraw-wasm.txt](licenses/libraw-wasm.txt) |
| Little CMS (inside `libraw.wasm`) | 2.19.1 | MIT | https://github.com/mm2/Little-CMS/tree/lcms2.19.1 | [little-cms.txt](licenses/little-cms.txt) |
| IJG libjpeg (inside `libraw.wasm`) | 9f | IJG | https://www.ijg.org/ | [ijg-libjpeg.txt](licenses/ijg-libjpeg.txt) |
| @immich/sdk | 3.4.0 | AGPL-3.0 | https://github.com/immich-app/immich/tree/v3.4.0/packages/sdk | [LICENSE](LICENSE) |
| @oazapfts/runtime (used by @immich/sdk) | 1.2.0 | MIT | https://github.com/oazapfts/oazapfts | [oazapfts.txt](licenses/oazapfts.txt) |
| Svelte | 5.57.3 | MIT | https://github.com/sveltejs/svelte | [svelte.txt](licenses/svelte.txt) |
| clsx (used by Svelte) | 2.1.1 | MIT | https://github.com/lukeed/clsx | [clsx.txt](licenses/clsx.txt) |
| esm-env (used by Svelte) | 1.2.2 | MIT | https://github.com/benmccann/esm-env | [esm-env.txt](licenses/esm-env.txt) |
| @noble/hashes (SHA-1 and SHA-256 on plain-HTTP pages) | 2.4.0 | MIT | https://github.com/paulmillr/noble-hashes | [noble-hashes.txt](licenses/noble-hashes.txt) |
| @jsquash/jpeg (JPEG encoder) | 1.6.0 | Apache-2.0 | https://github.com/jamsinclair/jSquash | [jsquash.txt](licenses/jsquash.txt) |
| MozJPEG / libjpeg-turbo (inside @jsquash/jpeg) | as built by @jsquash/jpeg 1.6.0 | IJG, BSD-3-Clause, zlib | https://github.com/mozilla/mozjpeg | [libjpeg-turbo.md](licenses/libjpeg-turbo.md), [ijg-libjpeg.txt](licenses/ijg-libjpeg.txt) |
| @jsquash/webp, @jsquash/avif, @jsquash/jxl (WebP, AVIF and JPEG XL encoders) | 1.5.0, 2.1.1, 1.3.0 | Apache-2.0 | https://github.com/jamsinclair/jSquash | [jsquash.txt](licenses/jsquash.txt) |
| wasm-feature-detect (used by the jSquash encoders) | 1.10.1 | Apache-2.0 | https://github.com/GoogleChromeLabs/wasm-feature-detect | [Apache-2.0.txt](licenses/Apache-2.0.txt) |
| libwebp (inside @jsquash/webp), and its libsharpyuv (inside @jsquash/avif) | commits d2e245ea and e2c85878 | BSD-3-Clause, with Google's additional patent grant | https://github.com/webmproject/libwebp | [libwebp.txt](licenses/libwebp.txt) |
| libavif (inside @jsquash/avif) | 1.0.1 | BSD-2-Clause (the licence text lists the parts under other terms) | https://github.com/AOMediaCodec/libavif/tree/v1.0.1 | [libavif.txt](licenses/libavif.txt) |
| libaom, the AV1 encoder (inside @jsquash/avif) | 3.7.0 | BSD-2-Clause, with the Alliance for Open Media Patent License 1.0 | https://aomedia.googlesource.com/aom/+/refs/tags/v3.7.0 | [libaom.txt](licenses/libaom.txt) |
| libjxl (inside @jsquash/jxl) | commit 9f544641 | BSD-3-Clause, with Google's additional patent grant | https://github.com/libjxl/libjxl/tree/9f544641ec83f6abd9da598bdd08178ee8a003e0 | [libjxl.txt](licenses/libjxl.txt) |
| Highway, Brotli, skcms (built into libjxl) | as vendored by libjxl 9f544641 | Apache-2.0; MIT; BSD-3-Clause | https://github.com/google/highway, https://github.com/google/brotli, https://skia.googlesource.com/skcms | [Apache-2.0.txt](licenses/Apache-2.0.txt), [brotli.txt](licenses/brotli.txt), [skcms.txt](licenses/skcms.txt) |
| Lensfun lens database (`lensfun/lensfun.json`) | commit 52cf1a7b | CC BY-SA 3.0 | https://github.com/lensfun/lensfun/tree/52cf1a7b0e82e07e0ecaa3391ee5106a6dd1ee54/data/db | [LICENSE.md](apps/editor/public/lensfun/LICENSE.md) |
| Material Icons (back, undo, redo, edit, delete) | | Apache-2.0 | https://github.com/google/material-design-icons | [icons.txt](licenses/icons.txt), [Apache-2.0.txt](licenses/Apache-2.0.txt) |
| Material Design Icons: "camera-iris", "camera-burst", "export-variant", "star-box-multiple-outline" (Immich buttons) | | Apache-2.0 | https://github.com/Templarian/MaterialDesign | [icons.txt](licenses/icons.txt), [Apache-2.0.txt](licenses/Apache-2.0.txt) |
| onnxruntime-web (runs the AI mask models; `/immich-raw/ort/`) | 1.31.1 | MIT; the components built into it are listed in its notices | https://github.com/microsoft/onnxruntime/tree/v1.31.1 | [onnxruntime.txt](licenses/onnxruntime.txt), [onnxruntime-third-party.txt](licenses/onnxruntime-third-party.txt) |
| @mediapipe/tasks-vision (people and face models for AI masks; `/immich-raw/mediapipe/`) | 1.2.2 | Apache-2.0 | https://github.com/google-ai-edge/mediapipe | [mediapipe.txt](licenses/mediapipe.txt) |

## AI models (downloaded at run time, not shipped)

AI masks and AI Upscale download these models from their public hosts the first time they are
needed (after asking) and keep them in the browser. They are not part of immich-raw or its image.

| Model | Used for | Licence | Source |
|---|---|---|---|
| IS-Net (DIS), general use, int8 | Subject, Background, Objects (box) | MIT (int8 conversion); IS-Net Apache-2.0 | https://huggingface.co/xrds/isnet-general-onnx-int8, https://github.com/xuebinqin/DIS |
| UperNet + ConvNeXt-Tiny, ADE20K | Sky, Landscape, where people are | MIT | https://huggingface.co/JElvis/upernet-convnext-tiny-ade-onnx (export of openmmlab/upernet-convnext-tiny) |
| SlimSAM-77 (Segment Anything), int8 | Objects (clicked) | Apache-2.0 | https://huggingface.co/Xenova/slimsam-77-uniform |
| MediaPipe Selfie Multiclass 256 x 256 | People: hair, skin, clothes | Apache-2.0 | https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter |
| MediaPipe Face Landmarker | People: eyes, brows, lips, teeth | Apache-2.0 | https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker |
| Real-ESRGAN general x4v3 (SRVGGNetCompact) | AI Upscale, Sharp | BSD-3-Clause | https://huggingface.co/jonathanst29/tinier-upscale-models (ONNX export of https://github.com/xinntao/Real-ESRGAN) |
| RealPLKSR 2x and 4x, MSSIM pretrain | AI Upscale, Natural | MIT (weights); ONNX packaging GPL-3.0-or-later | https://huggingface.co/darktable-org/upscale-realplksr-onnx (weights from https://github.com/dslisleedh/PLKSR) |

## Fujifilm film looks (downloaded at run time, not shipped)

The Fujifilm film looks in the profile list (Provia, Velvia, Astia, Classic Chrome, Reala Ace,
Pro Neg. Hi and Std, Classic Neg., Nostalgic Neg., Eterna and Eterna Bleach Bypass) use community
look tables. The editor downloads them from GitHub, at the commit below, the first time they are
needed (after asking), converts them to its own format without changing their values, and keeps
them in the browser. They are not part of immich-raw or its image.

| Data | Used for | Licence | Source |
|---|---|---|---|
| FujifilmCameraProfiles by abpy: the eight DCP look tables and tone curves (`xml tables/`) and the three Provia conversion LUTs (`provia conversion luts/*sRGB.cube`) | Fujifilm film looks | CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/) | https://github.com/abpy/FujifilmCameraProfiles/tree/b5a1f16abfb2759b337c83d69d9dc49470e7e518 |

Fujifilm, Provia, Velvia, Astia, Classic Chrome, Eterna and Reala Ace are trademarks of FUJIFILM
Corporation, used here only to name the looks. immich-raw is not affiliated with Fujifilm.

## Code adapted from other projects

- **Lensfun library** (`packages/lens/src/lensfun.ts`): lens matching, coefficient interpolation and
  the distortion, TCA and vignetting models, ported from `libs/lensfun/*.cpp` at commit 52cf1a7b.
  Copyright (C) 2007 Andrew Zabolotny and the Lensfun contributors. Lensfun's library is LGPL-3.0,
  which allows a modified version to be conveyed under the GPL-3.0 (LGPL-3.0 §2b); the GPL-3.0 allows
  it to be combined with AGPL-3.0 code (GPL-3.0 §13). See [LGPL-3.0.txt](licenses/LGPL-3.0.txt) and
  [GPL-3.0.txt](licenses/GPL-3.0.txt).
- **Adobe DNG SDK** (`packages/pipeline/src/color/temperature.ts`): the temperature/tint conversion
  follows `dng_temperature.cpp`. The profile look tables (`packages/pipeline/src/color/dcp.ts` and
  `applyLook` in `packages/pipeline/src/shaders.ts`) follow `RefBaselineHueSatMap` in
  `dng_reference.cpp` and the HSV conversion in `dng_utils.h`. Copyright 2006 Adobe Systems
  Incorporated, used under the DNG SDK License Agreement ([dng-sdk.txt](licenses/dng-sdk.txt)).
- **LibRaw** (`packages/dng/src/lossy.test.ts`, test code only): `librawCurves` re-implements how
  LibRaw 0.22.1 reads the lossy-DNG opcode list, as a reference for the tests. Copyright (C) 2008-2026
  LibRaw LLC, LGPL-2.1 ([LGPL-2.1.txt](licenses/LGPL-2.1.txt)).

## LibRaw: source and replacing it

The LGPL-2.1 lets you replace LibRaw with your own (modified) version. The editor loads it at run
time from separate files, so no rebuild of the editor is needed:

- Deployed editor: `/immich-raw/libraw/` (`index.js`, `worker.js`, `libraw.wasm`); in the Docker
  image that is `/usr/share/nginx/html/immich-raw/libraw/`. In this repository the same files are
  in [packages/libraw/lib/](packages/libraw/lib).
- How they are built: [packages/libraw/build/](packages/libraw/build) builds them in a Docker image
  (`npm run build:libraw -w @immich-raw/libraw`). It takes libraw-wasm's own build script and
  applies one change, [no-pthreads.patch](packages/libraw/build/no-pthreads.patch), which builds
  LibRaw without threads, so the decoder runs on pages without cross-origin isolation.
- Exact sources:
  - libraw-wasm v1.6.0, commit `32fd36a9883a10c1632bc20073f1ea88cc60487a`
    (https://github.com/ybouane/LibRaw-Wasm);
  - LibRaw 0.22.1, tag `0.22.1` (https://github.com/LibRaw/LibRaw);
  - Little CMS 2.19.1, tag `lcms2.19.1` (https://github.com/mm2/Little-CMS);
  - IJG libjpeg 9f, as the Emscripten port in Emscripten 5.0.7 (`emscripten/emsdk:5.0.7`, emcc
    `263db4cffa6f9fc2ec514a70abac81362ea41849`).
- To use your own build, replace those files in the deployed folder, or in `packages/libraw/lib/`
  before `npm run build`.
- Written offer: for at least three years after we last distribute this build, we will give anyone
  who asks the complete corresponding source code of LibRaw, Little CMS and libjpeg as used here,
  for no more than the cost of providing it. Ask by opening an issue at
  https://github.com/LorinMuehlebach/immich-raw.
