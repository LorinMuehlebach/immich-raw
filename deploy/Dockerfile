# Editor container: static files served by nginx at /immich-raw/.
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t immich-raw .

FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/editor/dist /usr/share/nginx/html/immich-raw
EXPOSE 80
