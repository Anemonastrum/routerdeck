import axios from 'axios';
import https from 'node:https';
import { sshExec } from '../etc/ssh.js';

const sessionCache = new Map();

function endpoint(service) {
  const scheme = service.scheme || 'http';
  const port = Number(service.port || (scheme === 'https' ? 443 : 80));
  return `${scheme}://${service.host}:${port}/control`;
}

function makeClient(service) {
  return axios.create({
    baseURL: endpoint(service),
    timeout: 9000,
    maxRedirects: 2,
    httpsAgent: new https.Agent({ rejectUnauthorized: !service.insecureTls }),
  });
}

function authValues(service) {
  const c = service.credentials || {};
  return { username: String(c.apiUsername || '').trim(), password: String(c.apiPassword || '') };
}

function authKey(service) {
  const a = authValues(service);
  return `${service.id || service.host}|${endpoint(service)}|${a.username}`;
}

function basicHeader(service) {
  const { username, password } = authValues(service);
  if (!username) return null;
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function sessionCookieFromResponse(response) {
  const values = response?.headers?.['set-cookie'];
  const raw = Array.isArray(values) ? values[0] : values;
  if (!raw) return '';
  return String(raw).split(';', 1)[0];
}

async function loginForSession(service) {
  const { username, password } = authValues(service);
  if (!username) return '';
  const client = makeClient(service);
  const body = { name: username, password };

  // AdGuard Home's web login accepts the credentials in the JSON body and
  // returns a session cookie.  Do not force Basic auth on this first attempt:
  // a reverse proxy may be the component rejecting the original Basic request.
  let response;
  try {
    response = await client.post('/login', body);
  } catch (error) {
    const status = error?.response?.status;
    const auth = basicHeader(service);
    // A few reverse-proxy setups protect /control/login itself with Basic auth.
    // Retry that edge case without making it the default path.
    if ((status === 401 || status === 403) && auth) {
      response = await client.post('/login', body, { headers: { Authorization: auth } });
    } else {
      throw error;
    }
  }

  const cookie = sessionCookieFromResponse(response);
  if (!cookie) throw new Error('AdGuard Home login succeeded but no session cookie was returned');
  sessionCache.set(authKey(service), { cookie, expiresAt: Date.now() + 20 * 60_000 });
  return cookie;
}

async function adguardRequest(service, method, path, options = {}) {
  const client = makeClient(service);
  const key = authKey(service);
  const cached = sessionCache.get(key);
  const auth = basicHeader(service);
  const firstHeaders = { ...(options.headers || {}) };
  if (cached?.cookie && cached.expiresAt > Date.now()) firstHeaders.Cookie = cached.cookie;
  else if (auth) firstHeaders.Authorization = auth;

  const run = headers => client.request({ method, url: path, params: options.params, data: options.data, headers });
  try {
    return await run(firstHeaders);
  } catch (error) {
    const status = error?.response?.status;
    const { username } = authValues(service);
    if ((status === 401 || status === 403) && username) {
      sessionCache.delete(key);
      try {
        const cookie = await loginForSession(service);
        return await run({ ...(options.headers || {}), Cookie: cookie });
      } catch (loginError) {
        const loginStatus = loginError?.response?.status;
        if (loginStatus === 401 || loginStatus === 403) {
          throw new Error('AdGuard Home authentication failed. Check the Web UI username and password.');
        }
        throw loginError;
      }
    }
    throw error;
  }
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function readProcessMetrics(service) {
  if (!service.sshMetrics) return { cpu: null, memoryUsed: null, memoryTotal: null, processFound: null };
  const c = service.credentials || {};
  const fakeDevice = {
    host: service.host,
    credentials: {
      sshUsername: c.sshUsername || 'root',
      sshPassword: c.sshPassword || '',
      sshPort: Number(c.sshPort || 22),
      privateKey: c.privateKey || undefined,
    },
  };
  const command = `
pid="$(pidof AdGuardHome 2>/dev/null | awk '{print $1}')"
[ -n "$pid" ] || pid="$(pgrep -x AdGuardHome 2>/dev/null | head -n1)"
if [ -z "$pid" ] || [ ! -r "/proc/$pid/stat" ]; then echo "NO_PROCESS"; exit 0; fi
p1="$(awk '{print $14+$15}' /proc/$pid/stat 2>/dev/null)"
t1="$(awk '/^cpu /{s=0;for(i=2;i<=NF;i++)s+=$i;print s;exit}' /proc/stat)"
ncpu="$(grep -c '^cpu[0-9]' /proc/stat 2>/dev/null)"; [ "$ncpu" -gt 0 ] 2>/dev/null || ncpu=1
sleep 0.35
p2="$(awk '{print $14+$15}' /proc/$pid/stat 2>/dev/null)"
t2="$(awk '/^cpu /{s=0;for(i=2;i<=NF;i++)s+=$i;print s;exit}' /proc/stat)"
cpu="$(awk -v p1="$p1" -v p2="$p2" -v t1="$t1" -v t2="$t2" -v n="$ncpu" 'BEGIN{if(t2>t1) printf "%.2f",((p2-p1)/(t2-t1))*100*n; else print "0"}')"
rss="$(awk '/^VmRSS:/{print $2*1024;exit}' /proc/$pid/status 2>/dev/null)"
total="$(awk '/^MemTotal:/{print $2*1024;exit}' /proc/meminfo 2>/dev/null)"
echo "$cpu \${rss:-0} \${total:-0}"
`;
  try {
    const out = (await sshExec(fakeDevice, command, 9000)).trim();
    if (!out || out === 'NO_PROCESS') return { cpu: null, memoryUsed: null, memoryTotal: null, processFound: false };
    const [cpu, memoryUsed, memoryTotal] = out.split(/\s+/);
    return { cpu: asNumber(cpu), memoryUsed: asNumber(memoryUsed), memoryTotal: asNumber(memoryTotal), processFound: true };
  } catch (e) {
    return { cpu: null, memoryUsed: null, memoryTotal: null, processFound: null, metricsError: e.message };
  }
}

export async function collectAdGuardHome(service) {
  const [statusRes, statsRes, process] = await Promise.all([
    adguardRequest(service, 'GET', '/status'),
    adguardRequest(service, 'GET', '/stats').catch(() => ({ data: {} })),
    readProcessMetrics(service),
  ]);
  const status = statusRes.data || {};
  const stats = statsRes.data || {};
  return {
    status: status.running === false ? 0 : 1,
    running: status.running !== false,
    protectionEnabled: Boolean(status.protection_enabled),
    version: status.version || '',
    dnsPort: status.dns_port ?? null,
    httpPort: status.http_port ?? null,
    dnsAddresses: status.dns_addresses || [],
    startedAt: status.start_time ?? null,
    cpu: process.cpu,
    memoryUsed: process.memoryUsed,
    memoryTotal: process.memoryTotal,
    processFound: process.processFound,
    metricsError: process.metricsError || null,
    stats: {
      numDnsQueries: asNumber(stats.num_dns_queries) || 0,
      numBlockedFiltering: asNumber(stats.num_blocked_filtering) || 0,
      numReplacedSafebrowsing: asNumber(stats.num_replaced_safebrowsing) || 0,
      numReplacedSafesearch: asNumber(stats.num_replaced_safesearch) || 0,
      numReplacedParental: asNumber(stats.num_replaced_parental) || 0,
      avgProcessingTime: asNumber(stats.avg_processing_time),
    },
  };
}

export async function testAdGuardHome(service) {
  const data = (await adguardRequest(service, 'GET', '/status')).data || {};
  return { ok: true, version: data.version || '', running: data.running !== false };
}

export async function getAdGuardDnsInfo(service) {
  return (await adguardRequest(service, 'GET', '/dns_info')).data || {};
}

const DNS_FIELDS = new Set([
  'bootstrap_dns', 'upstream_dns', 'fallback_dns', 'upstream_dns_file', 'ratelimit',
  'ratelimit_subnet_len_ipv4', 'ratelimit_subnet_len_ipv6', 'ratelimit_whitelist',
  'blocking_mode', 'blocking_ipv4', 'blocking_ipv6', 'blocked_response_ttl',
  'edns_cs_enabled', 'edns_cs_use_custom', 'edns_cs_custom_ip', 'disable_ipv6',
  'dnssec_enabled', 'cache_size', 'cache_ttl_min', 'cache_ttl_max', 'cache_enabled',
  'cache_optimistic', 'upstream_mode', 'use_private_ptr_resolvers', 'resolve_clients',
  'local_ptr_upstreams', 'upstream_timeout',
]);

export async function updateAdGuardDns(service, input = {}) {
  const body = {};
  for (const [key, value] of Object.entries(input || {})) if (DNS_FIELDS.has(key)) body[key] = value;
  await adguardRequest(service, 'POST', '/dns_config', { data: body });
  return getAdGuardDnsInfo(service);
}

export async function setAdGuardProtection(service, enabled) {
  await adguardRequest(service, 'POST', '/protection', { data: { enabled: Boolean(enabled) } });
  return collectAdGuardHome(service);
}

export async function getAdGuardQueryLog(service, options = {}) {
  const params = { limit: Math.min(500, Math.max(1, Number(options.limit || 100))) };
  if (options.search) params.search = String(options.search).slice(0, 200);
  if (options.olderThan) params.older_than = String(options.olderThan);
  if (options.reason) params.reason = Array.isArray(options.reason) ? options.reason : [String(options.reason)];
  const data = (await adguardRequest(service, 'GET', '/querylog', { params })).data || {};
  return { oldest: data.oldest || null, data: Array.isArray(data.data) ? data.data : [] };
}

export async function clearAdGuardQueryLog(service) {
  await adguardRequest(service, 'POST', '/querylog_clear');
  return { ok: true };
}

export async function clearAdGuardCache(service) {
  await adguardRequest(service, 'POST', '/cache_clear');
  return { ok: true };
}

export async function setAdGuardProcessState(service, enabled) {
  if (!service.sshMetrics) throw new Error('SSH host access is required to start or stop the AdGuard Home service');
  const c = service.credentials || {};
  const fakeDevice = {
    host: service.host,
    credentials: {
      sshUsername: c.sshUsername || 'root',
      sshPassword: c.sshPassword || '',
      sshPort: Number(c.sshPort || 22),
      privateKey: c.privateKey || undefined,
    },
  };
  const verb = enabled ? 'start' : 'stop';
  const command = `
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl ${verb} AdGuardHome 2>/dev/null || systemctl ${verb} adguardhome 2>/dev/null || systemctl ${verb} AdGuardHome.service
elif [ -x /etc/init.d/AdGuardHome ]; then
  /etc/init.d/AdGuardHome ${verb}
elif [ -x /etc/init.d/adguardhome ]; then
  /etc/init.d/adguardhome ${verb}
elif command -v service >/dev/null 2>&1; then
  service AdGuardHome ${verb} 2>/dev/null || service adguardhome ${verb}
else
  echo "No supported service manager found" >&2
  exit 1
fi
`;
  await sshExec(fakeDevice, command, 12000);
  return { ok: true, enabled: Boolean(enabled), action: verb };
}
