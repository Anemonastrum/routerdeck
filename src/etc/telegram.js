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

import { getTelegramBotToken, getTelegramSettings, getTelegramRecipients, latestUptimeAll, latestServiceUptimeAll } from '../db/index.js';

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
