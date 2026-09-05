import { Router } from 'express';
import {
  createDevice,
  deleteDevice,
  getDevice,
  getGatewayAnalyticsCache,
  latestMetric,
  latestUptimeAll,
  listDevices,
  metricHistory,
  reorderDevices,
  setGatewayAnalyticsCache,
  updateDetectedModel,
  updateDevice,
  uptimeHistory,
} from '../db/index.js';
import {
  blockInternetByMac,
  collectDevice,
  getDeviceLogs,
  getDeviceWireless,
  getInternetBlocks,
  testDevice,
  unblockInternetByMac,
  updateDeviceWireless,
} from '../drivers/index.js';
import {
  createMikroTikFirewallRule,
  createMikroTikQueue,
  deleteMikroTikFirewallRule,
  deleteMikroTikQueue,
  getMikroTikConnectionAnalytics,
  getMikroTikFirewall,
  getMikroTikQueues,
  updateMikroTikFirewallRule,
  updateMikroTikQueue,
} from '../drivers/mikrotik.js';
import { sendUpstreamError, upstreamError } from '../etc/http-errors.js';

const gatewayAnalyticsInFlight = new Map();
const gatewayAnalyticsTtlMs = Math.max(5000, Number(process.env.GATEWAY_ANALYTICS_TTL_MS || 15000));

function requireMikroTikDevice(req, res) {
  const device = getDevice(Number(req.params.id), true);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }
  if (device.osType !== 'mikrotik') {
    res.status(400).json({ error: 'This action is available only for MikroTik devices' });
    return null;
  }
  return device;
}

function requireInternetBlockDevice(req, res) {
  const device = getDevice(Number(req.params.id), true);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }
  if (device.osType === 'mikrotik') return device;
  if (device.osType === 'openwrt' && device.deviceRole === 'client') return device;
  res.status(400).json({ error: 'Internet blocking is available only for MikroTik and OpenWrt Client devices' });
  return null;
}

function emptyGatewayAnalytics(deviceId, error = 'RouterOS connection tracking is temporarily unavailable') {
  return {
    deviceId,
    generatedAt: Date.now(),
    cached: false,
    unavailable: true,
    fetchError: error,
    totalConnections: 0,
    establishedTcp: 0,
    totalRate: 0,
    protocols: { tcp: 0, udp: 0, icmp: 0, other: 0 },
    topSources: [],
    topDestinations: [],
    topCountries: [],
    topPorts: [],
    flows: [],
    geo: { available: false, reason: 'Waiting for a successful RouterOS snapshot' },
  };
}

async function stableGatewayAnalytics(device, maxRows) {
  const existing = getGatewayAnalyticsCache(device.id);
  if (existing?.payload && Date.now() - existing.ts < gatewayAnalyticsTtlMs) {
    return {
      ...existing.payload,
      cached: true,
      cacheTs: existing.ts,
      cacheAgeMs: Date.now() - existing.ts,
    };
  }

  if (gatewayAnalyticsInFlight.has(device.id)) return gatewayAnalyticsInFlight.get(device.id);

  const pending = (async () => {
    try {
      const data = await getMikroTikConnectionAnalytics(device, { maxRows });
      setGatewayAnalyticsCache(device.id, data);
      return { ...data, cached: false, unavailable: false };
    } catch (error) {
      const cached = getGatewayAnalyticsCache(device.id);
      if (cached?.payload) {
        return {
          ...cached.payload,
          cached: true,
          unavailable: false,
          cacheTs: cached.ts,
          cacheAgeMs: Date.now() - cached.ts,
          fetchError: upstreamError(error),
        };
      }
      return emptyGatewayAnalytics(device.id, upstreamError(error));
    } finally {
      gatewayAnalyticsInFlight.delete(device.id);
    }
  })();

  gatewayAnalyticsInFlight.set(device.id, pending);
  return pending;
}

function validateNewDevice(req, res) {
  const { name, host, osType } = req.body || {};
  if (!name || !host || !['openwrt', 'mikrotik', 'generic', 'ruijie'].includes(osType)) {
    res.status(400).json({ error: 'name, host and valid osType are required' });
    return null;
  }

  const input = {
    ...req.body,
    connectionMode: osType === 'mikrotik' ? 'rest' : osType === 'generic' ? 'icmp' : osType === 'ruijie' ? 'cloud' : 'ssh',
  };

  if (osType !== 'ruijie') return input;

  let credentials = { ...(req.body?.credentials || {}) };
  if (!String(credentials.ruijieSerialNumber || '').trim()) {
    res.status(400).json({ error: 'Ruijie/Reyee device serial number is required' });
    return null;
  }

  if (credentials.ruijieReuseExisting) {
    const existing = listDevices().find(device => device.osType === 'ruijie');
    const full = existing ? getDevice(existing.id, true) : null;
    const existingCredentials = full?.credentials || {};
    if (!String(existingCredentials.ruijieAppId || '').trim() || !String(existingCredentials.ruijieAppSecret || '')) {
      res.status(400).json({ error: 'No existing Ruijie Cloud credentials are available to reuse' });
      return null;
    }
    credentials = {
      ruijieAppId: existingCredentials.ruijieAppId,
      ruijieAppSecret: existingCredentials.ruijieAppSecret,
      ruijieBaseUrl: existingCredentials.ruijieBaseUrl || 'auto',
      ruijieApiToken: existingCredentials.ruijieApiToken || '',
      ruijieSerialNumber: credentials.ruijieSerialNumber,
    };
    input.credentials = credentials;
  }

  if (!String(credentials.ruijieAppId || '').trim() || !String(credentials.ruijieAppSecret || '')) {
    res.status(400).json({ error: 'Ruijie Cloud App ID and App Secret are required' });
    return null;
  }

  return input;
}

export function createDevicesRouter() {
  const router = Router();

  router.get('/devices', (_req, res) => {
    const statusMap = new Map(latestUptimeAll().map(row => [row.device_id, row]));
    res.json(listDevices().map(device => ({
      ...device,
      metric: latestMetric(device.id),
      uptime: statusMap.get(device.id) || null,
    })));
  });

  router.post('/order/devices', (req, res) => {
    try {
      const rows = reorderDevices(req.body?.ids || []);
      res.json({ ok: true, ids: rows.map(device => device.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/devices', (req, res) => {
    const input = validateNewDevice(req, res);
    if (!input) return;
    try {
      res.status(201).json(createDevice(input));
    } catch (error) {
      res.status(error.code === 'GATEWAY_EXISTS' ? 409 : 400).json({ error: error.message });
    }
  });

  router.get('/devices/:id', (req, res) => {
    const device = getDevice(Number(req.params.id));
    if (!device) return res.status(404).json({ error: 'Not found' });
    return res.json({ ...device, metric: latestMetric(device.id) });
  });

  router.patch('/devices/:id', (req, res) => {
    try {
      const device = updateDevice(Number(req.params.id), req.body || {});
      if (!device) return res.status(404).json({ error: 'Not found' });
      return res.json(device);
    } catch (error) {
      return res.status(error.code === 'GATEWAY_EXISTS' ? 409 : 400).json({ error: error.message });
    }
  });

  router.delete('/devices/:id', (req, res) => {
    if (!deleteDevice(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  });

  router.post('/devices/:id/test', async (req, res) => {
    const device = getDevice(Number(req.params.id), true);
    if (!device) return res.status(404).json({ error: 'Not found' });
    try {
      return res.json({ ok: true, result: await testDevice(device) });
    } catch (error) {
      return res.status(502).json({ ok: false, error: upstreamError(error) });
    }
  });

  router.get('/devices/:id/live', async (req, res) => {
    const device = getDevice(Number(req.params.id), true);
    if (!device) return res.status(404).json({ error: 'Not found' });
    try {
      const live = await collectDevice(device);
      updateDetectedModel(device.id, live?.deviceInfo?.model || live?.deviceInfo?.boardName || '');
      return res.json(live);
    } catch (error) {
      return sendUpstreamError(res, error);
    }
  });

  router.get('/devices/:id/metrics', (req, res) => {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 24)));
    res.json(metricHistory(Number(req.params.id), Date.now() - hours * 3600_000));
  });

  router.get('/devices/:id/uptime', (req, res) => {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 24)));
    res.json(uptimeHistory(Number(req.params.id), Date.now() - hours * 3600_000));
  });

  router.get('/devices/:id/mikrotik/connections', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    if (device.deviceRole !== 'host') {
      return res.status(403).json({ error: 'Connection analytics are enabled only for MikroTik devices configured as Host / gateway' });
    }
    return res.json(await stableGatewayAnalytics(device, req.query.maxRows));
  });

  router.get('/devices/:id/internet-blocks', async (req, res) => {
    const device = requireInternetBlockDevice(req, res);
    if (!device) return;
    try {
      res.json(await getInternetBlocks(device));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.post('/devices/:id/internet-blocks', async (req, res) => {
    const device = requireInternetBlockDevice(req, res);
    if (!device) return;
    try {
      res.status(201).json(await blockInternetByMac(device, req.body?.mac));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.delete('/devices/:id/internet-blocks/:mac', async (req, res) => {
    const device = requireInternetBlockDevice(req, res);
    if (!device) return;
    try {
      res.json(await unblockInternetByMac(device, req.params.mac));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.get('/devices/:id/logs', async (req, res) => {
    const device = getDevice(Number(req.params.id), true);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.osType === 'generic') return res.json([]);
    try {
      return res.json(await getDeviceLogs(device, req.query.limit));
    } catch (error) {
      return sendUpstreamError(res, error);
    }
  });

  router.get('/devices/:id/wireless', async (req, res) => {
    const device = getDevice(Number(req.params.id), true);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.osType === 'generic') return res.status(400).json({ error: 'Wireless management is not available for generic monitors' });
    try {
      return res.json(await getDeviceWireless(device));
    } catch (error) {
      return sendUpstreamError(res, error);
    }
  });

  router.patch('/devices/:id/wireless/:wirelessId', async (req, res) => {
    const device = getDevice(Number(req.params.id), true);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.osType === 'generic') return res.status(400).json({ error: 'Wireless management is not available for generic monitors' });
    try {
      return res.json(await updateDeviceWireless(device, req.params.wirelessId, req.body || {}));
    } catch (error) {
      return sendUpstreamError(res, error);
    }
  });

  router.get('/devices/:id/mikrotik/queues', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await getMikroTikQueues(device, String(req.query.kind || 'simple')));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.post('/devices/:id/mikrotik/queues', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.status(201).json(await createMikroTikQueue(device, String(req.body?.kind || 'simple'), req.body || {}));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.patch('/devices/:id/mikrotik/queues/:queueId', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await updateMikroTikQueue(device, String(req.body?.kind || 'simple'), req.params.queueId, req.body || {}));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.delete('/devices/:id/mikrotik/queues/:queueId', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await deleteMikroTikQueue(device, String(req.query.kind || 'simple'), req.params.queueId));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.get('/devices/:id/mikrotik/firewall', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await getMikroTikFirewall(device, String(req.query.table || 'filter')));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.post('/devices/:id/mikrotik/firewall', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.status(201).json(await createMikroTikFirewallRule(device, String(req.body?.table || 'filter'), req.body || {}));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.patch('/devices/:id/mikrotik/firewall/:ruleId', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await updateMikroTikFirewallRule(device, String(req.body?.table || 'filter'), req.params.ruleId, req.body || {}));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.delete('/devices/:id/mikrotik/firewall/:ruleId', async (req, res) => {
    const device = requireMikroTikDevice(req, res);
    if (!device) return;
    try {
      res.json(await deleteMikroTikFirewallRule(device, String(req.query.table || 'filter'), req.params.ruleId));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  return router;
}
