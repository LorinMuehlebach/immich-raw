# Optional HTTPS in front of immich-raw on a home network: Caddy with the DuckDNS DNS plugin, so
# Let's Encrypt can certify a DuckDNS name that points at the server's LAN address. See README.md.
# Build from the repository root:
#   docker build -t immich-raw-https deploy/https

# The stock Caddy image has no DNS plugins; xcaddy builds one with the DuckDNS plugin added.
FROM caddy:2.11.9-builder AS build
RUN xcaddy build --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2.11.9
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# Without HTTPS_HOST the Caddyfile's site block would read as Caddy's global options and fail with
# an unhelpful error, so say what is missing instead.
CMD ["sh", "-c", "if [ -z \"$HTTPS_HOST\" ] || [ -z \"$DUCKDNS_TOKEN\" ]; then echo 'Set HTTPS_HOST and DUCKDNS_TOKEN (deploy/https/README.md).' >&2; exit 1; fi; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
