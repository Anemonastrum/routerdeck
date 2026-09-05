import axios from 'axios';
import https from 'node:https';

const tokenCache = new Map();

function baseUrl(service) {
  const scheme = service.scheme || 'http';
  const port = Number(service.port || 81);
  return `${scheme}://${service.host}:${port}/api`;
}

function http(service) {
  return axios.create({
    baseURL: baseUrl(service),
    timeout: 12000,
    maxRedirects: 2,
    httpsAgent: new https.Agent({ rejectUnauthorized: !service.insecureTls }),
    headers: { Accept: 'application/json' },
  });
}

function credentials(service) {
  const c = service.credentials || {};
  return {
    identity: String(c.npmIdentity || c.identity || '').trim(),
    password: String(c.npmPassword || c.password || ''),
    token: String(c.npmToken || c.token || '').trim(),
  };
}

function cacheKey(service) {
  const c = credentials(service);
  return `${service.id || service.host}|${c.identity}`;
}

function parseExpiry(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : Date.now() + 12 * 60 * 60_000;
}

async function login(service, force = false) {
  const c = credentials(service);
  if (c.token) return { token: c.token, expiresAt: Number.MAX_SAFE_INTEGER };
  if (!c.identity || !c.password) throw new Error('Nginx Proxy Manager email/username and password are required');
  const key = cacheKey(service);
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached;
  // Current Nginx Proxy Manager schemas reject `expiry` in the POST body
  // (`additionalProperties: false`). A normal login needs only identity + secret;
  // the returned token already includes its expiry timestamp. Older NPM releases
  // also accept this minimal payload, so keep the authentication request portable.
  const response = await http(service).post('/tokens', {
    identity: c.identity,
    secret: c.password,
  }, { headers: { 'Content-Type': 'application/json' } });
  const token = String(response.data?.token || '').trim();
  if (!token) throw new Error('Nginx Proxy Manager authentication did not return a token');
  const session = { token, expiresAt: parseExpiry(response.data?.expires) };
  tokenCache.set(key, session);
  return session;
}

async function npmRequest(service, method, url, options = {}) {
  const run = async force => {
    const session = await login(service, force);
    const headers = { Authorization: `Bearer ${session.token}`, ...(options.headers || {}) };
    const response = await http(service).request({ method, url, params: options.params, data: options.data, headers });
    return response.data;
  };
  try { return await run(false); }
  catch (error) {
    const status = error?.response?.status;
    if ((status === 401 || status === 403) && !credentials(service).token) {
      tokenCache.delete(cacheKey(service));
      return run(true);
    }
    const detail = error?.response?.data?.error?.message || error?.response?.data?.message || error?.response?.data?.error || error?.message;
    throw new Error(`Nginx Proxy Manager API request failed${status ? ` (${status})` : ''}: ${detail || 'unknown error'}`);
  }
}

function bool(v) { return v === true || Number(v) === 1 || String(v).toLowerCase() === 'true'; }
function n(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }

function normalizeProxyHost(row = {}) {
  const certificate = row.certificate && typeof row.certificate === 'object' ? row.certificate : null;
  return {
    id: n(row.id, 0),
    domains: Array.isArray(row.domain_names) ? row.domain_names : [],
    forwardScheme: row.forward_scheme || 'http',
    forwardHost: row.forward_host || '',
    forwardPort: n(row.forward_port, 0),
    enabled: bool(row.enabled),
    sslForced: bool(row.ssl_forced),
    websocket: bool(row.allow_websocket_upgrade),
    http2: bool(row.http2_support),
    blockExploits: bool(row.block_exploits),
    certificateId: n(row.certificate_id, 0),
    certificateName: certificate?.nice_name || '',
    certificateProvider: certificate?.provider || '',
    accessListId: n(row.access_list_id, 0),
    createdOn: row.created_on || '',
    modifiedOn: row.modified_on || '',
  };
}

function normalizeCertificate(row = {}) {
  return {
    id: n(row.id, 0),
    name: row.nice_name || '',
    provider: row.provider || '',
    domains: Array.isArray(row.domain_names) ? row.domain_names : [],
    expiresOn: row.expires_on || row.expires || '',
    createdOn: row.created_on || '',
    modifiedOn: row.modified_on || '',
  };
}

export async function getNpmProxyHosts(service) {
  const rows = await npmRequest(service, 'GET', '/nginx/proxy-hosts', { params: { expand: 'owner,access_list,certificate' } });
  return (Array.isArray(rows) ? rows : []).map(normalizeProxyHost);
}

export async function getNpmCertificates(service) {
  const rows = await npmRequest(service, 'GET', '/nginx/certificates', { params: { expand: 'owner' } });
  return (Array.isArray(rows) ? rows : []).map(normalizeCertificate);
}

export async function collectNginxProxyManager(service) {
  const started = performance.now();
  const [hosts, certificates] = await Promise.all([getNpmProxyHosts(service), getNpmCertificates(service)]);
  const now = Date.now();
  const expiring = certificates.filter(c => {
    const expiry = Date.parse(String(c.expiresOn || ''));
    return Number.isFinite(expiry) && expiry >= now && expiry < now + 30 * 24 * 60 * 60_000;
  }).length;
  return {
    status: 1,
    cpu: null,
    memoryUsed: null,
    memoryTotal: null,
    version: '',
    proxyHostCount: hosts.length,
    enabledProxyHostCount: hosts.filter(h => h.enabled).length,
    certificateCount: certificates.length,
    expiringCertificateCount: expiring,
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

export async function testNginxProxyManager(service) {
  const started = performance.now();
  await getNpmProxyHosts(service);
  return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
}

export async function setNpmProxyHostEnabled(service, hostId, enabled) {
  const id = Number(hostId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('A valid Nginx Proxy Manager proxy host ID is required');
  await npmRequest(service, 'POST', `/nginx/proxy-hosts/${id}/${enabled ? 'enable' : 'disable'}`);
  return { ok: true, id, enabled: Boolean(enabled) };
}

export async function renewNpmCertificate(service, certificateId) {
  const id = Number(certificateId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('A valid certificate ID is required');
  const result = await npmRequest(service, 'POST', `/nginx/certificates/${id}/renew`);
  return { ok: true, id, result };
}
