# Test Immich

A throwaway Immich v3.4.0 (with Postgres and Valkey, no machine learning) behind nginx, set up like a
real deployment:

- `/immich-raw/` serves the built editor (`apps/editor/dist`) with the same cross-origin isolation
  headers as production.
- Every other path goes to Immich, with the "Edit RAW" button script added to its pages.

Photos and the database live in Docker volumes, not in this folder. Don't put real photos in here.

The try-it demo ([deploy/demo/](../deploy/demo/README.md)) is the same instance made from the
published images, with the samples and the culler's bursts already uploaded. It has the same address
and login, so the scripts here run against it too.

## Start and seed

From the repository root:

```sh
npm run build                                         # builds the editor into apps/editor/dist
docker compose -f e2e/docker-compose.immich.yml up -d
node e2e/seed.mjs <samples-dir>                       # admin account + uploads every RAW in the folder
```

Sample RAWs: `node spikes/decode-bench/fetch-samples.mjs <samples-dir>` downloads five CC0 files from
raw.pixls.us (~320 MB). Keep that folder outside OneDrive.

Open http://127.0.0.1:8088 and log in as `admin@example.com` / `raw-editor-e2e`. Open a RAW and click
the iris icon at the left of the viewer toolbar.

After rebuilding the editor (`npm run build`), just reload the page. nginx serves the folder directly.

## The culler

```sh
node e2e/culler-up.mjs          # gives it an API key of the test admin and starts it (first build ~1 GB)
node e2e/cull.mjs <out-dir>     # end-to-end test on RAW (DNG) and JPEG bursts, cleans up after itself
```

- **What `cull.mjs` does.** It makes the test bursts from the seeded photos' previews:
  - shots 1.5 stops darker and 1.7 stops brighter, a blurred shot and a shifted one;
  - written as DNG files (`raw-burst.mjs`, using `packages/dng`), RAW + JPEG pairs and JPEGs;
  - all on 2015-06-01.

  Then it checks the stacks, tags, the filmstrip, the user's own choice and undo. Then the
  auto-stack page from Immich's selection bar: the button, the preview, stacking and undo. Last comes
  the stack window: switching shots, Make preferred, Delete others, and the Compare stack button in
  Immich's viewer. Run one at a time: two runs delete each other's test photos.
- **Your own bursts.** `node e2e/seed.mjs <folder>` uploads your own RAW bursts. Then open one in
  the editor and use **Auto-stack…** in the filmstrip.
- **Command line:**
  `docker compose -f e2e/docker-compose.immich.yml exec culler python -m culler run --day YYYY-MM-DD`
  prints what it would do. The commands are in [docs/culler.md](../docs/culler.md#using-it).
- **Stopping it:** `docker compose -f e2e/docker-compose.immich.yml --profile culler stop culler`.

## Variants

- Immich's optional Content-Security-Policy:
  `IMMICH_HELMET_FILE=true docker compose -f e2e/docker-compose.immich.yml up -d`
- Serve another folder at `/immich-raw/`:
  `RAW_EDITOR_DIR=/some/dir docker compose -f e2e/docker-compose.immich.yml up -d`
- The published image in front of Immich (the README's quick setup), built from this checkout, on
  http://127.0.0.1:8089:
  `docker compose -f e2e/docker-compose.immich.yml --profile gateway up -d --build gateway`.
  The test scripts run against it with `IMMICH_URL=http://127.0.0.1:8089`, e.g.
  `IMMICH_URL=http://127.0.0.1:8089 node e2e/smoke.mjs <out-dir>`.
- Plain HTTP without a secure context, like `http://192.168.x.x:2283` at home: `INSECURE=1` makes
  `smoke.mjs` and `probe-dng.mjs` open the pages as `http://immich.test:<port>`, which the browser maps to
  127.0.0.1 (127.0.0.1 itself always counts as secure). Works with `IMMICH_URL` for the gateway, too:
  `INSECURE=1 node e2e/smoke.mjs <out-dir>`.
- Reachable from other devices on the network, e.g. a phone at `http://<pc-ip>:8088`:
  `E2E_BIND=0.0.0.0 docker compose -f e2e/docker-compose.immich.yml up -d proxy` (also works for the
  gateway). That's plain HTTP, so the editor downloads the RAW on every open. Anyone on the network
  can log in with the test password; run the same command without `E2E_BIND` to close it again.
- Decoder build: `node e2e/probe-decoder-compare.mjs <samples-dir>` decodes the samples with
  `packages/libraw/lib` and the npm libraw-wasm 1.6.0 it replaced, and checks the output is the same.
- AI masks: `node e2e/probe-ai-masks.mjs <out-dir> <asset-id>` makes a Sky, Subject, Landscape,
  Object and People mask on one photo (`leica-q2.DNG` has sky, water and a ferry), then exports it.
  It needs internet: the models (about 316 MB) download on first use and stay in the browser
  profile it keeps in `<out-dir>/profile`.
- Profiles: `node e2e/probe-profiles.mjs <out-dir> <asset-id>[,<asset-id>...]` renders seeded RAWs
  with the profiles, in memory only (nothing is saved):
  - `WRITE_BASELINE=<file>` with one build, then `BASELINE=<file>` with another, checks that Color,
    Neutral, Linear and Monochrome render the same pixels in both;
  - `FUJI=<asset-id> RAF=<path to that RAF>` compares the Provia film look with the camera's own
    JPEG inside the RAF over an exposure sweep (lightness percentiles, colourfulness, ΔE), which is
    how `FUJI_BASELINE_EV` was set; it downloads the film looks (about 15 MB) from GitHub;
  - `SHEETS=1` writes a contact sheet of every profile per photo.

  To compare builds side by side, run the editor's dev server from each checkout on its own port
  and point `IMMICH_URL` at it, e.g. `IMMICH_URL=http://localhost:5174`.
- Polygon masks: `node e2e/probe-polygon.mjs <out-dir> [file name part]` draws polygons and a lasso
  on one seeded RAW (`nikon-z7` by default):
  - closing on the first corner, with Enter and with a double-click (which must not zoom);
  - Backspace, Shift+K, corner editing (drag, add on an edge, Alt+click to remove);
  - the mask changing only the inside, and undo.

  Nothing is saved.
- AI Upscale: `node e2e/probe-upscale.mjs <out-dir> [file name part]` checks one seeded RAW
  (`nikon-z7` by default):
  - the preview patch;
  - the size and time check;
  - a 2× download of a centre crop;
  - Cancel;
  - Save to Immich (in the RAW's stack, front photo unchanged, tagged as made from the RAW).

  It removes the copy it uploaded afterwards. Options:
  - `INSECURE=1` checks the plain-HTTP path (one CPU thread: whole photos refused, a small crop
    allowed);
  - `STYLE=natural` checks the slower model;
  - `CROP` sets the side of the crop (0 to 1).

  Against the dev server, start Vite on 127.0.0.1 so that `immich.test` reaches it:
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=immich.test npx vite --port 5180 --host 127.0.0.1`
  (in `apps/editor`), then use `IMMICH_URL=http://127.0.0.1:5180`.

## Screenshots

`node e2e/screenshots.mjs [section ...]` takes the pictures of the guides in `docs/`, into
`docs/images/<section>/`. The sections are getting-started, editing, masks, workflow, export,
upscale, dng, stacking and mobile; without any, it takes them all.

- **Where:** the try-it demo with `--profile culler` is the easiest target. It has the samples,
  the bursts and the culler. Built from a checkout:
  `DEMO_PORT=8091 docker compose -f deploy/demo/compose.yml -f deploy/demo/compose.build.yml -p immich-raw-demo-test --profile culler up -d --build`,
  then `IMMICH_URL=http://127.0.0.1:8091 node e2e/screenshots.mjs`. The test Immich here works too,
  but without the bursts the stacking section is skipped.
- **Downloads:** the AI mask and upscale models and the Fujifilm looks download once, into the
  browser profile in `e2e/out/screenshots-profile`.
- **What it changes:** it resets `fuji-xt5` and saves an edit of it, makes the albums
  "immich-raw samples" and "immich-raw bursts" if missing, and stacks the bursts, then takes the
  stacks apart again.
- **When a section fails:** the page it stopped on is saved as
  `e2e/out/screenshots-failed-<section>.png`. Rendering large RAWs needs a lot of memory; on a
  busy computer a section can fail and simply needs to run again.

## Stop and reset

```sh
docker compose -f e2e/docker-compose.immich.yml stop      # pause, keeps the data
docker compose -f e2e/docker-compose.immich.yml down -v   # delete the instance and all its data
```
