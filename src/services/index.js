import { collectAdGuardHome, testAdGuardHome } from './adguard.js';
import { collectHomeAssistant, testHomeAssistant } from './homeassistant.js';
import { collectProxmox, testProxmox } from './proxmox.js';
import { collectSynology, testSynology } from './synology.js';
import { collectNginxProxyManager, testNginxProxyManager } from './nginx-proxy-manager.js';
import { collectCasaOs, testCasaOs } from './casaos.js';

export async function collectNetworkService(service) {
  if (service.serviceType === 'homeassistant') return collectHomeAssistant(service);
  if (service.serviceType === 'proxmox') return collectProxmox(service);
  if (service.serviceType === 'synology') return collectSynology(service);
  if (service.serviceType === 'nginxproxymanager') return collectNginxProxyManager(service);
  if (service.serviceType === 'casaos') return collectCasaOs(service);
  return collectAdGuardHome(service);
}

export async function testNetworkService(service) {
  if (service.serviceType === 'proxmox') return testProxmox(service);
  if (service.serviceType === 'synology') return testSynology(service);
  if (service.serviceType === 'nginxproxymanager') return testNginxProxyManager(service);
  if (service.serviceType === 'casaos') return testCasaOs(service);
  const started = performance.now();
  const result = service.serviceType === 'homeassistant'
    ? await testHomeAssistant(service)
    : await testAdGuardHome(service);
  return { ...result, ok: result.ok !== false, latencyMs: result.latencyMs ?? Math.round((performance.now() - started) * 10) / 10 };
}
