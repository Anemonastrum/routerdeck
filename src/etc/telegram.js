// Telegram status-change notifications.
//
// Hooks into the uptime monitor (src/etc/monitor.js): every device / service
// reachability check feeds its latest state through maybeNotify(), and only
// state *transitions* (up -> down / down -> up) trigger a message, so the
// monitor stays silent while nothing changes and does not spam while an
// outage continues.
//
// The bot token is stored encrypted in the telegram_settings table and is
// never exposed through the API. Notifications are fully disabled until the
// user enables them in Settings -> Telegram notifications.

import { randomBytes } from 'node:crypto';
import { createDevice, createService, deleteDevice, deleteService, getAppSettings, getDevice, getService, getTelegramBotToken, getTelegramSettings, getTelegramRecipients, latestUptimeAll, latestServiceUptimeAll, latestMetric, listDevices, listServices, updateDevice, updateService } from '../db/index.js';

const lastStates = new Map();  // `${kind}:${id}` -> Boolean(ok)
const downSince = new Map();   // `${kind}:${id}` -> ts when the DOWN transition happened

function keyFor(kind, id) { return `${kind}:${id}`; }

// Seed the in-memory baseline from the last recorded check on startup so a
// restart during an outage still fires the recovery notification, and an
// item that is already down does not spam a DOWN alert right after boot.
export function seedLastStates() {
  for (const row of latestUptimeAll()) lastStates.set(keyFor('device', row.device_id), Number(row.status) === 1);
  for (const row of latestServiceUptimeAll()) lastStates.set(keyFor('service', row.service_id), Number(row.status) === 1);
}

export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Send a plain-text message to a Telegram chat. Returns { ok } or { ok:false, error }.
export async function sendTelegram({ token, chatId, text }) {
  if (!token || !chatId) return { ok: false, error: 'Telegram bot token and chat ID are required' };
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    return { ok: false, error: e.message || 'Telegram API unreachable' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.description || `Telegram HTTP ${res.status}` };
  }
  return { ok: true };
}

function formatDowntime(ms) {
  if (!ms || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Alert timestamp. Mirrors the web app clock (Settings -> Appearance) as
// closely as a server can: same clock format (12h "01.30.30 AM" / 24h
// "18.30.30"), same dot separators, and the same timezone — the timezone
// chosen in Settings when set, otherwise the container's TZ env, otherwise
// the system default. The first alert logs the resolved zone so a mismatch
// is diagnosable at a glance.
let loggedTsFormat = false;
export function botTimeLabel(now = new Date()) {
  const appSettings = getAppSettings();
  const hour12 = appSettings?.clockFormat === '12h';
  let zone;
  let source;
  if (appSettings?.timeZone && appSettings.timeZone !== 'auto') {
    zone = appSettings.timeZone;
    source = 'app settings';
  } else if (process.env.TZ) {
    zone = process.env.TZ;
    source = 'TZ env';
  } else {
    try { zone = new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    source = 'system default';
  }
  if (!loggedTsFormat) {
    loggedTsFormat = true;
    console.log(`[telegram] alert timestamps use timezone=${zone || '(system default)'} (${source}), clock=${hour12 ? '12h' : '24h'}`);
    if ((!appSettings?.timeZone || appSettings.timeZone === 'auto') && !process.env.TZ) {
      console.warn('[telegram] TZ env is not set - alert times may be UTC. Set TZ in docker-compose (e.g. TZ=Asia/Jakarta) or pick a time zone in Settings -> Appearance.');
    }
  }
  const withZone = zone ? { timeZone: zone } : {};
  try {
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12, ...withZone }).replace(/:/g, '.');
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...withZone });
    return `${date}, ${time}`;
  } catch {
    return now.toLocaleString('en-GB');
  }
}

// kind: 'device' | 'service' — display: e.g. "Living Room AP (10.10.10.2)"
// result: { ok, latencyMs, error } from the uptime check.
export async function maybeNotify(kind, id, display, result = {}) {
  const ok = result.ok !== false;
  const key = keyFor(kind, id);
  const previous = lastStates.get(key);
  lastStates.set(key, ok);

  // First observation for this item: record the baseline silently, never
  // alert on it (covers new items and restarts without a seeded row).
  if (previous == null) return;

  if (ok === previous) return;

  const settings = getTelegramSettings();
  if (!settings.enabled) return;
  const token = getTelegramBotToken();
  if (!token) return;

  const kindLabel = kind === 'device' ? 'Device' : 'Service';
  const nameSafe = escHtml(display);
  const time = botTimeLabel();

  let text;
  if (ok) {
    const downAt = downSince.get(key);
    const duration = downAt ? formatDowntime(Date.now() - downAt) : '';
    const latency = result.latencyMs != null ? `\nLatency: ${result.latencyMs} ms` : '';
    text = `✅ UP — ${kindLabel}: ${nameSafe}\n${kindLabel} is back online${duration ? ` after ${duration}` : ''}.${latency}\n${time}`;
    downSince.delete(key);
  } else {
    downSince.set(key, Date.now());
    const reason = result.error ? ` (${escHtml(result.error)})` : '';
    text = `🔴 DOWN — ${kindLabel}: ${nameSafe}\n${kindLabel} is unreachable${reason}.\n${time}\nRouterDeck will notify you when it recovers.`;
  }

  // Deliver to every enabled recipient whose scope covers this item. Several
  // chats can watch the same device, and one chat can watch only a subset.
  const recipients = getTelegramRecipients().filter(r =>
    r.enabled &&
    (ok ? r.notifyUp : r.notifyDown) &&
    (r.scope === 'all' || (kind === 'device' ? r.deviceIds.includes(id) : r.serviceIds.includes(id)))
  );
  const covered = new Set(recipients.map(r => r.chatId)); // one message per chat

  // Legacy fallback: a single chat configured before recipients existed.
  if (!recipients.length && settings.chatId) covered.add(settings.chatId);

  for (const chatId of covered) {
    const sent = await sendTelegram({ token, chatId, text });
    if (sent.ok) {
      console.log(`[telegram] chat ${chatId} ${kind} "${display}" ${ok ? 'UP' : 'DOWN'} — alert sent`);
    } else {
      console.error(`[telegram] chat ${chatId} ${kind} "${display}" ${ok ? 'UP' : 'DOWN'} — alert failed: ${sent.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive bot commands (long polling): /devices /services /online
// /offline /clients /help. The command menu is registered with setMyCommands
// so these appear as a menu in every chat. The bot answers any chat that
// writes to it while notifications are enabled.
// ---------------------------------------------------------------------------

const COMMANDS = [
  { command: 'devices', description: 'List device names, IDs and status' },
  { command: 'services', description: 'List service names, IDs and status' },
  { command: 'online', description: 'Show everything currently online' },
  { command: 'offline', description: 'Show everything currently unreachable' },
  { command: 'clients', description: 'Live client counts per device' },
  { command: 'device_add', description: 'Add device; /help shows required input' },
  { command: 'device_edit', description: 'Edit named device by ID' },
  { command: 'device_delete', description: 'Delete named device by ID' },
  { command: 'service_add', description: 'Add service; /help shows required input' },
  { command: 'service_edit', description: 'Edit named service by ID' },
  { command: 'service_delete', description: 'Delete named service by ID' },
  { command: 'help', description: 'Show full command guide' },
];

let botTimer = null;
let botPolling = false;
let botPollOffset = 0;
let botMenuToken = null;
const pendingDeletes = new Map();

function commandParts(text = '') {
  const [head = '', ...rest] = String(text).trim().split(/\s+/);
  const tail = rest.join(' ');
  return { command: head.replace(/^\/+/, '').split('@')[0].toLowerCase(), args: (tail.includes('|') ? tail.split('|') : rest).map(x => x.trim()) };
}

export async function executeInventoryCommand({ chatId, userId }, text) {
  const { command, args } = commandParts(text);
  if (command === 'device_add') {
    const [name, host, type = 'generic', role = 'router'] = args;
    const roles = type === 'generic' ? ['router','access_point','switch','ip_camera'] : type === 'openwrt' ? ['client','access_point'] : ['client','host'];
    if (!name || !host || !['generic','openwrt','mikrotik'].includes(type) || !roles.includes(role)) return 'Usage: /device_add name|host|type|role\nTypes/roles: generic|router, access_point, switch, ip_camera; openwrt|client or access_point; mikrotik|client or host.';
    const device = createDevice({ name, host, osType:type, deviceRole:role });
    return `Device added: #${device.id} ${device.name} (${device.host}), type=${device.osType}, role=${device.deviceRole}. Add credentials in RouterDeck web UI when required.`;
  }
  if (command === 'device_edit') {
    const [idRaw, name, host, role] = args;
    const id = Number(idRaw), before = getDevice(id);
    if (!Number.isInteger(id) || !name || !host || !role) return 'Usage: /device_edit id|name|host|role\nUse /devices to find device ID. All fields are required.';
    if (!before) return `Device #${id} not found. Use /devices to list IDs and names.`;
    const device = updateDevice(id, { name, host, deviceRole:role });
    return `Device updated: #${id} ${before.name} -> ${device.name} (${device.host}), role=${device.deviceRole}.`;
  }
  if (command === 'service_add') {
    const [name, host, type, scheme, portRaw] = args;
    const port = Number(portRaw);
    const types = ['adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos'];
    if (!name || !host || !types.includes(type) || !['http','https'].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) return 'Usage: /service_add name|host|type|scheme|port\nTypes: adguardhome, homeassistant, proxmox, synology, nginxproxymanager, casaos. Add credentials later in RouterDeck web UI.';
    const service = createService({ name, host, serviceType:type, scheme, port });
    return `Service added: #${service.id} ${service.name} (${service.webUrl}), type=${service.serviceType}. Add required credentials in RouterDeck web UI.`;
  }
  if (command === 'service_edit') {
    const [idRaw, name, host, scheme, portRaw] = args;
    const id = Number(idRaw), port = Number(portRaw), before = getService(id);
    if (!Number.isInteger(id) || !name || !host || !['http','https'].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) return 'Usage: /service_edit id|name|host|scheme|port\nUse /services to find service ID. All fields are required.';
    if (!before) return `Service #${id} not found. Use /services to list IDs and names.`;
    const service = updateService(id, { name, host, scheme, port });
    return `Service updated: #${id} ${before.name} -> ${service.name} (${service.webUrl}).`;
  }
  const deleteMatch = command.match(/^(device|service)_delete(_confirm)?$/);
  if (!deleteMatch) return null;
  const [, kind, confirming] = deleteMatch;
  const id = Number(args[0]);
  const item = kind === 'device' ? getDevice(id) : getService(id);
  if (!Number.isInteger(id) || !item) return `${kind === 'device' ? 'Device' : 'Service'} #${Number.isInteger(id) ? id : '?'} not found. Use /${kind === 'device' ? 'devices' : 'services'} to list IDs and names.`;
  const key = `${chatId}:${userId}:${kind}:${id}`;
  if (!confirming) {
    const token = randomBytes(4).toString('hex').toUpperCase();
    pendingDeletes.set(key, { token, expiresAt:Date.now()+60_000 });
    return `Delete ${kind} #${id} ${item.name} (${item.host}) and its monitoring history? Confirm within 60 seconds:\n/${kind}_delete_confirm ${id} ${token}`;
  }
  const token = String(args[1] || '').toUpperCase();
  const pending = pendingDeletes.get(key);
  if (!pending || pending.expiresAt < Date.now() || pending.token !== token) return `Delete confirmation for ${kind} #${id} ${item.name} is invalid or expired.`;
  pendingDeletes.delete(key);
  const deleted = kind === 'device' ? deleteDevice(id) : deleteService(id);
  return deleted ? `${kind === 'device' ? 'Device' : 'Service'} #${id} ${item.name} deleted.` : `${kind === 'device' ? 'Device' : 'Service'} #${id} ${item.name} was already removed.`;
}

export const executeDeviceCommand = executeInventoryCommand;

// Register the command list with Telegram so clients show a menu.
export async function registerBotMenu(token) {
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: COMMANDS }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) { botMenuToken = token; return true; }
    console.error(`[telegram] setMyCommands failed: ${data.description || `HTTP ${res.status}`}`);
    return false;
  } catch (e) { console.error(`[telegram] setMyCommands error: ${e.message}`); return false; }
}

// Pure reply builder — exported for tests and reuse.
export function buildCommandReply(text) {
  const cmd = String(text || '').trim().split(' ')[0].replace(/^\/+/, '').toLowerCase();
  const deviceStatus = new Map((latestUptimeAll() || []).map(u => [u.device_id, Number(u.status) === 1]));
  const serviceStatus = new Map((latestServiceUptimeAll() || []).map(u => [u.service_id, Number(u.status) === 1]));

  if (cmd === 'devices' || cmd === 'services') {
    const isDev = cmd === 'devices';
    const items = isDev ? listDevices() : listServices();
    if (!items.length) return `${isDev ? 'No devices' : 'No services'} are configured yet.`;
    const map = isDev ? deviceStatus : serviceStatus;
    const lines = items.map(it => {
      const up = map.get(it.id);
      const sym = up === undefined ? '❔' : up ? '✅' : '🔴';
      return `${sym} #${it.id} ${it.name} (${it.host})`;
    });
    return `${isDev ? '📡 Devices' : '🧩 Services'} (${items.length})\n${lines.join('\n')}`;
  }

  if (cmd === 'online' || cmd === 'offline') {
    const wantUp = cmd === 'online';
    const one = (items, map, sym) => items.filter(it => map.get(it.id) === wantUp).map(it => `${sym} ${it.name} (${it.host})`);
    const lines = [...one(listDevices(), deviceStatus, wantUp ? '✅' : '🔴'), ...one(listServices(), serviceStatus, wantUp ? '✅' : '🔴')];
    if (!lines.length) return `Nothing is ${wantUp ? 'online' : 'down'} right now.`;
    return `${wantUp ? '✅ Online' : '🔴 Offline'} (${lines.length})\n${lines.join('\n')}`;
  }

  if (cmd === 'clients') {
    const devs = listDevices();
    if (!devs.length) return 'No devices are configured yet.';
    const lines = devs.map(d => {
      const m = latestMetric(d.id);
      const n = m ? (m.clients_count ?? m.clientsCount ?? null) : null;
      return `${n == null ? '❔' : '🏠'} ${d.name} — ${n == null ? 'no data yet' : `${n} client${n === 1 ? '' : 's'}`}`;
    });
    return `👥 Connected clients\n${lines.join('\n')}`;
  }

  if (cmd === 'help' || cmd === 'start') {
    return `RouterDeck bot\n\nInventory\n/devices — device names, IDs, hosts and status\n/services — service names, IDs, hosts and status\n/online — everything currently up\n/offline — everything currently down\n/clients — live client counts per device\n\nAdd device\n/device_add name|host|type|role\nAll four fields are required. Separate fields with |.\nTypes and roles:\n• generic: router, access_point, switch, ip_camera\n• openwrt: client, access_point\n• mikrotik: client, host\nExample: /device_add Front camera|192.168.1.20|generic|ip_camera\nCredentials cannot be sent through Telegram. Add them later in RouterDeck web UI.\n\nEdit device\n/device_edit id|name|host|role\nAll fields are required. Find id with /devices.\nExample: /device_edit 12|Front camera|192.168.1.21|ip_camera\n\nDelete device\n/device_delete id\nBot states device name and asks for a one-time confirmation.\nExample: /device_delete 12\n\nAdd service\n/service_add name|host|type|scheme|port\nTypes: adguardhome, homeassistant, proxmox, synology, nginxproxymanager, casaos. Scheme: http or https. All fields required.\nExample: /service_add Home Assistant|192.168.1.10|homeassistant|http|8123\nAdd credentials later in RouterDeck web UI.\n\nEdit service\n/service_edit id|name|host|scheme|port\nFind id with /services. All fields required.\nExample: /service_edit 4|Home Assistant|192.168.1.11|http|8123\n\nDelete service\n/service_delete id\nBot states service name and asks for a one-time confirmation.\nExample: /service_delete 4\n\n/help — this message`;
  }

  if (cmd) return `Unknown command "/${cmd}". Try /help.`;
  return null; // non-command message: ignore
}

async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat || typeof msg.text !== 'string' || !msg.text.trim().startsWith('/')) return;
  const settings = getTelegramSettings();
  const token = getTelegramBotToken();
  if (!settings.enabled || !token) return;
  const recipients = getTelegramRecipients().filter(r => r.enabled);
  const authorized = recipients.some(r => String(r.chatId) === String(msg.chat.id)) || (!recipients.length && String(settings.chatId) === String(msg.chat.id));
  if (!authorized) return;
  const mutation = /^\/(?:device|service)_(?:add|edit|delete|delete_confirm)(?:@\w+)?(?:\s|$)/i.test(msg.text);
  let reply;
  if (mutation) {
    if (msg.chat.type !== 'private' || !msg.from?.id) return;
    reply = await executeInventoryCommand({ chatId:String(msg.chat.id), userId:String(msg.from.id) }, msg.text);
  } else {
    reply = buildCommandReply(msg.text);
  }
  if (reply == null) return;
  const sent = await sendTelegram({ token, chatId: msg.chat.id, text: reply });
  if (!sent.ok) console.error(`[telegram] command -> ${msg.chat.id}: ${sent.error}`);
}

async function pollTelegramOnce() {
  const settings = getTelegramSettings();
  const token = getTelegramBotToken();
  if (!settings.enabled || !token) return;
  if (botMenuToken !== token && !(await registerBotMenu(token))) return;
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${botPollOffset}&timeout=5`);
  } catch { return; }
  let data;
  try { data = await res.json(); } catch { return; }
  if (data.ok === false) {
    const desc = data.description || `HTTP ${res.status}`;
    if (data.error_code === 409 && /webhook/i.test(desc)) {
      // The bot already has a webhook (used elsewhere, or from an earlier
      // config). getUpdates can never run side-by-side with a webhook, so
      // clear it once and let the next poll continue normally.
      console.warn('[telegram] getUpdates blocked by an active webhook — calling deleteWebhook and retrying');
      try { await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`); } catch {}
    } else if (data.error_code === 401) {
      console.error('[telegram] Bot token was rejected by Telegram (401 Unauthorized). Check the token in Settings -> Telegram notifications.');
    } else {
      console.error(`[telegram] getUpdates: ${desc}`);
    }
    return;
  }
  const updates = Array.isArray(data.result) ? data.result : [];
  if (!updates.length) return;
  botPollOffset = updates[updates.length - 1].update_id + 1;
  for (const u of updates) { try { await handleTelegramUpdate(u); } catch {} }
}

// Idempotent: safe to call again when settings change (re-registers the menu
// and restarts the poll loop with the current token). Timers are unref'd so
// they never keep the process alive on shutdown.
export function startTelegramBot() {
  if (botTimer) clearInterval(botTimer);
  botTimer = setInterval(() => {
    if (botPolling) return;
    botPolling = true;
    pollTelegramOnce().finally(() => { botPolling = false; });
  }, 10000);
  botTimer.unref?.();
  if (!botPolling) {
    botPolling = true;
    pollTelegramOnce().finally(() => { botPolling = false; });
  }
}
