import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as drivers from '../drivers/index.js';
import { collectGeneric } from '../drivers/generic.js';
import { normalizeRuijieBaseUrl } from '../drivers/ruijie.js';

test('Ruijie custom Cloud region accepts IP addresses and hostnames', () => {
  assert.equal(normalizeRuijieBaseUrl('192.0.2.5'), 'https://192.0.2.5');
  assert.equal(normalizeRuijieBaseUrl('cloud.example.test:8443'), 'https://cloud.example.test:8443');
  assert.equal(normalizeRuijieBaseUrl('http://192.0.2.6:8080/'), 'http://192.0.2.6:8080');
  assert.equal(normalizeRuijieBaseUrl('auto'), 'auto');
  assert.throws(() => normalizeRuijieBaseUrl('ftp://cloud.example.test'), /HTTP or HTTPS/i);
  assert.throws(() => normalizeRuijieBaseUrl('https://cloud.example.test/path'), /optional port/);
  assert.throws(() => normalizeRuijieBaseUrl('not a host'), /valid IP address or hostname/);
  assert.throws(() => normalizeRuijieBaseUrl('999.2.3.4'), /valid IP address or hostname/);
});

test('collectDevice throws on unsupported OS types', () => {
  assert.throws(() => drivers.collectDevice({ osType: 'bogus' }), /Unsupported OS type: bogus/);
  assert.throws(() => drivers.collectDevice({ osType: 'undefined' }), /Unsupported OS type/);
});

test('testDevice throws on unsupported OS types', () => {
  assert.throws(() => drivers.testDevice({ osType: 'bogus' }), /Unsupported OS type: bogus/);
});

test('logs and wireless are empty for devices without drivers', async () => {
  const generic = { osType: 'generic' };
  const ruijie = { osType: 'ruijie' };
  assert.deepEqual(await drivers.getDeviceLogs(generic, 50), []);
  assert.deepEqual(await drivers.getDeviceLogs(ruijie, 50), []);
  assert.deepEqual(await drivers.getDeviceWireless(generic), { source: '', interfaces: [] });
  assert.deepEqual(await drivers.getDeviceWireless(ruijie), { source: '', interfaces: [] });
});

test('wireless management is blocked for unsupported devices', () => {
  assert.throws(() => drivers.updateDeviceWireless({ osType: 'generic' }, 1, {}), /Wireless management is not available/);
  assert.throws(() => drivers.updateDeviceWireless({ osType: 'ruijie' }, 1, {}), /Wireless management is not available/);
});

test('internet blocking is restricted to MikroTik and OpenWrt Client devices', () => {
  assert.throws(() => drivers.getInternetBlocks({ osType: 'ruijie' }), /Internet blocking is available only for MikroTik and OpenWrt Client/);
  assert.throws(() => drivers.getInternetBlocks({ osType: 'generic' }), /Internet blocking is available only/);
  assert.throws(() => drivers.getInternetBlocks({ osType: 'openwrt', deviceRole: 'access_point' }), /Internet blocking is available only/);
  assert.throws(() => drivers.blockInternetByMac({ osType: 'ruijie' }, 'aa:bb'), /Internet blocking is available only/);
  assert.throws(() => drivers.unblockInternetByMac({ osType: 'openwrt', deviceRole: 'host' }, 'aa:bb'), /Internet blocking is available only/);
});

test('collectGeneric returns the static monitor payload', async () => {
  const metric = await collectGeneric({ name: 'My AP', host: '10.0.0.1' });
  assert.equal(metric.platform, 'Generic');
  assert.equal(metric.hostname, 'My AP');
  assert.equal(metric.clientsCount, 0);
  assert.equal(metric.cpu, null);
  assert.equal(metric.deviceInfo.os, 'Generic uptime monitor');
  assert.equal(metric.collector.api, 'ICMP ping only');
});
