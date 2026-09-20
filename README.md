# RouterDeck

RouterDeck is a self-hosted network monitoring dashboard for home labs and small networks. It tracks devices, managed services, uptime, resource use, traffic, connected clients, and status changes from one web interface.

- Source: [github.com/Anemonastrum/routerdeck](https://github.com/Anemonastrum/routerdeck)
- Docker image: [`anemonastrum/routerdeck`](https://hub.docker.com/r/anemonastrum/routerdeck)
- Architectures: `linux/amd64`, `linux/arm64`

## Features

- Live dashboards for OpenWrt, MikroTik RouterOS, Ruijie/Reyee Cloud, and generic ICMP targets
- Integrations for AdGuard Home, Home Assistant, Proxmox VE, Synology DSM, Nginx Proxy Manager, and CasaOS
- CPU, memory, traffic, uptime, latency, and connected-client metrics
- Rolling 24-hour availability history
- Telegram DOWN and recovery alerts with multiple chats and per-target routing
- Telegram bot commands for device, service, online, offline, and client status
- Automatic Telegram alert timezone detection from browser
- Public read-only status page at `/status`
- Interactive network topology
- Browser SSH terminal
- Encrypted configuration backup and restore
- Persistent SQLite storage

## Requirements

- Linux host with Docker Engine
- Docker Compose plugin (`docker compose`)
- TCP port `8080`, or another port selected through `ROUTERDECK_PORT`

Install Docker from [Docker Engine installation documentation](https://docs.docker.com/engine/install/) if needed.

## One-line installation

Run on Docker host:

```bash
curl -fsSL https://raw.githubusercontent.com/Anemonastrum/routerdeck/main/install.sh | sh
```

Installer:

1. Verifies Docker and Docker Compose.
2. Creates `~/routerdeck/compose.yaml` and `~/routerdeck/.env`.
3. Generates random admin password and application secret.
4. Pulls `anemonastrum/routerdeck:latest`.
5. Starts RouterDeck with persistent Docker volume.
6. Prints URL and generated admin password.

Open [http://localhost:8080](http://localhost:8080) after installation. Use server IP instead of `localhost` when connecting from another device.

Review script before execution if preferred:

```bash
curl -fsSL https://raw.githubusercontent.com/Anemonastrum/routerdeck/main/install.sh -o install.sh
less install.sh
sh install.sh
```

### Installer options

Set variables before command:

```bash
ROUTERDECK_PORT=8090 ROUTERDECK_TAG=v1.17.5 ROUTERDECK_DIR=/opt/routerdeck sh -c "$(curl -fsSL https://raw.githubusercontent.com/Anemonastrum/routerdeck/main/install.sh)"
```

| Variable | Default | Purpose |
|---|---:|---|
| `ROUTERDECK_PORT` | `8080` | Host HTTP port |
| `ROUTERDECK_TAG` | `latest` | Docker image tag |
| `ROUTERDECK_DIR` | `~/routerdeck` | Generated configuration directory |

Running installer again keeps existing `.env` credentials and updates container from selected image tag.

## Manual Docker installation

Create directory and `.env`:

```bash
mkdir -p routerdeck && cd routerdeck
printf 'ADMIN_PASSWORD=%s\nAPP_SECRET=%s\n' \
  'replace-with-a-secure-password' \
  "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

Create `compose.yaml`:

```yaml
services:
  routerdeck:
    image: anemonastrum/routerdeck:latest
    container_name: routerdeck
    restart: unless-stopped
    environment:
      PORT: 8080
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      APP_SECRET: ${APP_SECRET:?Set APP_SECRET in .env}
      DB_PATH: /data/routerdeck.db
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
    ports:
      - "${ROUTERDECK_PORT:-8080}:8080"
    volumes:
      - routerdeck-data:/data

volumes:
  routerdeck-data:
```

Start RouterDeck:

```bash
docker compose up -d
```

### `docker run`

```bash
docker volume create routerdeck-data
docker run -d \
  --name routerdeck \
  --restart unless-stopped \
  -p 8080:8080 \
  -e ADMIN_PASSWORD='replace-with-a-secure-password' \
  -e APP_SECRET='replace-with-at-least-32-random-characters' \
  -e DB_PATH='/data/routerdeck.db' \
  -v routerdeck-data:/data \
  anemonastrum/routerdeck:latest
```

## First setup

1. Sign in with `ADMIN_PASSWORD`.
2. Add devices from **Devices → Add**.
3. Add managed services from **Devices → Network services → Add**.
4. Open **Uptime** to view availability and configure public status page.
5. Open **Settings** to configure appearance, Telegram, and backups.

### Device types

| Type | Connection | Main data |
|---|---|---|
| OpenWrt | SSH | System, traffic, wireless, clients |
| MikroTik RouterOS | REST API | System, interfaces, queues, firewall, clients |
| Ruijie/Reyee Cloud | API token | Cloud inventory, ports, clients |
| Generic | ICMP ping | Availability and latency |

### Service integrations

- AdGuard Home
- Home Assistant
- Proxmox VE
- Synology DSM
- Nginx Proxy Manager
- CasaOS

## Telegram notifications

1. Create bot through [@BotFather](https://t.me/BotFather).
2. Get numeric chat ID through [@userinfobot](https://t.me/userinfobot), or add bot to group and use group ID.
3. Open **Settings → Telegram notifications**.
4. Enable notifications and save bot token.
5. Add one or more chats and select monitored devices or services.
6. Use **Test** button to verify delivery.

Alerts fire only on state transitions. Continued outage does not repeatedly send DOWN messages. Recovery sends separate UP alert with downtime and latency when available.

When timezone remains **Automatic**, authenticated browser detects current IANA timezone and saves it for server-side Telegram timestamps. Manual timezone selection remains available.

### Bot commands

| Command | Result |
|---|---|
| `/devices` | All monitored devices and current status |
| `/services` | All managed services and current status |
| `/online` | Online devices and services |
| `/offline` | Unreachable devices and services |
| `/clients` | Connected-client count per device |
| `/help` | Command list |

## Public status page

Configure page under **Uptime → Public status page**. Public page is available at:

```text
http://YOUR_SERVER:8080/status
```

Page exposes status and uptime only. Credentials and management controls remain authenticated.

## Configuration

| Variable | Default | Required | Description |
|---|---:|:---:|---|
| `ADMIN_PASSWORD` | — | Yes | Web login password |
| `APP_SECRET` | — | Yes | Credential and session encryption secret; minimum 32 characters |
| `PORT` | `8080` | No | HTTP port inside container |
| `DB_PATH` | `/data/routerdeck.db` | No | SQLite database path |
| `POLL_INTERVAL_MS` | `15000` | No | Metrics collection interval; minimum 5000 ms |
| `UPTIME_INTERVAL_MS` | `30000` | No | Reachability-check interval; minimum 10000 ms |
| `COOKIE_SECURE` | `false` | No | Set `true` behind HTTPS |
| `TZ` | Container default | No | Server fallback timezone; browser auto-detection normally supplies alert timezone |
| `RUIJIE_API_TOKEN` | Empty | No | Global Ruijie/Reyee API token override |
| `RUIJIE_CLOUD_CACHE_MS` | `120000` | No | Ruijie Cloud response cache |
| `RUIJIE_CLOUD_STALE_MS` | `1800000` | No | Ruijie stale-data window |
| `RUIJIE_RATE_LIMIT_BACKOFF_MS` | `300000` | No | Ruijie rate-limit backoff |
| `RUIJIE_INVENTORY_CACHE_SECONDS` | `900` | No | Ruijie inventory cache TTL |
| `GATEWAY_ANALYTICS_TTL_MS` | `15000` | No | MikroTik gateway analytics cache |

Keep `APP_SECRET` stable. Changing it invalidates encrypted stored credentials and backups created without separate password.

## Data and backups

SQLite database lives at `/data/routerdeck.db` in container. Docker examples mount `routerdeck-data` volume at `/data`.

Use **Settings → Configuration backup** to export configuration. Password-protected export is portable. Export without password uses current `APP_SECRET`.

Inspect volume:

```bash
docker volume inspect routerdeck-data
```

## Updating

Installer-managed installation:

```bash
cd ~/routerdeck
docker compose pull
docker compose up -d
```

Manual Compose installation uses same commands from directory containing `compose.yaml`.

Pin release by changing image tag:

```yaml
image: anemonastrum/routerdeck:v1.17.5
```

Database migrations run automatically during startup. Back up data before major upgrades.

## Operations

```bash
# Status
docker ps --filter name=routerdeck

# Logs
docker logs -f routerdeck

# Restart
docker restart routerdeck

# Stop without deleting data
cd ~/routerdeck && docker compose down

# Start again
cd ~/routerdeck && docker compose up -d
```

Do not add `-v` to `docker compose down` unless persistent RouterDeck data should be deleted.

## Build from source

```bash
git clone https://github.com/Anemonastrum/routerdeck.git
cd routerdeck
npm install
npm test
npm run check
docker build -t routerdeck:local .
```

Development server requires `ADMIN_PASSWORD` and `APP_SECRET`:

```bash
ADMIN_PASSWORD='development-password' \
APP_SECRET='development-secret-at-least-32-characters' \
npm start
```

## Security

- Use strong `ADMIN_PASSWORD`.
- Keep `.env`, `APP_SECRET`, Telegram token, backups, and device credentials private.
- Put RouterDeck behind HTTPS before setting `COOKIE_SECURE=true`.
- Restrict dashboard access to trusted network or authenticated reverse proxy.
- Review downloaded install script before execution when required by local security policy.

## License

See repository for current license terms: [github.com/Anemonastrum/routerdeck](https://github.com/Anemonastrum/routerdeck).
