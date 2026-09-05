function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadEnvironment() {
  const config = {
    port: positiveInteger(process.env.PORT, 8080),
    appSecret: String(process.env.APP_SECRET || ''),
    adminPassword: String(process.env.ADMIN_PASSWORD || ''),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    pollIntervalMs: Math.max(5000, positiveInteger(process.env.POLL_INTERVAL_MS, 15000)),
    uptimeIntervalMs: Math.max(10000, positiveInteger(process.env.UPTIME_INTERVAL_MS, 30000)),
  };

  if (config.appSecret.length < 32) {
    throw new Error('APP_SECRET must be set to at least 32 characters');
  }
  if (!config.adminPassword || config.adminPassword === 'change-this-password') {
    throw new Error('ADMIN_PASSWORD must be set to a non-default password');
  }

  return Object.freeze(config);
}
