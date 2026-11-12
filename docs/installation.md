# Installation

immich-raw runs next to your own Immich. To look at it first without touching your Immich, start
the [try-it demo](../deploy/demo/README.md). There are two ways to set it up:

- **Quick setup (recommended):** one container goes in front of Immich, on Immich's port. It serves
  the editor and passes everything else to Immich, adding the Edit RAW button on the way. Your
  reverse proxy, the mobile apps and other clients keep working as before.
- **Advanced setup:** your own reverse proxy sends `/immich-raw/` to the container and adds the
  button itself (nginx or Caddy), or a browser userscript adds it.

A second container, the culler, is optional in both.

## Requirements

- **Immich 3.4.x** (tested with 3.4.0), run with Docker Compose.
- **HTTPS or plain HTTP.** Both work, including a plain `http://192.168.x.x:2283` address. On plain
  HTTP the browser keeps no copy of the originals, so the editor downloads the RAW again each time
  you open it. Over HTTPS (or on `localhost`) it keeps recently opened originals.

  AI Upscale also needs HTTPS (or `localhost`) for whole photos. Browsers give a web page the
  graphics card (WebGPU) only there; on plain HTTP it runs on one CPU thread and handles only crops.
- **A browser with WebGL2:** tested in Chrome and Edge. Large RAWs (45–60 megapixels) need about
  2 GB of memory in the browser tab. An AI Upscale result needs about 4 bytes per pixel more, up to
  800 MB at its 200 MP limit; 2× of a 45 MP photo worked in Edge on a 32 GB laptop.
- **Phones and tablets** work too ([Phones and tablets](mobile.md)), but a phone's browser may not
  give one tab enough memory for the largest RAWs.

The images are published on GitHub's container registry:
- `ghcr.io/lorinmuehlebach/immich-raw` for x86-64 and ARM64;
- `ghcr.io/lorinmuehlebach/immich-raw-culler` for x86-64.

## Quick setup

1. In the `docker-compose.yml` you run Immich with, add the immich-raw service:

   ```yaml
     immich-raw:
       container_name: immich_raw
       image: ghcr.io/lorinmuehlebach/immich-raw:latest
       ports:
         - '2283:80'
       depends_on:
         - immich-server
       restart: always
   ```

2. In the same file, take the port away from `immich-server`: remove or comment out its `ports:` lines.

   ```yaml
     immich-server:
       # ... unchanged ...
       # ports:
       #   - '2283:2283'
   ```

3. Start it:

   ```sh
   docker compose up -d
   ```

Port 2283 now leads to immich-raw, which passes everything on to Immich.
- **Reverse proxies reaching Immich by container name** (for example `http://immich-server:2283`
  on a Docker network, or Traefik labels on `immich-server`) need one change: point them at
  `immich-raw`, port 80.
- **A differently named Immich container:** set `IMMICH_URL` on immich-raw, for example
  `IMMICH_URL: http://my-immich:2283`.

To undo the setup, give the port back to `immich-server` and remove the service.

## Advanced setup: your own reverse proxy

Here immich-raw only serves the editor, and your proxy sends `/immich-raw/` to it. Everything else
goes to Immich as before.

**1. Add the container** to Immich's `docker-compose.yml`, without a port:

```yaml
  immich-raw:
    container_name: immich_raw
    image: ghcr.io/lorinmuehlebach/immich-raw:latest
    restart: always
```

Run `docker compose up -d immich-raw`. The container serves the editor on port 80, and your reverse
proxy reaches it by name. If your proxy runs outside this compose project, put both on the same
Docker network. Or publish a local port (for example `ports: ["127.0.0.1:8090:80"]`) and point the
proxy at `127.0.0.1:8090`.

**2. Route `/immich-raw/` and add the button.** Every path stays with Immich except `/immich-raw/`.
The proxy also adds one script tag (`/immich-raw/inject.js`) to Immich's HTML pages; that script
draws the button.

**nginx.** Add the following to the server block for your Immich domain. The complete example,
including the optional culler, is [deploy/immich-nginx.snippet.conf](../deploy/immich-nginx.snippet.conf).

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
  }
}
```

**Caddy.** See [deploy/Caddyfile.snippet](../deploy/Caddyfile.snippet). Adding the button needs Caddy built
with the `replace-response` plugin (`xcaddy build --with github.com/caddyserver/replace-response`).
Without the plugin, keep only the `/immich-raw/*` route and use the userscript (step 3).

**Traefik and other proxies.** Route the path prefix `/immich-raw/` on your Immich host to the
`immich-raw` container on port 80, then use the userscript for the button (step 3). With Traefik that
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
`Cross-Origin-Resource-Policy` headers. The editor doesn't need them today, but they are best passed
through as they are.

**3. Only if your proxy can't add the button: the userscript.**

1. Install a userscript extension: [Violentmonkey](https://violentmonkey.github.io) or
   [Tampermonkey](https://www.tampermonkey.net).
2. Open `https://<your-immich>/immich-raw/immich-raw.user.js`; the extension offers to install it.
3. In the extension's editor, change `// @match https://immich.example.com/*` to your Immich address,
   keeping the trailing `/*`, and save.

If both the proxy script and the userscript are active, only one button appears.

## Check

1. Reload Immich and open a RAW photo. The iris button appears at the left of the viewer's toolbar.
2. Click it. The editor opens at `<your-immich>/immich-raw/?asset=…` and shows the photo after a few
   seconds (the first open downloads the RAW).
3. If the button doesn't appear, the script tag isn't being added: check the proxy setup above, or use
   the userscript.

## Optional: the culler (auto-stack and best pick)

The culler groups bursts and similar shots into Immich stacks and puts the best photo of each group
on top. It tags the others with the reason they lost: lighting, blur or closed eyes. It works on
RAWs, JPEGs and RAW + JPEG pairs. It sorts new uploads automatically. You can also run it on a day
or an album from the editor's filmstrip (**Auto-stack…**), or on photos selected in Immich
(**Auto-stack** in the selection bar), with a preview first and undo afterwards.
The **stack window** (the number on a stack in the filmstrip, or **Compare stack** in Immich's photo
viewer) shows a stack's shots one at a time with what the culler measured; pick the one you prefer
and move the others to Immich's trash. How to use it, with pictures:
[Stacking and best pick](stacking.md).

It runs small AI models (CLIP, YuNet, MediaPipe's face landmarker and object detector) on the
server's CPU; they are part of the image, which is about a 1.8 GB download. How it decides, all
settings and the command line are in [docs/culler.md](culler.md).

1. In Immich, create an API key for the user whose library it should sort: **Account Settings → API
   Keys**. It needs these permissions:
   - `asset.read`, `asset.view`, `asset.download`, `asset.update`
   - `album.read`, `user.read`
   - `stack.create`, `stack.read`, `stack.update`, `stack.delete`
   - `tag.create`, `tag.read`, `tag.asset`

   Put the key in a file `culler.env` next to your compose file, and keep that file private:

   ```sh
   IMMICH_API_KEY=your-key-here
   ```

2. Add the service to the compose file:

   ```yaml
     immich-culler:
       container_name: immich_culler
       image: ghcr.io/lorinmuehlebach/immich-raw-culler:latest
       env_file: culler.env
       environment:
         IMMICH_URL: http://immich-server:2283
         # CULLER_WATCH: "false"        # don't sort new uploads automatically
         # CULLER_AUTO_APPLY: "false"   # only suggest (dry runs) for new uploads
       volumes:
         - culler-data:/data
       cpus: 2
       mem_limit: 2g
       restart: always

   volumes:
     culler-data:
   ```

3. Quick setup: nothing else to do. The immich-raw container finds the culler at `immich-culler:8080`
   (set `CULLER_URL` on immich-raw if you name it differently). Advanced setup: route
   `/immich-raw/culler/` to `immich-culler:8080` in your proxy, before the `/immich-raw/` route; the
   nginx and Caddy snippets in [deploy/](../deploy/) already contain it.
4. Run `docker compose up -d immich-culler`.

Without the culler, the editor simply hides its controls.
- **New uploads:** on its first start, the culler only sorts photos uploaded from then on. Sort older
  days or albums from the editor.
- **Tags:** the losers get tags under `Culling/` (for example `Culling/Rejected/Blur`).
- **Reject flag:** the culler also sets it (rating −1), but Immich 3.4 empties it again a moment
  later, so the tags are what to search for.
- **Settings:** thresholds and the tag name can be changed in `/data/culler.toml`; see
  [docs/culler.md](culler.md#settings).

## Updating

```sh
docker compose pull immich-raw immich-culler     # leave out immich-culler if you don't use it
docker compose up -d
```

`latest` follows the main branch. To stay on a release, use its version as the tag (for example
`ghcr.io/lorinmuehlebach/immich-raw:1.0.0`) once releases are published.

## Building the images yourself

Clone the repository next to your compose file:

```sh
git clone https://github.com/LorinMuehlebach/immich-raw.git
```

Then replace each `image:` line with a build section:

```yaml
  immich-raw:
    build:
      context: ./immich-raw
      dockerfile: deploy/Dockerfile
  immich-culler:
    build:
      context: ./immich-raw/services/culler
```

Finally run `docker compose up -d --build`. To update, run `git pull` in `immich-raw` and the same
command again.

## Uninstalling

Remove the services (quick setup: give port 2283 back to `immich-server`), or remove the proxy lines
(advanced setup). Edited JPEGs stay in Immich as normal photos, and the RAW files were never changed.
The stored edit settings (asset metadata keys starting with `raw-editor.`) stay behind; Immich
ignores them.

