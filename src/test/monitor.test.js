process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'monitor-test-secret-0123456789abcdefghijk';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const db = await import('../db/index.js');
const { startMonitoring } = await import('../etc/monitor.js');

function eventSink() {
  const emitted = [];
  return {
    emitted,
    io: { emit: (event, data) => emitted.push({ event, data }) },
  };
}

async function pingAvailable() {
  try {
    await execFileAsync('ping', ['-c', '1', '-W', '1', '127.0.0.1'], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

test('startMonitoring returns a controller that stops cleanly and reports idle', async () => {
  const { io } = eventSink();
  const monitoring = startMonitoring(io);
  assert.equal(typeof monitoring.stop, 'function');
  assert.equal(typeof monitoring.waitForIdle, 'function');
  assert.equal(typeof monitoring.pollOne, 'function');
  assert.equal(typeof monitoring.checkOne, 'function');
  monitoring.stop();
  assert.equal(await monitoring.waitForIdle(1000), true);
});

test('pollOne collects a generic device into the metrics table', async () => {
  const { emitted, io } = eventSink();
  const monitoring = startMonitoring(io);
  monitoring.stop(); // keep background timers from racing the assertions
  const dev = db.createDevice({ name: 'Gen', host: '127.0.0.1', osType: 'generic' });
  await monitoring.pollOne({ id: dev.id });
  const metric = db.latestMetric(dev.id);
  assert.equal(metric.clients_count, 0);
  assert.equal(metric.device_id, dev.id);
  assert.ok(emitted.some(e => e.event === 'metric' && e.data.deviceId === dev.id));
});

test('checkOne pings a reachable host, stores an UP check and emits', async t => {
  if (!(await pingAvailable())) {
    t.skip('ping binary unavailable in this environment');
    return;
  }
  const { emitted, io } = eventSink();
  const monitoring = startMonitoring(io);
  monitoring.stop();
  const dev = db.createDevice({ name: 'PingOK', host: '127.0.0.1', osType: 'generic' });
  await monitoring.checkOne({ id: dev.id, host: '127.0.0.1' });
  const history = db.uptimeHistory(dev.id, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 1);
  assert.ok(emitted.some(e => e.event === 'uptime' && e.data.deviceId === dev.id && e.data.ok === true));
});

test('checkOne records a DOWN check for an unreachable host', async t => {
  if (!(await pingAvailable())) {
    t.skip('ping binary unavailable in this environment');
    return;
  }
  const { emitted, io } = eventSink();
  const monitoring = startMonitoring(io);
  monitoring.stop();
  const dev = db.createDevice({ name: 'PingDown', host: '203.0.113.1', osType: 'generic' }); // TEST-NET, unroutable
  await monitoring.checkOne({ id: dev.id, host: '203.0.113.1' });
  const history = db.uptimeHistory(dev.id, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 0);
  assert.ok(history[0].error);
  assert.ok(emitted.some(e => e.event === 'uptime' && e.data.deviceId === dev.id && e.data.ok === false));
});

test('pollService stores a metric for a service (failure path tolerated)', async () => {
  const { emitted, io } = eventSink();
  const monitoring = startMonitoring(io);
  monitoring.stop();
  const svc = db.createService({ name: 'Casa', host: '127.0.0.1', port: 1, serviceType: 'casaos' });
  await monitoring.pollService({ id: svc.id });
  assert.equal(db.serviceMetricHistory(svc.id, 0).length, 1);
  assert.ok(emitted.some(e => e.event === 'service-metric' && e.data.serviceId === svc.id));
});
