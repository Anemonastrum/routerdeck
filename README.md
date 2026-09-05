# RouterDeck



## RouterDeck 1.17.5

### 1.17.5 monitoring and device UI updates

- Removed the public-status accent color picker from the Uptime settings page; existing stored status colors remain backward-compatible.
- Device/service detail headers now use a chevron-left **Back** action, with text on desktop and icon-only controls on mobile.
- Delete actions now use the same icon + text responsive behavior as Edit.
- OpenWrt CPU monitoring now uses cross-poll `/proc/stat` deltas with a minimum sampling window and correct Linux guest-time accounting, preventing false/stuck 100% readings on slower devices.
- Generic uptime monitor types now include **IP camera**.
- Generic Router, Access point, Switch and IP camera icons use filled dashboard-oriented artwork instead of the previous outline-only symbols.


## RouterDeck 1.17.4

### 1.17.4 topology and monitor updates

- Topology is device-only; managed network services no longer appear as topology nodes.
- AP/client device cards can show live DHCP/Wi-Fi/neighbor clients as attached child cards connected by dashed lines; the Host/Gateway card is excluded.
- Topology connection actions now use a compact double-chevron button beside the open-device action.
- Generic uptime monitors can be categorized as Router, Access point, or Switch, with matching inventory/topology/uptime icons.
- Settings now includes an explicit Logout action.


## RouterDeck 1.17.3

- Added the persistent **Topology** workspace and authenticated `GET /api/topology` / `PUT /api/topology` endpoints.
- Added draggable topology cards, saved links, auto-arrange, direct device opening, and the Connections list.
- Fixed Devices inventory rows at portrait/medium desktop widths so the Edit button and chevron remain contained inside each card.
- Updated the mobile navigation to accommodate the Topology destination.

## RouterDeck 1.17.2

- Fixed a native `better-sqlite3` teardown crash by moving Docker to Node.js 22 LTS, pinning `better-sqlite3` 13.0.3 (N-API), and closing SQLite explicitly during graceful shutdown.
- Reorganized backend code into `src/services/`, `src/configs/`, `src/db/`, and `src/etc/`.
- Split SQLite connection/lifecycle, schema/migrations, and repository functions across the `src/db/` folder.
- Moved all frontend logos, icons, and favicons into `public/img/` and updated their references.
- Monitoring timers can now be stopped and drained during SIGTERM/SIGINT shutdown.
- Expanded `npm run check` to validate module imports, public image references, and required project directories.

## RouterDeck 1.17.1

- Refactored the HTTP server into focused route modules for public endpoints, devices, services, settings, network utilities, and manual refresh while preserving existing API paths.
- Extracted reusable frontend HTTP, formatting, and Heroicon helpers from the main dashboard script.
- Replaced the multi-panel sign-in screen with a compact responsive login card for mobile, tablet, and desktop.
- Moved sign-in styling into `public/login.css` and removed the old stacked WebFig/login CSS overrides from the dashboard stylesheet.
- Added `npm run check` for repeatable JavaScript syntax validation.

## RouterDeck 1.17

- Network Service detail pages now remember whether they were opened from Overview or Devices, matching device back-navigation behavior.
- The Overview Online summary combines Network Devices and Network Services and reports online vs total targets.
- MikroTik gateway Connection Analytics now uses in-flight request deduplication, a short server-side cache and an always-200 stale/empty fallback so transient RouterOS failures do not surface as HTTP 502 cards.
- Login was redesigned around a compact WebFig-inspired management panel with responsive desktop/tablet/mobile layouts and quick links for GitHub, public uptime Status and Help.
- Set `ROUTERDECK_GITHUB_URL` to point the unauthenticated GitHub quick-link at your RouterDeck repository.

## RouterDeck 1.16

- Fixed the mobile login layout with a compact safe-area-aware design and no automatic soft-keyboard focus on phones/tablets.
- Uptime and Settings use a Heroicons document-check Save action: icon + “Save” on desktop, icon-only on mobile.
- Add/Edit device and service dialogs now animate smoothly on open and close, including Escape/cancel actions.
- Shortened the Devices inventory subtitle.

## RouterDeck 1.15

- Devices and Network Services can now be edited directly from their inventory rows or detail pages. Credential fields are write-only in edit mode; leave them blank to keep the saved value.
- CasaOS is available as a managed Network Service with uptime/status, installed application inventory, and start/stop/restart controls through CasaOS UserService/AppManagement APIs.
- The sign-in screen is redesigned as a responsive mobile-first entry experience with network capability highlights and a smooth authenticated transition into the dashboard.

## RouterDeck v1.14

- Removed the experimental Reyee EW local-eWeb device integration; existing EW entries are migrated to generic ICMP uptime monitors so their uptime history is preserved.
- Overview card ordering now uses the entire card as the drag surface; the card follows the pointer while neighboring cards animate into place.
- Form fields, search boxes and filter selects use normalized appearance rules for macOS Safari, iOS Safari, Chromium and Firefox.

- Ruijie Cloud polling now uses a 2-minute snapshot cache, 15-minute inventory cache, in-flight request deduplication, stale-data fallback, and exponential backoff for Ruijie API error 44 (`Too many requests`).
- Added Nginx Proxy Manager as a Network Service using its authenticated `/api` endpoints. RouterDeck can monitor uptime, proxy-host/certificate counts, enable/disable proxy hosts, and request certificate renewal.
- Nginx Proxy Manager credentials and optional Bearer token are encrypted using the existing RouterDeck credential store.


> v1.10 adds Ruijie/Reyee gateway/router monitoring, Ruijie Cloud region auto-detection/account reuse, and inventory-style Home Assistant control filters.


RouterDeck is a self-hosted dashboard for managing OpenWrt, MikroTik RouterOS and supported Ruijie/Reyee Cloud switches, plus network services such as AdGuard Home, Home Assistant, Proxmox VE and Synology DSM on a local network.

## Features

- Synology DSM network-service support through `synology-api`: system health, CPU/RAM, temperatures, storage/volume inventory, installed packages, uptime, reboot/shutdown and direct DSM access
- Ruijie/Reyee worker hardened with lazy imports, structured diagnostics, stderr propagation and automatic one-shot retry; runtime now includes the full Python environment required by `pyruijie`
- Proxmox node hardware cards span the full desktop content width and the Guests search/type filter now reuse the Devices inventory toolbar

- Proxmox node hardware details including kernel, CPU topology/model, RAM/swap/root filesystem and PCI/PCIe inventory
- Encrypted configuration backup/restore from Settings; optional password makes backups portable across RouterDeck installations
- Ruijie/Reyee Cloud switch monitoring through `pyruijie`: cloud state, model/firmware, physical switch ports, VLAN/PoE/uplink state and connected wired clients
- Unified **Add** dialog for network devices and network services
- Network-service uptime history and public `/status` integration
- Home Assistant monitoring through its REST API with long-lived access tokens
- Proxmox VE monitoring through `/api2/json`, with API-token or username/password authentication
- Proxmox node/cluster overview plus QEMU VM and LXC container power controls
- Home Assistant Overview and Control tabs, entity actions, restart control, and direct web-UI link
- Cached MikroTik gateway connection analytics: the last successful snapshot is shown if the next RouterOS fetch fails
- AdGuard Home direct web-UI link plus optional process Start/Stop over SSH
- AdGuard Home network-service monitoring and management over its REST API
- AdGuard Home Overview, DNS Settings and Query Log tabs
- Optional AdGuardHome process CPU / memory monitoring over SSH
- Network Services cards below Network Devices on the main Overview
- Dashboard Icons assets bundled locally for AdGuard Home, Home Assistant, Proxmox VE and generic router monitors
- Exactly one MikroTik device can be designated Host / gateway
- Host / gateway connection analytics live on the main Overview below Network Services
- Manual device registration by IP address or hostname
- OpenWrt monitoring over SSH + native `ubus`/`/proc` data
- MikroTik monitoring through RouterOS REST API
- Embedded SSH terminal for both platforms
- Device overview with hardware / OS information
- CPU, memory, load, uptime and interface traffic statistics
- 24-hour RX/TX bandwidth-rate graph derived from stored interface counters
- Associated Wi-Fi station list
- DHCP lease list
- Network-neighbor fallback when a device is not the DHCP server
- Ping-based uptime history similar to Uptime Kuma
- SQLite storage
- Encrypted device credentials
- MikroTik Simple Queue / Queue Tree management over RouterOS REST
- MikroTik firewall filter / NAT / mangle / raw management over RouterOS REST
- Device log viewer for MikroTik and OpenWrt
- Local OpenWrt/MikroTik logos from Dashboard Icons
- Docker deployment, including ARM64 native-module build support
- Catppuccin Latte / Frappé / Macchiato / Mocha application themes plus AMOLED Black
- Searchable device inventory with device-type filtering
- Device model shown on both Overview cards and Devices inventory rows
- MikroTik role selector: Client / managed device or Host / gateway
- MikroTik Host analytics: protocol totals, active flow rate, top sources, top destinations, destination ports, top countries, world connection map, flow groups and active connection table
- Local GeoIP lookup with `geoip-lite`; remote addresses are not sent to a third-party GeoIP service


## RouterDeck 1.5 Proxmox hardware, backups and Ruijie switches

### Proxmox hardware detail

The Proxmox **Overview** now expands each node with kernel/PVE version, CPU model/topology/frequency, RAM and swap usage, root filesystem usage, boot mode, plus a collapsible PCI/PCIe inventory. The PCI inventory is cached server-side for five minutes so RouterDeck does not repeatedly request essentially static hardware information every polling cycle. The **Guests** tab uses responsive guest cards with separate CPU, memory, disk and uptime blocks and a dedicated power-action footer.

### Configuration backup and restore

Settings now contains **Configuration backup** directly below Web Application settings. A backup includes devices, network services, their encrypted-at-rest credentials after export re-encryption, web application settings and public status settings. Monitoring/uptime history is intentionally excluded. Entering an optional backup password creates a portable AES-256-GCM encrypted backup; leaving it blank binds the backup to the current `APP_SECRET`. Restore replaces the current device/service configuration in one SQLite transaction.

### Ruijie/Reyee Cloud switches

Choose **Network device → Ruijie/Reyee Cloud switch**, then provide the switch local IP (for RouterDeck ICMP uptime), switch serial number, Cloud region, App ID and App Secret. The Docker image installs `pyruijie` in a small Python virtual environment and RouterDeck keeps a persistent bridge process so authenticated Cloud sessions can be reused between polls.

The current integration is intentionally monitoring-focused: switch cloud state, model/firmware, local/egress IP, physical port state, speed, VLANs, uplink, PoE/power and connected clients. RouterDeck does not expose switch configuration writes because the `pyruijie` Cloud switch methods used here are read/inventory operations.

## RouterDeck 1.4 network services

Use the single **Add** button and choose **Network service**. RouterDeck currently supports:

- **AdGuard Home** — status/statistics, DNS settings, query log, protection toggle, cache clear, direct web UI link, and optional process Start/Stop plus CPU/RAM collection over SSH. RouterDeck first tries HTTP Basic authentication and automatically falls back to AdGuard Home session-cookie login after a 401/403.
- **Home Assistant** — authenticated API health, instance metadata, room/entity summary, entity and automation controls, restart control, and a direct web UI link. Home Assistant uses a long-lived access token stored encrypted with `APP_SECRET`.
- **Proxmox VE** — node/cluster health, aggregate CPU/RAM, QEMU VM/LXC inventory, and guest start/shutdown/reboot/force-stop actions over the Proxmox VE REST API. API tokens are preferred; username/password ticket authentication is available as a fallback.

All service types participate in RouterDeck's uptime subsystem. Their API availability and latency are stored in `service_uptime_checks`, displayed on the authenticated Uptime page, and included on the public `/status` page without exposing credentials or management functions.

The main Overview has no separate **Add service** button; device and service creation share the same Add dialog.

MikroTik gateway connection analytics are cached in SQLite after every successful fetch. If the live RouterOS connection-table request fails, RouterDeck returns the last successful snapshot and labels it **Cached fallback**, including the cache timestamp and current fetch error.

### Home Assistant setup

Create a long-lived access token from the Home Assistant user profile, then add a **Network service → Home Assistant** entry. The default port is `8123`; HTTPS and self-signed TLS can also be selected when your installation uses them. RouterDeck talks to `/api/`, `/api/config`, `/api/states`, and the authenticated `/api/services/<domain>/<service>` endpoints.

### AdGuard Home authentication and process control

The AdGuard Home API is used for DNS/protection management. RouterDeck sends the configured Web UI username/password using Basic authentication first. If the server or reverse proxy responds with 401/403, RouterDeck logs in through `/control/login`, caches the returned session cookie briefly, and retries the API request. Actual process Start/Stop still needs host access because a stopped AdGuard Home process cannot receive an HTTP request to start itself. Enable the SSH option in the Add form if you want process Start/Stop and process CPU/RAM metrics.

### Proxmox VE setup

Add **Network service → Proxmox VE** and enter the Proxmox host/IP. RouterDeck defaults to HTTPS on port `8006` and supports self-signed TLS. The preferred authentication method is a Proxmox API token: enter the full token ID such as `root@pam!routerdeck` plus its secret. Alternatively, enter a Proxmox username such as `root@pam` and password; RouterDeck obtains and caches a PVE ticket/CSRF token. The service page provides **Overview** and **Guests** tabs.

For read-only monitoring, give the token/user permission to audit the relevant cluster/nodes/VMs. Guest power buttons additionally require the appropriate VM power-management privilege for the target guests.

## RouterDeck 1.0 Network Services and MikroTik gateway mode

MikroTik devices can be classified as either, but RouterDeck enforces a maximum of **one** Host / gateway at a time:

- **Client / managed device** — normal RouterDeck monitoring and management.
- **Host / gateway** — supplies the connection analytics section on the main RouterDeck Overview.

The role is selectable when adding a MikroTik and can be changed later from the device Overview page. If a gateway is already selected, other MikroTik devices cannot be promoted until it is demoted. Host analytics read the RouterOS connection-tracking table through REST and appear below Network Services on the main Overview:

- active connections and TCP / UDP / ICMP / other protocol totals
- established TCP sessions and aggregate live connection rate
- top source and destination addresses
- top destination ports
- source → destination flow groups
- country aggregation with protocol breakdown
- geographic connection map
- a highest-rate active-connection table

Geo-IP lookup runs locally in the RouterDeck container using `geoip-lite`. The Docker image uses Node.js 22 LTS for a stable native-addon runtime while remaining compatible with the current GeoIP package. Host analytics are loaded only while the authenticated **main Overview** is open and refresh every 10 seconds; they are not exposed on the public `/status` page.

For RouterOS REST, RouterDeck requests only the required connection properties with `.proplist`. The analytics source is `/ip/firewall/connection`; no packet sniffer or RouterDeck agent is installed on the router.

## RouterDeck 1.0 AdGuard Home

Add AdGuard Home from the unified **Add → Network service** form. RouterDeck uses AdGuard Home's authenticated `/control` API for status, statistics, DNS settings, protection state, cache clearing, and query log access.

The service card shows On/Off state and, when SSH process metrics are enabled, AdGuardHome process CPU and memory. AdGuard Home's HTTP API does not expose process CPU/RSS, so those two values are collected separately from `/proc` over optional SSH; all DNS management remains API-based.

The service detail page contains **Overview**, **DNS settings**, and **Query log** tabs. Credentials are encrypted in RouterDeck's SQLite database using the same `APP_SECRET` mechanism used for device credentials.

Dashboard icon assets are bundled locally from Dashboard Icons (`adguard-home.svg`, `home-assistant.svg`, `proxmox.svg`, and `router.svg`) so the browser does not depend on a third-party CDN at runtime.

## RouterDeck 0.3 OpenWrt collector fix

RouterDeck 0.2 bundled OpenWrt command output through the router-side `base64` command. On minimal OpenWrt images where that applet is unavailable or incompatible, the web API could return a mostly empty object such as `uptimeSec: 0`, blank model/version, null memory/traffic and no clients.

0.3 removes that dependency completely. RouterDeck opens one SSH connection and executes the native read-only commands directly. It uses:

- `ubus call system info`
- `ubus call system board`
- `/proc/stat`
- `/proc/meminfo`
- `/proc/net/dev`
- `/proc/cpuinfo`
- `/proc/uptime`
- `/proc/loadavg`
- `/etc/openwrt_release`
- `/tmp/sysinfo/model`
- `/tmp/sysinfo/board_name`
- `/tmp/dhcp.leases`
- `ip neigh show`
- `ubus call hostapd.* get_status`
- `ubus call hostapd.* get_clients`

No OpenWrt agent or extra OpenWrt package is required.

## Monitoring transports

### OpenWrt

OpenWrt monitoring is SSH-only. `ubus` provides board/system/Wi-Fi information and `/proc` provides low-level metrics and fallbacks.

The OpenWrt **Clients** page contains:

1. Associated Wi-Fi stations from hostapd ubus.
2. DHCP leases from `/tmp/dhcp.leases`.
3. If the device has no DHCP leases, an ARP/neighbor-table fallback is shown so a dumb AP still has useful client visibility.

If a DHCP server is running somewhere else, the fallback rows are explicitly labelled as network neighbors rather than DHCP leases.

### MikroTik RouterOS

All MikroTik monitoring uses RouterOS REST API. SSH is only used when the web SSH terminal is opened.

REST resources include:

- `/rest/system/resource`
- `/rest/system/identity`
- `/rest/system/routerboard`
- `/rest/interface`
- `/rest/ip/dhcp-server/lease`
- `/rest/ip/arp`
- `/rest/interface/wifi/registration-table`

RouterDeck also falls back to legacy `/interface/wireless/registration-table` and CAPsMAN registration tables when the modern WiFi table is unavailable.

HTTPS is recommended for RouterOS REST.

## Start with Docker

```bash
cp .env.example .env
```

Set at least:

```env
PORT=8080
ADMIN_PASSWORD=replace-with-a-strong-password
APP_SECRET=replace-with-at-least-32-random-characters
POLL_INTERVAL_MS=15000
UPTIME_INTERVAL_MS=30000
DB_PATH=/data/routerdeck.db
COOKIE_SECURE=false
```

Generate an application secret:

```bash
openssl rand -hex 32
```

Build and run:

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

Open:

```text
http://SERVER-IP:8080
```

## Add an OpenWrt device

Choose OpenWrt and provide SSH credentials. Root works on a standard OpenWrt installation.

RouterDeck does **not** require `base64`, LuCI, rpcd HTTP access or a custom agent.

## Add a MikroTik device

Choose MikroTik RouterOS and provide RouterOS REST credentials. Provide SSH credentials separately if you want to use the embedded terminal.

For monitoring only, a read-only REST account is enough. If you want to use the **Queues** and **Firewall** management tabs, the REST account also needs RouterOS write permission for those configuration changes. Keep that account restricted to the RouterDeck server IP when possible and use HTTPS for REST.

A read-only account will still work for device metrics, clients and logs; write actions will return a RouterOS permission error instead of silently falling back to SSH.

## Client counts

The generic **Connected clients** count is built from unique client MAC addresses:

- Wi-Fi association table
- active DHCP leases
- neighbor/ARP table only as a fallback when neither of the first two has data

The Clients page keeps the data sources separate so an ARP neighbor is never presented as a DHCP lease.

## SSH terminal

The browser terminal path is:

```text
Browser <-> Socket.IO <-> RouterDeck <-> SSH <-> Router/AP
```

Background metrics update cards/tables in place and do not rerender the terminal DOM, so an active terminal stays open while monitoring polls run.

## Debugging OpenWrt data

After adding a device, request the live endpoint from an authenticated browser session:

```text
/api/devices/DEVICE_ID/live
```

0.3 includes a `collector` object. A healthy OpenWrt response should normally show:

```json
{
  "collector": {
    "ubusSystem": true,
    "ubusBoard": true
  }
}
```

The first live call also takes a short CPU sample, so CPU percentage is available immediately instead of waiting for the next 15-second monitoring cycle.

## RouterDeck 0.4 additions

- Manual **Refresh** button beside the Live indicator. It forces a fresh ICMP uptime check and refreshes router/AP statistics for managed devices.
- Public, read-only uptime page at **`/status`**. No login is required for this route.
- Uptime-page customization for public status title, subtitle, auto-refresh interval, accent color, and optional IP/hostname visibility.
- Smoother device navigation with fade transitions and skeleton placeholders while live data is loading.
- **Generic uptime monitor** device type. Add any reachable IP address or hostname with no router credentials; RouterDeck monitors it using ICMP ping only.
- Generic devices do not expose SSH, resource statistics, DHCP or client tabs.

### Public status privacy

`/status` only serves uptime state, latency, 24-hour availability, and the configured display name. Device addresses are hidden by default and can be enabled from **Uptime → Public status page**. Credentials, terminals, DHCP leases, wireless clients, CPU/memory statistics, and management APIs remain authenticated.


## v0.5 additions

- OpenWrt and MikroTik device logos are bundled locally from the Dashboard Icons collection (`dashboardicons.com`).
- Managed device overview includes a 24-hour RX/TX bandwidth graph calculated from stored interface counter samples.
- MikroTik devices have RouterOS REST-backed **Queues** (Simple Queue + Queue Tree) and **Firewall** (filter/NAT/mangle/raw) tabs with list/add/edit/enable-disable/delete actions.
- Managed devices have a **Logs** tab. MikroTik reads `/log` over RouterOS REST; OpenWrt reads `logread` over SSH.

For MikroTik configuration writes, the REST account must have the RouterOS permissions required to modify queues/firewall rules (in addition to REST access). Use HTTPS for REST management. Be careful with firewall changes: a rule can cut off RouterDeck's access to the router.

Dashboard logos are sourced from Dashboard Icons / Homarr Labs and stored locally so the RouterDeck UI does not depend on a third-party CDN at runtime.

## v0.6 additions

- RouterDeck now uses the supplied custom logo for the login screen, sidebar, public status page, browser favicon and Apple touch icon.
- Generic uptime-only monitors use a router/network-device icon instead of the previous generic arrow mark.
- Managed OpenWrt and MikroTik devices now have an **Interfaces** tab. Physical Ethernet/SFP ports are rendered as port cards with live state:
  - **Ready**: interface is enabled and link/carrier is up.
  - **Not plugged**: physical port is enabled but has no carrier/link.
  - **Disabled**: administratively disabled/down.
- MikroTik interface state is collected through RouterOS REST (`/interface` and `/interface/ethernet`). OpenWrt reads the Linux `/sys/class/net` state over the existing SSH connection; no OpenWrt agent is required.
- Managed devices now have a **Wireless** tab.
  - OpenWrt reads `ubus call network.wireless status` and UCI wireless configuration. Existing SSIDs can be renamed, enabled/disabled, hidden, isolated, have encryption/password updated and have the radio channel changed. RouterDeck commits UCI and schedules `wifi reload` after the API response.
  - MikroTik uses RouterOS REST only. RouterDeck supports both the modern `/interface/wifi` menu and the legacy `/interface/wireless` menu. Modern WiFi interfaces can update SSID, enabled/hidden state, frequency, authentication types and an optional new passphrase. Legacy wireless interfaces can update SSID, enabled/hidden state and frequency; existing security-profile secrets are never exposed.
- Wireless password fields are write-only. RouterDeck never returns an existing Wi-Fi passphrase to the browser.

Changing Wi-Fi configuration can disconnect clients and can also interrupt RouterDeck itself when the management path uses the radio being modified. Prefer a wired management path when changing SSIDs, channels or security settings.

## RouterDeck 0.7 additions

- Live clock on the Overview dashboard with configurable 12-hour or 24-hour format.
- Global Settings page for web app name, theme (`system`, `light`, `dark`) and clock format.
- Mobile bottom navigation uses compact Heroicons-style outline icons rather than text labels.
- Device cards use the same green/red dot language as the Live indicator.
- OpenWrt port discovery mirrors LuCI Port Status behavior: `luci.getBuiltinEthernetPorts` first, then `/etc/board.json`, with sysfs only as a fallback. This preserves DSA names such as `lan1`, `lan2` and `wan`.
- OpenWrt physical port cards include carrier state, link speed/duplex, LAN/WAN role and RX/TX counters when available.

## Upgrading from older versions

Keep your existing `.env` and `/data/routerdeck.db`. On first startup v1.4 automatically:

- upgrades the network-service schema to support AdGuard Home, Home Assistant and Proxmox VE;
- creates service uptime history and gateway-analytics cache tables while preserving existing data;
- preserves one existing MikroTik Host / gateway and automatically demotes any additional old Host assignments to Client;
- adds a database-level unique constraint so only one MikroTik gateway can exist at a time;
- keeps all existing device metrics, uptime history, themes, credentials, queues, firewall configuration and device roles.

No new Node package is required for AdGuard Home support; RouterDeck uses its existing Axios and SSH dependencies. Rebuild the container to install the new application files:

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```


## v1.2 additions
- Theme-aware MikroTik Dashboard Icons logo for Latte/system-light vs dark themes.
- Device branding preview in the unified Add form.
- Home Assistant Automations tab (search, trigger, enable/disable).
- Time-zone setting for the dashboard clock.
- Viewport-safe mobile bottom navigation using dynamic viewport units (`dvh`) and hidden section scrollbar indicators.
- Targeted live DOM patches with skeleton-style shimmer instead of full-page redraws for routine metric updates.


## v1.3 additions

- Desktop sidebar is fixed to the top/left of the viewport while the content scrolls.
- The single MikroTik Host / gateway is always sorted to the first Network Devices card on the main Overview.
- Overview replaces the old device-count summary with the current public egress IP (with a short server-side cache).
- Home Assistant Overview includes room/area cards, and Home Assistant cards show the total room count. Room metadata is read through the authenticated Home Assistant WebSocket registry API and cached briefly.
- Uptime and Settings save controls use a Heroicons-style save/download icon; desktop shows icon + `save`, mobile shows the icon only.
- Mobile Live indicator is dot-only.
- OpenWrt devices can be classified as **Client** or **Access point**. Existing OpenWrt devices remain Client unless changed.
- The Clients tab adds **Internet access** controls for MikroTik devices and OpenWrt Client devices. RouterDeck creates/removes MAC-based firewall rules and can act directly on MAC addresses discovered from DHCP, Wi-Fi association, or neighbor data.
- Settings continues to include the global time-zone selection added in v1.2.

The v1.3 release adds the `ws` Node dependency for Home Assistant room/area registry discovery. Rebuild the Docker image so the dependency is installed.


## v1.4 additions

- AdGuard Home authentication now retries 401/403 responses using the native `/control/login` session-cookie flow, while retaining Basic authentication as the first/default API method.
- Added **Proxmox VE** as a Network Service with the locally bundled Dashboard Icons Proxmox logo.
- Proxmox supports API-token authentication (`user@realm!tokenid` + secret) and username/password ticket authentication.
- Proxmox Overview shows cluster/node availability, aggregate CPU and memory, Proxmox version, QEMU VM count, LXC count and running guests.
- Proxmox Guests provides searchable VM/container inventory with Start, Shutdown, Reboot and Force stop controls over the PVE API.
- Proxmox participates in the same RouterDeck service uptime history and public `/status` monitoring as AdGuard Home and Home Assistant.
- Existing v1.3 service/device data is preserved; the network-service CHECK constraint is migrated automatically on first startup.

## RouterDeck v1.8 notes

- Ruijie/Reyee Cloud worker now runs with the full Python runtime in the production container, keeps import/API failures inside the worker as structured errors, retries a crashed worker once, and includes the worker stderr tail in Docker/RouterDeck errors. The Ruijie device icon is the supplied Ruijie SVG.
- Proxmox node hardware cards are full-width on desktop. The Guests page uses the same search/filter/count toolbar pattern as Device inventory.
- Synology DSM is available under **Add → Network service → Synology DSM**. RouterDeck uses `N4S4/synology-api` through a persistent Python worker for DSM system health, CPU/memory, storage/volume/disk inventory, installed packages, uptime checks, and reboot/shutdown actions. Default DSM endpoint is HTTPS port 5001; HTTP port 5000 is also supported.

### Ruijie SDK compatibility

RouterDeck v1.8 supports both newer `pyruijie` builds that expose `RuijieClient.get_switch_ports()` and older PyPI builds that do not. When the public method is missing, the worker reuses the SDK's authenticated `_get()` transport against Ruijie Cloud API 2.6.7 (`/service/api/conf/switch/device/{sn}/ports`) with the same 0-based pagination used by current upstream pyruijie. This avoids the previous `AttributeError` while keeping the authenticated Cloud session inside pyruijie.


## RouterDeck v1.9 notes

Ruijie compatibility now covers both switch ports and connected clients. If the installed `pyruijie` build does not expose `RuijieClient.get_clients()`, RouterDeck reuses the SDK's authenticated `_get()` transport against `/service/api/open/v1/dev/user/current-user` with the same `group_id`, `page_index`, and `page_size` pagination used by current upstream. Device-detail navigation also remembers whether the device was opened from Overview or Devices, and gateway analytics no longer renders the connection map or active-connection table.


## RouterDeck v1.10 notes

- Ruijie/Reyee Cloud authentication now tries the configured region and the alternate official Asia/US endpoint before failing. An authenticated account is reused across additional Ruijie devices in the same RouterDeck worker.
- The Add form can reuse credentials from an already-working Ruijie device, avoiding repeated App ID/secret entry when adding another device from the same Cloud account.
- Ruijie monitoring now accepts Cloud gateways/routers as well as switches. Switches use the switch-port API; gateway-class devices use the gateway WAN/LAN port API, with authenticated `_get()` compatibility fallbacks for older `pyruijie` packages.
- Home Assistant Control and Automations now use the same search + filter + result-count toolbar pattern as Devices inventory.


## RouterDeck 1.11


## Telegram notifications

RouterDeck can send a Telegram message when a monitored device or service
goes down, and another when it comes back online.

**Setup**

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token
   (format `123456789:AA...`).
2. Find your numeric chat ID: message [@userinfobot](https://t.me/userinfobot)
   and note your ID, or add the bot to a group and use the group's ID
   (a negative number such as `-1001234567890`) as the chat ID.
3. Open RouterDeck **Settings → Telegram notifications**:
   - enable notifications,
   - paste the bot token (it is stored encrypted; the UI never shows it back),
   - enter the chat ID,
   - choose whether to alert on DOWN, on recovery (UP), or both, then **Save**.
4. Use **Send test message** to verify delivery before relying on it.

**Behavior**

- Alerts are sent only on a status *change*; a steady-down or steady-up state
  produces no messages, so an ongoing outage does not spam the chat.
- A device/service that is already down when RouterDeck restarts does not
  re-alert; its recovery is still reported.
- The bot token is stored encrypted with the same APP_SECRET as device
  credentials and is never exposed through the API or the status page.
- Notifications are fully disabled until enabled in Settings.

**Multiple chats and device/service routing**

- Use **Add chat** to register several Telegram channels. Each chat has its
  own label, enabled state and DOWN/UP toggles.
- A chat routed to **All devices and services** receives alerts for every
  monitored item. A chat routed to **selected** items only alerts for the
  devices and services you tick in its picker lists.
- One device can alert several chats at once, and a chat can watch only a
  subset — e.g. a "Server room" chat for Proxmox/service alerts and a
  "Home" chat for router/AP alerts.
- Each chat card has its own **Test** button to verify delivery to that
  channel.
- The single-chat setting from earlier versions is migrated automatically
  into a "Default" recipient on upgrade.
