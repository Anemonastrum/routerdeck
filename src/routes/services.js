import { Router } from 'express';
import {
  createService,
  deleteService,
  getService,
  latestServiceMetric,
  latestServiceUptimeAll,
  listServices,
  reorderServices,
  serviceMetricHistory,
  serviceUptimeHistory,
  updateService,
} from '../db/index.js';
import {
  clearAdGuardCache,
  clearAdGuardQueryLog,
  getAdGuardDnsInfo,
  getAdGuardQueryLog,
  setAdGuardProcessState,
  setAdGuardProtection,
  updateAdGuardDns,
} from '../services/adguard.js';
import {
  controlHomeAssistantEntity,
  getHomeAssistantAutomations,
  getHomeAssistantEntities,
  getHomeAssistantRooms,
  restartHomeAssistant,
} from '../services/homeassistant.js';
import { controlProxmoxGuest, getProxmoxGuests, getProxmoxNodes } from '../services/proxmox.js';
import { controlSynology, getSynologyPackages, getSynologyStorage } from '../services/synology.js';
import {
  getNpmCertificates,
  getNpmProxyHosts,
  renewNpmCertificate,
  setNpmProxyHostEnabled,
} from '../services/nginx-proxy-manager.js';
import { controlCasaOsApp, getCasaOsApps } from '../services/casaos.js';
import { collectNetworkService, testNetworkService } from '../services/index.js';
import { sendUpstreamError } from '../etc/http-errors.js';

const serviceLabels = {
  adguardhome: 'AdGuard Home',
  homeassistant: 'Home Assistant',
  proxmox: 'Proxmox VE',
  synology: 'Synology DSM',
  nginxproxymanager: 'Nginx Proxy Manager',
  casaos: 'CasaOS',
};

const supportedServiceTypes = new Set(Object.keys(serviceLabels));

function requireService(req, res, expectedType = null) {
  const service = getService(Number(req.params.id), true);
  if (!service) {
    res.status(404).json({ error: 'Service not found' });
    return null;
  }
  if (expectedType && service.serviceType !== expectedType) {
    res.status(400).json({ error: `This action is available only for ${serviceLabels[expectedType] || expectedType} services` });
    return null;
  }
  return service;
}

function validateServiceCredentials(body, res) {
  const { serviceType } = body;
  const credentials = body.credentials || {};

  if (serviceType === 'homeassistant' && !String(credentials.accessToken || '').trim()) {
    res.status(400).json({ error: 'Home Assistant access token is required' });
    return false;
  }

  if (serviceType === 'proxmox') {
    const tokenReady = String(credentials.apiTokenId || '').trim() && String(credentials.apiTokenSecret || '').trim();
    const passwordReady = String(credentials.username || '').trim() && String(credentials.password || '');
    if (!tokenReady && !passwordReady) {
      res.status(400).json({ error: 'Proxmox API token or username/password is required' });
      return false;
    }
  }

  if (serviceType === 'synology') {
    if (!String(credentials.synologyUsername || '').trim() || !String(credentials.synologyPassword || '')) {
      res.status(400).json({ error: 'Synology DSM username and password are required' });
      return false;
    }
  }

  if (serviceType === 'nginxproxymanager') {
    const tokenReady = String(credentials.npmToken || '').trim();
    const loginReady = String(credentials.npmIdentity || '').trim() && String(credentials.npmPassword || '');
    if (!tokenReady && !loginReady) {
      res.status(400).json({ error: 'Nginx Proxy Manager login or API token is required' });
      return false;
    }
  }

  if (serviceType === 'casaos') {
    const tokenReady = String(credentials.casaAccessToken || '').trim();
    const loginReady = String(credentials.casaUsername || '').trim() && String(credentials.casaPassword || '');
    if (!tokenReady && !loginReady) {
      res.status(400).json({ error: 'CasaOS username/password or access token is required' });
      return false;
    }
  }

  return true;
}

export function createServicesRouter() {
  const router = Router();

  router.get('/services', (_req, res) => {
    const uptimeMap = new Map(latestServiceUptimeAll().map(row => [row.service_id, row]));
    res.json(listServices().map(service => ({
      ...service,
      metric: latestServiceMetric(service.id),
      uptime: uptimeMap.get(service.id) || null,
    })));
  });

  router.post('/order/services', (req, res) => {
    try {
      const rows = reorderServices(req.body?.ids || []);
      res.json({ ok: true, ids: rows.map(service => service.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/services', (req, res) => {
    const { name, host, serviceType } = req.body || {};
    if (!name || !host) return res.status(400).json({ error: 'name and host are required' });
    if (!supportedServiceTypes.has(serviceType)) return res.status(400).json({ error: 'valid serviceType is required' });
    if (!validateServiceCredentials(req.body || {}, res)) return;

    try {
      return res.status(201).json(createService(req.body || {}));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/services/:id', (req, res) => {
    const service = getService(Number(req.params.id));
    if (!service) return res.status(404).json({ error: 'Service not found' });
    return res.json({ ...service, metric: latestServiceMetric(service.id) });
  });

  router.patch('/services/:id', (req, res) => {
    const service = updateService(Number(req.params.id), req.body || {});
    if (!service) return res.status(404).json({ error: 'Service not found' });
    return res.json(service);
  });

  router.delete('/services/:id', (req, res) => {
    if (!deleteService(Number(req.params.id))) return res.status(404).json({ error: 'Service not found' });
    return res.json({ ok: true });
  });

  router.post('/services/:id/test', async (req, res) => {
    const service = requireService(req, res);
    if (!service) return;
    try {
      res.json(await testNetworkService(service));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.get('/services/:id/live', async (req, res) => {
    const service = requireService(req, res);
    if (!service) return;
    try {
      res.json(await collectNetworkService(service));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.get('/services/:id/metrics', (req, res) => {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 24)));
    res.json(serviceMetricHistory(Number(req.params.id), Date.now() - hours * 3600_000));
  });

  router.get('/services/:id/uptime', (req, res) => {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 24)));
    res.json(serviceUptimeHistory(Number(req.params.id), Date.now() - hours * 3600_000));
  });

  router.get('/services/:id/dns', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await getAdGuardDnsInfo(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/dns', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await updateAdGuardDns(service, req.body || {})); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/protection', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await setAdGuardProtection(service, Boolean(req.body?.enabled))); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/process', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await setAdGuardProcessState(service, Boolean(req.body?.enabled))); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/cache/clear', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await clearAdGuardCache(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/querylog', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try {
      res.json(await getAdGuardQueryLog(service, {
        limit: req.query.limit,
        search: req.query.search,
        olderThan: req.query.older_than,
        reason: req.query.reason,
      }));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  router.delete('/services/:id/querylog', async (req, res) => {
    const service = requireService(req, res, 'adguardhome');
    if (!service) return;
    try { res.json(await clearAdGuardQueryLog(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/homeassistant/entities', async (req, res) => {
    const service = requireService(req, res, 'homeassistant');
    if (!service) return;
    try { res.json(await getHomeAssistantEntities(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/homeassistant/rooms', async (req, res) => {
    const service = requireService(req, res, 'homeassistant');
    if (!service) return;
    try { res.json(await getHomeAssistantRooms(service, null, req.query.force === '1')); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/homeassistant/automations', async (req, res) => {
    const service = requireService(req, res, 'homeassistant');
    if (!service) return;
    try { res.json(await getHomeAssistantAutomations(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/homeassistant/control', async (req, res) => {
    const service = requireService(req, res, 'homeassistant');
    if (!service) return;
    try { res.json(await controlHomeAssistantEntity(service, req.body?.entityId, req.body?.action)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/homeassistant/restart', async (req, res) => {
    const service = requireService(req, res, 'homeassistant');
    if (!service) return;
    try { res.json(await restartHomeAssistant(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/proxmox/nodes', async (req, res) => {
    const service = requireService(req, res, 'proxmox');
    if (!service) return;
    try { res.json(await getProxmoxNodes(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/proxmox/guests', async (req, res) => {
    const service = requireService(req, res, 'proxmox');
    if (!service) return;
    try { res.json(await getProxmoxGuests(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/proxmox/guests/control', async (req, res) => {
    const service = requireService(req, res, 'proxmox');
    if (!service) return;
    try { res.json(await controlProxmoxGuest(service, req.body || {})); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/synology/storage', async (req, res) => {
    const service = requireService(req, res, 'synology');
    if (!service) return;
    try { res.json(await getSynologyStorage(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/synology/packages', async (req, res) => {
    const service = requireService(req, res, 'synology');
    if (!service) return;
    try { res.json(await getSynologyPackages(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/synology/control', async (req, res) => {
    const service = requireService(req, res, 'synology');
    if (!service) return;
    try { res.json(await controlSynology(service, String(req.body?.action || ''))); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/nginxproxymanager/proxy-hosts', async (req, res) => {
    const service = requireService(req, res, 'nginxproxymanager');
    if (!service) return;
    try { res.json(await getNpmProxyHosts(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/nginxproxymanager/proxy-hosts/:hostId/state', async (req, res) => {
    const service = requireService(req, res, 'nginxproxymanager');
    if (!service) return;
    try { res.json(await setNpmProxyHostEnabled(service, req.params.hostId, Boolean(req.body?.enabled))); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/nginxproxymanager/certificates', async (req, res) => {
    const service = requireService(req, res, 'nginxproxymanager');
    if (!service) return;
    try { res.json(await getNpmCertificates(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/nginxproxymanager/certificates/:certId/renew', async (req, res) => {
    const service = requireService(req, res, 'nginxproxymanager');
    if (!service) return;
    try { res.json(await renewNpmCertificate(service, req.params.certId)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.get('/services/:id/casaos/apps', async (req, res) => {
    const service = requireService(req, res, 'casaos');
    if (!service) return;
    try { res.json(await getCasaOsApps(service)); } catch (error) { sendUpstreamError(res, error); }
  });

  router.post('/services/:id/casaos/apps/:appId/state', async (req, res) => {
    const service = requireService(req, res, 'casaos');
    if (!service) return;
    try { res.json(await controlCasaOsApp(service, req.params.appId, String(req.body?.action || ''))); } catch (error) { sendUpstreamError(res, error); }
  });

  return router;
}
