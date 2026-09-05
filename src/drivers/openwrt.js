import { sshExec, sshExecMany } from '../etc/ssh.js';

const cpuSamples = new Map();

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJson(text = '') {
  try { return JSON.parse(String(text).trim()); }
  catch { return {}; }
}

function cpuPercent(deviceId, counters) {
  if (!counters) return null;

  // Linux /proc/stat already includes guest time inside user/nice, so only use
  // user..steal (first 8 counters). Including guest/guest_nice would double-count
  // CPU time and can inflate utilization on some OpenWrt targets.
  const samples = String(counters).trim().split('\n').map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'cpu') return null;
    const values = parts.slice(1, 9).map(Number);
    if (values.length < 4 || values.some(Number.isNaN)) return null;
    const idle = (values[3] || 0) + (values[4] || 0);
    return { idle, total: values.reduce((a, b) => a + b, 0) };
  }).filter(Boolean);
  if (!samples.length) return null;

  const now = Date.now();
  const current = { ...samples.at(-1), at: now };
  const prev = cpuSamples.get(deviceId);
  if (!prev) {
    cpuSamples.set(deviceId, current);
    return null;
  }

  // Fast repeated /live requests can land inside one scheduler-tick window on
  // small routers. Keep the previous baseline rather than turning a tiny delta
  // with zero idle ticks into a false 100% reading.
  if (now - prev.at < 1000) return prev.percent ?? null;

  const dt = current.total - prev.total;
  const di = current.idle - prev.idle;
  if (dt <= 0 || di < 0) {
    cpuSamples.set(deviceId, current);
    return null;
  }

  const raw = Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
  // Light smoothing removes single-poll scheduler spikes without making the CPU
  // card sluggish. The raw counter delta remains the source of truth.
  const percent = prev.percent == null ? raw : (raw * 0.72) + (prev.percent * 0.28);
  cpuSamples.set(deviceId, { ...current, percent });
  return percent;
}

function parseNetdev(text = '') {
  return text.split('\n').slice(2).map(line => {
    const [name, rest] = line.split(':');
    if (!rest) return null;
    const v = rest.trim().split(/\s+/).map(Number);
    if (!name || v.length < 9) return null;
    return { name: name.trim(), rx: asNumber(v[0]), tx: asNumber(v[8]) };
  }).filter(Boolean);
}


function discoverLuCiPorts(luciRaw = '', boardRaw = '') {
  const luci = parseJson(luciRaw);
  const board = parseJson(boardRaw);
  const rows = [];
  const seen = new Set();
  const add = (device, role = '', label = '') => {
    const name = String(device || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    rows.push({ name, role: String(role || ''), label: String(label || name) });
  };

  const builtin = Array.isArray(luci.result) ? luci.result : Array.isArray(luci) ? luci : [];
  for (const port of builtin) add(port?.device, port?.role, port?.label);

  // Match LuCI's fallback: board.network.lan/wan ports or single device.
  if (!rows.length && board?.network) {
    for (const role of ['lan', 'wan']) {
      const entry = board.network[role];
      if (!entry) continue;
      if (Array.isArray(entry.ports)) entry.ports.forEach(name => add(name, role));
      else if (typeof entry.device === 'string') add(entry.device, role);
    }
  }
  return rows;
}

function parseInterfaces(text = '', luciRaw = '', boardRaw = '') {
  const known = discoverLuCiPorts(luciRaw, boardRaw);
  const knownMap = new Map(known.map((p, i) => [p.name, { ...p, order: i }]));
  const useKnown = knownMap.size > 0;

  return String(text).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name = '', operstate = '', carrierRaw = '', flagsRaw = '', mac = '', mtuRaw = '', speedRaw = '', physicalRaw = '0', duplex = '', rxRaw = '', txRaw = ''] = line.split('|');
    const flags = Number.parseInt(String(flagsRaw).replace(/^0x/i, ''), 16);
    const adminUp = Number.isFinite(flags) ? Boolean(flags & 0x1) : operstate !== 'down';
    const carrier = carrierRaw === '1' ? true : carrierRaw === '0' ? false : null;
    const knownPort = knownMap.get(name);
    const physicalFallback = physicalRaw === '1' || /^(lan\d*|wan\d*|eth\d+|sfp|qsfp|combo)/i.test(name);
    const wireless = /^(wlan|phy|wifi)/i.test(name);
    const physical = useKnown ? Boolean(knownPort) : physicalFallback;
    let status = 'inactive';
    if (!adminUp) status = 'disabled';
    else if (carrier === true || operstate === 'up') status = 'ready';
    else if (physical && !wireless && carrier === false) status = 'not-plugged';
    return {
      id: name,
      name,
      label: knownPort?.label || name,
      role: knownPort?.role || '',
      order: knownPort?.order ?? 9999,
      type: wireless ? 'wifi' : physical ? 'ethernet' : 'virtual',
      physical: physical && !wireless,
      portKind: /^(sfp|qsfp|combo)/i.test(name) ? 'sfp' : 'ethernet',
      status,
      running: status === 'ready',
      disabled: status === 'disabled',
      carrier,
      operstate,
      mac,
      mtu: asNumber(mtuRaw),
      speedMbps: speedRaw && speedRaw !== '-1' ? asNumber(speedRaw) : null,
      speed: speedRaw && speedRaw !== '-1' ? `${speedRaw} Mbps${duplex ? ` ${duplex}` : ''}` : '',
      duplex: duplex || '',
      rxBytes: asNumber(rxRaw),
      txBytes: asNumber(txRaw),
    };
  }).filter(x => x.name && x.name !== 'lo');
}

function netdevBytes(text, requestedIface) {
  const rows = parseNetdev(text);
  if (!rows.length) return { rxBytes: null, txBytes: null, selectedInterface: '' };

  const exact = requestedIface ? rows.find(r => r.name === requestedIface) : null;
  if (exact) return { rxBytes: exact.rx, txBytes: exact.tx, selectedInterface: exact.name };

  // br-lan is normally the most useful automatic counter on an OpenWrt AP/router
  // and avoids double-counting bridge + physical interfaces.
  const preferredNames = ['br-lan', 'pppoe-wan', 'wan', 'eth0'];
  const automatic = preferredNames.map(n => rows.find(r => r.name === n)).find(Boolean);
  if (automatic) return { rxBytes: automatic.rx, txBytes: automatic.tx, selectedInterface: automatic.name };

  const usable = rows.filter(r => r.name !== 'lo');
  return {
    rxBytes: usable.reduce((s, r) => s + (r.rx || 0), 0),
    txBytes: usable.reduce((s, r) => s + (r.tx || 0), 0),
    selectedInterface: usable.length === 1 ? usable[0].name : 'aggregate',
  };
}

function parseDhcpLeases(text = '') {
  const now = Math.floor(Date.now() / 1000);
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    // dnsmasq lease format: expiry mac ip hostname client-id
    const fields = line.split(/\s+/);
    const expiry = Number(fields.shift() || 0);
    const mac = (fields.shift() || '').toLowerCase();
    const address = fields.shift() || '';
    const hostnameRaw = fields.shift() || '';
    const clientId = fields.join(' ');
    const active = expiry === 0 || expiry > now;
    return {
      address,
      mac,
      hostname: hostnameRaw === '*' ? '' : hostnameRaw,
      clientId: clientId === '*' ? '' : clientId,
      status: active ? 'bound' : 'expired',
      expiresAt: expiry || null,
      expiresInSec: expiry > 0 ? Math.max(0, expiry - now) : null,
      dynamic: true,
      active,
      source: 'dnsmasq',
    };
  }).filter(l => l.address || l.mac);
}

function parseNeighbors(text = '') {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    const devIndex = parts.indexOf('dev');
    const macIndex = parts.indexOf('lladdr');
    const state = parts.at(-1) || '';
    return {
      address: parts[0] || '',
      interface: devIndex >= 0 ? parts[devIndex + 1] || '' : '',
      mac: macIndex >= 0 ? String(parts[macIndex + 1] || '').toLowerCase() : '',
      state,
      active: !['FAILED', 'INCOMPLETE'].includes(state),
    };
  }).filter(n => n.address && n.mac);
}

function firstCpuName(cpuinfo = '') {
  const preferred = ['model name', 'cpu model', 'system type', 'machine', 'hardware'];
  for (const key of preferred) {
    const match = cpuinfo.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im'));
    if (match) return match[1].trim();
  }
  return '';
}

function cpuCount(cpuinfo = '') {
  const matches = cpuinfo.match(/^processor\s*:/gim);
  return matches?.length || null;
}

function parseMeminfo(text = '') {
  const values = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB/i);
    if (m) values[m[1]] = Number(m[2]) * 1024;
  }
  const total = values.MemTotal || null;
  const available = values.MemAvailable ?? null;
  return {
    total,
    used: total != null && available != null ? Math.max(0, total - available) : null,
  };
}

function parseReleaseFile(text = '') {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function parseWifiBundle(raw = '', dhcpLeases = [], neighbors = []) {
  const blocks = [];
  let current = null;
  let mode = '';

  for (const rawLine of String(raw).split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('__RD_BSS__')) {
      current = { object: line.slice('__RD_BSS__'.length).trim(), status: [], clients: [] };
      blocks.push(current);
      mode = 'status';
      continue;
    }
    if (line === '__RD_CLIENTS__') { mode = 'clients'; continue; }
    if (line === '__RD_END__') { current = null; mode = ''; continue; }
    if (!current) continue;
    if (mode === 'status') current.status.push(rawLine);
    else if (mode === 'clients') current.clients.push(rawLine);
  }

  const leaseByMac = new Map(dhcpLeases.map(l => [String(l.mac).toLowerCase(), l]));
  const neighByMac = new Map(neighbors.map(n => [String(n.mac).toLowerCase(), n]));
  const stations = [];

  for (const block of blocks) {
    const status = parseJson(block.status.join('\n'));
    const clientData = parseJson(block.clients.join('\n'));
    const iface = String(block.object || '').replace(/^hostapd\./, '');
    for (const [macRaw, c] of Object.entries(clientData.clients || {})) {
      const mac = String(macRaw).toLowerCase();
      const lease = leaseByMac.get(mac) || {};
      const neigh = neighByMac.get(mac) || {};
      stations.push({
        mac,
        address: lease.address || neigh.address || '',
        hostname: lease.hostname || '',
        interface: iface,
        ssid: status.ssid || '',
        frequency: asNumber(status.freq ?? clientData.freq),
        signal: asNumber(c.signal),
        rxRateKbps: asNumber(c.rate?.rx),
        txRateKbps: asNumber(c.rate?.tx),
        rxBytes: asNumber(c.bytes?.rx),
        txBytes: asNumber(c.bytes?.tx),
        authorized: Boolean(c.authorized),
        associated: c.assoc !== false,
      });
    }
  }
  return stations;
}

function memoryFromSystem(system = {}) {
  const total = asNumber(system?.memory?.total);
  const free = asNumber(system?.memory?.free);
  const buffered = asNumber(system?.memory?.buffered) || 0;
  const cached = asNumber(system?.memory?.cached) || 0;
  return {
    total,
    used: total != null && free != null ? Math.max(0, total - free - buffered - cached) : null,
  };
}

function normalize(device, data) {
  const system = data.system;
  const board = data.board;
  const release = board?.release || {};
  const releaseFile = data.releaseFile;
  const memProc = parseMeminfo(data.meminfo);
  const memUbus = memoryFromSystem(system);
  const bytes = netdevBytes(data.netdev, device.monitorInterface);
  const dhcpLeases = parseDhcpLeases(data.leases);
  const neighbors = parseNeighbors(data.neighbors);
  const interfaces = parseInterfaces(data.interfaces, data.luciPorts, data.boardLayout);
  const wifiClients = parseWifiBundle(data.wifi, dhcpLeases, neighbors);
  const activeDhcp = dhcpLeases.filter(l => l.active);

  const fallbackUptime = asNumber(String(data.uptime).trim().split(/\s+/)[0]);
  const fallbackLoad = asNumber(String(data.loadavg).trim().split(/\s+/)[0]);
  const load1 = Array.isArray(system.load)
    ? asNumber(system.load[0]) != null ? Number(system.load[0]) / 65535 : null
    : fallbackLoad;

  const deviceInfo = {
    hostname: board.hostname || system.hostname || device.name,
    model: board.model || String(data.model).trim(),
    boardName: board.board_name || String(data.boardName).trim(),
    platform: 'OpenWrt',
    os: release.description || release.distribution || releaseFile.DISTRIB_DESCRIPTION || releaseFile.DISTRIB_ID || 'OpenWrt',
    version: release.version || releaseFile.DISTRIB_RELEASE || '',
    revision: release.revision || releaseFile.DISTRIB_REVISION || '',
    target: release.target || releaseFile.DISTRIB_TARGET || '',
    architecture: String(data.arch).trim(),
    kernel: board.kernel || String(data.kernel).trim(),
    cpu: firstCpuName(data.cpuinfo) || board.system || '',
    cpuCount: cpuCount(data.cpuinfo),
    monitorInterface: device.monitorInterface || bytes.selectedInterface || '',
  };

  const clientKeys = new Set();
  for (const c of wifiClients) clientKeys.add(c.mac || c.address);
  for (const l of activeDhcp) clientKeys.add(l.mac || l.address);
  if (!clientKeys.size) for (const n of neighbors.filter(n => n.active)) clientKeys.add(n.mac || n.address);
  const clientsCount = [...clientKeys].filter(Boolean).length;

  return {
    platform: 'OpenWrt',
    hostname: deviceInfo.hostname,
    version: deviceInfo.version,
    uptimeSec: asNumber(system.uptime) ?? fallbackUptime ?? 0,
    cpu: cpuPercent(device.id, data.cpu),
    load1,
    memoryTotal: memProc.total ?? memUbus.total,
    memoryUsed: memProc.used ?? memUbus.used,
    rxBytes: bytes.rxBytes,
    txBytes: bytes.txBytes,
    selectedInterface: bytes.selectedInterface,
    clientsCount,
    wifiCount: wifiClients.length,
    wifiClients,
    dhcpCount: activeDhcp.length,
    dhcpLeases,
    neighbors,
    interfaces,
    deviceInfo,
    collector: {
      ubusSystem: Object.keys(system).length > 0,
      ubusBoard: Object.keys(board).length > 0,
      dhcpLeaseFile: dhcpLeases.length > 0,
      wifiBssCount: new Set(wifiClients.map(c => c.interface)).size,
      portSource: discoverLuCiPorts(data.luciPorts, data.boardLayout).length ? (parseJson(data.luciPorts).result?.length ? 'luci.getBuiltinEthernetPorts' : '/etc/board.json') : 'sysfs-fallback',
    },
  };
}

export async function collectOpenWrt(device) {
  // Do not depend on base64/coreutils being installed. Every command below is
  // available on a normal OpenWrt image; ubus calls have file/proc fallbacks.
  const commands = [
    "ubus call system info 2>/dev/null || printf '{}'",
    "ubus call system board 2>/dev/null || printf '{}'",
    'cat /proc/net/dev 2>/dev/null || true',
    "head -n 1 /proc/stat 2>/dev/null || true",
    'cat /proc/cpuinfo 2>/dev/null || true',
    'uname -m 2>/dev/null || true',
    'cat /tmp/dhcp.leases 2>/dev/null || true',
    'ip neigh show 2>/dev/null || true',
    'cat /proc/meminfo 2>/dev/null || true',
    'cat /proc/uptime 2>/dev/null || true',
    'cat /proc/loadavg 2>/dev/null || true',
    'cat /etc/openwrt_release 2>/dev/null || true',
    'cat /tmp/sysinfo/model 2>/dev/null || true',
    'cat /tmp/sysinfo/board_name 2>/dev/null || true',
    'uname -r 2>/dev/null || true',
    `for p in /sys/class/net/*; do
  [ -e "$p" ] || continue
  n=$(basename "$p")
  [ "$n" = "lo" ] && continue
  oper=$(cat "$p/operstate" 2>/dev/null || printf unknown)
  carrier=$(cat "$p/carrier" 2>/dev/null || true)
  flags=$(cat "$p/flags" 2>/dev/null || printf 0x0)
  mac=$(cat "$p/address" 2>/dev/null || true)
  mtu=$(cat "$p/mtu" 2>/dev/null || true)
  speed=$(cat "$p/speed" 2>/dev/null || true)
  duplex=$(cat "$p/duplex" 2>/dev/null || true)
  rx=$(cat "$p/statistics/rx_bytes" 2>/dev/null || true)
  tx=$(cat "$p/statistics/tx_bytes" 2>/dev/null || true)
  [ -e "$p/device" ] && physical=1 || physical=0
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$n" "$oper" "$carrier" "$flags" "$mac" "$mtu" "$speed" "$physical" "$duplex" "$rx" "$tx"
done`,
    "ubus call luci getBuiltinEthernetPorts 2>/dev/null || printf '{}'",
    "cat /etc/board.json 2>/dev/null || printf '{}'",
    String.raw`for obj in $(ubus list 'hostapd.*'  2>/dev/null); do
  printf '__RD_BSS__%s\n' "$obj"
  ubus call "$obj" get_status 2>/dev/null || printf '{}\n'
  printf '__RD_CLIENTS__\n'
  ubus call "$obj" get_clients 2>/dev/null || printf '{}\n'
  printf '__RD_END__\n'
done`,
  ];

  const [systemRaw, boardRaw, netdev, cpu, cpuinfo, arch, leases, neighbors,
    meminfo, uptime, loadavg, releaseRaw, model, boardName, kernel, interfaces, luciPorts, boardLayout, wifi] = await sshExecMany(device, commands);

  return normalize(device, {
    system: parseJson(systemRaw),
    board: parseJson(boardRaw),
    netdev,
    cpu,
    cpuinfo,
    arch,
    leases,
    neighbors,
    meminfo,
    uptime,
    loadavg,
    releaseFile: parseReleaseFile(releaseRaw),
    model,
    boardName,
    kernel,
    interfaces,
    luciPorts,
    boardLayout,
    wifi,
  });
}

export async function testOpenWrt(device) {
  const [boardRaw, infoRaw] = await sshExecMany(device, [
    "ubus call system board 2>/dev/null || printf '{}'",
    "ubus call system info 2>/dev/null || printf '{}'",
  ]);
  const board = parseJson(boardRaw);
  const info = parseJson(infoRaw);
  if (!Object.keys(board).length && !Object.keys(info).length) {
    // A final very small command gives a useful error if SSH works but ubus is broken.
    const hostname = (await sshExec(device, 'cat /proc/sys/kernel/hostname 2>/dev/null || hostname')).trim();
    return { ok: true, transport: 'SSH', warning: 'ubus returned no data', hostname };
  }
  return { ok: true, transport: 'SSH/ubus', board, info };
}


export async function getOpenWrtLogs(device, limit = 250) {
  const safeLimit = Math.min(1000, Math.max(20, Number(limit) || 250));
  const raw = await sshExec(device, `logread 2>/dev/null | tail -n ${safeLimit}`);
  return String(raw || '').split('\n').filter(Boolean).map((message, index) => ({
    id: `openwrt-${index}`,
    time: '',
    topics: 'system',
    message,
  }));
}


function unquoteUci(value = '') {
  let v = String(value).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return v.replace(/'\\''/g, "'");
}

function parseUciWireless(text = '') {
  const sections = new Map();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('wireless.') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const lhs = line.slice('wireless.'.length, eq);
    const value = unquoteUci(line.slice(eq + 1));
    const dot = lhs.indexOf('.');
    const section = dot < 0 ? lhs : lhs.slice(0, dot);
    const option = dot < 0 ? '__type' : lhs.slice(dot + 1);
    if (!sections.has(section)) sections.set(section, { section });
    sections.get(section)[option] = value;
  }
  return sections;
}

function normalizeOpenWrtWireless(status = {}, uciText = '') {
  const uci = parseUciWireless(uciText);
  const out = [];
  const seen = new Set();
  for (const [radioName, radio] of Object.entries(status || {})) {
    for (const iface of radio?.interfaces || []) {
      const config = iface?.config || {};
      const section = iface.section || config.section || iface.ifname || '';
      if (!section) continue;
      const u = uci.get(section) || {};
      seen.add(section);
      const disabled = String(u.disabled ?? config.disabled ?? '0') === '1' || radio.disabled === true;
      out.push({
        id: section,
        section,
        radio: radioName,
        ifname: iface.ifname || '',
        ssid: config.ssid || u.ssid || '',
        mode: config.mode || u.mode || '',
        network: Array.isArray(config.network) ? config.network.join(' ') : (config.network || u.network || ''),
        encryption: config.encryption || u.encryption || '',
        hidden: String(u.hidden ?? config.hidden ?? '0') === '1',
        isolate: String(u.isolate ?? config.isolate ?? '0') === '1',
        disabled,
        running: Boolean(radio.up) && !disabled,
        status: disabled ? 'disabled' : radio.up ? 'ready' : 'inactive',
        channel: radio?.config?.channel ?? uci.get(radioName)?.channel ?? '',
        band: radio?.config?.band ?? uci.get(radioName)?.band ?? '',
        htmode: radio?.config?.htmode ?? uci.get(radioName)?.htmode ?? '',
        country: radio?.config?.country ?? uci.get(radioName)?.country ?? '',
      });
    }
  }
  for (const [section, u] of uci) {
    if (u.__type !== 'wifi-iface' || seen.has(section)) continue;
    const radio = u.device || '';
    const radioCfg = uci.get(radio) || {};
    const disabled = String(u.disabled || '0') === '1' || String(radioCfg.disabled || '0') === '1';
    out.push({
      id: section, section, radio, ifname: '', ssid: u.ssid || '', mode: u.mode || '', network: u.network || '',
      encryption: u.encryption || '', hidden: String(u.hidden || '0') === '1', isolate: String(u.isolate || '0') === '1',
      disabled, running: false, status: disabled ? 'disabled' : 'inactive', channel: radioCfg.channel || '', band: radioCfg.band || '',
      htmode: radioCfg.htmode || '', country: radioCfg.country || '',
    });
  }
  return out;
}

function validUciSection(value) {
  return /^(?:[A-Za-z0-9_][A-Za-z0-9_-]*|@wifi-iface\[\d+\])$/.test(String(value || ''));
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export async function getOpenWrtWireless(device) {
  const [statusRaw, uciRaw] = await sshExecMany(device, [
    "ubus call network.wireless status 2>/dev/null || printf '{}'",
    'uci -q show wireless 2>/dev/null || true',
  ]);
  return { source: 'uci', interfaces: normalizeOpenWrtWireless(parseJson(statusRaw), uciRaw) };
}

export async function updateOpenWrtWireless(device, section, input = {}) {
  if (!validUciSection(section)) throw new Error('Invalid wireless section');
  const radio = String(input.radio || '');
  if (radio && !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(radio)) throw new Error('Invalid radio section');
  const commands = [];
  if ('ssid' in input) {
    const ssid = String(input.ssid || '').trim();
    if (!ssid || ssid.length > 32) throw new Error('SSID must be 1-32 characters');
    commands.push(`uci set wireless.${section}.ssid=${shQuote(ssid)}`);
  }
  if ('disabled' in input) commands.push(`uci set wireless.${section}.disabled=${input.disabled ? '1' : '0'}`);
  if ('hidden' in input) commands.push(`uci set wireless.${section}.hidden=${input.hidden ? '1' : '0'}`);
  if ('isolate' in input) commands.push(`uci set wireless.${section}.isolate=${input.isolate ? '1' : '0'}`);
  if (input.encryption !== undefined && input.encryption !== '') {
    const encryption = String(input.encryption);
    if (!/^[A-Za-z0-9+_-]+$/.test(encryption)) throw new Error('Invalid encryption value');
    commands.push(`uci set wireless.${section}.encryption=${shQuote(encryption)}`);
    if (encryption === 'none') commands.push(`uci -q delete wireless.${section}.key || true`);
  }
  if (input.passphrase) {
    const passphrase = String(input.passphrase);
    if (passphrase.length < 8 || passphrase.length > 63) throw new Error('Wi-Fi passphrase must be 8-63 characters');
    commands.push(`uci set wireless.${section}.key=${shQuote(passphrase)}`);
  }
  if (radio && input.channel !== undefined && String(input.channel).trim()) {
    const channel = String(input.channel).trim();
    if (!/^(?:auto|\d{1,4})$/.test(channel)) throw new Error('Channel must be auto or a channel number');
    commands.push(`uci set wireless.${radio}.channel=${shQuote(channel)}`);
  }
  if (!commands.length) throw new Error('No wireless fields to update');
  commands.push('uci commit wireless');
  await sshExec(device, `${commands.join(' && ')}; (sleep 1; wifi reload >/dev/null 2>&1 </dev/null) &`, 20000);
  return { ok: true };
}

function normalizeMacAddress(value = '') {
  const raw = String(value || '').trim().replace(/-/g, ':').toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(raw)) throw new Error('Invalid MAC address');
  return raw;
}

function blockSectionForMac(mac) {
  return `routerdeck_block_${mac.replace(/:/g, '').toLowerCase()}`;
}

export async function getOpenWrtInternetBlocks(device) {
  const raw = await sshExec(device, `for s in $(uci -q show firewall | sed -n 's/^firewall\\.\\(routerdeck_block_[A-Za-z0-9_]*\\)=rule$/\\1/p'); do mac=$(uci -q get firewall.$s.src_mac | head -n1); enabled=$(uci -q get firewall.$s.enabled || printf 1); name=$(uci -q get firewall.$s.name); printf '%s|%s|%s|%s\\n' "$s" "$mac" "$enabled" "$name"; done`, 12000);
  return String(raw).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [id = '', mac = '', enabled = '1', comment = ''] = line.split('|');
    return { id, mac: String(mac).toUpperCase(), disabled: String(enabled) === '0', comment, source: 'OpenWrt firewall rule' };
  }).filter(row => row.mac);
}

export async function blockOpenWrtInternetByMac(device, macAddress) {
  const mac = normalizeMacAddress(macAddress);
  const section = blockSectionForMac(mac);
  const command = [
    `uci -q delete firewall.${section} || true`,
    `uci set firewall.${section}=rule`,
    `uci set firewall.${section}.name=${shQuote(`RouterDeck Block Internet ${mac}`)}`,
    `uci set firewall.${section}.src='lan'`,
    `uci set firewall.${section}.dest='wan'`,
    `uci set firewall.${section}.src_mac=${shQuote(mac)}`,
    `uci set firewall.${section}.target='REJECT'`,
    `uci set firewall.${section}.enabled='1'`,
    `uci reorder firewall.${section}=0`,
    'uci commit firewall',
    '/etc/init.d/firewall reload',
  ].join(' && ');
  await sshExec(device, command, 20000);
  return { ok: true, mac, section };
}

export async function unblockOpenWrtInternetByMac(device, macAddress) {
  const mac = normalizeMacAddress(macAddress);
  const section = blockSectionForMac(mac);
  await sshExec(device, `uci -q delete firewall.${section} || true; uci commit firewall; /etc/init.d/firewall reload`, 20000);
  return { ok: true, mac, section };
}
