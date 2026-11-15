# HTTPS on your home network

Over HTTPS the editor keeps recently opened RAWs, AI Upscale can use the graphics card, and Chrome
and Edge export into a folder ([Export speed](../../docs/export-speed.md#what-https-adds)). On a
plain `http://192.168.x.x:2283` address it can do none of that.

No certificate authority issues certificates for LAN addresses like `192.168.178.20`. So this setup
gives your server a free name at [DuckDNS](https://www.duckdns.org), for example
`my-photos.duckdns.org`, that points at its LAN address. Let's Encrypt issues a normal certificate
for that name. To prove the name is yours, the service writes a TXT record at DuckDNS (the DNS-01
challenge). Let's Encrypt never has to connect to your server.

- **Nothing is opened to the internet.** No port forwarding, no public IP. The name leads to your
  LAN address, which only devices in your own network can reach.
- **It works on every device in your network** without installing anything: computers, phones,
  tablets, the Immich apps.
- **Outside your home the address doesn't work.** That is intended. Away from home, use whatever you
  use today (for example a VPN).

The service is [Caddy](https://caddyserver.com) with the DuckDNS plugin. It goes in front of the
immich-raw container from the [quick setup](../../docs/installation.md#quick-setup). If you already
run a reverse proxy with HTTPS, you don't need it.

It isn't published as an image yet: you build it from a clone of this repository (step 6).

The steps below use a Fritz!Box router as the example (German labels, English in brackets). Other
routers have the same settings under similar names.

## What you need

- Immich with immich-raw's [quick setup](../../docs/installation.md#quick-setup), run with Docker
  Compose.
- An account at DuckDNS. It's free; you sign in with an existing account, for example GitHub or
  Google.
- `git`, to get the files for the build.
- About 1–2 GB of free memory on the server for the first build (it compiles Caddy).

## 1. Find the server's LAN address

The address of the computer that runs Docker, in your home network. It usually starts with
`192.168.`, `10.` or `172.16.`–`172.31.`.

- **Linux:** run `hostname -I`. The first address is usually the right one. Skip `172.17.0.1` and
  similar `172.x` addresses: those are Docker's own networks.
- **Windows:** run `ipconfig`. Take the **IPv4 Address** (**IPv4-Adresse**) of the adapter you're
  connected with: **Wireless LAN adapter** (**Drahtlos-LAN-Adapter**) for Wi-Fi, or **Ethernet
  adapter**. Skip adapters called `vEthernet`, `WSL`, `VirtualBox` or `VMware`; those are virtual.
- **Synology:** **Control Panel → Network → Network Interface**.
- **Or in the router:** on a Fritz!Box, open http://fritz.box and go to **Heimnetz → Netzwerk**
  (**Home Network → Network**). The **Netzwerkverbindungen** (**Network Connections**) tab lists
  every device with its address.

The examples below use `192.168.178.20`. Use your own address instead.

## 2. Give the server a fixed address

The router hands out addresses and can give the server a different one later. The DuckDNS name
would then point at the wrong device. Tell the router to always give it the same one.

**Fritz!Box:**
1. Open http://fritz.box and log in.
2. Go to **Heimnetz → Netzwerk** (**Home Network → Network**), tab **Netzwerkverbindungen**
   (**Network Connections**).
3. Find the server in the list (by its name or the address from step 1) and click its pencil icon
   (**Bearbeiten**, **Edit**).
4. Tick **Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen** (**Always assign this
   network device the same IPv4 address**).
5. Click **OK** (or **Übernehmen**, **Apply**).

**Other routers:** look for "DHCP reservation", "static lease" or "address reservation" in the LAN
or DHCP settings.

## 3. Create the DuckDNS name

1. Open https://www.duckdns.org and sign in with one of the buttons at the top.
2. The top of the page shows your account. The long value next to **token** (36 characters, like
   `a1b2c3d4-...`) is your token; you need it in step 5. Keep it private: with it, anyone can change
   your DuckDNS names.
3. Under **domains**, type a name into the **sub domain** box (only the first part, for example
   `my-photos`) and click **add domain**.
4. The new name appears in the list below, with a **current ip** box. DuckDNS fills it with your
   *public* IP, the one it sees you connecting from. Replace it with the LAN address from step 1
   (`192.168.178.20`) and click **update ip** next to it. Nothing can reach you through the public IP
   in the meantime, since nothing is forwarded on your router.
5. The **ipv6** box in the same row must be empty. If it isn't, clear it and click **update ipv6**.

Instead of steps 4 and 5 you can open this address in a browser (with your name, token and
address). It answers `OK`:

```
https://www.duckdns.org/update?domains=my-photos&token=<token>&ip=192.168.178.20
```

**Don't let anything update this name automatically.** DuckDNS is usually used with an updater that
keeps the name on your *public* IP. Here that would be wrong. So:
- don't add DuckDNS in the Fritz!Box under **Internet → Freigaben → DynDNS** (**Internet → Permit
  Access → DynDNS**);
- don't run a DuckDNS updater container (such as `linuxserver/duckdns`), app or script for this
  name.

If you already use DuckDNS that way for something else, create a separate name for this.

Anyone can look up the name and see your LAN address. That tells them nothing they could use from
outside your network. Let's Encrypt also lists the name in its public certificate logs.

## 4. Let your router answer for the name

Many routers refuse DNS answers that point into your own network ("DNS rebind protection"). The
name then works everywhere except at home. Check first, from any computer in your network:

```sh
nslookup my-photos.duckdns.org 1.1.1.1
nslookup my-photos.duckdns.org
```

The first command asks a public DNS server, the second asks your router. Both should end with
`Address: 192.168.178.20`. If the first one does but the second one doesn't (no address,
"Non-existent domain", or a timeout), the router is blocking it.

On a Fritz!Box, which blocks it by default:
1. Open http://fritz.box and go to **Heimnetz → Netzwerk** (**Home Network → Network**), tab
   **Netzwerkeinstellungen** (**Network Settings**).
2. Scroll down to **DNS-Rebind-Schutz** (**DNS Rebind Protection**). If you don't see it, open
   **weitere Einstellungen** (**Additional Settings**) on that page, or switch the view to
   **Erweitert** (**Advanced**) at the bottom left.
3. In **Hostnamen-Ausnahmen** (**Host name exceptions**), enter the full name, for example
   `my-photos.duckdns.org`. Put several names on separate lines.
4. Click **Übernehmen** (**Apply**).

Then run `nslookup my-photos.duckdns.org` again; it should now answer the LAN address. On other
routers (or Pi-hole, AdGuard Home), look for "rebind protection" and allow the name there.

Devices set to a public DNS server (for example Android's **Private DNS**) never ask the router, so
they work either way.

## 5. Put the name and token in a file

Next to the `docker-compose.yml` you run Immich with, create a file called `https.env`:

```sh
HTTPS_HOST=my-photos.duckdns.org
DUCKDNS_TOKEN=a1b2c3d4-0000-0000-0000-000000000000
```

- `HTTPS_HOST` is the full name, including `.duckdns.org`.
- `DUCKDNS_TOKEN` is the token from step 3.
- Keep the file private. On Linux: `chmod 600 https.env`.

## 6. Add the service

Get the files for the build: in the folder with your compose file, run

```sh
git clone https://github.com/LorinMuehlebach/immich-raw.git
```

Then open your `docker-compose.yml`. Under `services:`, next to `immich-server` and `immich-raw` and
indented like them, add:

```yaml
  immich-raw-https:
    container_name: immich_raw_https
    build: ./immich-raw/deploy/https
    env_file: https.env
    ports:
      - '443:443'
      - '443:443/udp'
    # environment:
    #   UPSTREAM: immich-raw:80        # where immich-raw is (this is the default)
    volumes:
      - https-data:/data
    restart: always
```

At the end of the file, Immich's compose file already has a `volumes:` section (with
`model-cache:`). Add `https-data:` to it, at the same indent as `model-cache:`:

```yaml
volumes:
  model-cache:
  https-data:
```

- **`443:443`** is the normal HTTPS port, so the address needs no port number. The UDP line allows
  HTTP/3, which is a little faster; it isn't required.
- **Port 443 already in use** (Synology DSM, another web server): `docker compose up` then fails
  with "port is already allocated" or "address already in use". Use `'8443:443'` instead, remove the
  UDP line, and add `:8443` to the address: `https://my-photos.duckdns.org:8443`.
- **`https-data`** keeps the certificate when the container restarts. Without it, every restart asks
  Let's Encrypt for a new one, and it allows only a few per week for the same name.
- **Leave immich-raw's `2283:80` as it is.** The plain `http://192.168.178.20:2283` address keeps
  working, for example for the mobile apps until you switch them over.
- **immich-raw named differently:** set `UPSTREAM` to its name and port 80, for example
  `UPSTREAM: my-immich-raw:80`.

## 7. Start it

```sh
docker compose up -d --build immich-raw-https
```

The first start builds Caddy with the DuckDNS plugin, which takes a few minutes. Later starts are
quick. Then watch the log:

```sh
docker compose logs -f immich-raw-https
```

Within a minute or two a line with `certificate obtained successfully` and your name appears. Press
Ctrl+C to stop watching; the service keeps running.

What the log may say instead:
- **`Set HTTPS_HOST and DUCKDNS_TOKEN`**: `https.env` is missing, empty, or not next to the compose
  file.
- **`DuckDNS API token must be a 36 characters long UUID`**: the token in `https.env` is wrong or
  has extra characters (quotes, spaces).
- **`DuckDNS request failed, expected (OK) but got (KO)`**: DuckDNS rejected the token or the name.
  Check that `HTTPS_HOST` is a name of this DuckDNS account.
- **It keeps retrying the DNS challenge:** DuckDNS is sometimes slow. Caddy keeps trying by itself;
  give it a few minutes, or restart it with `docker compose restart immich-raw-https`.

Caddy renews the certificate by itself before it runs out. It only needs to keep running, with an
internet connection to Let's Encrypt and DuckDNS.

## 8. Check

1. Open `https://my-photos.duckdns.org` (with `:8443` if you changed the port). Immich opens and
   the browser shows a padlock, without a warning. Try it on a phone in your Wi-Fi too.
2. Open a RAW in the editor, press F12, and in the **Console** type `isSecureContext` and then
   `crossOriginIsolated`. Both answer `true`.
3. Run `nslookup my-photos.duckdns.org 1.1.1.1` again. It still answers your LAN address. Getting
   the certificate only changes the name's TXT record, never its address.

Optional:
- **Immich apps:** in the app's server address, use `https://my-photos.duckdns.org`. This only works
  at home; for away from home, the app's settings can switch addresses by Wi-Fi network.
- **Shared links:** in Immich, set **External Domain** (administration, server settings) to the
  HTTPS address, so links you share use it.

## Removing it

1. Remove the `immich-raw-https` service and the `https-data:` line from your compose file, then run
   `docker compose up -d --remove-orphans`.
2. Delete the stored certificate: `docker volume ls` shows the volume as `<project>_https-data`;
   remove it with `docker volume rm <project>_https-data`.
3. On duckdns.org, click **delete domain** next to the name, and remove the Fritz!Box exception from
   step 4.
