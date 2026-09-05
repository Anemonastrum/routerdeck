import db from './connection.js';
import { initializeDatabase } from './schema.js';
import { encryptJson, decryptJson } from '../etc/crypto.js';

initializeDatabase(db);

function rowToDevice(row, includeSecrets = false) {
  if (!row) return null;
  const device = {
    id: row.id,
    name: row.name,
    host: row.host,
    osType: row.os_type,
    connectionMode: row.connection_mode,
    restScheme: row.rest_scheme,
    restPort: row.rest_port,
    monitorInterface: row.monitor_interface,
    insecureTls: Boolean(row.insecure_tls),
    deviceRole: row.os_type === 'mikrotik'
      ? (row.device_role === 'host' ? 'host' : 'client')
      : row.os_type === 'openwrt'
        ? (row.device_role === 'access_point' ? 'access_point' : 'client')
        : row.os_type === 'generic'
          ? (['router','access_point','switch','ip_camera'].includes(row.device_role) ? row.device_role : 'router')
          : 'client',
    detectedModel: row.detected_model || '',
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at,
  };
  if (includeSecrets) device.credentials = decryptJson(row.credentials_enc);
  return device;
}

export function listDevices() {
  return db.prepare("SELECT * FROM devices ORDER BY CASE WHEN os_type='mikrotik' AND device_role='host' THEN 0 ELSE 1 END, display_order ASC, name COLLATE NOCASE, id ASC").all().map(r => rowToDevice(r));
}

export function getDevice(id, includeSecrets = false) {
  return rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id), includeSecrets);
}

export function getMikroTikHost(excludeId = null) {
  const row = excludeId == null
    ? db.prepare("SELECT * FROM devices WHERE os_type='mikrotik' AND device_role='host' ORDER BY id LIMIT 1").get()
    : db.prepare("SELECT * FROM devices WHERE os_type='mikrotik' AND device_role='host' AND id<>? ORDER BY id LIMIT 1").get(excludeId);
  return rowToDevice(row);
}

function assertGatewayAvailable(requestedRole, excludeId = null) {
  if (requestedRole !== 'host') return;
  const existing = getMikroTikHost(excludeId);
  if (existing) {
    const err = new Error(`Only one MikroTik Host / gateway is allowed. ${existing.name} is already the gateway.`);
    err.code = 'GATEWAY_EXISTS';
    throw err;
  }
}

function nextDeviceDisplayOrder() {
  return Number(db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM devices').get()?.n || 0);
}

export function createDevice(input) {
  const requestedRole = input.osType === 'mikrotik'
    ? (input.deviceRole === 'host' ? 'host' : 'client')
    : input.osType === 'openwrt'
      ? (input.deviceRole === 'access_point' ? 'access_point' : 'client')
      : input.osType === 'generic'
        ? (['router','access_point','switch','ip_camera'].includes(input.deviceRole) ? input.deviceRole : 'router')
        : 'client';
  assertGatewayAvailable(input.osType === 'mikrotik' ? requestedRole : 'client');
  const mode = input.osType === 'mikrotik' ? 'rest' : input.osType === 'generic' ? 'icmp' : input.osType === 'ruijie' ? 'cloud' : 'ssh';
  const info = db.prepare(`
    INSERT INTO devices
    (name, host, os_type, connection_mode, rest_scheme, rest_port, monitor_interface, insecure_tls, device_role, detected_model, credentials_enc, display_order, created_at)
    VALUES (@name, @host, @osType, @connectionMode, @restScheme, @restPort, @monitorInterface, @insecureTls, @deviceRole, '', @credentialsEnc, @displayOrder, @createdAt)
  `).run({
    name: input.name,
    host: input.host,
    osType: input.osType,
    connectionMode: mode,
    restScheme: input.restScheme || 'https',
    restPort: input.restPort || null,
    monitorInterface: input.monitorInterface || null,
    insecureTls: input.insecureTls ? 1 : 0,
    deviceRole: requestedRole,
    credentialsEnc: encryptJson(input.osType === 'generic' ? {} : (input.credentials || {})),
    displayOrder: Number.isFinite(Number(input.displayOrder)) ? Number(input.displayOrder) : nextDeviceDisplayOrder(),
    createdAt: Date.now(),
  });
  return getDevice(info.lastInsertRowid);
}

export function updateDevice(id, input) {
  const existing = getDevice(id, true);
  if (!existing) return null;
  const osType = input.osType ?? existing.osType;
  const connectionMode = osType === 'mikrotik' ? 'rest' : osType === 'generic' ? 'icmp' : osType === 'ruijie' ? 'cloud' : 'ssh';
  const credentials = osType === 'generic' ? {} : { ...existing.credentials, ...(input.credentials || {}) };
  const requestedRole = osType === 'mikrotik'
    ? ((input.deviceRole ?? existing.deviceRole) === 'host' ? 'host' : 'client')
    : osType === 'openwrt'
      ? ((input.deviceRole ?? existing.deviceRole) === 'access_point' ? 'access_point' : 'client')
      : osType === 'generic'
        ? (['router','access_point','switch','ip_camera'].includes(input.deviceRole ?? existing.deviceRole) ? (input.deviceRole ?? existing.deviceRole) : 'router')
        : 'client';
  assertGatewayAvailable(osType === 'mikrotik' ? requestedRole : 'client', id);
  db.prepare(`
    UPDATE devices SET
      name=@name, host=@host, os_type=@osType, connection_mode=@connectionMode,
      rest_scheme=@restScheme, rest_port=@restPort,
      monitor_interface=@monitorInterface, insecure_tls=@insecureTls, device_role=@deviceRole,
      credentials_enc=@credentialsEnc
    WHERE id=@id
  `).run({
    id,
    name: input.name ?? existing.name,
    host: input.host ?? existing.host,
    osType,
    connectionMode,
    restScheme: input.restScheme ?? existing.restScheme,
    restPort: input.restPort ?? existing.restPort,
    monitorInterface: ['generic','ruijie'].includes(osType) ? null : (input.monitorInterface ?? existing.monitorInterface),
    insecureTls: (input.insecureTls ?? existing.insecureTls) ? 1 : 0,
    deviceRole: requestedRole,
    credentialsEnc: encryptJson(credentials),
  });
  return getDevice(id);
}

export function updateDetectedModel(id, model = '') {
  const value = String(model || '').trim().slice(0, 160);
  if (!value) return false;
  return db.prepare("UPDATE devices SET detected_model=? WHERE id=? AND COALESCE(detected_model, '') <> ?").run(value, id, value).changes > 0;
}

export function reorderDevices(ids = []) {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  const current = listDevices();
  const validIds = new Set(current.map(d => d.id));
  const gateway = current.find(d => d.osType === 'mikrotik' && d.deviceRole === 'host');
  const ordered = [];
  if (gateway) ordered.push(gateway.id);
  for (const id of requested) if (validIds.has(id) && id !== gateway?.id && !ordered.includes(id)) ordered.push(id);
  for (const d of current) if (!ordered.includes(d.id)) ordered.push(d.id);
  const setOrder = db.prepare('UPDATE devices SET display_order=? WHERE id=?');
  const tx = db.transaction(values => values.forEach((id, i) => setOrder.run(i, id)));
  tx(ordered);
  return listDevices();
}

export function deleteDevice(id) {
  return db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
}

export function insertMetric(deviceId, m) {
  db.prepare(`INSERT INTO metrics
    (device_id, ts, cpu, memory_used, memory_total, uptime_sec, rx_bytes, tx_bytes, clients_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(deviceId, Date.now(), m.cpu ?? null, m.memoryUsed ?? null, m.memoryTotal ?? null,
      m.uptimeSec ?? null, m.rxBytes ?? null, m.txBytes ?? null, m.clientsCount ?? null);
}

export function latestMetric(deviceId) {
  return db.prepare('SELECT * FROM metrics WHERE device_id=? ORDER BY ts DESC LIMIT 1').get(deviceId) || null;
}

export function metricHistory(deviceId, since) {
  return db.prepare('SELECT * FROM metrics WHERE device_id=? AND ts>=? ORDER BY ts ASC').all(deviceId, since);
}

export function insertUptime(deviceId, result) {
  db.prepare('INSERT INTO uptime_checks(device_id, ts, status, latency_ms, error) VALUES (?, ?, ?, ?, ?)')
    .run(deviceId, Date.now(), result.ok ? 1 : 0, result.latencyMs ?? null, result.error || null);
}

export function uptimeHistory(deviceId, since) {
  return db.prepare('SELECT * FROM uptime_checks WHERE device_id=? AND ts>=? ORDER BY ts ASC').all(deviceId, since);
}

export function latestUptimeAll() {
  return db.prepare(`
    SELECT u.* FROM uptime_checks u
    JOIN (SELECT device_id, MAX(ts) ts FROM uptime_checks GROUP BY device_id) x
      ON x.device_id=u.device_id AND x.ts=u.ts
  `).all();
}

export function getStatusSettings() {
  const row = db.prepare('SELECT * FROM status_page_settings WHERE id=1').get();
  return {
    title: row?.title || 'Network Status',
    subtitle: row?.subtitle || '',
    showHosts: Boolean(row?.show_hosts),
    refreshSeconds: Number(row?.refresh_seconds || 30),
    accent: row?.accent || '#6f8cff',
    updatedAt: row?.updated_at || null,
  };
}

export function updateStatusSettings(input = {}) {
  const current = getStatusSettings();
  const title = String(input.title ?? current.title).trim().slice(0, 80) || 'Network Status';
  const subtitle = String(input.subtitle ?? current.subtitle).trim().slice(0, 240);
  const showHosts = Boolean(input.showHosts);
  const refreshSeconds = Math.min(300, Math.max(10, Number(input.refreshSeconds ?? current.refreshSeconds) || 30));
  const accentInput = String(input.accent ?? current.accent);
  const accent = /^#[0-9a-fA-F]{6}$/.test(accentInput) ? accentInput : current.accent;
  db.prepare(`UPDATE status_page_settings SET
    title=?, subtitle=?, show_hosts=?, refresh_seconds=?, accent=?, updated_at=? WHERE id=1`)
    .run(title, subtitle, showHosts ? 1 : 0, refreshSeconds, accent, Date.now());
  return getStatusSettings();
}


export function getAppSettings() {
  const row = db.prepare('SELECT * FROM app_settings WHERE id=1').get();
  return {
    appName: row?.app_name || 'RouterDeck',
    clockFormat: row?.clock_format === '12h' ? '12h' : '24h',
    theme: ['system', 'latte', 'frappe', 'macchiato', 'mocha', 'amoled'].includes(row?.theme)
      ? row.theme : row?.theme === 'light' ? 'latte' : row?.theme === 'dark' ? 'mocha' : 'system',
    timeZone: row?.time_zone || 'auto',
    updatedAt: row?.updated_at || null,
  };
}

export function updateAppSettings(input = {}) {
  const current = getAppSettings();
  const appName = String(input.appName ?? current.appName).trim().replace(/\s+/g, ' ').slice(0, 48) || 'RouterDeck';
  const clockFormat = ['12h', '24h'].includes(input.clockFormat) ? input.clockFormat : current.clockFormat;
  const requestedTheme = input.theme === 'light' ? 'latte' : input.theme === 'dark' ? 'mocha' : input.theme;
  const theme = ['system', 'latte', 'frappe', 'macchiato', 'mocha', 'amoled'].includes(requestedTheme) ? requestedTheme : current.theme;
  let timeZone = String(input.timeZone ?? current.timeZone ?? 'auto').trim() || 'auto';
  if (timeZone !== 'auto') {
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); }
    catch { timeZone = current.timeZone || 'auto'; }
  }
  db.prepare(`UPDATE app_settings SET app_name=?, clock_format=?, theme=?, time_zone=?, updated_at=? WHERE id=1`)
    .run(appName, clockFormat, theme, timeZone, Date.now());
  return getAppSettings();
}

function rowToService(row, includeSecrets = false) {
  if (!row) return null;
  const service = {
    id: row.id,
    name: row.name,
    serviceType: row.service_type,
    host: row.host,
    scheme: row.scheme,
    port: row.port,
    insecureTls: Boolean(row.insecure_tls),
    sshMetrics: Boolean(row.ssh_metrics),
    webUrl: `${row.scheme || (['proxmox','synology'].includes(row.service_type) ? 'https' : 'http')}://${row.host}:${row.port || (row.service_type === 'homeassistant' ? 8123 : row.service_type === 'proxmox' ? 8006 : row.service_type === 'synology' ? (row.scheme === 'http' ? 5000 : 5001) : row.service_type === 'nginxproxymanager' ? 81 : row.service_type === 'casaos' ? (row.scheme === 'https' ? 443 : 80) : (row.scheme === 'https' ? 443 : 80))}`,
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at,
  };
  if (includeSecrets) service.credentials = decryptJson(row.credentials_enc);
  return service;
}

export function listServices() {
  return db.prepare('SELECT * FROM network_services ORDER BY display_order ASC, name COLLATE NOCASE, id ASC').all().map(r => rowToService(r));
}

export function getService(id, includeSecrets = false) {
  return rowToService(db.prepare('SELECT * FROM network_services WHERE id=?').get(id), includeSecrets);
}

function nextServiceDisplayOrder() {
  return Number(db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM network_services').get()?.n || 0);
}

export function createService(input = {}) {
  const serviceType = ['adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos'].includes(input.serviceType) ? input.serviceType : 'adguardhome';
  const defaultName = serviceType === 'homeassistant' ? 'Home Assistant' : serviceType === 'proxmox' ? 'Proxmox VE' : serviceType === 'synology' ? 'Synology DSM' : serviceType === 'nginxproxymanager' ? 'Nginx Proxy Manager' : serviceType === 'casaos' ? 'CasaOS' : 'AdGuard Home';
  const defaultPort = serviceType === 'homeassistant' ? 8123 : serviceType === 'proxmox' ? 8006 : serviceType === 'synology' ? 5001 : serviceType === 'nginxproxymanager' ? 81 : serviceType === 'casaos' ? 80 : null;
  const info = db.prepare(`INSERT INTO network_services
    (name,service_type,host,scheme,port,insecure_tls,ssh_metrics,credentials_enc,display_order,created_at)
    VALUES (@name,@serviceType,@host,@scheme,@port,@insecureTls,@sshMetrics,@credentialsEnc,@displayOrder,@createdAt)`)
    .run({
      name: String(input.name || defaultName).trim(), serviceType, host: String(input.host || '').trim(),
      scheme: input.scheme === 'http' ? 'http' : input.scheme === 'https' ? 'https' : (['proxmox','synology'].includes(serviceType) ? 'https' : 'http'), port: input.port || defaultPort,
      insecureTls: input.insecureTls ? 1 : 0, sshMetrics: serviceType === 'adguardhome' && input.sshMetrics ? 1 : 0,
      credentialsEnc: encryptJson(input.credentials || {}), displayOrder: Number.isFinite(Number(input.displayOrder)) ? Number(input.displayOrder) : nextServiceDisplayOrder(), createdAt: Date.now(),
    });
  return getService(info.lastInsertRowid);
}

export function updateService(id, input = {}) {
  const existing = getService(id, true);
  if (!existing) return null;
  const serviceType = existing.serviceType;
  const credentials = { ...existing.credentials, ...(input.credentials || {}) };
  db.prepare(`UPDATE network_services SET
    name=@name,host=@host,scheme=@scheme,port=@port,insecure_tls=@insecureTls,
    ssh_metrics=@sshMetrics,credentials_enc=@credentialsEnc WHERE id=@id`).run({
      id,
      name: String(input.name ?? existing.name).trim(), host: String(input.host ?? existing.host).trim(),
      scheme: (input.scheme ?? existing.scheme) === 'https' ? 'https' : 'http',
      port: input.port ?? existing.port, insecureTls: (input.insecureTls ?? existing.insecureTls) ? 1 : 0,
      sshMetrics: serviceType === 'adguardhome' && (input.sshMetrics ?? existing.sshMetrics) ? 1 : 0,
      credentialsEnc: encryptJson(credentials),
    });
  return getService(id);
}

export function reorderServices(ids = []) {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  const current = listServices();
  const validIds = new Set(current.map(s => s.id));
  const ordered = [];
  for (const id of requested) if (validIds.has(id) && !ordered.includes(id)) ordered.push(id);
  for (const service of current) if (!ordered.includes(service.id)) ordered.push(service.id);
  const setOrder = db.prepare('UPDATE network_services SET display_order=? WHERE id=?');
  const tx = db.transaction(values => values.forEach((id, i) => setOrder.run(i, id)));
  tx(ordered);
  return listServices();
}

export function deleteService(id) {
  return db.prepare('DELETE FROM network_services WHERE id=?').run(id).changes > 0;
}

export function insertServiceMetric(serviceId, metric = {}) {
  const extraFields = {};
  const keys = [
    'entityCount','unavailableCount','roomCount','automationCount','lightCount','switchCount','locationName',
    'clusterName','nodeCount','onlineNodeCount','vmCount','lxcCount','guestCount','runningCount','release','repositoryId','nodes','model','serial','temperature','health','volumeCount','diskCount','packageCount','uptimeSec','proxyHostCount','enabledProxyHostCount','certificateCount','expiringCertificateCount','appCount','runningAppCount','updateCount','architecture'
  ];
  for (const key of keys) {
    if (metric[key] == null) continue;
    if (key === 'nodes' && Array.isArray(metric.nodes)) {
      // Keep service metric history compact: PCI/PCIe inventories are live/static detail,
      // not useful to duplicate every polling interval.
      extraFields.nodes = metric.nodes.map(({ pcie, ...node }) => ({ ...node, pcieCount: Array.isArray(pcie) ? pcie.length : (node.pcieCount || 0) }));
    } else extraFields[key] = metric[key];
  }
  if (metric.summary && typeof metric.summary === 'object') {
    for (const key of ['entityCount','unavailableCount','automationCount','lightCount','switchCount']) {
      if (extraFields[key] == null && metric.summary[key] != null) extraFields[key] = metric.summary[key];
    }
  }
  const extra = Object.keys(extraFields).length ? JSON.stringify(extraFields) : null;
  db.prepare(`INSERT INTO service_metrics
    (service_id,ts,status,cpu,memory_used,memory_total,protection_enabled,version,extra_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(serviceId, Date.now(), Number(metric.status) === 1 ? 1 : 0,
      metric.cpu ?? null, metric.memoryUsed ?? null, metric.memoryTotal ?? null,
      metric.protectionEnabled == null ? null : (metric.protectionEnabled ? 1 : 0), metric.version || null, extra);
}

function parseServiceMetric(row) {
  if (!row) return null;
  let extra = {};
  try { extra = row.extra_json ? JSON.parse(row.extra_json) : {}; } catch {}
  return { ...row, ...extra };
}

export function latestServiceMetric(serviceId) {
  return parseServiceMetric(db.prepare('SELECT * FROM service_metrics WHERE service_id=? ORDER BY ts DESC LIMIT 1').get(serviceId));
}

export function serviceMetricHistory(serviceId, since) {
  return db.prepare('SELECT * FROM service_metrics WHERE service_id=? AND ts>=? ORDER BY ts ASC').all(serviceId, since).map(parseServiceMetric);
}

export function insertServiceUptime(serviceId, result) {
  db.prepare('INSERT INTO service_uptime_checks(service_id, ts, status, latency_ms, error) VALUES (?, ?, ?, ?, ?)')
    .run(serviceId, Date.now(), result.ok ? 1 : 0, result.latencyMs ?? null, result.error || null);
}

export function serviceUptimeHistory(serviceId, since) {
  return db.prepare('SELECT * FROM service_uptime_checks WHERE service_id=? AND ts>=? ORDER BY ts ASC').all(serviceId, since);
}

export function latestServiceUptimeAll() {
  return db.prepare(`
    SELECT u.* FROM service_uptime_checks u
    JOIN (SELECT service_id, MAX(ts) ts FROM service_uptime_checks GROUP BY service_id) x
      ON x.service_id=u.service_id AND x.ts=u.ts
  `).all();
}

export function latestServiceUptime(serviceId) {
  return db.prepare('SELECT * FROM service_uptime_checks WHERE service_id=? ORDER BY ts DESC LIMIT 1').get(serviceId) || null;
}

export function setGatewayAnalyticsCache(deviceId, payload) {
  db.prepare(`INSERT INTO gateway_analytics_cache(device_id,ts,payload_json) VALUES(?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET ts=excluded.ts,payload_json=excluded.payload_json`)
    .run(deviceId, Date.now(), JSON.stringify(payload || {}));
}

export function getGatewayAnalyticsCache(deviceId) {
  const row = db.prepare('SELECT * FROM gateway_analytics_cache WHERE device_id=?').get(deviceId);
  if (!row) return null;
  try { return { ts: row.ts, payload: JSON.parse(row.payload_json) }; } catch { return null; }
}


export function exportConfiguration() {
  return {
    format: 'routerdeck-config-v1',
    exportedAt: Date.now(),
    appSettings: getAppSettings(),
    statusSettings: getStatusSettings(),
    telegramSettings: { ...getTelegramSettings(), botToken: getTelegramBotToken() || '' },
    telegramRecipients: getTelegramRecipients(),
    devices: listDevices().map(d => {
      const full = getDevice(d.id, true);
      return {
        name: full.name, host: full.host, osType: full.osType, restScheme: full.restScheme,
        restPort: full.restPort, monitorInterface: full.monitorInterface, insecureTls: full.insecureTls,
        deviceRole: full.deviceRole, displayOrder: full.displayOrder, credentials: full.credentials || {},
      };
    }),
    services: listServices().map(svc => {
      const full = getService(svc.id, true);
      return {
        name: full.name, host: full.host, serviceType: full.serviceType, scheme: full.scheme,
        port: full.port, insecureTls: full.insecureTls, sshMetrics: full.sshMetrics, displayOrder: full.displayOrder,
        credentials: full.credentials || {},
      };
    }),
  };
}

export function restoreConfiguration(payload = {}) {
  if (payload?.format !== 'routerdeck-config-v1') throw new Error('Unsupported RouterDeck backup format');
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const services = Array.isArray(payload.services) ? payload.services : [];
  const validDeviceTypes = new Set(['openwrt','mikrotik','generic','ruijie']);
  const validServiceTypes = new Set(['adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos']);
  const hosts = devices.filter(d => d?.osType === 'mikrotik' && d?.deviceRole === 'host');
  if (hosts.length > 1) throw new Error('Backup contains more than one MikroTik Host / gateway');
  for (const d of devices) if (!validDeviceTypes.has(d?.osType)) throw new Error(`Unsupported device type in backup: ${d?.osType || 'unknown'}`);
  for (const s of services) if (!validServiceTypes.has(s?.serviceType)) throw new Error(`Unsupported service type in backup: ${s?.serviceType || 'unknown'}`);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM network_services').run();
    db.prepare('DELETE FROM devices').run();
    if (payload.appSettings) updateAppSettings(payload.appSettings);
    if (payload.statusSettings) updateStatusSettings(payload.statusSettings);
    if (payload.telegramSettings) {
      updateTelegramSettings({ ...payload.telegramSettings, botToken: payload.telegramSettings.botToken || '' });
    }
    db.prepare('DELETE FROM telegram_recipients').run();
    for (const recipient of payload.telegramRecipients || []) createTelegramRecipient(recipient);
    for (const d of [...devices].sort((a,b)=>Number(a.displayOrder??0)-Number(b.displayOrder??0))) createDevice(d);
    for (const svc of [...services].sort((a,b)=>Number(a.displayOrder??0)-Number(b.displayOrder??0))) createService(svc);
  });
  tx();
  return { ok: true, devices: devices.length, services: services.length };
}

// ------------------- Telegram notifications -------------------

db.prepare(`INSERT OR IGNORE INTO telegram_settings
  (id, enabled, bot_token_enc, chat_id, notify_down, notify_up, updated_at)
  VALUES (1, 0, '', '', 1, 1, ?)`).run(Date.now());

// Migrate the legacy single-chat_id setting into a recipient entry so the
// multi-recipient model works out of the box on upgrades.
const legacyTg = db.prepare('SELECT chat_id, notify_down, notify_up FROM telegram_settings WHERE id=1').get();
if (legacyTg?.chat_id && db.prepare('SELECT COUNT(*) n FROM telegram_recipients').get().n === 0) {
  db.prepare(`INSERT INTO telegram_recipients (chat_id,label,enabled,notify_down,notify_up,scope,device_ids_json,service_ids_json,display_order,created_at)
    VALUES (?, 'Default', 1, ?, ?, 'all', '[]', '[]', 0, ?)`)
    .run(legacyTg.chat_id, legacyTg.notify_down ?? 1, legacyTg.notify_up ?? 1, Date.now());
}

export function getTelegramSettings() {
  const row = db.prepare('SELECT * FROM telegram_settings WHERE id=1').get();
  return {
    enabled: Boolean(row?.enabled),
    botTokenSet: Boolean(row?.bot_token_enc), // token is never returned, only its presence
    chatId: row?.chat_id || '',
    notifyDown: row ? Number(row.notify_down) !== 0 : true,
    notifyUp: row ? Number(row.notify_up) !== 0 : true,
    updatedAt: row?.updated_at || null,
  };
}

export function getTelegramBotToken() {
  const row = db.prepare('SELECT bot_token_enc FROM telegram_settings WHERE id=1').get();
  if (!row?.bot_token_enc) return null;
  try { return decryptJson(row.bot_token_enc)?.token || null; } catch { return null; }
}

export function updateTelegramSettings(input = {}) {
  const current = db.prepare('SELECT * FROM telegram_settings WHERE id=1').get();
  const tokenInput = typeof input.botToken === 'string' ? input.botToken.trim() : '';
  const token = tokenInput ? encryptJson({ token: tokenInput }) : (current?.bot_token_enc || '');
  const chatId = String(input.chatId ?? current?.chat_id ?? '').trim().slice(0, 64);
  const enabled = Boolean(input.enabled);
  const notifyDown = input.notifyDown !== false;
  const notifyUp = input.notifyUp !== false;
  db.prepare(`INSERT INTO telegram_settings (id, enabled, bot_token_enc, chat_id, notify_down, notify_up, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled=excluded.enabled, bot_token_enc=excluded.bot_token_enc, chat_id=excluded.chat_id,
      notify_down=excluded.notify_down, notify_up=excluded.notify_up, updated_at=excluded.updated_at`)
    .run(enabled ? 1 : 0, token, chatId, notifyDown ? 1 : 0, notifyUp ? 1 : 0, Date.now());
  return getTelegramSettings();
}

export function getTelegramRecipients() {
  return db.prepare('SELECT * FROM telegram_recipients ORDER BY display_order ASC, id ASC').all().map(rowToRecipient);
}

function rowToRecipient(row) {
  if (!row) return null;
  let deviceIds = [];
  let serviceIds = [];
  try { deviceIds = JSON.parse(row.device_ids_json || '[]'); } catch {}
  try { serviceIds = JSON.parse(row.service_ids_json || '[]'); } catch {}
  return {
    id: row.id,
    chatId: row.chat_id,
    label: row.label || '',
    enabled: Boolean(row.enabled),
    notifyDown: Number(row.notify_down) !== 0,
    notifyUp: Number(row.notify_up) !== 0,
    scope: row.scope === 'selected' ? 'selected' : 'all',
    deviceIds: Array.isArray(deviceIds) ? [...new Set(deviceIds.map(Number).filter(Number.isInteger))] : [],
    serviceIds: Array.isArray(serviceIds) ? [...new Set(serviceIds.map(Number).filter(Number.isInteger))] : [],
    createdAt: row.created_at,
  };
}

function sanitizeIds(value) {
  return JSON.stringify([...new Set((Array.isArray(value) ? value : []).map(Number).filter(Number.isInteger))]);
}

export function createTelegramRecipient(input = {}) {
  const chatId = String(input.chatId || '').trim().slice(0, 64);
  if (!chatId) {
    const err = new Error('Chat ID is required');
    err.code = 'CHAT_ID_REQUIRED';
    throw err;
  }
  const label = String(input.label || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const scope = input.scope === 'selected' ? 'selected' : 'all';
  const info = db.prepare(`INSERT INTO telegram_recipients
    (chat_id,label,enabled,notify_down,notify_up,scope,device_ids_json,service_ids_json,display_order,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, label, input.enabled === false ? 0 : 1,
      input.notifyDown !== false ? 1 : 0, input.notifyUp !== false ? 1 : 0, scope,
      sanitizeIds(input.deviceIds), sanitizeIds(input.serviceIds),
      Number(db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM telegram_recipients').get()?.n || 0), Date.now());
  return rowToRecipient(db.prepare('SELECT * FROM telegram_recipients WHERE id=?').get(info.lastInsertRowid));
}

export function updateTelegramRecipient(id, input = {}) {
  const existing = db.prepare('SELECT * FROM telegram_recipients WHERE id=?').get(id);
  if (!existing) return null;
  const chatId = input.chatId != null ? String(input.chatId).trim().slice(0, 64) : existing.chat_id;
  if (!chatId) {
    const err = new Error('Chat ID is required');
    err.code = 'CHAT_ID_REQUIRED';
    throw err;
  }
  const label = input.label != null ? String(input.label).trim().replace(/\s+/g, ' ').slice(0, 60) : (existing.label || '');
  const scope = input.scope != null ? (input.scope === 'selected' ? 'selected' : 'all') : existing.scope;
  db.prepare(`UPDATE telegram_recipients SET chat_id=?, label=?, enabled=?, notify_down=?, notify_up=?, scope=?, device_ids_json=?, service_ids_json=? WHERE id=?`)
    .run(chatId, label,
      (input.enabled ?? Number(existing.enabled)) ? 1 : 0,
      (input.notifyDown ?? Number(existing.notify_down)) !== false ? 1 : 0,
      (input.notifyUp ?? Number(existing.notify_up)) !== false ? 1 : 0,
      scope,
      input.scope != null ? sanitizeIds(input.deviceIds) : (existing.device_ids_json || '[]'),
      input.scope != null ? sanitizeIds(input.serviceIds) : (existing.service_ids_json || '[]'),
      id);
  return rowToRecipient(db.prepare('SELECT * FROM telegram_recipients WHERE id=?').get(id));
}

export function deleteTelegramRecipient(id) {
  return db.prepare('DELETE FROM telegram_recipients WHERE id=?').run(id).changes > 0;
}

export function cleanupHistory() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM uptime_checks WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM service_metrics WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM service_uptime_checks WHERE ts < ?').run(cutoff);
}

export { closeDatabase, databaseStatus } from './connection.js';
