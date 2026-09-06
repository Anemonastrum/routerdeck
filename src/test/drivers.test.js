import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as drivers from '../drivers/index.js';
import { collectGeneric } from '../drivers/generic.js';

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
