import axios from 'axios';
import https from 'node:https';

const ticketCache = new Map();
const nodeHardwareCache = new Map();

function baseUrl(service) {
  const scheme = service.scheme || 'https';
  const port = Number(service.port || 8006);
  return `${scheme}://${service.host}:${port}/api2/json`;
}

function makeHttp(service) {
  return axios.create({
    baseURL: baseUrl(service),
    timeout: 12000,
    maxRedirects: 2,
    httpsAgent: new https.Agent({ rejectUnauthorized: !service.insecureTls }),
    validateStatus: status => status >= 200 && status < 300,
  });
}

function credentials(service) {
  const c = service.credentials || {};
  return {
    tokenId: String(c.apiTokenId || '').trim(),
    tokenSecret: String(c.apiTokenSecret || '').trim(),
    username: String(c.username || '').trim(),
    password: String(c.password || ''),
  };
}

function tokenHeader(service) {
  const c = credentials(service);
  if (!c.tokenId || !c.tokenSecret) return null;
  return `PVEAPIToken=${c.tokenId}=${c.tokenSecret}`;
}

function cacheKey(service) {
  const c = credentials(service);
  return `${service.id || service.host}|${c.username}`;
}

async function loginWithPassword(service, force = false) {
  const c = credentials(service);
  if (!c.username || !c.password) return null;
  const key = cacheKey(service);
  const cached = ticketCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const http = makeHttp(service);
  const form = new URLSearchParams({ username: c.username, password: c.password });
  const response = await http.post('/access/ticket', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const auth = response.data?.data || {};
  if (!auth.ticket) throw new Error('Proxmox authentication did not return a ticket');
  const session = { ticket: auth.ticket, csrf: auth.CSRFPreventionToken || '', expiresAt: Date.now() + 90 * 60_000 };
  ticketCache.set(key, session);
  return session;
}

async function authHeaders(service, method = 'GET', forceTicket = false) {
  const apiToken = tokenHeader(service);
  if (apiToken) return { Authorization: apiToken };
  const session = await loginWithPassword(service, forceTicket);
  if (!session) throw new Error('Configure a Proxmox API token or username/password');
  const headers = { Cookie: `PVEAuthCookie=${session.ticket}` };
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase()) && session.csrf) headers.CSRFPreventionToken = session.csrf;
  return headers;
}

async function pveRequest(service, method, url, options = {}) {
  const http = makeHttp(service);
  const run = async forceTicket => {
    const headers = { ...(await authHeaders(service, method, forceTicket)), ...(options.headers || {}) };
    const res = await http.request({ method, url, params: options.params, data: options.data, headers });
    return res.data?.data;
  };
  try { return await run(false); }
  catch (error) {
    const status = error?.response?.status;
    if ((status === 401 || status === 403) && !tokenHeader(service) && credentials(service).username) {
      ticketCache.delete(cacheKey(service));
      return run(true);
    }
    throw error;
  }
}

function n(v, fallback = 0) { const value = Number(v); return Number.isFinite(value) ? value : fallback; }

function aggregateNodes(nodes = []) {
  const online = nodes.filter(x => x.status === 'online');
  const totalCpu = online.reduce((sum, x) => sum + Math.max(1, n(x.maxcpu, 1)), 0);
  const cpu = totalCpu ? online.reduce((sum, x) => sum + n(x.cpu, 0) * Math.max(1, n(x.maxcpu, 1)), 0) / totalCpu * 100 : null;
  const memoryTotal = online.reduce((sum, x) => sum + n(x.maxmem, 0), 0);
  const memoryUsed = online.reduce((sum, x) => sum + n(x.mem, 0), 0);
  return { online, cpu, memoryTotal, memoryUsed };
}

function normalizeGuest(row = {}) {
  const type = row.type === 'lxc' ? 'lxc' : 'qemu';
  return {
    id: `${type}:${row.node}:${row.vmid}`, type, node: row.node || '', vmid: n(row.vmid, 0),
    name: row.name || `${type === 'lxc' ? 'CT' : 'VM'} ${row.vmid}`, status: row.status || 'unknown',
    cpu: row.cpu == null ? null : n(row.cpu) * 100, maxCpu: n(row.maxcpu, 0), memoryUsed: n(row.mem, 0), memoryTotal: n(row.maxmem, 0),
    diskUsed: n(row.disk, 0), diskTotal: n(row.maxdisk, 0), uptimeSec: n(row.uptime, 0), template: Boolean(Number(row.template || 0)), lock: row.lock || '',
  };
}

function normalizePci(row = {}) {
  return {
    id: row.id || row.path || '',
    class: row.class || '',
    vendor: row.vendor_name || row.vendor || '',
    device: row.device_name || row.device || '',
    subsystemVendor: row.subsystem_vendor_name || '',
    subsystemDevice: row.subsystem_device_name || '',
    iommuGroup: row.iommugroup ?? row.iommu_group ?? null,
    mdev: Boolean(row.mdev),
  };
}

function normalizeNodeStatus(node, basic = {}, status = {}, pci = []) {
  const cpuinfo = status.cpuinfo || {};
  const memory = status.memory || {};
  const swap = status.swap || {};
  const rootfs = status.rootfs || {};
  return {
    node,
    status: basic.status || 'unknown',
    cpu: basic.cpu == null ? null : n(basic.cpu) * 100,
    maxCpu: n(basic.maxcpu),
    memoryUsed: n(basic.mem || memory.used), memoryTotal: n(basic.maxmem || memory.total),
    diskUsed: n(basic.disk || rootfs.used), diskTotal: n(basic.maxdisk || rootfs.total), uptimeSec: n(basic.uptime || status.uptime),
    sslFingerprint: basic.ssl_fingerprint || '',
    kernel: status.kversion || status.kernelversion || '', pveVersion: status.pveversion || '',
    cpuModel: cpuinfo.model || cpuinfo.model_name || '', cpuSockets: n(cpuinfo.sockets, 0), cpuCores: n(cpuinfo.cores, 0), cpuThreads: n(cpuinfo.cpus, basic.maxcpu || 0), cpuMhz: n(cpuinfo.mhz, 0),
    memory: { used: n(memory.used || basic.mem), total: n(memory.total || basic.maxmem), free: n(memory.free, 0) },
    swap: { used: n(swap.used), total: n(swap.total), free: n(swap.free) },
    rootfs: { used: n(rootfs.used || basic.disk), total: n(rootfs.total || basic.maxdisk), free: n(rootfs.free) },
    loadAvg: Array.isArray(status.loadavg) ? status.loadavg : [], bootMode: status['boot-info']?.mode || status.boot_mode || '',
    pcie: (Array.isArray(pci) ? pci : []).map(normalizePci).filter(x => x.id || x.vendor || x.device).slice(0, 128),
  };
}

async function nodeHardware(service, basic) {
  const node = basic.node || '';
  const key = `${service.id || service.host}:${node}`;
  const cached = nodeHardwareCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return normalizeNodeStatus(node, basic, cached.status, cached.pci);
  const [status, pci] = await Promise.all([
    pveRequest(service, 'GET', `/nodes/${encodeURIComponent(node)}/status`).catch(() => ({})),
    pveRequest(service, 'GET', `/nodes/${encodeURIComponent(node)}/hardware/pci`, { params: { 'pci-class-blacklist': '' } }).catch(() => []),
  ]);
  nodeHardwareCache.set(key, { status: status || {}, pci: Array.isArray(pci) ? pci : [], expiresAt: Date.now() + 5 * 60_000 });
  return normalizeNodeStatus(node, basic, status || {}, pci || []);
}

export async function collectProxmox(service) {
  const [version, nodes, guests, clusterStatus] = await Promise.all([
    pveRequest(service, 'GET', '/version'),
    pveRequest(service, 'GET', '/nodes'),
    pveRequest(service, 'GET', '/cluster/resources', { params: { type: 'vm' } }).catch(() => []),
    pveRequest(service, 'GET', '/cluster/status').catch(() => []),
  ]);
  const nodeRows = Array.isArray(nodes) ? nodes : [];
  const detailedNodes = await Promise.all(nodeRows.map(row => nodeHardware(service, row)));
  const guestRows = (Array.isArray(guests) ? guests : []).filter(x => x.type === 'qemu' || x.type === 'lxc').map(normalizeGuest);
  const agg = aggregateNodes(nodeRows);
  const cluster = (Array.isArray(clusterStatus) ? clusterStatus : []).find(x => x.type === 'cluster');
  const qemuCount = guestRows.filter(x => x.type === 'qemu').length;
  const lxcCount = guestRows.filter(x => x.type === 'lxc').length;
  const runningCount = guestRows.filter(x => x.status === 'running').length;
  return {
    serviceType: 'proxmox', status: 1, running: true, version: version?.version || version?.release || '', release: version?.release || '', repositoryId: version?.repoid || '',
    clusterName: cluster?.name || '', nodeCount: nodeRows.length, onlineNodeCount: agg.online.length, vmCount: qemuCount, lxcCount, guestCount: guestRows.length, runningCount,
    cpu: agg.cpu, memoryUsed: agg.memoryUsed, memoryTotal: agg.memoryTotal, nodes: detailedNodes,
  };
}

export async function testProxmox(service) {
  const started = performance.now();
  const version = await pveRequest(service, 'GET', '/version');
  return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, version: version?.version || version?.release || '' };
}

export async function getProxmoxGuests(service) {
  const rows = await pveRequest(service, 'GET', '/cluster/resources', { params: { type: 'vm' } });
  return (Array.isArray(rows) ? rows : []).filter(x => x.type === 'qemu' || x.type === 'lxc').map(normalizeGuest).sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid);
}

export async function getProxmoxNodes(service) {
  const rows = await pveRequest(service, 'GET', '/nodes');
  return Promise.all((Array.isArray(rows) ? rows : []).map(row => nodeHardware(service, row)));
}

export async function controlProxmoxGuest(service, input = {}) {
  const type = input.type === 'lxc' ? 'lxc' : input.type === 'qemu' ? 'qemu' : null;
  const action = String(input.action || '').toLowerCase(); const node = String(input.node || '').trim(); const vmid = Number(input.vmid);
  if (!type || !node || !Number.isInteger(vmid) || vmid <= 0) throw new Error('Valid node, guest type, and VMID are required');
  if (!['start', 'shutdown', 'stop', 'reboot', 'reset'].includes(action)) throw new Error('Unsupported Proxmox guest action');
  const result = await pveRequest(service, 'POST', `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`, { data: {} });
  return { ok: true, action, type, node, vmid, task: result || null };
}
