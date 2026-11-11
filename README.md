# immich-raw

Lightroom-style RAW editing for [Immich](https://immich.app), right in your browser.

immich-raw adds an **Edit RAW** button to Immich's photo viewer. It opens the RAW file in a full photo
editor: white balance, tone, colour, curves, masks, lens corrections, noise reduction and more. When
you save, the edited photo goes back into Immich as a full-resolution JPEG, stacked on top of the
original. The RAW file itself is never changed, and the edit settings are stored with it, so you can
reopen the photo later and carry on where you left off.

It's an unofficial add-on: a small web app you run next to your own Immich. It isn't affiliated with
Immich or Adobe.

Tested with Immich 3.4.0 in Chromium-based browsers (Chrome, Edge).

## How it works

**1. Open a RAW in Immich and click the iris button** in the viewer's toolbar (outlined in red here).
The button only appears on RAW files, and on edited copies, where it opens the RAW again.

![The Edit RAW button in Immich's photo viewer](docs/images/1-immich-button.jpg)

**2. Edit in the browser.** The RAW is decoded on your computer, not on the server, and your graphics
card renders every change live. The panels follow Lightroom's Develop module: Basic, Tone Curve,
Color Mixer, Color Grading, Detail, Lens Corrections, Transform, Effects and Calibration. Lightroom
presets (`.xmp`) and sidecar files can be imported.

![The editor with Auto tone and a few sliders applied](docs/images/2-editor.jpg)

**3. Make local adjustments with masks:** linear and radial gradients, a brush, and colour and
luminance ranges, each with its own exposure, contrast, colour and sharpness sliders. Here a gradient
darkens the sky; the red overlay shows where it applies.

![A linear gradient mask over the sky](docs/images/3-masks.jpg)

**4. Save.** The full-resolution JPEG is uploaded to Immich and stacked on top of the RAW. It keeps the
RAW's date, location, albums, rating, description and favourite. The two thumbnails at the bottom
left are the stack: the edited JPEG and the RAW. Saving again replaces the JPEG, and the old one goes
to Immich's trash. Leaving with unsaved changes asks whether to save them.

![Back in Immich: the edited photo on top of its stack](docs/images/5-immich-result.jpg)

**5. Optional: convert to DNG to save space.** The DNG… button replaces the RAW in Immich with a
DNG, either lossless (the exact sensor data) or lossy (Adobe's lossy DNG, typically 7 to 15 times
smaller). Before anything is uploaded, the DNG is decoded again and compared with the original.
Albums, stack, tags, rating, favourite, shared links and your edit all move to the DNG; then the
original is deleted (to the trash, or permanently).

![The Convert to DNG dialog after checking a lossy DNG](docs/images/4-dng.jpg)

### Under the hood

- **Same domain as Immich.** The editor is a static web app that your reverse proxy serves under
  `/immich-raw/` on your Immich domain. It uses your existing Immich login and talks to Immich's API
  directly. There is no separate account, and photos aren't processed on the server.
- **RAW decoding:** [LibRaw](https://www.libraw.org) compiled to WebAssembly, running in background
  threads in the browser.
- **Rendering:** a WebGL2 pipeline in a wide linear colour space. It previews at reduced size while
  you drag a slider and renders full resolution for 100 % zoom and for saving.
- **The button:** a small script that the proxy adds to Immich's pages (or a browser userscript).
- **Stored data:** the edit settings live in Immich's asset metadata on the RAW. The original file is
  cached in the browser, so reopening a photo is fast.
- **Culler (optional):** a separate small service that groups bursts of similar shots into stacks,
  puts the best one on top and tags why the others lost (lighting, blur, closed eyes). See
  [Optional: the culler](#optional-the-culler-auto-stack-and-best-pick).

## Features

- **Basic:** profile, white balance (as shot, presets, custom, picker), exposure, contrast, highlights,
  shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation.
- **Auto tone (Ctrl+U)** sets exposure, contrast, highlights, shadows, whites and blacks for the photo.
  Shift+double-click a slider name to set only that slider. The gear next to Auto sets how it behaves.
- **Tone curve:** parametric and point curves, RGB and per channel.
- **Color Mixer:** hue, saturation and luminance for 8 colour bands, with the targeted adjustment tool
  (drag up or down on a colour in the photo); B&W mix for the Monochrome profile.
- **Color Grading** (shadow, midtone, highlight and global wheels, blending, balance) and
  **Calibration** (shadow tint, red/green/blue primaries).
- **Detail:** sharpening with Alt-drag previews; luminance and colour noise reduction.
- **Lens Corrections:**
  - lens profiles from the [Lensfun](https://lensfun.github.io) database (distortion, chromatic
    aberration, vignetting), or the correction a DNG carries;
  - automatic chromatic aberration removal;
  - manual distortion, defringe and lens vignetting.
- **Transform:** vertical and horizontal perspective, rotate, aspect, scale, offsets, Constrain Crop.
- **Effects:** post-crop vignetting (three styles) and grain.
- **Crop and straighten** with aspect presets; rotate 90°.
- **Masking (Shift+W):**
  - linear (M) and radial (Shift+M) gradients;
  - brush (K; Alt erases, `[` and `]` change the size);
  - colour ranges (click a colour, Shift+click to add one);
  - luminance ranges.

  Mask parts can be added, subtracted or intersected, and O shows the overlay.
- **Workflow:**
  - histogram with clipping warnings (J), before/after (`\`), 100 % zoom (double-click the photo);
  - history with named steps, undo/redo;
  - snapshots (stored on the RAW);
  - presets (kept in the browser; Lightroom `.xmp` presets can be imported);
  - copy/paste settings;
  - a filmstrip of the album, person or search you came from.
- **Lightroom XMP sidecar import** on first open: basic, curves, colour mixer, B&W, colour grading,
  calibration, detail, lens corrections, transform, effects, crop and masks. AI masks are skipped.
- **Convert to DNG** (lossless or lossy), described above.

The editor shows its keyboard shortcuts in the right-hand panel.

## Installation

You add one container (the editor) to the Docker Compose setup you run Immich with, and route
`/immich-raw/` to it in your reverse proxy. The proxy also adds the Edit RAW button to Immich's pages.
A second container, the culler, is optional.

### Requirements

- **Immich 3.4.x** (tested with 3.4.0), run with Docker Compose.
- **A reverse proxy in front of Immich** that you can configure: nginx or Caddy for the automatic button,
  or any proxy (Traefik, …) together with the userscript.
- **HTTPS.** The RAW decoder needs the browser's shared memory, which browsers only allow on secure
  origins (`https://…`, or `http://localhost` for testing).
- **A desktop browser with WebGL2:** tested in Chrome and Edge. Large RAWs (45–60 megapixels) need
  about 2 GB of memory in the browser tab.
- **git and Docker on the server.** The images are built from this repository; there are no
  prebuilt images yet.

### 1. Get the code

On the machine that runs Immich, next to Immich's `docker-compose.yml`:

```sh
git clone https://github.com/LorinMuehlebach/immich-raw.git
```

### 2. Add the editor container

Add this service to Immich's `docker-compose.yml`. The path in `context` is where you cloned the
repository, relative to the compose file.

```yaml
services:
  # ... Immich's own services ...

  immich-raw:
    container_name: immich_raw
    build:
      context: ./immich-raw
      dockerfile: deploy/Dockerfile
    restart: always
```

Then build and start it:

```sh
docker compose up -d --build immich-raw
```

The container serves the editor on port 80, under `/immich-raw/` only. It needs no published port:
your reverse proxy reaches it by name. If your proxy runs outside this compose project, put both
on the same Docker network. Or publish a local port (for example `ports: ["127.0.0.1:8090:80"]`)
and point the proxy at `127.0.0.1:8090`.

### 3. Route `/immich-raw/` and add the button

Every path stays with Immich except `/immich-raw/`. The proxy also adds one script tag
(`/immich-raw/inject.js`) to Immich's HTML pages; that script draws the button.

**nginx.** Add the following to the server block for your Immich domain. The complete example,
including the optional culler, is [deploy/immich-nginx.snippet.conf](deploy/immich-nginx.snippet.conf).

```nginx
# http {} level (a file in conf.d/ is already inside http {}):
# Immich's HTML is fetched uncompressed so the script tag can be added.
map $uri $immich_accept_encoding {
  ~^/(_app|api)/ $http_accept_encoding;
  default "";
}

server {
  # ... your existing listen / server_name / ssl settings for Immich ...
  resolver 127.0.0.11 valid=10s;            # Docker's DNS; remove outside Docker
  set $immich_raw http://immich-raw:80;
  set $immich http://immich-server:2283;

  location /immich-raw/ {
    proxy_pass $immich_raw;
    proxy_set_header Host $host;
  }

  location / {
    proxy_pass $immich;
    # ... your existing Immich proxy settings (websocket upgrade, timeouts, body size) ...
    proxy_set_header Accept-Encoding $immich_accept_encoding;
    sub_filter '</head>' '<script defer src="/immich-raw/inject.js"></script></head>';
    sub_filter_once on;
    sub_filter_types text/html;
  }
}
```

**Caddy.** See [deploy/Caddyfile.snippet](deploy/Caddyfile.snippet). Adding the button needs Caddy built
with the `replace-response` plugin (`xcaddy build --with github.com/caddyserver/replace-response`).
Without the plugin, keep only the `/immich-raw/*` route and use the userscript (step 4).

**Traefik and other proxies.** Route the path prefix `/immich-raw/` on your Immich host to the
`immich-raw` container on port 80, then use the userscript for the button (step 4). With Traefik that
means labels like these on the `immich-raw` service (an untested example; adjust the entry point and
TLS settings to your setup):

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.immich-raw.rule=Host(`photos.example.com`) && PathPrefix(`/immich-raw/`)
      - traefik.http.routers.immich-raw.entrypoints=websecure
      - traefik.http.routers.immich-raw.tls=true
      - traefik.http.services.immich-raw.loadbalancer.server.port=80
```

The editor container sends `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and
`Cross-Origin-Resource-Policy` headers. Make sure your proxy passes them through: the RAW decoder
doesn't work without them.

### 4. The button without proxy changes: the userscript

Skip this step if your proxy adds the button (step 3).

1. Install a userscript extension: [Violentmonkey](https://violentmonkey.github.io) or
   [Tampermonkey](https://www.tampermonkey.net).
2. Open `https://<your-immich>/immich-raw/immich-raw.user.js`; the extension offers to install it.
3. In the extension's editor, change `// @match https://immich.example.com/*` to your Immich address,
   keeping the trailing `/*`, and save.

If both the proxy script and the userscript are active, only one button appears.

### 5. Check

1. Reload Immich and open a RAW photo. The iris button appears at the left of the viewer's toolbar.
2. Click it. The editor opens at `https://<your-immich>/immich-raw/?asset=…` and shows the photo after a
   few seconds (the first open downloads the RAW).
3. If the editor reports a problem with cross-origin isolation, open the browser's developer tools on
   the editor page and check that `crossOriginIsolated` is `true`. If it isn't, the proxy drops the
   headers mentioned in step 3, or the page isn't served over HTTPS.

### Optional: the culler (auto-stack and best pick)

The culler groups bursts and similar shots into Immich stacks and puts the best photo of each group
on top. It tags the others with the reason they lost: lighting, blur or closed eyes. You start it
from the editor's filmstrip (**Auto-stack…**), or let it sort new uploads automatically. It runs
small AI models (CLIP, YuNet, MediaPipe) on the server's CPU. The models are downloaded when the
image is built.

1. In Immich, create an API key for the user whose library it should sort: **Account Settings → API
   Keys**, with all permissions. Put it in a file `culler.env` next to your compose file, and keep that
   file private:

   ```sh
   IMMICH_API_KEY=your-key-here
   ```

2. Add the service to the compose file:

   ```yaml
     immich-culler:
       container_name: immich_culler
       build:
         context: ./immich-raw/services/culler
       env_file: culler.env
       environment:
         IMMICH_URL: http://immich-server:2283
         # CULLER_WATCH: "true"      # sort new uploads automatically
       volumes:
         - culler-data:/data
       cpus: 2
       mem_limit: 2g
       restart: always

   volumes:
     culler-data:
   ```

3. Route `/immich-raw/culler/` to `immich-culler:8080` in your proxy, before the `/immich-raw/`
   route. The nginx and Caddy snippets in [deploy/](deploy/) already contain it.
4. Run `docker compose up -d --build immich-culler`.

Without the culler, the editor simply hides its controls. Thresholds and the tag name can be changed in
`/data/culler.toml`. Its sections and defaults are in
[services/culler/src/culler/config.py](services/culler/src/culler/config.py).

### Updating

```sh
cd immich-raw && git pull && cd ..
docker compose up -d --build immich-raw     # and immich-culler, if you use it
```

### Uninstalling

Remove the services and the proxy lines, then restart the proxy. Edited JPEGs stay in Immich as
normal photos, and the RAW files were never changed. The stored edit settings (asset metadata keys
starting with `raw-editor.`) stay behind; Immich ignores them.

## Development

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

- `npm test`: unit tests (vitest); `npm run check`: type checks.
- `node e2e/smoke.mjs <out-dir>`: end-to-end test (open, edit, save, reopen, re-save).
- `node e2e/screenshots.mjs`: regenerates the screenshots in this README.
- [e2e/README.md](e2e/README.md) describes the test setup; [deploy/README.md](deploy/README.md) the
  deployment files.

Project layout:

- `apps/editor/`: the Svelte editor.
- `packages/`:
  - `decoder`: libraw-wasm;
  - `pipeline`: WebGL2 renderer, colour maths;
  - `recipe`: edit settings;
  - `xmp`: Lightroom import/export;
  - `lens`: Lensfun profiles, DNG lens data, CA measurement;
  - `dng`: DNG writer;
  - `inject`: the Immich button.
- `services/culler/`: the optional culler (Python).
- `deploy/`: Dockerfile and reverse-proxy snippets.
- `e2e/`: test Immich, seed, smoke-test and screenshot scripts.
- `licenses/`: third-party licence texts.
- `spikes/`, `docs/`: early experiments and measurements.

## Licence

immich-raw is licensed under the GNU Affero General Public License v3.0 ([LICENSE](LICENSE)).

It includes third-party components such as LibRaw, Little CMS, libjpeg, Svelte, jSquash and the
Lensfun database. They are listed with their licences in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the full texts are in [licenses/](licenses/).
The editor links to all of it from the ⓘ button in its header.

This product includes DNG technology under license by Adobe. immich-raw is not affiliated with
Immich, Adobe or LibRaw. The sample photo in the screenshots is from [raw.pixls.us](https://raw.pixls.us)
(CC0).

## How it was made

immich-raw was created using Claude AI tools (Claude Code by Anthropic).
