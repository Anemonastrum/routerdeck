import axios from 'axios';
import https from 'node:https';
import WebSocket from 'ws';

function makeClient(service) {
  const c = service.credentials || {};
  const scheme = service.scheme || 'http';
  const port = Number(service.port || 8123);
  const token = String(c.accessToken || '').trim();
  return axios.create({
    baseURL: `${scheme}://${service.host}:${port}`,
    timeout: 10000,
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    httpsAgent: new https.Agent({ rejectUnauthorized: !service.insecureTls }),
  });
}



const roomCache = new Map();
const ROOM_CACHE_MS = 5 * 60 * 1000;

function roomCacheKey(service) {
  return `${service.id || ''}:${service.scheme || 'http'}://${service.host}:${Number(service.port || 8123)}`;
}

function homeAssistantWsUrl(service) {
  const scheme = service.scheme === 'https' ? 'wss' : 'ws';
  return `${scheme}://${service.host}:${Number(service.port || 8123)}/api/websocket`;
}

function registrySnapshot(service) {
  return new Promise((resolve, reject) => {
    const token = String(service.credentials?.accessToken || '').trim();
    if (!token) return reject(new Error('Home Assistant access token is required'));
    const ws = new WebSocket(homeAssistantWsUrl(service), { rejectUnauthorized: !service.insecureTls, handshakeTimeout: 8000 });
    const results = new Map();
    const requests = [
      { id: 1, type: 'config/area_registry/list', key: 'areas' },
      { id: 2, type: 'config/device_registry/list', key: 'devices' },
      { id: 3, type: 'config/entity_registry/list', key: 'entities' },
    ];
    let authed = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Home Assistant room registry timeout')), 10000);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    }
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (msg.type === 'auth_invalid') return finish(new Error(msg.message || 'Home Assistant WebSocket authentication failed'));
      if (msg.type === 'auth_ok') {
        authed = true;
        for (const req of requests) ws.send(JSON.stringify({ id: req.id, type: req.type }));
        return;
      }
      if (!authed || msg.type !== 'result') return;
      const req = requests.find(x => x.id === msg.id);
      if (!req) return;
      if (!msg.success) return finish(new Error(msg.error?.message || `Home Assistant ${req.type} failed`));
      results.set(req.key, Array.isArray(msg.result) ? msg.result : []);
      if (results.size === requests.length) finish(null, Object.fromEntries(results));
    });
    ws.on('error', err => finish(err));
    ws.on('close', () => { if (!settled && results.size !== requests.length) finish(new Error('Home Assistant WebSocket closed before room registry completed')); });
  });
}

function buildRooms(snapshot = {}, states = []) {
  const areas = Array.isArray(snapshot.areas) ? snapshot.areas : [];
  const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
  const entities = Array.isArray(snapshot.entities) ? snapshot.entities : [];
  const deviceById = new Map(devices.map(d => [d.id, d]));
  const stateById = new Map((Array.isArray(states) ? states : []).map(s => [s.entity_id, s]));
  const roomById = new Map(areas.map(a => [a.area_id || a.id, {
    id: a.area_id || a.id,
    name: a.name || a.area_id || a.id,
    entityCount: 0,
    activeCount: 0,
    unavailableCount: 0,
    deviceIds: new Set(),
    domains: {},
  }]));
  for (const entry of entities) {
    if (entry.disabled_by) continue;
    const areaId = entry.area_id || deviceById.get(entry.device_id)?.area_id || '';
    const room = roomById.get(areaId);
    if (!room) continue;
    const entityId = entry.entity_id || '';
    const domain = entityId.split('.')[0] || 'unknown';
    room.entityCount += 1;
    room.domains[domain] = (room.domains[domain] || 0) + 1;
    if (entry.device_id) room.deviceIds.add(entry.device_id);
    const state = String(stateById.get(entityId)?.state || '').toLowerCase();
    if (state === 'unavailable') room.unavailableCount += 1;
    if (state && !['off', 'unavailable', 'unknown', 'idle', 'closed', 'not_home'].includes(state)) room.activeCount += 1;
  }
  return [...roomById.values()].map(room => ({
    id: room.id,
    name: room.name,
    entityCount: room.entityCount,
    activeCount: room.activeCount,
    unavailableCount: room.unavailableCount,
    deviceCount: room.deviceIds.size,
    domains: room.domains,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getHomeAssistantRooms(service, states = null, force = false) {
  const key = roomCacheKey(service);
  const cached = roomCache.get(key);
  if (!force && cached && Date.now() - cached.ts < ROOM_CACHE_MS) return cached.rooms;
  try {
    const [snapshot, stateRows] = await Promise.all([
      registrySnapshot(service),
      states == null ? makeClient(service).get('/api/states').then(r => Array.isArray(r.data) ? r.data : []) : Promise.resolve(states),
    ]);
    const rooms = buildRooms(snapshot, stateRows);
    roomCache.set(key, { ts: Date.now(), rooms });
    return rooms;
  } catch (err) {
    if (cached?.rooms) return cached.rooms.map(r => ({ ...r, cached: true }));
    throw err;
  }
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function summarizeStates(states = []) {
  const domains = {};
  let unavailable = 0;
  let unknown = 0;
  let on = 0;
  for (const row of states) {
    const domain = String(row.entity_id || '').split('.')[0] || 'unknown';
    domains[domain] = (domains[domain] || 0) + 1;
    if (row.state === 'unavailable') unavailable += 1;
    else if (row.state === 'unknown') unknown += 1;
    if (row.state === 'on') on += 1;
  }
  return {
    entityCount: states.length,
    unavailableCount: unavailable,
    unknownCount: unknown,
    onCount: on,
    automationCount: domains.automation || 0,
    lightCount: domains.light || 0,
    switchCount: domains.switch || 0,
    sensorCount: domains.sensor || 0,
    personCount: domains.person || 0,
    domains,
  };
}

function findPercentSensor(states, terms) {
  const row = states.find(s => {
    const id = String(s.entity_id || '').toLowerCase();
    const name = String(s.attributes?.friendly_name || '').toLowerCase();
    const unit = String(s.attributes?.unit_of_measurement || '');
    return unit === '%' && terms.some(t => id.includes(t) || name.includes(t)) && asNumber(s.state) != null;
  });
  return row ? asNumber(row.state) : null;
}

export async function testHomeAssistant(service) {
  const started = performance.now();
  const data = (await makeClient(service).get('/api/')).data || {};
  return {
    ok: /api running/i.test(String(data.message || '')) || Boolean(data.message),
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
    message: data.message || 'API running',
  };
}

export async function collectHomeAssistant(service) {
  const client = makeClient(service);
  const [healthRes, configRes, statesRes] = await Promise.all([
    client.get('/api/'),
    client.get('/api/config'),
    client.get('/api/states'),
  ]);
  const health = healthRes.data || {};
  const config = configRes.data || {};
  const states = Array.isArray(statesRes.data) ? statesRes.data : [];
  const summary = summarizeStates(states);
  let rooms = [];
  try { rooms = await getHomeAssistantRooms(service, states); } catch {}
  return {
    status: health.message ? 1 : 0,
    running: Boolean(health.message),
    version: config.version || '',
    locationName: config.location_name || '',
    timeZone: config.time_zone || '',
    state: config.state || '',
    latitude: config.latitude ?? null,
    longitude: config.longitude ?? null,
    elevation: config.elevation ?? null,
    currency: config.currency || '',
    country: config.country || '',
    language: config.language || '',
    unitSystem: config.unit_system || {},
    componentsCount: Array.isArray(config.components) ? config.components.length : 0,
    entityCount: summary.entityCount,
    roomCount: rooms.length,
    rooms,
    unavailableCount: summary.unavailableCount,
    unknownCount: summary.unknownCount,
    automationCount: summary.automationCount,
    lightCount: summary.lightCount,
    switchCount: summary.switchCount,
    sensorCount: summary.sensorCount,
    personCount: summary.personCount,
    domains: summary.domains,
    // If System Monitor entities are installed, surface their percent values without
    // requiring a second host agent. These are optional and may remain null.
    cpu: findPercentSensor(states, ['processor_use', 'cpu_usage', 'cpu use', 'processor use']),
    memoryPercent: findPercentSensor(states, ['memory_use_percent', 'memory usage', 'memory use']),
    memoryUsed: null,
    memoryTotal: null,
    summary,
  };
}

const CONTROL_DOMAINS = new Set([
  'light', 'switch', 'fan', 'input_boolean', 'automation', 'script', 'scene',
  'cover', 'lock', 'button', 'input_button', 'siren', 'media_player', 'humidifier',
]);

function normalizeEntity(row = {}) {
  const entityId = String(row.entity_id || '');
  const domain = entityId.split('.')[0] || '';
  return {
    entityId,
    domain,
    state: row.state ?? '',
    name: row.attributes?.friendly_name || entityId,
    icon: row.attributes?.icon || '',
    deviceClass: row.attributes?.device_class || '',
    unit: row.attributes?.unit_of_measurement || '',
    lastChanged: row.last_changed || null,
    lastUpdated: row.last_updated || null,
    lastTriggered: row.attributes?.last_triggered || null,
    current: row.attributes?.current ?? null,
    mode: row.attributes?.mode || '',
    controllable: CONTROL_DOMAINS.has(domain),
  };
}

export async function getHomeAssistantEntities(service) {
  const rows = (await makeClient(service).get('/api/states')).data;
  const states = Array.isArray(rows) ? rows : [];
  return states.map(normalizeEntity).filter(x => x.controllable).sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

export async function getHomeAssistantAutomations(service) {
  const rows = (await makeClient(service).get('/api/states')).data;
  const states = Array.isArray(rows) ? rows : [];
  return states.map(normalizeEntity).filter(x => x.domain === 'automation').sort((a, b) => a.name.localeCompare(b.name));
}

const ACTIONS = {
  light: new Set(['turn_on', 'turn_off', 'toggle']),
  switch: new Set(['turn_on', 'turn_off', 'toggle']),
  fan: new Set(['turn_on', 'turn_off', 'toggle']),
  input_boolean: new Set(['turn_on', 'turn_off', 'toggle']),
  automation: new Set(['turn_on', 'turn_off', 'toggle', 'trigger']),
  script: new Set(['turn_on']),
  scene: new Set(['turn_on']),
  cover: new Set(['open_cover', 'close_cover', 'stop_cover']),
  lock: new Set(['lock', 'unlock']),
  button: new Set(['press']),
  input_button: new Set(['press']),
  siren: new Set(['turn_on', 'turn_off']),
  media_player: new Set(['turn_on', 'turn_off', 'media_play_pause']),
  humidifier: new Set(['turn_on', 'turn_off', 'toggle']),
};

export async function controlHomeAssistantEntity(service, entityId, action) {
  const id = String(entityId || '').trim();
  const domain = id.split('.')[0];
  const serviceAction = String(action || '').trim();
  if (!id.includes('.') || !ACTIONS[domain]?.has(serviceAction)) throw new Error('Unsupported Home Assistant entity action');
  const response = await makeClient(service).post(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(serviceAction)}`, { entity_id: id });
  return { ok: true, result: response.data || [] };
}

export async function restartHomeAssistant(service) {
  const response = await makeClient(service).post('/api/services/homeassistant/restart', {});
  return { ok: true, result: response.data || [] };
}
