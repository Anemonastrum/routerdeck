import { Router } from 'express';
import { getDevice, getService, listDevices, listServices } from '../db/index.js';

export function createRefreshRouter(monitoring) {
  const router = Router();

  router.post('/refresh', async (req, res) => {
    const deviceId = Number(req.body?.deviceId || 0);
    const serviceId = Number(req.body?.serviceId || 0);

    if (serviceId) {
      const service = getService(serviceId);
      if (!service) return res.status(404).json({ error: 'Service not found' });
      await Promise.all([monitoring.pollService(service), monitoring.checkService(service)]);
      return res.json({ ok: true, refreshedAt: Date.now() });
    }

    const devices = deviceId ? [getDevice(deviceId)].filter(Boolean) : listDevices();
    if (deviceId && !devices.length) return res.status(404).json({ error: 'Device not found' });

    await Promise.all([
      ...devices.flatMap(device => [
        monitoring.checkOne(device),
        device.osType === 'generic' ? Promise.resolve() : monitoring.pollOne(device),
      ]),
      ...(deviceId ? [] : listServices().flatMap(service => [
        monitoring.pollService(service),
        monitoring.checkService(service),
      ])),
    ]);

    return res.json({ ok: true, refreshedAt: Date.now() });
  });

  return router;
}
