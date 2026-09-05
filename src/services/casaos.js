import axios from 'axios';
import https from 'node:https';

const tokenCache = new Map();

function baseUrl(service) {
  const scheme = service.scheme === 'https' ? 'https' : 'http';
  const port = Number(service.port || (scheme === 'https' ? 443 : 80));
  return `${scheme}://${service.host}:${port}`;
}

function cacheKey(service) { return `${service.id || service.host}:${service.host}:${service.port || ''}`; }
function httpClient(service) {
  return axios.create({
    baseURL: baseUrl(service),
    timeout: 12000,
    validateStatus: () => true,
    httpsAgent: service.insecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  });
}

function tokenFromPayload(payload) {
  const root = payload?.data ?? payload ?? {};
  const token = root?.token ?? root;
  return token?.access_token || token?.accessToken || token?.AccessToken || root?.access_token || root?.accessToken || null;
}
function expiryFromPayload(payload) {
  const root = payload?.data ?? payload ?? {};
  const token = root?.token ?? root;
  const raw = Number(token?.expires_at ?? token?.expiresAt ?? token?.ExpiresAt ?? 0);
  if (!raw) return Date.now() + 2.5 * 3600_000;
  return raw > 10_000_000_000 ? raw : raw * 1000;
}

async function login(service, force = false) {
  const c = service.credentials || {};
  const direct = String(c.casaAccessToken || '').trim();
  if (direct) return direct;
  const key = cacheKey(service);
  const cached = tokenCache.get(key);
  if (!force && cached?.token && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const username = String(c.casaUsername || '').trim();
  const password = String(c.casaPassword || '');
  if (!username || !password) throw new Error('CasaOS username/password or access token is required');
  const client = httpClient(service);
  const res = await client.post('/v1/users/login', { username, password }, { headers: { 'Content-Type': 'application/json' } });
  const token = tokenFromPayload(res.data);
  if (res.status < 200 || res.status >= 300 || !token) {
    const msg = res.data?.message || res.data?.msg || res.data?.error || `HTTP ${res.status}`;
    throw new Error(`CasaOS login failed: ${msg}`);
  }
  tokenCache.set(key, { token, expiresAt: expiryFromPayload(res.data) });
  return token;
}

async function requestWithToken(service, method, url, options = {}) {
  const client = httpClient(service);
  let token = await login(service, false);
  let last;
  for (let loginAttempt = 0; loginAttempt < 2; loginAttempt += 1) {
    // CasaOS documents an Authorization API-key header. Some gateway builds accept
    // the raw JWT while others expect a Bearer prefix, so try both safely.
    const authValues = [token, `Bearer ${token}`];
    for (const authorization of authValues) {
      const res = await client.request({
        method, url,
        params: options.params,
        data: options.data,
        transformRequest: options.transformRequest,
        headers: { Authorization: authorization, ...(options.headers || {}) },
      });
      last = res;
      if (res.status !== 401 && res.status !== 403) {
        if (res.status < 200 || res.status >= 300) {
          const msg = res.data?.message || res.data?.msg || res.data?.error || `HTTP ${res.status}`;
          throw new Error(`CasaOS API request failed (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        }
        return res.data;
      }
    }
    if (String(service.credentials?.casaAccessToken || '').trim()) break;
    tokenCache.delete(cacheKey(service));
    token = await login(service, true);
  }
  throw new Error(`CasaOS authentication failed (${last?.status || 401}). Check the CasaOS username/password or access token.`);
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) return payload.data;
  return payload;
}

function localizedText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return fallback;
  return value.en_US || value.en_GB || value['en-US'] || value.default || Object.values(value).find(v => typeof v === 'string') || fallback;
}

function normalizeCasaApp(id, raw = {}) {
  const store = raw.store_info || raw.storeInfo || {};
  const compose = raw.compose || {};
  const title = localizedText(store.title, '') || store.name || compose.name || id;
  const description = localizedText(store.description, '');
  const services = compose.services && typeof compose.services === 'object' ? Object.keys(compose.services) : [];
  return {
    id: String(id),
    name: String(title || id),
    description: String(description || ''),
    status: String(raw.status || 'unknown'),
    updateAvailable: Boolean(raw.update_available ?? raw.updateAvailable),
    uncontrolled: Boolean(raw.is_uncontrolled ?? raw.isUncontrolled),
    category: String(store.category || store.category_id || ''),
    version: String(store.version || store.tag || ''),
    icon: typeof store.icon === 'string' ? store.icon : '',
    serviceCount: services.length,
    services,
  };
}

export async function getCasaOsApps(service) {
  const payload = await requestWithToken(service, 'GET', '/v2/app_management/compose');
  const data = unwrap(payload) || {};
  if (Array.isArray(data)) return data.map((item, index) => normalizeCasaApp(item?.id || item?.name || index, item));
  return Object.entries(data).map(([id, raw]) => normalizeCasaApp(id, raw));
}

export async function collectCasaOs(service) {
  const started = performance.now();
  const [infoResult, apps] = await Promise.all([
    requestWithToken(service, 'GET', '/v2/app_management/info').catch(() => ({})),
    getCasaOsApps(service),
  ]);
  const info = unwrap(infoResult) || infoResult || {};
  const running = apps.filter(a => String(a.status).toLowerCase() === 'running').length;
  const updates = apps.filter(a => a.updateAvailable).length;
  return {
    status: 1,
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
    version: String(info.version || info.release || ''),
    architecture: String(info.architecture || ''),
    appCount: apps.length,
    runningAppCount: running,
    updateCount: updates,
    apps,
  };
}

export async function testCasaOs(service) {
  const started = performance.now();
  await requestWithToken(service, 'GET', '/v2/app_management/info');
  return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
}

export async function controlCasaOsApp(service, appId, action) {
  if (!['start', 'restart', 'stop'].includes(action)) throw new Error('CasaOS app action must be start, restart or stop');
  const payload = await requestWithToken(service, 'PUT', `/v2/app_management/compose/${encodeURIComponent(String(appId))}/status`, {
    data: JSON.stringify(action),
    transformRequest: [data => data],
    headers: { 'Content-Type': 'application/json' },
  });
  return { ok: true, action, data: unwrap(payload) ?? null };
}
