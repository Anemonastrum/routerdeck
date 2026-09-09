# RouterDeck

> Self-hosted network monitoring dashboard for home labs — track devices, network services and uptime from a single web UI.

| | |
|---|---|
| **Docker image** | [`anemonastrum/routerdeck`](https://hub.docker.com/r/anemonastrum/routerdeck) |
| **Source** | [github.com/Anemonastrum/routerdeck](https://github.com/Anemonastrum/routerdeck) |
| **Platforms** | `linux/amd64`, `linux/arm64` |

## Features

- Dashboard with live CPU, memory, traffic and client counts for **OpenWrt**, **MikroTik RouterOS** and **Ruijie/Reyee Cloud** devices, plus generic ICMP uptime monitors
- Managed network services — **AdGuard Home**, **Home Assistant**, **Proxmox VE**, **Synology DSM**, **Nginx Proxy Manager**, **CasaOS**
- 24-hour uptime tracking with per-device / per-service history
- **Telegram notifications** when a device or service goes down or recovers — with multiple chats and per-chat device/service routing
- Public read-only status page at `/status`
- Configuration backup & restore (encrypted), SSH terminal, online topology

## Quick start (Docker Hub image)

> Both options use the prebuilt image `anemonastrum/routerdeck`. Pick the image tag you want — `latest`, `v1.17.5`, or a commit SHA.

### Option A — `docker run`

```bash
docker run -d \
  --name routerdeck \
  --restart unless-stopped \
  -p 8080:8080 \
  -e ADMIN_PASSWORD="change-me" \
  -e APP_SECRET="replace-with-at-least-32-random-characters" \
  -e DB_PATH="/data/routerdeck.db" \
  -v routerdeck-data:/data \
  anemonastrum/routerdeck:latest
```

Data (SQLite database) is persisted in the named volume `routerdeck-data`. Open http://localhost:8080 and log in with `ADMIN_PASSWORD`.

### Option B — `docker compose` (recommended)

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Edit `.env` — at minimum set `ADMIN_PASSWORD` and `APP_SECRET` (at least 32 random characters):

```bash
ADMIN_PASSWORD=your-secure-password
APP_SECRET=your-at-least-32-character-random-secret
```

3. `docker-compose.yml`:

```yaml
services:
  routerdeck:
    image: anemonastrum/routerdeck:latest
    container_name: routerdeck
    restart: unless-stopped
    environment:
      # Required — leave these wired to .env
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      APP_SECRET: ${APP_SECRET:?Set APP_SECRET in .env}
      # Optional — every variable below has a sane default
      PORT: ${PORT:-8080}
      DB_PATH: ${DB_PATH:-/data/routerdeck.db}
      POLL_INTERVAL_MS: ${POLL_INTERVAL_MS:-15000}
      UPTIME_INTERVAL_MS: ${UPTIME_INTERVAL_MS:-30000}
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
      RUIJIE_API_TOKEN: ${RUIJIE_API_TOKEN:-}
    ports:
      - "8080:8080"
    volumes:
      - routerdeck-data:/data
    networks:
      - routerdeck

volumes:
  routerdeck-data:

networks:
  routerdeck:
    driver: bridge
```

Compose reads `.env` automatically from the same directory — no `env_file:` needed. Start with:

```bash
docker compose up -d
```

Then open http://localhost:8080.

## Environment variables reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `ADMIN_PASSWORD` | — | ✅ | Login password for the web UI. **Must be set.** |
| `APP_SECRET` | — | ✅ | Secret used to encrypt stored credentials and sessions. **At least 32 characters.** Keep it stable — changing it breaks restoring password-less backups. |
| `PORT` | `8080` | | HTTP port inside the container. |
| `DB_PATH` | `/data/routerdeck.db` | | SQLite database path. Mount a volume at `/data` to persist it. |
| `POLL_INTERVAL_MS` | `15000` | | How often live metrics (CPU, traffic, clients) are collected. Clamped to ≥ 5000. |
| `UPTIME_INTERVAL_MS` | `30000` | | How often devices/services are reachability-checked for uptime and Telegram alerts. Clamped to ≥ 10000. |
| `COOKIE_SECURE` | `false` | | Set `true` when serving over HTTPS (secure session cookies). |
| `RUIJIE_API_TOKEN` | *(empty)* | | Optional global token override for Ruijie/Reyee Cloud `api_token` auth. |
| `RUIJIE_CLOUD_CACHE_MS` | `120000` | | Ruijie Cloud response cache window. |
| `RUIJIE_CLOUD_STALE_MS` | `1800000` | | How long stale Ruijie Cloud data is served. |
| `RUIJIE_RATE_LIMIT_BACKOFF_MS` | `300000` | | Backoff applied after a Ruijie Cloud rate limit. |
| `RUIJIE_INVENTORY_CACHE_SECONDS` | `900` | | Ruijie inventory cache TTL. |
| `TZ` | `Asia/Jakarta` | | Container timezone so Telegram alert timestamps (and logs) use your local time instead of UTC. Override in your `.env` (e.g. `TZ=Europe/Berlin`). |
| `GATEWAY_ANALYTICS_TTL_MS` | `15000` | | Server-side cache window for MikroTik gateway analytics. |

## First setup

1. **Log in** with `ADMIN_PASSWORD` at http://localhost:8080.
2. **Add devices** — *Devices → Add*: OpenWrt (SSH), MikroTik (REST API), Ruijie/Reyee Cloud (API token), or a *generic* device for plain ICMP ping monitoring (no credentials needed).
3. **Add network services** — *Devices → Network services → Add*: AdGuard Home, Home Assistant, Proxmox VE, Synology DSM, Nginx Proxy Manager or CasaOS with their base URL and credentials. Their API, stats and health are collected on each poll.
4. **Uptime** — every device and service is checked every `UPTIME_INTERVAL_MS`; the *Uptime* page shows rolling 24-hour availability.

### Telegram notifications

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token (`123456789:AA...`).
2. Get your numeric chat ID from [@userinfobot](https://t.me/userinfobot), or add the bot to a group and use the group's negative ID (`-1001234567890`).
3. **Settings → Telegram notifications**: enable notifications, paste the token (stored encrypted, never shown again), then **Add chat** for each channel you want alerts in.
4. Each chat can be routed to **all** devices/services or to a **selected** subset (e.g. a "Server room" chat for Proxmox alerts and a "Home" chat for router/AP alerts), with independent DOWN/UP toggles and a per-chat **Test** button.
5. Alerts are sent only on status *changes* — an ongoing outage does not spam the chat, and an item already down across a restart still reports its recovery.

### Telegram bot commands

Once Telegram notifications are enabled, the bot also answers interactive
commands in any chat it is added to (the command menu registers itself
automatically via the Telegram client):

| Command | Reply |
|---|---|
| `/devices` | All monitored devices with current status (✅ up / 🔴 down / ❔ no data) |
| `/services` | All network services with current status |
| `/online` | Everything currently up (devices + services) |
| `/offline` | Everything currently unreachable |
| `/clients` | Live connected-client count per device |
| `/help` | This command list |

### Public status page

Enable sharing in **Uptime → Public status page** settings: title, subtitle, auto-refresh and accent color. The read-only page is served at `/status` without login. Router credentials, metrics and client data stay behind login.

## Backups

**Settings → Configuration backup**: export devices, services, encrypted credentials and settings as an encrypted JSON file. Use a password for portable backups, or leave it blank to encrypt with your `APP_SECRET`.

## Upgrading

```bash
docker pull anemonastrum/routerdeck:latest
docker compose up -d   # or: docker restart routerdeck after pulling
```

The database auto-migrates on boot — upgrades never delete uptime history or configured targets.

## Build from source

```bash
git clone https://github.com/Anemonastrum/routerdeck.git
cd routerdeck
npm install
# development:  ADMIN_PASSWORD=... APP_SECRET=... node server.js
# production:   docker build -t anemonastrum/routerdeck .
```
