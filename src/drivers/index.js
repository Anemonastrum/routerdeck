import { collectOpenWrt, testOpenWrt, getOpenWrtLogs, getOpenWrtWireless, updateOpenWrtWireless, getOpenWrtInternetBlocks, blockOpenWrtInternetByMac, unblockOpenWrtInternetByMac } from './openwrt.js';
import { collectMikroTik, testMikroTik, getMikroTikLogs, getMikroTikWireless, updateMikroTikWireless, getMikroTikInternetBlocks, blockMikroTikInternetByMac, unblockMikroTikInternetByMac } from './mikrotik.js';
import { collectGeneric, testGeneric } from './generic.js';
import { collectRuijie, testRuijie } from './ruijie.js';

export function collectDevice(device) {
  if (device.osType === 'openwrt') return collectOpenWrt(device);
  if (device.osType === 'mikrotik') return collectMikroTik(device);
  if (device.osType === 'generic') return collectGeneric(device);
  if (device.osType === 'ruijie') return collectRuijie(device);
  throw new Error(`Unsupported OS type: ${device.osType}`);
}

export function testDevice(device) {
  if (device.osType === 'openwrt') return testOpenWrt(device);
  if (device.osType === 'mikrotik') return testMikroTik(device);
  if (device.osType === 'generic') return testGeneric(device);
  if (device.osType === 'ruijie') return testRuijie(device);
  throw new Error(`Unsupported OS type: ${device.osType}`);
}


export function getDeviceLogs(device, limit = 250) {
  if (device.osType === 'openwrt') return getOpenWrtLogs(device, limit);
  if (device.osType === 'mikrotik') return getMikroTikLogs(device, limit);
  return Promise.resolve([]);
}

export function getDeviceWireless(device) {
  if (device.osType === 'openwrt') return getOpenWrtWireless(device);
  if (device.osType === 'mikrotik') return getMikroTikWireless(device);
  return Promise.resolve({ source: '', interfaces: [] });
}

export function updateDeviceWireless(device, id, input = {}) {
  if (device.osType === 'openwrt') return updateOpenWrtWireless(device, id, input);
  if (device.osType === 'mikrotik') return updateMikroTikWireless(device, id, input);
  throw new Error('Wireless management is not available for this device');
}

export function getInternetBlocks(device) {
  if (device.osType === 'mikrotik') return getMikroTikInternetBlocks(device);
  if (device.osType === 'openwrt' && device.deviceRole === 'client') return getOpenWrtInternetBlocks(device);
  throw new Error('Internet blocking is available only for MikroTik and OpenWrt Client devices');
}

export function blockInternetByMac(device, mac) {
  if (device.osType === 'mikrotik') return blockMikroTikInternetByMac(device, mac);
  if (device.osType === 'openwrt' && device.deviceRole === 'client') return blockOpenWrtInternetByMac(device, mac);
  throw new Error('Internet blocking is available only for MikroTik and OpenWrt Client devices');
}

export function unblockInternetByMac(device, mac) {
  if (device.osType === 'mikrotik') return unblockMikroTikInternetByMac(device, mac);
  if (device.osType === 'openwrt' && device.deviceRole === 'client') return unblockOpenWrtInternetByMac(device, mac);
  throw new Error('Internet blocking is available only for MikroTik and OpenWrt Client devices');
}
