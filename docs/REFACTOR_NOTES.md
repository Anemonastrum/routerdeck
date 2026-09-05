# RouterDeck 1.17.3 Refactor Notes

## Native SQLite crash addressed

The reported crash occurred inside `better_sqlite3.node` while a native `Statement` object was being destroyed:

- `node::RemoveEnvironmentCleanupHook(...)`
- `Assertion failed: (env) != nullptr`
- `Statement::~Statement()`
- exit code `139` (segmentation fault)

RouterDeck 1.17.2 changes the native-runtime boundary in three ways:

1. Docker now uses Node.js 22 LTS instead of Node.js 24.
2. `better-sqlite3` is pinned to 13.0.3, the N-API-based generation rather than the older V8/Node-version-coupled implementation.
3. SQLite now has explicit graceful shutdown through `closeDatabase()` after monitoring and HTTP/socket activity are stopped.

These changes target both compatibility and teardown ordering rather than hiding the crash with a restart policy.

## Structure changes

- Service integrations moved into `src/services/`.
- Configuration modules moved into `src/configs/`.
- Database code moved into `src/db/` and split into connection, schema/migration, and repository responsibilities.
- Miscellaneous shared runtime helpers moved into `src/etc/`.
- Public logos, icons, and favicons moved into `public/img/`.
- All internal imports and browser image references were updated to the new layout.

## Monitoring lifecycle

`startMonitoring()` now tracks its timers and exposes `stop()` plus `waitForIdle()`. The process shutdown handler prevents new monitor cycles, closes Socket.IO/HTTP, waits briefly for active monitor jobs, checkpoints/closes SQLite, and then exits.

## Verification performed

- JavaScript syntax validation for the complete source tree.
- Relative-import resolution validation.
- Public `/img/` reference validation.
- Required-directory validation for the new structure.
- Legacy moved-path scan.

A full `npm install` was attempted in the sandbox but exceeded the execution limit, so Docker/runtime dependency installation must still be exercised on the deployment host with a clean rebuild.
