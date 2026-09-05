import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let geoip = null;
let unavailableReason = '';
try {
  geoip = require('geoip-lite');
} catch (e) {
  unavailableReason = e?.message || String(e);
  console.warn('[geo] geoip-lite unavailable:', unavailableReason);
}

const regionNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

export function lookupGeo(ip) {
  if (!geoip || !ip) return null;
  try {
    const hit = geoip.lookup(String(ip));
    if (!hit) return null;
    const code = String(hit.country || '').toUpperCase();
    const ll = Array.isArray(hit.ll) && hit.ll.length === 2 ? hit.ll.map(Number) : null;
    return {
      countryCode: code,
      country: code ? (regionNames?.of(code) || code) : 'Unknown',
      region: hit.region || '',
      city: hit.city || '',
      timezone: hit.timezone || '',
      lat: ll && Number.isFinite(ll[0]) ? ll[0] : null,
      lon: ll && Number.isFinite(ll[1]) ? ll[1] : null,
    };
  } catch {
    return null;
  }
}

export function geoStatus() {
  return { available: Boolean(geoip), reason: unavailableReason };
}
