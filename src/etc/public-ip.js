let cached = null;
let cachedAt = 0;
const CACHE_MS = 10 * 60 * 1000;

function validIp(value = '') {
  const s = String(value || '').trim();
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+$/i.test(s);
}

async function fetchJson(url, timeoutMs = 4500) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'RouterDeck/1.4' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getPublicIp(force = false) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return { ip: cached, cached: false, fetchedAt: cachedAt };
  let error = null;
  for (const url of ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json']) {
    try {
      const data = await fetchJson(url);
      const ip = String(data?.ip || '').trim();
      if (!validIp(ip)) throw new Error('Invalid public IP response');
      cached = ip;
      cachedAt = Date.now();
      return { ip, cached: false, fetchedAt: cachedAt };
    } catch (err) { error = err; }
  }
  if (cached) return { ip: cached, cached: true, fetchedAt: cachedAt, error: error?.message || 'Public IP lookup failed' };
  return { ip: null, cached: false, fetchedAt: null, error: error?.message || 'Public IP lookup failed' };
}
