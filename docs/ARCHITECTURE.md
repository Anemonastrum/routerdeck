# RouterDeck architecture

RouterDeck is organized by responsibility so adding device drivers or network-service integrations does not grow the process bootstrap into a monolith.

## Runtime layout

- `server.js` — application bootstrap, Express/Socket.IO composition, monitoring startup, and graceful shutdown.
- `src/routes/` — HTTP transport grouped by public, network, devices, services, topology, settings, and refresh domains.
- `src/drivers/` — device-specific collectors and management adapters for OpenWrt, MikroTik, generic monitors, and Ruijie/Reyee.
- `src/services/` — managed network-service adapters (`adguard.js`, `homeassistant.js`, `proxmox.js`, `synology.js`, `nginx-proxy-manager.js`, `casaos.js`) plus their dispatcher in `index.js`.
- `src/configs/` — runtime environment validation and encrypted configuration backup/restore.
- `src/db/` — SQLite persistence boundary:
  - `connection.js` opens/closes SQLite and owns database pragmas.
  - `schema.js` contains schema initialization and migrations.
  - `index.js` exposes the main RouterDeck persistence/repository functions.
  - `topology.js` owns topology node/link persistence and inventory synchronization.
- `src/etc/` — shared runtime helpers such as authentication, crypto, monitoring, SSH, GeoIP, public-IP lookup, terminal setup, and upstream error normalization.
- `public/img/` — all locally served logos, favicons, and service/device images.
- `public/js/` — dependency-free browser helpers.
- `public/app.js` — dashboard state and page rendering, including the interactive topology workspace.
- `public/login.css` — login-only styles; dashboard styles remain in `public/styles.css`.

## Database lifecycle

RouterDeck uses `better-sqlite3` as one process-wide SQLite connection. The connection is initialized once through `src/db/connection.js`, schema/migrations run once from `src/db/schema.js`, and the server closes SQLite explicitly on `SIGTERM`/`SIGINT` after monitoring is stopped. This avoids relying solely on native-addon garbage collection during Node process teardown.

## API boundary

Public routes are registered before the `/api` authentication gate. All management routes are registered after `requireAuth`, so new `/api/*` endpoints are authenticated by default.

Keep existing API paths stable unless a breaking version is intentional. Device-specific behavior belongs in `src/drivers/`; managed-service behavior belongs in `src/services/` plus `src/routes/services.js`.

## Verification

Run:

```bash
npm run check
```

The check validates JavaScript syntax, relative module imports, `/img/` references, and required project directories. A deployment smoke test still requires installed dependencies and valid `APP_SECRET` / `ADMIN_PASSWORD` values.
