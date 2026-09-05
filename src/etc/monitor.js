import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectDevice } from '../drivers/index.js';
import { collectNetworkService, testNetworkService } from '../services/index.js';
import {
  listDevices, getDevice, insertMetric, insertUptime, cleanupHistory, updateDetectedModel,
  listServices, getService, insertServiceMetric, insertServiceUptime,
} from '../db/index.js';
import { maybeNotify, seedLastStates } from './telegram.js';

const execFileAsync = promisify(execFile);
const runningStats = new Set();
const runningChecks = new Set();
const runningServices = new Set();
const runningServiceChecks = new Set();

async function ping(host) {
  const started = performance.now();
  try {
    await execFileAsync('ping', ['-c', '1', '-W', '2', host], { timeout: 4000 });
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (e) {
    return { ok: false, latencyMs: null, error: e.killed ? 'timeout' : 'unreachable' };
  }
}

export function startMonitoring(io) {
  const pollMs = Math.max(5000, Number(process.env.POLL_INTERVAL_MS || 15000));
  const uptimeMs = Math.max(10000, Number(process.env.UPTIME_INTERVAL_MS || 30000));

  // Baseline from the last recorded checks so Telegram only fires on real
  // transitions — and a restart during an outage still reports recovery.
  seedLastStates();

  const pollOne = async basic => {
    if (runningStats.has(basic.id)) return;
    runningStats.add(basic.id);
    try {
      const device = getDevice(basic.id, true);
      const metric = await collectDevice(device);
      insertMetric(device.id, metric);
      updateDetectedModel(device.id, metric?.deviceInfo?.model || metric?.deviceInfo?.boardName || '');
      io.emit('metric', { deviceId: device.id, metric: { ...metric, ts: Date.now() } });
    } catch (e) {
      io.emit('metric-error', { deviceId: basic.id, error: e.message });
    } finally {
      runningStats.delete(basic.id);
    }
  };

  const checkOne = async basic => {
    if (runningChecks.has(basic.id)) return;
    runningChecks.add(basic.id);
    try {
      const result = await ping(basic.host);
      insertUptime(basic.id, result);
      io.emit('uptime', { deviceId: basic.id, ...result, ts: Date.now() });
      // Telegram: alert only when this device changed state (up <-> down).
      maybeNotify('device', basic.id, `${basic.name} (${basic.host})`, result);
    } finally {
      runningChecks.delete(basic.id);
    }
  };

  const pollService = async basic => {
    if (runningServices.has(basic.id)) return;
    runningServices.add(basic.id);
    try {
      const service = getService(basic.id, true);
      const metric = await collectNetworkService(service);
      insertServiceMetric(service.id, metric);
      io.emit('service-metric', { serviceId: service.id, metric: { ...metric, ts: Date.now() } });
    } catch (e) {
      const metric = { status: 0, cpu: null, memoryUsed: null, memoryTotal: null, protectionEnabled: null, version: '', error: e.message };
      insertServiceMetric(basic.id, metric);
      io.emit('service-metric', { serviceId: basic.id, metric: { ...metric, ts: Date.now() } });
    } finally {
      runningServices.delete(basic.id);
    }
  };

  const checkService = async basic => {
    if (runningServiceChecks.has(basic.id)) return;
    runningServiceChecks.add(basic.id);
    try {
      const service = getService(basic.id, true);
      let result;
      try {
        result = await testNetworkService(service);
        result = { ok: result.ok !== false, latencyMs: result.latencyMs ?? null, error: result.ok === false ? (result.error || 'service unavailable') : null };
      } catch (e) {
        result = { ok: false, latencyMs: null, error: e.message || 'service unavailable' };
      }
      insertServiceUptime(service.id, result);
      io.emit('service-uptime', { serviceId: service.id, ...result, ts: Date.now() });
      // Telegram: alert only when this service changed state (up <-> down).
      maybeNotify('service', service.id, `${service.name} (${service.host})`, result);
    } finally {
      runningServiceChecks.delete(basic.id);
    }
  };

  const pollAll = () => listDevices().filter(d => d.osType !== 'generic').forEach(d => pollOne(d));
  const checkAll = () => listDevices().forEach(d => checkOne(d));
  const pollAllServices = () => listServices().forEach(s => pollService(s));
  const checkAllServices = () => listServices().forEach(s => checkService(s));

  const timers = [
    setTimeout(pollAll, 1000),
    setTimeout(checkAll, 500),
    setTimeout(pollAllServices, 1300),
    setTimeout(checkAllServices, 1600),
    setInterval(pollAll, pollMs),
    setInterval(pollAllServices, pollMs),
    setInterval(checkAll, uptimeMs),
    setInterval(checkAllServices, uptimeMs),
    setInterval(cleanupHistory, 6 * 60 * 60 * 1000),
  ];
  for (const timer of timers) timer.unref?.();

  const isIdle = () =>
    runningStats.size === 0 &&
    runningChecks.size === 0 &&
    runningServices.size === 0 &&
    runningServiceChecks.size === 0;

  const stop = () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  };

  const waitForIdle = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!isIdle() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return isIdle();
  };

  return {
    pollOne, checkOne, pollService, checkService, pollAllServices, checkAllServices,
    stop, waitForIdle,
  };
}
