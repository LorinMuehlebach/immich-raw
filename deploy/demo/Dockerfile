# The try-it demo's seed image (deploy/demo/README.md): the five CC0 sample RAWs from
# raw.pixls.us, the culler's demo bursts made from them, and the script that uploads both to the
# demo's Immich. Build from the repository root:
#   docker build -f deploy/demo/Dockerfile -t immich-raw-demo-seed .

# The files are the same on every platform, so they are made once, on the builder's platform.
# uv too: a plain COPY --from=<image> would take uv for the target platform (arm64 under emulation).
FROM --platform=$BUILDPLATFORM ghcr.io/astral-sh/uv:0.12.12 AS uv
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS files
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY spikes/decode-bench/fetch-samples.mjs spikes/decode-bench/
RUN node spikes/decode-bench/fetch-samples.mjs /out/samples \
 && test "$(ls /out/samples | wc -l)" -eq 5
COPY package.json ./
COPY packages/dng packages/dng
COPY e2e/raw-burst.mjs e2e/
COPY services/culler/scripts/make_burst.py services/culler/scripts/
COPY deploy/demo/previews.py deploy/demo/make-bursts.mjs deploy/demo/
RUN node deploy/demo/make-bursts.mjs /out/samples /out/bursts

FROM node:24-alpine
RUN apk add --no-cache curl
WORKDIR /demo
COPY --from=files /out/samples samples
COPY --from=files /out/bursts bursts
COPY package.json ./
COPY e2e/seed.mjs e2e/
COPY deploy/demo/seed.mjs deploy/demo/
ENV IMMICH_URL=http://immich-server:2283
ENTRYPOINT ["node", "/demo/deploy/demo/seed.mjs"]
CMD ["samples"]
