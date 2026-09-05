import axios from 'axios';
import https from 'node:https';
import { lookupGeo, geoStatus } from '../etc/geo.js';

function parseUptime(s = '') {
  let seconds = 0;
  const re = /(\d+)(w|d|h|m|s)/g;
  for (const m of String(s).matchAll(re)) {
    seconds += Number(m[1]) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[m[2]] || 0);
  }
  return seconds;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeClient(device) {
  const c = device.credentials || {};
  const scheme = device.restScheme || 'https';
  const port = device.restPort || (scheme === 'https' ? 443 : 80);
  return axios.create({
    baseURL: `${scheme}://${device.host}:${port}/rest`,
    timeout: 9000,
    auth: {
      username: c.apiUsername || c.username || 'admin',
      password: c.apiPassword || c.password || '',
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: !device.insecureTls }),
  });
}

async function safeGet(client, path) {
  try {
    const data = (await client.get(path)).data;
    if (Array.isArray(data)) return data;
    return data ? [data] : [];
  } catch (e) {
    if (e.response?.status === 404 || e.response?.status === 400) return [];
    throw e;
  }
}

function normalizeLease(row) {
  const status = String(row.status || '').toLowerCase();
  const address = row['active-address'] || row.address || '';
  const mac = String(row['active-mac-address'] || row['mac-address'] || '').toLowerCase();
  const hostname = row['host-name'] || row.hostname || '';
  const active = status === 'bound' || Boolean(row['active-address']);

  return {
    address,
    mac,
    hostname,
    server: row.server || '',
    status: row.status || (active ? 'bound' : 'waiting'),
    expiresAfter: row['expires-after'] || '',
    lastSeen: row['last-seen'] || '',
    dynamic: row.dynamic === true || row.dynamic === 'true',
    disabled: row.disabled === true || row.disabled === 'true',
    blocked: row.blocked === true || row.blocked === 'true',
    comment: row.comment || '',
    active,
    source: 'RouterOS REST',
  };
}

function normalizeNeighbor(row) {
  const mac = String(row['mac-address'] || '').toLowerCase();
  const status = String(row.status || '').toLowerCase();
  return {
    address: row.address || '',
    mac,
    interface: row.interface || '',
    state: row.status || (row.complete === 'true' || row.complete === true ? 'complete' : ''),
    active: Boolean(mac) && !['failed', 'incomplete'].includes(status),
  };
}


function asBool(value) {
  return value === true || value === 'true' || value === 'yes';
}

function normalizeRouterInterface(row = {}, ethernet = {}) {
  const type = String(row.type || ethernet.type || '').toLowerCase();
  const name = row.name || ethernet.name || '';
  const disabled = asBool(row.disabled);
  const running = asBool(row.running);
  const physical = ['ether', 'ethernet', 'sfp', 'combo', 'qsfp'].includes(type) || /^(ether|sfp|combo|qsfp)/i.test(name);
  let status = 'inactive';
  if (disabled) status = 'disabled';
  else if (running) status = 'ready';
  else if (physical) status = 'not-plugged';
  return {
    id: row['.id'] || ethernet['.id'] || name,
    name,
    defaultName: row['default-name'] || ethernet['default-name'] || '',
    type: type || 'interface',
    physical,
    portKind: /^(sfp|qsfp|combo)/i.test(name) ? 'sfp' : 'ethernet',
    status,
    running,
    disabled,
    mac: row['mac-address'] || ethernet['mac-address'] || '',
    mtu: asNumber(row['actual-mtu'] ?? row.mtu ?? ethernet.mtu),
    speed: ethernet.rate || ethernet.speed || row.rate || '',
    autoNegotiation: ethernet['auto-negotiation'] ?? '',
    rxBytes: asNumber(row['rx-byte']),
    txBytes: asNumber(row['tx-byte']),
    rxPackets: asNumber(row['rx-packet']),
    txPackets: asNumber(row['tx-packet']),
    linkDowns: asNumber(row['link-downs'] ?? ethernet['link-downs']),
    lastLinkUp: row['last-link-up-time'] || ethernet['last-link-up-time'] || '',
    lastLinkDown: row['last-link-down-time'] || ethernet['last-link-down-time'] || '',
    comment: row.comment || ethernet.comment || '',
  };
}

function normalizeWifi(row, leaseByMac) {
  const mac = String(row['mac-address'] || row.mac || '').toLowerCase();
  const lease = leaseByMac.get(mac) || {};
  const signal = asNumber(row.signal ?? row['signal-strength']);
  return {
    mac,
    address: row['last-ip'] || lease.address || '',
    hostname: lease.hostname || '',
    interface: row.interface || '',
    ssid: row.ssid || '',
    signal,
    rxRate: row['rx-rate'] || '',
    txRate: row['tx-rate'] || '',
    rxBytes: asNumber(row['rx-bytes'] ?? row['rx-byte']),
    txBytes: asNumber(row['tx-bytes'] ?? row['tx-byte']),
    uptime: row.uptime || '',
    authorized: row.authorized == null ? true : (row.authorized === true || row.authorized === 'true'),
    associated: true,
  };
}

export async function collectMikroTik(device) {
  const client = makeClient(device);
  const [resources, identities, routerboards, interfaces, ethernetRows, leases, wifiNew, wifiLegacy, capsman, arp] = await Promise.all([
    safeGet(client, '/system/resource'),
    safeGet(client, '/system/identity'),
    safeGet(client, '/system/routerboard'),
    safeGet(client, '/interface'),
    safeGet(client, '/interface/ethernet'),
    safeGet(client, '/ip/dhcp-server/lease'),
    safeGet(client, '/interface/wifi/registration-table'),
    safeGet(client, '/interface/wireless/registration-table'),
    safeGet(client, '/caps-man/registration-table'),
    safeGet(client, '/ip/arp'),
  ]);

  const resource = resources[0] || {};
  const identity = identities[0] || {};
  const routerboard = routerboards[0] || {};
  const iface = device.monitorInterface
    ? interfaces.find(i => i.name === device.monitorInterface)
    : null;
  const ethernetByName = new Map(ethernetRows.map(x => [x.name, x]));
  const normalizedInterfaces = interfaces.map(x => normalizeRouterInterface(x, ethernetByName.get(x.name) || {})).filter(x => x.name);
  const dhcpLeases = leases.map(normalizeLease);
  const activeDhcp = dhcpLeases.filter(l => l.active && !l.disabled);
  const leaseByMac = new Map(dhcpLeases.map(l => [l.mac, l]));

  // Prefer the modern /interface/wifi table, then legacy wireless, then CAPsMAN.
  const registrations = wifiNew.length ? wifiNew : wifiLegacy.length ? wifiLegacy : capsman;
  const wifiClients = registrations.map(row => normalizeWifi(row, leaseByMac)).filter(c => c.mac);
  const neighbors = arp.map(normalizeNeighbor).filter(n => n.address && n.mac);
  const clientKeys = new Set();
  for (const c of wifiClients) clientKeys.add(c.mac || c.address);
  for (const l of activeDhcp) clientKeys.add(l.mac || l.address);
  if (!clientKeys.size) for (const n of neighbors.filter(n => n.active)) clientKeys.add(n.mac || n.address);

  const total = asNumber(resource['total-memory']);
  const free = asNumber(resource['free-memory']);

  const deviceInfo = {
    hostname: identity.name || device.name,
    model: routerboard.model || resource['board-name'] || '',
    boardName: resource['board-name'] || '',
    platform: resource.platform || 'MikroTik',
    os: 'MikroTik RouterOS',
    version: resource.version || '',
    architecture: resource['architecture-name'] || '',
    cpu: resource.cpu || '',
    cpuCount: asNumber(resource['cpu-count']),
    cpuFrequencyMhz: asNumber(resource['cpu-frequency']),
    serialNumber: routerboard['serial-number'] || '',
    currentFirmware: routerboard['current-firmware'] || '',
    upgradeFirmware: routerboard['upgrade-firmware'] || '',
    factoryFirmware: routerboard['factory-firmware'] || '',
    firmwareType: routerboard['firmware-type'] || '',
    buildTime: resource['build-time'] || '',
    monitorInterface: device.monitorInterface || '',
  };

  return {
    platform: 'MikroTik',
    hostname: deviceInfo.hostname,
    version: deviceInfo.version,
    uptimeSec: parseUptime(resource.uptime),
    cpu: asNumber(resource['cpu-load']),
    load1: null,
    memoryTotal: total,
    memoryUsed: total != null && free != null ? total - free : null,
    rxBytes: iface ? asNumber(iface['rx-byte']) : null,
    txBytes: iface ? asNumber(iface['tx-byte']) : null,
    clientsCount: [...clientKeys].filter(Boolean).length,
    wifiCount: wifiClients.length,
    wifiClients,
    dhcpCount: activeDhcp.length,
    dhcpLeases,
    neighbors,
    interfaces: normalizedInterfaces,
    deviceInfo,
    collector: {
      api: 'RouterOS REST',
      wifiSource: wifiNew.length ? '/interface/wifi/registration-table' : wifiLegacy.length ? '/interface/wireless/registration-table' : capsman.length ? '/caps-man/registration-table' : '',
    },
  };
}

export async function testMikroTik(device) {
  const client = makeClient(device);
  const data = (await client.get('/system/resource')).data;
  return { ok: true, api: 'RouterOS REST', resource: data };
}


function routerOsPayload(input = {}, allowed = [], includeEmpty = false) {
  const out = {};
  for (const key of allowed) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === undefined || value === null || (!includeEmpty && value === '')) continue;
    if (typeof value === 'boolean') out[key] = value ? 'true' : 'false';
    else out[key] = String(value);
  }
  return out;
}

const QUEUE_FIELDS = [
  'name', 'target', 'max-limit', 'limit-at', 'priority', 'queue', 'parent',
  'packet-marks', 'packet-mark', 'burst-limit', 'burst-threshold', 'burst-time', 'bucket-size',
  'comment', 'disabled',
];

const FIREWALL_FIELDS = [
  'chain', 'action', 'comment', 'disabled', 'protocol', 'src-address', 'dst-address',
  'src-port', 'dst-port', 'in-interface', 'out-interface', 'in-interface-list',
  'out-interface-list', 'src-address-list', 'dst-address-list', 'connection-state',
  'connection-nat-state', 'connection-mark', 'packet-mark', 'routing-mark',
  'new-connection-mark', 'new-packet-mark', 'new-routing-mark', 'jump-target',
  'log', 'log-prefix', 'limit', 'dst-limit', 'icmp-options', 'tcp-flags', 'tcp-mss',
  'src-address-type', 'dst-address-type', 'ipsec-policy', 'to-addresses', 'to-ports',
  'place-before',
];

function firewallPath(table) {
  if (!['filter', 'nat', 'mangle', 'raw'].includes(table)) throw new Error('Unsupported firewall table');
  return `/ip/firewall/${table}`;
}

function queuePath(kind = 'simple') {
  if (!['simple', 'tree'].includes(kind)) throw new Error('Unsupported queue kind');
  return `/queue/${kind}`;
}

export async function getMikroTikQueues(device, kind = 'simple') {
  return safeGet(makeClient(device), queuePath(kind));
}

export async function createMikroTikQueue(device, kind, input) {
  const client = makeClient(device);
  const payload = routerOsPayload(input, QUEUE_FIELDS);
  if (!payload.name) throw new Error('Queue name is required');
  if (kind === 'simple' && !payload.target) throw new Error('Simple queue target is required');
  return (await client.put(queuePath(kind), payload)).data;
}

export async function updateMikroTikQueue(device, kind, id, input) {
  const payload = routerOsPayload(input, QUEUE_FIELDS, true);
  if (!Object.keys(payload).length) throw new Error('No queue fields to update');
  return (await makeClient(device).patch(`${queuePath(kind)}/${encodeURIComponent(id)}`, payload)).data;
}

export async function deleteMikroTikQueue(device, kind, id) {
  await makeClient(device).delete(`${queuePath(kind)}/${encodeURIComponent(id)}`);
  return { ok: true };
}

export async function getMikroTikFirewall(device, table = 'filter') {
  return safeGet(makeClient(device), firewallPath(table));
}

export async function createMikroTikFirewallRule(device, table, input) {
  const payload = routerOsPayload(input, FIREWALL_FIELDS);
  if (!payload.chain || !payload.action) throw new Error('Firewall chain and action are required');
  return (await makeClient(device).put(firewallPath(table), payload)).data;
}

export async function updateMikroTikFirewallRule(device, table, id, input) {
  const payload = routerOsPayload(input, FIREWALL_FIELDS, true);
  if (!Object.keys(payload).length) throw new Error('No firewall fields to update');
  return (await makeClient(device).patch(`${firewallPath(table)}/${encodeURIComponent(id)}`, payload)).data;
}

export async function deleteMikroTikFirewallRule(device, table, id) {
  await makeClient(device).delete(`${firewallPath(table)}/${encodeURIComponent(id)}`);
  return { ok: true };
}

export async function getMikroTikLogs(device, limit = 250) {
  const rows = await safeGet(makeClient(device), '/log');
  const safeLimit = Math.min(1000, Math.max(20, Number(limit) || 250));
  return rows.slice(-safeLimit).reverse().map((row, index) => ({
    id: row['.id'] || `ros-${index}`,
    time: row.time || '',
    topics: row.topics || '',
    message: row.message || '',
  }));
}


function normalizeWirelessRow(row = {}, source = 'wifi', profiles = new Map()) {
  const profile = profiles.get(row.configuration || row['configuration']) || {};
  const disabled = asBool(row.disabled);
  const running = asBool(row.running);
  const dynamic = asBool(row.dynamic);
  const ssid = row['configuration.ssid'] || row.ssid || profile.ssid || '';
  const hidden = asBool(row['configuration.hide-ssid'] ?? row['hide-ssid'] ?? profile['hide-ssid']);
  const mode = row['configuration.mode'] || row.mode || profile.mode || '';
  const frequency = row['channel.frequency'] || row.frequency || profile['channel.frequency'] || '';
  const band = row['channel.band'] || row.band || profile['channel.band'] || '';
  const auth = row['security.authentication-types'] || profile['security.authentication-types'] || row['security-profile'] || '';
  return {
    id: row['.id'] || row.name,
    name: row.name || '',
    defaultName: row['default-name'] || '',
    source,
    ssid,
    mode,
    band,
    frequency,
    channelWidth: row['channel.width'] || profile['channel.width'] || '',
    country: row['configuration.country'] || profile.country || '',
    authentication: auth,
    securityProfile: row['security-profile'] || '',
    masterInterface: row['master-interface'] || '',
    configurationProfile: row.configuration || '',
    hidden,
    disabled,
    running,
    dynamic,
    status: disabled ? 'disabled' : running ? 'ready' : 'enabled',
    mac: row['mac-address'] || '',
  };
}

export async function getMikroTikWireless(device) {
  const client = makeClient(device);
  const [modern, profiles] = await Promise.all([
    safeGet(client, '/interface/wifi'),
    safeGet(client, '/interface/wifi/configuration'),
  ]);
  if (modern.length) {
    const profileMap = new Map(profiles.map(x => [x.name, x]));
    return { source: 'wifi', interfaces: modern.map(x => normalizeWirelessRow(x, 'wifi', profileMap)) };
  }
  const legacy = await safeGet(client, '/interface/wireless');
  return { source: 'wireless', interfaces: legacy.map(x => normalizeWirelessRow(x, 'wireless')) };
}

export async function updateMikroTikWireless(device, id, input = {}) {
  const source = input.source === 'wireless' ? 'wireless' : 'wifi';
  const path = source === 'wireless' ? '/interface/wireless' : '/interface/wifi';
  const payload = {};
  if ('ssid' in input) {
    const ssid = String(input.ssid || '').trim();
    if (!ssid || ssid.length > 32) throw new Error('SSID must be 1-32 characters');
    payload[source === 'wifi' ? 'configuration.ssid' : 'ssid'] = ssid;
  }
  if ('disabled' in input) payload.disabled = input.disabled ? 'true' : 'false';
  if ('hidden' in input) payload[source === 'wifi' ? 'configuration.hide-ssid' : 'hide-ssid'] = input.hidden ? 'true' : 'false';
  if (source === 'wifi' && input.authentication !== undefined && input.authentication !== '') payload['security.authentication-types'] = String(input.authentication);
  if (source === 'wifi' && input.passphrase) {
    const passphrase = String(input.passphrase);
    if (passphrase.length < 8 || passphrase.length > 63) throw new Error('Wi-Fi passphrase must be 8-63 characters');
    payload['security.passphrase'] = passphrase;
  }
  if (input.frequency !== undefined && String(input.frequency).trim()) payload[source === 'wifi' ? 'channel.frequency' : 'frequency'] = String(input.frequency).trim();
  if (!Object.keys(payload).length) throw new Error('No wireless fields to update');
  return (await makeClient(device).patch(`${path}/${encodeURIComponent(id)}`, payload)).data;
}

// Host/gateway connection analytics. This intentionally uses RouterOS' read-only
// connection tracking table, with .proplist to keep REST responses compact.

function isPrivateIPv4(ip = '') {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a === 0 || a >= 224;
}

function bareAddress(value = '') {
  return String(value || '').split('/')[0].trim();
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function aggregateBy(rows, keyFn, extraFn = () => ({}), limit = 10) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const cur = map.get(key) || { key, connections: 0, rate: 0, bytes: 0, ...extraFn(row) };
    cur.connections += 1;
    cur.rate += row.totalRate || 0;
    cur.bytes += row.totalBytes || 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.connections - a.connections || b.rate - a.rate).slice(0, limit);
}

function normalizeConnection(row = {}, leaseByIp = new Map()) {
  const src = bareAddress(row['src-address']);
  const dst = bareAddress(row['dst-address']);
  const protocol = String(row.protocol || 'other').toLowerCase();
  const origRate = numeric(row['orig-rate']);
  const replRate = numeric(row['repl-rate']);
  const origBytes = numeric(row['orig-bytes']);
  const replBytes = numeric(row['repl-bytes']);
  const srcPrivate = isPrivateIPv4(src);
  const dstPrivate = isPrivateIPv4(dst);
  const srcGeo = src && !srcPrivate ? lookupGeo(src) : null;
  const dstGeo = dst && !dstPrivate ? lookupGeo(dst) : null;
  const remoteIp = srcPrivate && !dstPrivate ? dst : !srcPrivate && dstPrivate ? src : (!dstPrivate ? dst : '');
  const geo = remoteIp === src ? srcGeo : remoteIp === dst ? dstGeo : null;
  return {
    id: row['.id'] || `${src}-${dst}-${row['src-port'] || ''}-${row['dst-port'] || ''}-${protocol}`,
    protocol,
    src,
    srcPort: row['src-port'] || '',
    srcName: leaseByIp.get(src) || '',
    dst,
    dstPort: row['dst-port'] || '',
    dstName: leaseByIp.get(dst) || '',
    tcpState: row['tcp-state'] || '',
    timeout: row.timeout || '',
    origRate,
    replRate,
    totalRate: origRate + replRate,
    origBytes,
    replBytes,
    totalBytes: origBytes + replBytes,
    seenReply: asBool(row['seen-reply']),
    fasttrack: asBool(row.fasttrack),
    srcnat: asBool(row.srcnat),
    dstnat: asBool(row.dstnat),
    remoteIp,
    geo,
    srcGeo,
    dstGeo,
  };
}

export async function getMikroTikConnectionAnalytics(device, options = {}) {
  const client = makeClient(device);
  const maxRows = Math.min(500, Math.max(50, Number(options.maxRows) || 180));
  const proplist = [
    '.id','protocol','src-address','src-port','dst-address','dst-port','tcp-state','timeout',
    'orig-rate','repl-rate','orig-bytes','repl-bytes','seen-reply','fasttrack','srcnat','dstnat',
  ];
  const [connectionReply, leases, addresses, tracking] = await Promise.all([
    client.post('/ip/firewall/connection/print', { '.proplist': proplist }),
    safeGet(client, '/ip/dhcp-server/lease'),
    safeGet(client, '/ip/address'),
    safeGet(client, '/ip/firewall/connection/tracking'),
  ]);
  const raw = Array.isArray(connectionReply.data) ? connectionReply.data : [];
  const leaseByIp = new Map();
  for (const lease of leases) {
    const ip = bareAddress(lease['active-address'] || lease.address);
    if (ip) leaseByIp.set(ip, lease['host-name'] || lease.hostname || '');
  }
  const rows = raw.map(row => normalizeConnection(row, leaseByIp));
  const protocolCounts = { tcp: 0, udp: 0, icmp: 0, other: 0 };
  let establishedTcp = 0;
  for (const row of rows) {
    const protocolBucket = row.protocol === 'tcp' ? 'tcp' : row.protocol === 'udp' ? 'udp'
      : ['icmp', 'icmpv6', 'ipv6-icmp'].includes(row.protocol) ? 'icmp' : 'other';
    protocolCounts[protocolBucket] += 1;
    if (row.protocol === 'tcp' && row.tcpState === 'established') establishedTcp += 1;
  }
  const topSources = aggregateBy(rows, r => r.src, r => ({ name: r.srcName || '' }), 10);
  const topDestinations = aggregateBy(rows, r => r.dst, r => ({ name: r.dstName || '', geo: r.dstGeo || null }), 10);

  const countryMap = new Map();
  for (const row of rows) {
    if (!row.geo?.countryCode) continue;
    const code = row.geo.countryCode;
    const cur = countryMap.get(code) || {
      countryCode: code, country: row.geo.country || code, city: row.geo.city || '',
      lat: row.geo.lat, lon: row.geo.lon, connections: 0, rate: 0, bytes: 0,
      protocols: { tcp: 0, udp: 0, icmp: 0, other: 0 },
    };
    cur.connections += 1;
    cur.rate += row.totalRate;
    cur.bytes += row.totalBytes;
    const bucket = row.protocol === 'tcp' ? 'tcp' : row.protocol === 'udp' ? 'udp' : ['icmp','icmpv6','ipv6-icmp'].includes(row.protocol) ? 'icmp' : 'other';
    cur.protocols[bucket] += 1;
    countryMap.set(code, cur);
  }
  const topCountries = [...countryMap.values()].sort((a,b) => b.connections - a.connections || b.rate - a.rate).slice(0, 14);

  const flowMap = new Map();
  for (const row of rows) {
    const sourceLabel = row.srcName ? `${row.srcName} (${row.src})` : row.src;
    const destinationLabel = row.geo?.country || row.dstName || row.dst;
    if (!sourceLabel || !destinationLabel) continue;
    const key = `${sourceLabel}\u0000${destinationLabel}`;
    const cur = flowMap.get(key) || { source: sourceLabel, destination: destinationLabel, connections: 0, rate: 0 };
    cur.connections += 1;
    cur.rate += row.totalRate;
    flowMap.set(key, cur);
  }
  const flows = [...flowMap.values()].sort((a,b) => b.connections - a.connections || b.rate - a.rate).slice(0, 12);

  const portMap = new Map();
  for (const row of rows) {
    if (!row.dstPort) continue;
    const key = `${row.protocol}/${row.dstPort}`;
    portMap.set(key, (portMap.get(key) || 0) + 1);
  }
  const topPorts = [...portMap.entries()].map(([port, connections]) => ({ port, connections }))
    .sort((a,b) => b.connections - a.connections).slice(0, 10);

  let wanLocation = null;
  for (const address of addresses) {
    const ip = bareAddress(address.address);
    if (!ip || isPrivateIPv4(ip)) continue;
    const geo = lookupGeo(ip);
    if (geo) { wanLocation = { ip, ...geo }; break; }
  }

  const sortedConnections = [...rows].sort((a,b) => b.totalRate - a.totalRate || b.totalBytes - a.totalBytes).slice(0, maxRows);
  const totalRate = rows.reduce((sum, r) => sum + r.totalRate, 0);
  const trackingRow = tracking[0] || {};
  return {
    generatedAt: Date.now(),
    totalConnections: rows.length,
    maxEntries: numeric(trackingRow['max-entries']) || null,
    reportedTotalEntries: numeric(trackingRow['total-entries']) || rows.length,
    totalRate,
    establishedTcp,
    protocols: {
      tcp: protocolCounts.tcp,
      udp: protocolCounts.udp,
      icmp: protocolCounts.icmp,
      other: protocolCounts.other,
    },
    topSources,
    topDestinations,
    topCountries,
    topPorts,
    flows,
    map: { origin: wanLocation, countries: topCountries.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon)) },
    connections: sortedConnections,
    geo: geoStatus(),
    source: '/ip/firewall/connection via RouterOS REST',
  };
}

const INTERNET_BLOCK_COMMENT = 'RouterDeck Block Internet ';

function normalizeMacAddress(value = '') {
  const raw = String(value || '').trim().replace(/-/g, ':').toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(raw)) throw new Error('Invalid MAC address');
  return raw;
}

export async function getMikroTikInternetBlocks(device) {
  const rows = await safeGet(makeClient(device), '/ip/firewall/filter');
  return rows.filter(row => String(row.comment || '').startsWith(INTERNET_BLOCK_COMMENT) && row['src-mac-address'])
    .map(row => ({
      id: row['.id'] || '',
      mac: String(row['src-mac-address'] || '').toUpperCase(),
      disabled: asBool(row.disabled),
      comment: row.comment || '',
      source: 'RouterOS firewall filter',
    }));
}

export async function blockMikroTikInternetByMac(device, macAddress) {
  const mac = normalizeMacAddress(macAddress);
  const client = makeClient(device);
  const existing = (await getMikroTikInternetBlocks(device)).find(row => row.mac === mac);
  if (existing) {
    if (existing.disabled && existing.id) await client.patch(`/ip/firewall/filter/${encodeURIComponent(existing.id)}`, { disabled: 'false' });
    return { ok: true, mac, existing: true };
  }
  const payload = {
    chain: 'forward',
    action: 'drop',
    'src-mac-address': mac,
    comment: `${INTERNET_BLOCK_COMMENT}${mac}`,
    disabled: 'false',
    'place-before': '0',
  };
  // Scope the rule to the conventional WAN interface list when it exists.
  // Custom RouterOS installations without a WAN list still get a working
  // forward-chain MAC rule instead of failing the operation outright.
  const interfaceLists = await safeGet(client, '/interface/list');
  if (interfaceLists.some(row => String(row.name || '').toUpperCase() === 'WAN')) payload['out-interface-list'] = 'WAN';
  const result = (await client.put('/ip/firewall/filter', payload)).data;
  return { ok: true, mac, result };
}

export async function unblockMikroTikInternetByMac(device, macAddress) {
  const mac = normalizeMacAddress(macAddress);
  const client = makeClient(device);
  const rows = (await getMikroTikInternetBlocks(device)).filter(row => row.mac === mac && row.id);
  for (const row of rows) await client.delete(`/ip/firewall/filter/${encodeURIComponent(row.id)}`);
  return { ok: true, mac, removed: rows.length };
}
