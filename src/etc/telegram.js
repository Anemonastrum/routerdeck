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

import { getTelegramBotToken, getTelegramSettings, getTelegramRecipients, latestUptimeAll, latestServiceUptimeAll, latestMetric, listDevices, listServices } from '../db/index.js';

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
  const time = new Date().toLocaleString();

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
  { command: 'devices', description: 'List all monitored devices with current status' },
  { command: 'services', description: 'List all network services with current status' },
  { command: 'online', description: 'Show everything currently online' },
  { command: 'offline', description: 'Show everything currently unreachable' },
  { command: 'clients', description: 'Live client counts per device' },
  { command: 'help', description: 'Show available commands' },
];

let botTimer = null;
let botPolling = false;
let botPollOffset = 0;
let botMenuToken = null;

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
      return `${sym} ${it.name} (${it.host})`;
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
    return `RouterDeck bot\n\n/devices — list monitored devices with status\n/services — list network services with status\n/online — everything currently up\n/offline — everything currently down\n/clients — live client counts per device\n/help — this message`;
  }

  if (cmd) return `Unknown command "/${cmd}". Try /help.`;
  return null; // non-command message: ignore
}

async function handleTelegramUpdate(update) {
  const msg = update.message || update.channel_post || update.edited_message;
  if (!msg || !msg.chat || typeof msg.text !== 'string' || !msg.text.trim().startsWith('/')) return;
  const reply = buildCommandReply(msg.text);
  if (reply == null) return;
  const settings = getTelegramSettings();
  const token = getTelegramBotToken();
  if (!settings.enabled || !token) return;
  const sent = await sendTelegram({ token, chatId: msg.chat.id, text: reply });
  if (!sent.ok) console.error(`[telegram] command ${msg.text.trim()} -> ${msg.chat.id}: ${sent.error}`);
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
  if (data.ok === false) { console.error(`[telegram] getUpdates: ${data.description}`); return; }
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
