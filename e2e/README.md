# Test Immich

A throwaway Immich v3.4.0 (with Postgres and Valkey, no machine learning) behind nginx, set up like a
real deployment:

- `/immich-raw/` serves the built editor (`apps/editor/dist`) with the cross-origin isolation headers.
- Every other path goes to Immich, with the "Edit RAW" button script added to its pages.

Photos and the database live in Docker volumes, not in this folder. Don't put real photos in here.

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

## Variants

- Immich's optional Content-Security-Policy:
  `IMMICH_HELMET_FILE=true docker compose -f e2e/docker-compose.immich.yml up -d`
- Serve another folder at `/immich-raw/`:
  `RAW_EDITOR_DIR=/some/dir docker compose -f e2e/docker-compose.immich.yml up -d`

## Stop and reset

```sh
docker compose -f e2e/docker-compose.immich.yml stop      # pause, keeps the data
docker compose -f e2e/docker-compose.immich.yml down -v   # delete the instance and all its data
```
