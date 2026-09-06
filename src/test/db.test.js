process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'db-test-secret-0123456789abcdefghijkl';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../db/index.js');
const conn = (await import('../db/connection.js')).default;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('database boots with the full schema', () => {
  assert.deepEqual(db.databaseStatus(), { path: ':memory:', open: true });
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const expected of ['devices', 'metrics', 'uptime_checks', 'network_services', 'service_metrics',
    'service_uptime_checks', 'app_settings', 'status_page_settings', 'telegram_settings',
    'telegram_recipients', 'gateway_analytics_cache', 'topology_nodes', 'topology_links']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  assert.equal(db.getStatusSettings().title, 'Network Status');
  assert.equal(db.getAppSettings().theme, 'system');
});

test('createDevice maps roles and connection modes per OS type', () => {
  const gw = db.createDevice({ name: 'GW', host: '10.0.0.1', osType: 'mikrotik', deviceRole: 'host' });
  assert.equal(gw.osType, 'mikrotik');
  assert.equal(gw.deviceRole, 'host');
  assert.equal(gw.connectionMode, 'rest');
  assert.equal(db.listDevices()[0].name, 'GW'); // gateway sorts first

  const generic = db.createDevice({ name: 'Router', host: '10.0.0.2', osType: 'generic' });
  assert.equal(generic.deviceRole, 'router'); // default for generic
  assert.equal(generic.connectionMode, 'icmp');

  const ruijie = db.createDevice({ name: 'Switch', host: 'cloud.example', osType: 'ruijie' });
  assert.equal(ruijie.connectionMode, 'cloud');

  const ap = db.createDevice({ name: 'AP', host: '10.0.0.3', osType: 'openwrt', deviceRole: 'access_point' });
  assert.equal(ap.deviceRole, 'access_point');
});

test('only one MikroTik Host / gateway may exist', () => {
  assert.throws(
    () => db.createDevice({ name: 'GW2', host: '10.0.0.9', osType: 'mikrotik', deviceRole: 'host' }),
    e => e.code === 'GATEWAY_EXISTS',
  );
  const client = db.createDevice({ name: 'MT Client', host: '10.0.0.10', osType: 'mikrotik' });
  assert.equal(client.deviceRole, 'client');
});

test('device credentials are encrypted at rest and hidden without secrets', () => {
  const dev = db.createDevice({
    name: 'OpenWrt', host: '10.0.0.11', osType: 'openwrt', credentials: { user: 'root', password: 'x' },
  });
  const plain = db.getDevice(dev.id);
  assert.equal(plain.credentials, undefined);
  const withSecrets = db.getDevice(dev.id, true);
  assert.deepEqual(withSecrets.credentials, { user: 'root', password: 'x' });
  assert.equal(db.getDevice(999999), null);
});

test('updateDevice merges credentials and cannot create a second gateway', () => {
  const dev = db.createDevice({ name: 'R1', host: '10.0.0.12', osType: 'openwrt', credentials: { user: 'root' } });
  const updated = db.updateDevice(dev.id, { name: 'R1 renamed', credentials: { password: 'yy' } });
  assert.equal(updated.name, 'R1 renamed');
  assert.deepEqual(db.getDevice(dev.id, true).credentials, { user: 'root', password: 'yy' });
  assert.equal(db.updateDevice(999999, { name: 'x' }), null);
  assert.throws(() => db.updateDevice(dev.id, { osType: 'mikrotik', deviceRole: 'host' }), e => e.code === 'GATEWAY_EXISTS');
});

test('updateDetectedModel truncates and avoids no-op writes', () => {
  const dev = db.createDevice({ name: 'M1', host: '10.0.0.13', osType: 'generic' });
  assert.equal(db.updateDetectedModel(dev.id, 'Xiaomi Router AX3000 v2'), true);
  assert.equal(db.getDevice(dev.id).detectedModel, 'Xiaomi Router AX3000 v2');
  assert.equal(db.updateDetectedModel(dev.id, 'Xiaomi Router AX3000 v2'), false); // unchanged
  assert.equal(db.updateDetectedModel(dev.id, ''), false);
  assert.equal(db.updateDetectedModel(dev.id, 'a'.repeat(200)), true);
  assert.equal(db.getDevice(dev.id).detectedModel.length, 160); // sliced
});

test('metrics: insert, latest, and history in ascending order', async () => {
  const dev = db.createDevice({ name: 'M2', host: '10.0.0.14', osType: 'generic' });
  db.insertMetric(dev.id, { cpu: 10.5, clientsCount: 2 });
  await sleep(5);
  db.insertMetric(dev.id, { cpu: 20.5, clientsCount: 5 });
  const latest = db.latestMetric(dev.id);
  assert.equal(latest.clients_count, 5);
  assert.equal(latest.cpu, 20.5);
  const history = db.metricHistory(dev.id, 0);
  assert.equal(history.length, 2);
  assert.ok(history[0].ts <= history[1].ts);
});

test('uptime: checks are stored with status and exposed through latestUptimeAll', async () => {
  const dev = db.createDevice({ name: 'M3', host: '10.0.0.15', osType: 'generic' });
  db.insertUptime(dev.id, { ok: true, latencyMs: 1.2 });
  await sleep(5);
  db.insertUptime(dev.id, { ok: false, error: 'timeout' });
  const history = db.uptimeHistory(dev.id, 0);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 1);
  assert.equal(history[1].status, 0);
  assert.equal(history[1].error, 'timeout');
  const all = db.latestUptimeAll().find(u => u.device_id === dev.id);
  assert.equal(all.status, 0);
});

test('deleteDevice cascades to metrics and returns success flags', () => {
  const dev = db.createDevice({ name: 'M4', host: '10.0.0.16', osType: 'generic' });
  db.insertMetric(dev.id, { cpu: 1 });
  assert.equal(db.deleteDevice(dev.id), true);
  assert.equal(db.latestMetric(dev.id), null);
  assert.equal(db.deleteDevice(dev.id), false);
});

test('reorderDevices rewrites display order while keeping the gateway first', () => {
  const a = db.createDevice({ name: 'A', host: '10.0.0.20', osType: 'generic' });
  const b = db.createDevice({ name: 'B', host: '10.0.0.21', osType: 'generic' });
  const c = db.createDevice({ name: 'C', host: '10.0.0.22', osType: 'generic' });
  const order = db.reorderDevices([c.id, a.id, b.id]);
  const gw = db.listDevices().find(d => d.osType === 'mikrotik' && d.deviceRole === 'host');
  assert.equal(order[0].id, gw.id); // gateway pinned first
  assert.equal(order[1].id, c.id);
  assert.equal(order[2].id, a.id);
  assert.equal(order[3].id, b.id);
});

test('services: defaults, ports and web URLs per type', () => {
  const ad = db.createService({ name: 'Ads', host: '10.0.0.30', serviceType: 'adguardhome' });
  assert.equal(ad.webUrl, 'http://10.0.0.30:80');
  const px = db.createService({ name: 'PVE', host: '10.0.0.31', serviceType: 'proxmox' });
  assert.equal(px.port, 8006);
  assert.equal(px.webUrl, 'https://10.0.0.31:8006');
  assert.equal(px.scheme, 'https');
  const ha = db.createService({ name: 'HA', host: '10.0.0.32', serviceType: 'homeassistant' });
  assert.equal(ha.port, 8123);
  const syn = db.createService({ name: 'DSM', host: '10.0.0.33', serviceType: 'synology' });
  assert.equal(syn.port, 5001);
  assert.equal(syn.scheme, 'https');
  const npm = db.createService({ name: 'NPM', host: '10.0.0.34', serviceType: 'nginxproxymanager' });
  assert.equal(npm.port, 81);
  const co = db.createService({ name: 'Casa', host: '10.0.0.35', serviceType: 'casaos' });
  assert.equal(co.port, 80);
  assert.equal(db.createService({ name: 'Bogus', host: '10.0.0.36', serviceType: 'unknown' }).serviceType, 'adguardhome');
});

test('services: update, reorder and delete', () => {
  const s = db.createService({ name: 'S1', host: '10.0.0.40', serviceType: 'adguardhome' });
  const updated = db.updateService(s.id, { port: 3000, credentials: { user: 'u' } });
  assert.equal(updated.port, 3000);
  assert.equal(db.updateService(999999, { port: 1 }), null);
  const reordered = db.reorderServices([s.id]).map(x => x.id);
  assert.equal(reordered[0], s.id); // requested service first
  assert.equal(db.deleteService(s.id), true);
  assert.equal(db.deleteService(s.id), false);
});

test('service metrics: extra fields are stored and nodes are compacted', () => {
  const s = db.createService({ host: '10.0.0.41', serviceType: 'casaos' });
  db.insertServiceMetric(s.id, {
    status: 1,
    roomCount: 3,
    nodes: [{ name: 'A', pcie: [1, 2] }, { name: 'B' }],
  });
  const m = db.latestServiceMetric(s.id);
  assert.equal(m.status, 1);
  assert.equal(m.roomCount, 3);
  assert.deepEqual(m.nodes[0], { name: 'A', pcieCount: 2 });
  assert.deepEqual(m.nodes[1], { name: 'B', pcieCount: 0 });
  assert.equal(m.nodes[0].pcie, undefined);
});

test('service metrics: summary values and status coercion', () => {
  const s = db.createService({ host: '10.0.0.42', serviceType: 'adguardhome' });
  db.insertServiceMetric(s.id, { status: 0, summary: { unavailableCount: 2, entityCount: 4 } });
  const m = db.latestServiceMetric(s.id);
  assert.equal(m.status, 0);
  assert.equal(m.unavailableCount, 2);
  assert.equal(m.entityCount, 4);
});

test('service uptime: history and latest', async () => {
  const s = db.createService({ host: '10.0.0.43', serviceType: 'proxmox' });
  db.insertServiceUptime(s.id, { ok: true, latencyMs: 2 });
  await sleep(5);
  db.insertServiceUptime(s.id, { ok: false, error: 'unreachable' });
  const history = db.serviceUptimeHistory(s.id, 0);
  assert.equal(history.length, 2);
  assert.equal(history[1].status, 0);
  const latest = db.latestServiceUptimeAll().find(u => u.service_id === s.id);
  assert.equal(latest.status, 0);
});

test('status settings: clamped refresh, validated accent, truncated title', () => {
  const s = db.updateStatusSettings({ title: 'My Status', accent: '#123abc', refreshSeconds: 45 });
  assert.equal(s.title, 'My Status');
  assert.equal(s.accent, '#123abc');
  assert.equal(s.refreshSeconds, 45);
  const clamped = db.updateStatusSettings({ refreshSeconds: 5 });
  assert.equal(clamped.refreshSeconds, 10);
  const clampedMax = db.updateStatusSettings({ refreshSeconds: 9999 });
  assert.equal(clampedMax.refreshSeconds, 300);
  const badAccent = db.updateStatusSettings({ accent: 'red' });
  assert.equal(badAccent.accent, '#123abc');
  const truncated = db.updateStatusSettings({ title: 'x'.repeat(200) });
  assert.equal(truncated.title.length, 80);
});

test('app settings: theme mapping and timezone validation', () => {
  const dark = db.updateAppSettings({ theme: 'dark' });
  assert.equal(dark.theme, 'mocha'); // legacy dark maps into the Catppuccin mocha flavor
  const light = db.updateAppSettings({ theme: 'light' });
  assert.equal(light.theme, 'latte');
  const badTz = db.updateAppSettings({ timeZone: 'Not/AZone' });
  assert.equal(badTz.timeZone, 'auto');
  const goodTz = db.updateAppSettings({ timeZone: 'Asia/Jakarta' });
  assert.equal(goodTz.timeZone, 'Asia/Jakarta');
  const badClock = db.updateAppSettings({ clockFormat: '12h' });
  assert.equal(badClock.clockFormat, '12h');
});

test('telegram settings: token is stored encrypted and never returned', () => {
  db.updateTelegramSettings({ enabled: true, botToken: 'tok:123', chatId: '-100' });
  const settings = db.getTelegramSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.botTokenSet, true);
  assert.equal(settings.botToken, undefined); // never exposed
  assert.equal(db.getTelegramBotToken(), 'tok:123');
  db.updateTelegramSettings({ enabled: false });
  assert.equal(db.getTelegramSettings().enabled, false);
});

test('telegram recipients: validation, id sanitizing and CRUD', () => {
  assert.throws(() => db.createTelegramRecipient({ chatId: '' }), e => e.code === 'CHAT_ID_REQUIRED');
  const r = db.createTelegramRecipient({ chatId: '111', deviceIds: [1, '2', 3.7], scope: 'selected' });
  assert.deepEqual(r.deviceIds, [1, 2]); // non-integers dropped
  assert.equal(r.scope, 'selected');
  const updated = db.updateTelegramRecipient(r.id, { scope: 'all' });
  assert.equal(updated.scope, 'all');
  assert.equal(db.updateTelegramRecipient(999999, { chatId: '1' }), null);
  assert.equal(db.deleteTelegramRecipient(r.id), true);
  assert.equal(db.deleteTelegramRecipient(r.id), false);
});

test('gateway analytics cache upserts per device', () => {
  const dev = db.createDevice({ name: 'M5', host: '10.0.0.50', osType: 'generic' });
  assert.equal(db.getGatewayAnalyticsCache(dev.id), null);
  db.setGatewayAnalyticsCache(dev.id, { a: 1 });
  const first = db.getGatewayAnalyticsCache(dev.id);
  assert.deepEqual(first.payload, { a: 1 });
  db.setGatewayAnalyticsCache(dev.id, { b: 2 });
  const second = db.getGatewayAnalyticsCache(dev.id);
  assert.deepEqual(second.payload, { b: 2 });
  assert.ok(second.ts >= first.ts);
});

test('cleanupHistory drops rows older than 30 days', () => {
  const dev = db.createDevice({ name: 'M6', host: '10.0.0.51', osType: 'generic' });
  db.insertMetric(dev.id, { cpu: 1 }); // fresh row
  conn.prepare('INSERT INTO metrics(device_id, ts, cpu) VALUES (?, ?, NULL)')
    .run(dev.id, Date.now() - 40 * 24 * 3600 * 1000);
  db.cleanupHistory();
  const remaining = conn.prepare('SELECT COUNT(*) n FROM metrics WHERE device_id=?').get(dev.id).n;
  assert.equal(remaining, 1);
});

test('exportConfiguration captures everything needed for a restore', () => {
  const exported = db.exportConfiguration();
  assert.equal(exported.format, 'routerdeck-config-v1');
  assert.ok(Array.isArray(exported.devices) && exported.devices.length > 0);
  assert.ok(Array.isArray(exported.services) && exported.services.length > 0);
  assert.equal(exported.appSettings.theme, 'latte');
  assert.equal(exported.telegramSettings.botToken, 'tok:123');
});

test('restoreConfiguration roundtrips devices, services, settings and telegram state', () => {
  const exported = db.exportConfiguration();
  const restored = db.restoreConfiguration(exported);
  assert.deepEqual(restored, { ok: true, devices: exported.devices.length, services: exported.services.length });
  const gw = db.listDevices().find(d => d.osType === 'mikrotik');
  assert.equal(gw.deviceRole, 'host');
  const openwrt = db.listDevices().find(d => d.name === 'OpenWrt');
  assert.deepEqual(db.getDevice(openwrt.id, true).credentials, { user: 'root', password: 'x' });
  const renamed = db.listDevices().find(d => d.name === 'R1 renamed');
  assert.deepEqual(db.getDevice(renamed.id, true).credentials, { user: 'root', password: 'yy' });
  assert.equal(db.getStatusSettings().accent, '#123abc');
  assert.equal(db.getTelegramBotToken(), 'tok:123');
});

test('restoreConfiguration rejects bad formats, types and duplicate gateways', () => {
  assert.throws(() => db.restoreConfiguration({ format: 'nope' }), /Unsupported RouterDeck backup format/);
  assert.throws(
    () => db.restoreConfiguration({ format: 'routerdeck-config-v1', devices: [{ osType: 'bogus' }] }),
    /Unsupported device type in backup/,
  );
  assert.throws(
    () => db.restoreConfiguration({ format: 'routerdeck-config-v1', services: [{ serviceType: 'bogus' }] }),
    /Unsupported service type in backup/,
  );
  assert.throws(
    () => db.restoreConfiguration({
      format: 'routerdeck-config-v1',
      devices: [{ osType: 'mikrotik', deviceRole: 'host' }, { osType: 'mikrotik', deviceRole: 'host' }],
    }),
    /more than one MikroTik Host/,
  );
});
