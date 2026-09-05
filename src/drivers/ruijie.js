import { spawn } from 'node:child_process';
import readline from 'node:readline';

let worker = null;
let sequence = 0;
const pending = new Map();
let lastWorkerStderr = '';

const cloudSnapshotCache = new Map();
const cloudBackoff = new Map();
const cloudInFlight = new Map();
const RUIJIE_CACHE_MS = Math.max(60_000, Number(process.env.RUIJIE_CLOUD_CACHE_MS || 120_000));
const RUIJIE_STALE_MS = Math.max(RUIJIE_CACHE_MS, Number(process.env.RUIJIE_CLOUD_STALE_MS || 30 * 60_000));
const RUIJIE_BACKOFF_MS = Math.max(60_000, Number(process.env.RUIJIE_RATE_LIMIT_BACKOFF_MS || 5 * 60_000));

function cloudKey(device) {
  const c = device.credentials || {};
  return `${String(c.ruijieAppId || '')}|${String(c.ruijieSerialNumber || '').toLowerCase()}|${String(c.ruijieBaseUrl || 'auto')}`;
}
function isRateLimitError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return m.includes('too many requests') || m.includes('api error 44') || m.includes('rate limit');
}
function decorateCachedSnapshot(entry, state = 'fresh', error = '') {
  const snap = structuredClone(entry.snap);
  snap.compat = { ...(snap.compat || {}), cache: state, cache_age_ms: Math.max(0, Date.now() - entry.ts) };
  if (error) snap.compat.cache_error = error;
  return snap;
}
async function getCloudSnapshot(device, action = 'collect') {
  const key = cloudKey(device);
  const now = Date.now();
  const entry = cloudSnapshotCache.get(key);
  const backoff = cloudBackoff.get(key);
  if (action === 'collect' && entry && now - entry.ts < RUIJIE_CACHE_MS) return decorateCachedSnapshot(entry, 'fresh');
  if (backoff && now < backoff.retryAt) {
    if (entry && now - entry.ts < RUIJIE_STALE_MS) return decorateCachedSnapshot(entry, 'stale-rate-limit', backoff.error);
    const wait = Math.ceil((backoff.retryAt - now) / 1000);
    throw new Error(`Ruijie Cloud is rate-limited. RouterDeck will retry in about ${wait}s instead of repeatedly calling the API.`);
  }
  try {
    if (action === 'collect' && cloudInFlight.has(key)) return await cloudInFlight.get(key);
    const fetchPromise = callWorker(device, action).finally(() => { if (action === 'collect') cloudInFlight.delete(key); });
    if (action === 'collect') cloudInFlight.set(key, fetchPromise);
    const snap = await fetchPromise;
    cloudSnapshotCache.set(key, { snap: structuredClone(snap), ts: Date.now() });
    cloudBackoff.delete(key);
    return snap;
  } catch (err) {
    if (isRateLimitError(err)) {
      const previous = cloudBackoff.get(key);
      const strikes = Math.min(6, Number(previous?.strikes || 0) + 1);
      const retryMs = Math.min(30 * 60_000, RUIJIE_BACKOFF_MS * Math.pow(2, strikes - 1));
      cloudBackoff.set(key, { retryAt: now + retryMs, strikes, error: String(err?.message || err) });
      if (entry && now - entry.ts < RUIJIE_STALE_MS) return decorateCachedSnapshot(entry, 'stale-rate-limit', String(err?.message || err));
      throw new Error(`Ruijie Cloud rate limit reached. RouterDeck paused Cloud polling for ${Math.ceil(retryMs / 60_000)} minute(s) to avoid API error 44.`);
    }
    if (entry && now - entry.ts < RUIJIE_STALE_MS) return decorateCachedSnapshot(entry, 'stale-error', String(err?.message || err));
    throw err;
  }
}

function workerPath() {
  return process.env.PYRUIJIE_PYTHON || '/opt/pyruijie/bin/python';
}

function startWorker() {
  if (worker && !worker.killed) return worker;
  worker = spawn(workerPath(), ['-u', new URL('./ruijie_worker.py', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: worker.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.ok) item.resolve(msg.result);
      else item.reject(new Error(msg.error || 'pyruijie request failed'));
    } catch {}
  });
  worker.stderr.on('data', chunk => { const text=String(chunk); lastWorkerStderr=(lastWorkerStderr+text).slice(-6000); console.error(`[pyruijie] ${text.trim()}`); });
  worker.on('exit', code => {
    const detail=lastWorkerStderr.trim().split(/\r?\n/).slice(-4).join(' | '); const err = new Error(`pyruijie worker exited (${code ?? 'unknown'})${detail ? `: ${detail}` : ''}`); lastWorkerStderr='';
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(err); }
    pending.clear(); worker = null;
  });
  return worker;
}

function cloudConfig(device) {
  const c = device.credentials || {};
  return {
    appId: c.ruijieAppId || '',
    appSecret: c.ruijieAppSecret || '',
    serialNumber: c.ruijieSerialNumber || '',
    baseUrl: c.ruijieBaseUrl || 'auto',
    apiToken: c.ruijieApiToken || process.env.RUIJIE_API_TOKEN || '',
  };
}

function callWorkerOnce(device, action = 'collect', timeout = 45000) {
  return new Promise((resolve, reject) => {
    const proc = startWorker();
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Ruijie Cloud request timed out')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, action, config: cloudConfig(device) })}\n`, err => { if(err){clearTimeout(timer);pending.delete(id);reject(err);} });
  });
}
async function callWorker(device, action = 'collect', timeout = 45000) {
  try { return await callWorkerOnce(device, action, timeout); }
  catch (err) {
    if (!String(err?.message || '').includes('worker exited')) throw err;
    worker = null;
    return callWorkerOnce(device, action, timeout);
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function switchPort(row = {}) {
  const up = row.is_up === true || String(row.status || '').toLowerCase() === 'up' || String(row.status) === '1';
  const disabled = ['0','false','disable','disabled','off'].includes(String(row.enable || '').toLowerCase());
  const allowed = Array.isArray(row.allowed_vlans) ? row.allowed_vlans.join(', ') : (row.allowed_vlans || row.vlan_list || '');
  return {
    name: row.name || '', label: row.name || '', type: row.port_type || 'ethernet', portKind: /sfp|fiber/i.test(row.port_type || row.name || '') ? 'sfp' : 'ethernet',
    physical: true, status: disabled ? 'disabled' : up ? 'ready' : 'not-plugged', speed: row.speed || '', mac: '', mtu: null,
    rxBytes: null, txBytes: null, duplex: '', linkDowns: null, role: row.role || (row.is_wan ? 'wan' : row.is_lan ? 'lan' : row.is_uplink ? 'uplink' : ''),
    vlan: row.vlan ?? null, vlanList: allowed, poeStatus: row.poe_status || '', powerUsed: row.power_used || '', loopState: row.loop_state || '',
  };
}

function clientRow(row = {}) {
  return {
    mac: row.mac || '', address: row.ip || '', hostname: row.user_name || row.hostname || '', interface: row.device_name || '',
    switchName: row.device_name || '', type: row.connect_type || 'wired', manufacturer: row.manufacturer || '', os: row.sta_os || '', active: true, state: 'online',
    rxBytes: num(row.flow_down, 0), txBytes: num(row.flow_up, 0), uptimeSec: num(row.online_time, 0),
  };
}

export async function collectRuijie(device) {
  const snap = await getCloudSnapshot(device, 'collect');
  const d = snap.device || {};
  const ports = (snap.ports || []).map(switchPort);
  const clients = (snap.clients || []).map(clientRow);
  return {
    platform: 'Ruijie/Reyee Cloud', hostname: d.name || device.name, version: d.firmware_version || '', uptimeSec: 0,
    cpu: null, load1: null, memoryTotal: null, memoryUsed: null, rxBytes: null, txBytes: null,
    clientsCount: clients.length, dhcpCount: 0, dhcpLeases: [], wifiClients: [], neighbors: clients,
    interfaces: ports,
    deviceInfo: {
      hostname: d.name || device.name, model: d.product_class || d.product_type || 'Ruijie/Reyee device', boardName: d.product_class || '',
      platform: 'Ruijie/Reyee Cloud', os: 'Ruijie/Reyee Cloud-managed device', version: d.firmware_version || '', revision: '', target: '', architecture: '', kernel: '', cpu: '', cpuCount: null,
      monitorInterface: '', serialNumber: d.serial_number || device.credentials?.ruijieSerialNumber || '', mac: d.mac || '', localIp: d.local_ip || device.host,
      egressIp: d.egress_ip || '', projectName: snap.project?.name || '', cloudStatus: d.is_online === true ? 'online' : d.online_status || '',
    },
    collector: { source: 'pyruijie', portSource: snap.compat?.port_source || snap.compat?.switch_ports || snap.compat?.gateway_ports || 'Ruijie Cloud ports', project: snap.project?.name || '', compat: snap.compat || {} },
  };
}

export async function testRuijie(device) {
  const started = performance.now();
  const result = await callWorker(device, 'test');
  return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, cloudStatus: result.device?.is_online === true ? 'online' : result.device?.online_status || '', model: result.device?.product_class || '', compat: result.compat || {} };
}
