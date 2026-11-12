# Builds the single-threaded LibRaw for WebAssembly (see ../README.md). From packages/libraw:
#   docker build -f build/Dockerfile --output type=local,dest=lib build
# or `npm run build:libraw -w @immich-raw/libraw`.
FROM emscripten/emsdk:5.0.7 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends autoconf automake libtool pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY build.sh no-pthreads.patch ./
RUN bash build.sh

FROM scratch
COPY --from=build /out/ /
