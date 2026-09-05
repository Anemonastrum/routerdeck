import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function ping(host) {
  const started = performance.now();
  try {
    await execFileAsync('ping', ['-c', '1', '-W', '2', host], { timeout: 4000 });
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (e) {
    throw new Error(e.killed ? 'Ping timed out' : 'Host is unreachable');
  }
}

export async function testGeneric(device) {
  const result = await ping(device.host);
  return { method: 'ICMP ping', host: device.host, ...result };
}

export async function collectGeneric(device) {
  return {
    platform: 'Generic',
    hostname: device.name,
    version: '',
    uptimeSec: null,
    cpu: null,
    load1: null,
    memoryTotal: null,
    memoryUsed: null,
    rxBytes: null,
    txBytes: null,
    clientsCount: 0,
    dhcpCount: 0,
    dhcpLeases: [],
    wifiCount: 0,
    wifiClients: [],
    deviceInfo: {
      hostname: device.name,
      model: '',
      boardName: '',
      platform: 'Generic',
      os: 'Generic uptime monitor',
      version: '',
      target: '',
      architecture: '',
      kernel: '',
      cpu: '',
      cpuCount: null,
      monitorInterface: 'ICMP ping',
    },
    collector: { api: 'ICMP ping only' },
  };
}
