# immich-raw container: the editor at /immich-raw/, and a pass-through to Immich that adds the
# Edit RAW button (see nginx.conf.template). Build from the repository root:
#   docker build -f deploy/Dockerfile -t immich-raw .

# The build output is the same on every platform, so it is built once on the builder's own
# platform, also when building images for other platforms (e.g. arm64).
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

FROM nginx:1.29-alpine
# Where Immich and the optional culler are; the defaults are the container names from Immich's
# docker-compose.yml and deploy/compose.example.yml.
ENV IMMICH_URL=http://immich-server:2283 \
    CULLER_URL=http://immich-culler:8080 \
    NGINX_ENVSUBST_FILTER=IMMICH_URL|CULLER_URL
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/editor/dist /usr/share/nginx/html/immich-raw
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1/immich-raw/ || exit 1
