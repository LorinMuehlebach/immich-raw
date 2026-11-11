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
| libraw-wasm (LibRaw built for WebAssembly) | 1.6.0 | ISC | https://github.com/ybouane/LibRaw-Wasm/tree/v1.6.0 | [libraw-wasm.txt](licenses/libraw-wasm.txt) |
| Little CMS (inside `libraw.wasm`) | 2.19.1 | MIT | https://github.com/mm2/Little-CMS/tree/lcms2.19.1 | [little-cms.txt](licenses/little-cms.txt) |
| IJG libjpeg (inside `libraw.wasm`) | 9f | IJG | https://www.ijg.org/ | [ijg-libjpeg.txt](licenses/ijg-libjpeg.txt) |
| @immich/sdk | 3.4.0 | AGPL-3.0 | https://github.com/immich-app/immich/tree/v3.4.0/packages/sdk | [LICENSE](LICENSE) |
| @oazapfts/runtime (used by @immich/sdk) | 1.2.0 | MIT | https://github.com/oazapfts/oazapfts | [oazapfts.txt](licenses/oazapfts.txt) |
| Svelte | 5.57.3 | MIT | https://github.com/sveltejs/svelte | [svelte.txt](licenses/svelte.txt) |
| clsx (used by Svelte) | 2.1.1 | MIT | https://github.com/lukeed/clsx | [clsx.txt](licenses/clsx.txt) |
| esm-env (used by Svelte) | 1.2.2 | MIT | https://github.com/benmccann/esm-env | [esm-env.txt](licenses/esm-env.txt) |
| @jsquash/jpeg (JPEG encoder) | 1.6.0 | Apache-2.0 | https://github.com/jamsinclair/jSquash | [jsquash.txt](licenses/jsquash.txt) |
| MozJPEG / libjpeg-turbo (inside @jsquash/jpeg) | as built by @jsquash/jpeg 1.6.0 | IJG, BSD-3-Clause, zlib | https://github.com/mozilla/mozjpeg | [libjpeg-turbo.md](licenses/libjpeg-turbo.md), [ijg-libjpeg.txt](licenses/ijg-libjpeg.txt) |
| Lensfun lens database (`lensfun/lensfun.json`) | commit 52cf1a7b | CC BY-SA 3.0 | https://github.com/lensfun/lensfun/tree/52cf1a7b0e82e07e0ecaa3391ee5106a6dd1ee54/data/db | [LICENSE.md](apps/editor/public/lensfun/LICENSE.md) |
| Material Icons (back, undo, redo, edit, delete) | | Apache-2.0 | https://github.com/google/material-design-icons | [icons.txt](licenses/icons.txt), [Apache-2.0.txt](licenses/Apache-2.0.txt) |
| Material Design Icons, "camera-iris" (Immich button) | | Apache-2.0 | https://github.com/Templarian/MaterialDesign | [icons.txt](licenses/icons.txt), [Apache-2.0.txt](licenses/Apache-2.0.txt) |

## Code adapted from other projects

- **Lensfun library** (`packages/lens/src/lensfun.ts`): lens matching, coefficient interpolation and
  the distortion, TCA and vignetting models, ported from `libs/lensfun/*.cpp` at commit 52cf1a7b.
  Copyright (C) 2007 Andrew Zabolotny and the Lensfun contributors. Lensfun's library is LGPL-3.0,
  which allows a modified version to be conveyed under the GPL-3.0 (LGPL-3.0 §2b); the GPL-3.0 allows
  it to be combined with AGPL-3.0 code (GPL-3.0 §13). See [LGPL-3.0.txt](licenses/LGPL-3.0.txt) and
  [GPL-3.0.txt](licenses/GPL-3.0.txt).
- **Adobe DNG SDK** (`packages/pipeline/src/color/temperature.ts`): the temperature/tint conversion
  follows `dng_temperature.cpp`. Copyright 2006 Adobe Systems Incorporated, used under the DNG SDK
  License Agreement ([dng-sdk.txt](licenses/dng-sdk.txt)).
- **LibRaw** (`packages/dng/src/lossy.test.ts`, test code only): `librawCurves` re-implements how
  LibRaw 0.22.1 reads the lossy-DNG opcode list, as a reference for the tests. Copyright (C) 2008-2026
  LibRaw LLC, LGPL-2.1 ([LGPL-2.1.txt](licenses/LGPL-2.1.txt)).

## LibRaw: source and replacing it

The LGPL-2.1 lets you replace LibRaw with your own (modified) version. The editor loads it at run
time from separate files, so no rebuild of the editor is needed:

- Deployed editor: `/immich-raw/libraw/` (`index.js`, `worker.js`, `libraw.js`, `libraw.wasm`); in
  the Docker image that is `/usr/share/nginx/html/immich-raw/libraw/`.
- Source: LibRaw 0.22.1 (link above) and libraw-wasm 1.6.0, whose `compileLibraw.sh` builds
  `libraw.js` + `libraw.wasm` with Emscripten (LibRaw and Little CMS from source, libjpeg from the
  Emscripten port).
- To use your own build, replace those files in the deployed folder, or put them into
  `node_modules/libraw-wasm/dist/` before `npm run build`.
