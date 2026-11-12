# Deploying next to your Immich

The editor is a set of static files. It must be served from the **same host as Immich**, under
`/immich-raw/`. That way it uses your Immich login and can call Immich's API directly. Immich doesn't
allow cross-origin API calls.

The step-by-step guide is [docs/installation.md](../docs/installation.md). This folder holds the files
behind it:

- **[Dockerfile](Dockerfile):** the immich-raw image. Published as `ghcr.io/lorinmuehlebach/immich-raw`
  by [.github/workflows/images.yml](../.github/workflows/images.yml). To build it yourself, run
  `docker build -f deploy/Dockerfile -t immich-raw .` from the repository root.
- **[nginx.conf.template](nginx.conf.template):** nginx inside the container. Its routes:
  - `/immich-raw/`: the editor;
  - `/immich-raw/culler/`: the culler (`CULLER_URL`, default `http://immich-culler:8080`);
  - everything else: Immich (`IMMICH_URL`, default `http://immich-server:2283`), with the button
    script added to Immich's pages.
- **[compose.example.yml](compose.example.yml):** the services to add to Immich's compose file.
- **[immich-nginx.snippet.conf](immich-nginx.snippet.conf)** and **[Caddyfile.snippet](Caddyfile.snippet):**
  for the advanced setup, where your own proxy routes `/immich-raw/` and adds the button.
- **[demo/](demo/README.md):** the try-it demo, a throwaway Immich with immich-raw and sample
  photos from one `docker compose` command.

## Quick setup: the container in front of Immich

Give the container Immich's port (`2283:80`) and take it away from `immich-server`. Everything that
used port 2283 now goes through immich-raw, which passes it on to Immich: browsers, the mobile apps
and your reverse proxy. Proxies that reach Immich by container name (`immich-server:2283`) must point
at `immich-raw:80` instead.

What it does for Immich traffic:
- uses the same settings as Immich's own reverse-proxy guide: uploads up to 50 GB, WebSockets for live
  updates, 600 s timeouts;
- passes uploads straight through;
- keeps the `X-Forwarded-*` headers an outer HTTPS proxy sets;
- asks Immich for its HTML pages uncompressed so it can add the script tag, then compresses them
  again for the browser.

## Advanced setup: your own reverse proxy

- **nginx**: copy the parts of [immich-nginx.snippet.conf](immich-nginx.snippet.conf) into your config.
  It sends `/immich-raw/` to the editor container and adds the "Edit RAW" button script to Immich's pages.
- **Caddy**: see [Caddyfile.snippet](Caddyfile.snippet). The button script needs Caddy built with the
  `replace-response` plugin.
- **Other proxies** (Traefik, ...): route `/immich-raw/` to the editor container, then use the userscript
  (below) for the button.

The editor sends `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and
`Cross-Origin-Resource-Policy` headers. The editor no longer needs them (it also runs on plain HTTP),
but leave them in: a future multi-threaded decoder would.

### Button without proxy changes: the userscript

If your proxy can't edit Immich's HTML, install the userscript in Violentmonkey or Tampermonkey.
The editor container serves it at `https://<your-immich>/immich-raw/immich-raw.user.js` (it is
built to `packages/inject/dist/immich-raw.user.js` by `npm run build`):

1. Open that address; the extension offers to install the script, then open it in the extension's
   editor.
2. Change `// @match https://immich.example.com/*` to your Immich address, keeping the trailing `/*`.
3. Leave `RAW_EDITOR_BASE` at `/immich-raw/` unless the editor is served elsewhere on the same host.

Don't use both the proxy injection and the userscript. If you do anyway, the script makes sure only
one button appears.

## Check

Open a RAW in Immich's viewer. An iris icon appears at the left of the toolbar. Clicking it opens
`/immich-raw/?asset=…` and shows the photo after a few seconds. On HTTPS the editor page is also
cross-origin isolated (`crossOriginIsolated` is `true` in the developer tools). Nothing needs that
yet, but it shows the headers come through.

## Optional: the culler

The culler stacks bursts, puts the best shot in front and tags why the others lost.

1. Add the `immich-culler` service from [compose.example.yml](compose.example.yml), with an Immich
   API key in `culler.env`. The key's permissions are listed in
   [docs/culler.md](../docs/culler.md#settings).
2. In the quick setup the immich-raw container already routes `/immich-raw/culler/` to it. The nginx
   and Caddy snippets do too; that route must come before `/immich-raw/`.
3. Check: `https://<your-immich>/immich-raw/culler/api/v1/health` answers `{"ok": true, …}`, and the
   editor's filmstrip shows **Auto-stack…**.

[docs/installation.md](../docs/installation.md#optional-the-culler-auto-stack-and-best-pick) has the step-by-step setup.
