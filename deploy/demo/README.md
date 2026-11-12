# Try it: a demo Immich with immich-raw

A throwaway Immich with immich-raw in front of it and five sample RAW files (Sony, Nikon, Canon,
Fujifilm, Leica; CC0, from [raw.pixls.us](https://raw.pixls.us)). Nothing else is needed but
Docker. It doesn't touch an Immich you already run.

## Start it

There are two ways; both start the same demo.

**Straight from the registry** (macOS, Linux):

```sh
docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo up -d
```

**From a downloaded compose file**: on Windows with Docker Desktop, and with Docker Compose
versions that can't run compose files from a registry.

```sh
curl -fsSLO https://raw.githubusercontent.com/LorinMuehlebach/immich-raw/main/deploy/demo/compose.yml
docker compose -f compose.yml up -d
```

In PowerShell, write `curl.exe` instead of `curl`. On Windows the `oci://` command currently fails
with `proxyconnect tcp: open ./pipe/dockerHttpProxy`. Compose sends the download through Docker
Desktop's proxy, a Windows named pipe, and can't open it (seen with Docker Compose 5.1.4).

The commands below use `-f oci://ghcr.io/lorinmuehlebach/immich-raw-demo`. With the downloaded
file, write `-f compose.yml` instead, in the folder you downloaded it to.

Then open **http://localhost:8088** and log in as `admin@example.com` / `raw-editor-e2e`. Open a
RAW from the album "immich-raw samples" and click the iris button (Edit RAW) in the viewer's
toolbar. The first start downloads Immich, its database and the sample photos, which takes a few
minutes. `docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo logs seed` shows how far
the photos are.

**Not for your photos.** The login is public, and other devices on your network can open the demo.
Use your own Immich for real photos: see the [installation guide](../../docs/installation.md).

## With the culler: stacks of bursts

```sh
docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo --profile culler up -d
```

This adds the culler and 15 test shots on 2015-06-01 (album "immich-raw bursts"): three bursts
with a too dark, a too bright and a blurred shot among sharp ones, and a single photo. They come
as RAW (DNG), RAW + JPEG pairs and JPEGs. Open one of the RAWs from the album, then use
**Auto-stack…** in the filmstrip: Preview shows the stacks it would make and why each shot lost;
Apply makes them. You can also select the shots in Immich and click **Auto-stack** in the
selection bar. More: [docs/culler.md](../../docs/culler.md).

The culler image is about 1.8 GB and is built for x86-64 only; on ARM computers (Apple
silicon) Docker runs it emulated and slowly.

## Other devices

The demo answers on every network address of the computer: open
`http://<this computer's address>:8088` on a phone or tablet. On Windows, allow Docker through the
firewall if it asks.

That is plain HTTP, so on those devices:
- the browser downloads the RAW again each time it opens one;
- AI Upscale handles crops only, because browsers give WebGPU only to secure pages.

On the computer itself, `localhost` counts as secure and everything works.

## Settings

Set these as environment variables for `docker compose`, for example
`DEMO_PORT=9000 docker compose -f oci://… up -d` (PowerShell: `$env:DEMO_PORT=9000` first).

| Variable | Default | |
|---|---|---|
| `DEMO_PORT` | `8088` | the port |
| `DEMO_BIND` | `0.0.0.0` | `127.0.0.1` keeps the demo to this computer |
| `DEMO_EMAIL`, `DEMO_PASSWORD` | `admin@example.com`, `raw-editor-e2e` | the login; set it on a network you share with others. It is made on the first start, so change it only together with `down -v` |

## Update and remove

```sh
docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo pull
docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo up -d
docker compose -f oci://ghcr.io/lorinmuehlebach/immich-raw-demo --profile culler down -v   # removes it with all its photos
```

Keep `--profile culler` in `down` even if you never used it: without it, a culler you started
once stays behind.

With the downloaded file, download it again before `pull`, so that you also get changes to the
demo itself.

## What's in it

- Immich 3.4.0 with its database, without machine learning: smart search and face recognition
  don't work, the editor and the culler don't need them.
- `immich-raw` in front of Immich, as in the README's quick setup.
- `seed`, which runs once per start: makes the account, uploads the samples into an album and
  creates the culler's API key. Starting again skips what is already there.
- With `--profile culler`: `seed-bursts` and the culler.

## For development

The demo is the same instance as the test Immich in [e2e/](../../e2e/README.md), with the same
address and login, so the e2e scripts run against it. To try changes, build the images from a
checkout (`-p` and the port keep it apart from the test Immich):

```sh
DEMO_PORT=8091 docker compose -f deploy/demo/compose.yml -f deploy/demo/compose.build.yml \
  -p immich-raw-demo-test --profile culler up -d --build
```

- [Dockerfile](Dockerfile) builds the seed image: the samples come from
  `spikes/decode-bench/fetch-samples.mjs`, and [make-bursts.mjs](make-bursts.mjs) makes the bursts
  with the culler's `make_burst.py`, as `e2e/cull.mjs` does.
- [seed.mjs](seed.mjs) uploads them, using `e2e/seed.mjs`.
- CI publishes the images and this compose file on every push to main and on version tags
  ([.github/workflows/images.yml](../../.github/workflows/images.yml)).
