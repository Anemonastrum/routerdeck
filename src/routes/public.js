import { Router } from 'express';
import {
  getAppSettings,
  getStatusSettings,
  latestServiceUptimeAll,
  latestUptimeAll,
  listDevices,
  listServices,
  serviceUptimeHistory,
  uptimeHistory,
} from '../db/index.js';

function bucketHistory(rows, count = 60, hours = 24) {
  const end = Date.now();
  const start = end - hours * 3600_000;
  const width = (end - start) / count;

  return Array.from({ length: count }, (_, index) => {
    const bucketStart = start + index * width;
    const bucketEnd = bucketStart + width;
    const values = rows.filter(row => row.ts >= bucketStart && row.ts < bucketEnd);
    const ts = Math.round(bucketStart + width / 2);
    if (!values.length) return { status: null, ts };

    const healthy = values.filter(row => Number(row.status) === 1).length;
    return { status: healthy / values.length >= 0.5 ? 1 : 0, ts };
  });
}

export function createPublicRouter({ indexFile }) {
  const router = Router();

  // Public status intentionally exposes availability data only, never credentials
  // or privileged device/service management information.
  router.get('/api/public/status', (_req, res) => {
    const settings = getStatusSettings();
    const since = Date.now() - 24 * 3600_000;
    const latestDevices = new Map(latestUptimeAll().map(row => [row.device_id, row]));
    const latestServices = new Map(latestServiceUptimeAll().map(row => [row.service_id, row]));

    const devices = listDevices().map(device => {
      const history = uptimeHistory(device.id, since);
      const healthy = history.filter(row => Number(row.status) === 1).length;
      const last = latestDevices.get(device.id) || null;
      return {
        id: device.id,
        kind: 'device',
        name: device.name,
        host: settings.showHosts ? device.host : null,
        type: device.osType,
        deviceRole: device.deviceRole,
        status: last ? Number(last.status) : null,
        latencyMs: last?.latency_ms ?? null,
        checkedAt: last?.ts ?? null,
        uptime24h: history.length ? (healthy / history.length) * 100 : null,
        history: bucketHistory(history),
      };
    });

    const services = listServices().map(service => {
      const history = serviceUptimeHistory(service.id, since);
      const healthy = history.filter(row => Number(row.status) === 1).length;
      const last = latestServices.get(service.id) || null;
      return {
        id: service.id,
        kind: 'service',
        name: service.name,
        host: settings.showHosts ? service.host : null,
        type: service.serviceType,
        status: last ? Number(last.status) : null,
        latencyMs: last?.latency_ms ?? null,
        checkedAt: last?.ts ?? null,
        uptime24h: history.length ? (healthy / history.length) * 100 : null,
        history: bucketHistory(history),
      };
    });

    res.json({
      settings,
      branding: getAppSettings(),
      generatedAt: Date.now(),
      devices: [...devices, ...services],
    });
  });

  router.get('/api/public/branding', (_req, res) => {
    const { appName, theme, clockFormat, timeZone } = getAppSettings();
    res.json({
      appName,
      theme,
      clockFormat,
      timeZone,
      githubUrl: process.env.ROUTERDECK_GITHUB_URL || 'https://github.com/',
    });
  });

  router.get('/status', (_req, res) => res.sendFile(indexFile));

  return router;
}
