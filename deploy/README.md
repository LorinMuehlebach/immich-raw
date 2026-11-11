# Deploying next to your Immich

The editor is a set of static files. It must be served from the **same host as Immich**, under
`/immich-raw/`. That way it uses your Immich login and can call Immich's API directly. Immich doesn't
allow cross-origin API calls.

## 1. Build and run the editor container

Add the service from [compose.example.yml](compose.example.yml) to the compose file you run Immich with,
then run `docker compose up -d`. Or build the image yourself from the repository root:

```sh
docker build -f deploy/Dockerfile -t immich-raw .
```

The container listens on port 80 and serves only `/immich-raw/`.

## 2. Route `/immich-raw/` through your reverse proxy

- **nginx**: copy the parts of [immich-nginx.snippet.conf](immich-nginx.snippet.conf) into your config.
  It sends `/immich-raw/` to the editor container and adds the "Edit RAW" button script to Immich's pages.
- **Caddy**: see [Caddyfile.snippet](Caddyfile.snippet). The button script needs Caddy built with the
  `replace-response` plugin.
- **Other proxies** (Traefik, ...): route `/immich-raw/` to the editor container, then use the userscript
  (step 3) for the button.

The editor sends `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and
`Cross-Origin-Resource-Policy` headers. Don't strip them: the RAW decoder doesn't work without them.

## 3. Button without proxy changes: the userscript

If your proxy can't edit Immich's HTML, install the userscript in Violentmonkey or Tampermonkey.
The editor container serves it at `https://<your-immich>/immich-raw/immich-raw.user.js` (it is
built to `packages/inject/dist/immich-raw.user.js` by `npm run build`):

1. Open that address; the extension offers to install the script, then open it in the extension's
   editor.
2. Change `// @match https://immich.example.com/*` to your Immich address, keeping the trailing `/*`.
3. Leave `RAW_EDITOR_BASE` at `/immich-raw/` unless the editor is served elsewhere on the same host.

Don't use both the proxy injection and the userscript. If you do anyway, the script makes sure only
one button appears.

## 4. Check

Open a RAW in Immich's viewer. An iris icon appears at the left of the toolbar. Clicking it opens
`/immich-raw/?asset=…`. In the browser's developer tools, `crossOriginIsolated` should be `true` on
the editor page.

## 5. Optional: the culler

The culler stacks bursts, puts the best shot in front and tags why the others lost.

1. Add the `immich-culler` service from [compose.example.yml](compose.example.yml), with an Immich
   API key in `culler.env`. The key's permissions are listed in
   [docs/culler.md](../docs/culler.md#settings).
2. The nginx and Caddy snippets already route `/immich-raw/culler/` to it. That route must come
   before `/immich-raw/`.
3. Check: `https://<your-immich>/immich-raw/culler/api/v1/health` answers `{"ok": true, …}`, and the
   editor's filmstrip shows **Auto-stack…**.

The [README](../README.md#optional-the-culler-auto-stack-and-best-pick) has the step-by-step setup.
