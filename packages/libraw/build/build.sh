#!/usr/bin/env bash
# Builds libraw-wasm v1.6.0 without pthreads, inside build/Dockerfile. Same sources, compiler
# (Emscripten 5.0.7) and flags as the npm release, minus shared memory, so the decoder also runs
# on pages without cross-origin isolation (Immich on plain HTTP). no-pthreads.patch is the only
# change. The result goes to /out: index.js, worker.js, libraw.wasm and index.d.ts.
set -euo pipefail

REPO=https://github.com/ybouane/LibRaw-Wasm.git
TAG=v1.6.0
COMMIT=32fd36a9883a10c1632bc20073f1ea88cc60487a
here=$(pwd)

git clone --branch "$TAG" --depth 1 "$REPO" src
cd src
if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  echo "Tag $TAG is not commit $COMMIT any more" >&2
  exit 1
fi
git apply "$here/no-pthreads.patch"

# build.js needs esbuild; the browser download of the tests' playwright isn't needed.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
# Build LCMS and LibRaw from source rather than reusing the libraries checked in upstream.
FORCE_LIBS=1 bash compileLibraw.sh

if grep -q 'em-pthread' dist/worker.js; then
  echo "dist/worker.js still starts pthread workers" >&2
  exit 1
fi

mkdir -p /out
cp dist/index.js dist/worker.js dist/libraw.wasm dist/index.d.ts /out/
emcc --version | head -n 1
sha256sum /out/*
