process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'telegram-test-secret-0123456789abcdefghi';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../db/index.js');
const tg = await import('../etc/telegram.js');
const { escHtml, sendTelegram, maybeNotify } = tg;

const realFetch = globalThis.fetch;
let fetchCalls = [];

function stubFetch(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (responder) return responder();
    return { ok: true, json: async () => ({ ok: true }) };
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// The Telegram tables are process-global; give every maybeNotify test a clean slate.
function resetTelegram() {
  for (const r of db.getTelegramRecipients()) db.deleteTelegramRecipient(r.id);
  db.updateTelegramSettings({ enabled: false, chatId: '' });
}

function bodyOf(i) {
  return JSON.parse(fetchCalls[i].opts.body);
}

test('escHtml escapes the four HTML metacharacters', () => {
  assert.equal(escHtml('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  assert.equal(escHtml('plain text'), 'plain text');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(null), '');
});

test('sendTelegram requires token and chatId', async () => {
  const missing = await sendTelegram({ token: '', chatId: '1', text: 'x' });
  assert.equal(missing.ok, false);
  const missingChat = await sendTelegram({ token: 't', chatId: null, text: 'x' });
  assert.equal(missingChat.ok, false);
  assert.match(String(missing.error), /required/i);
});

test('sendTelegram posts to the Telegram API and reports success', async () => {
  stubFetch(); // default responder: ok:true
  const sent = await sendTelegram({ token: '123:ABC', chatId: '-1001', text: 'hello' });
  assert.equal(sent.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /api\.telegram\.org\/bot123:ABC\/sendMessage/);
  const body = bodyOf(0);
  assert.equal(body.chat_id, '-1001');
  assert.equal(body.text, 'hello');
  restoreFetch();
});

test('sendTelegram surfaces the API description on failure', async () => {
  stubFetch(() => ({ ok: false, json: async () => ({ ok: false, description: 'bot was blocked' }) }));
  const sent = await sendTelegram({ token: '123:ABC', chatId: '1', text: 'x' });
  assert.equal(sent.ok, false);
  assert.equal(sent.error, 'bot was blocked');
  restoreFetch();
});

test('sendTelegram reports the HTTP status when the body is unreadable', async () => {
  stubFetch(() => ({ ok: false, status: 500, json: async () => { throw new Error('bad json'); } }));
  const sent = await sendTelegram({ token: '123:ABC', chatId: '1', text: 'x' });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /Telegram HTTP 500/);
  restoreFetch();
});

test('sendTelegram swallows network errors into the result object', async () => {
  stubFetch(() => { throw new Error('ECONNREFUSED'); });
  const sent = await sendTelegram({ token: '123:ABC', chatId: '1', text: 'x' });
  assert.equal(sent.ok, false);
  assert.match(String(sent.error), /ECONNREFUSED/);
  restoreFetch();
});

test('maybeNotify stays silent on the first observation (baseline)', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  db.createTelegramRecipient({ chatId: '1001' });
  await maybeNotify('device', 950, 'AP One (10.0.0.1)', { ok: false }); // baseline set
  assert.equal(fetchCalls.length, 0);
  await maybeNotify('device', 950, 'AP One (10.0.0.1)', { ok: false }); // no state change
  assert.equal(fetchCalls.length, 0);
  await maybeNotify('device', 950, 'AP One (10.0.0.1)', { ok: true }); // transition fires
  assert.equal(fetchCalls.length, 1);
  assert.match(bodyOf(0).text, /✅ UP — Device: AP One \(10\.0\.0\.1\)/);
  restoreFetch();
});

test('maybeNotify reports DOWN with the error and UP with latency', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  db.createTelegramRecipient({ chatId: '1001' });
  await maybeNotify('device', 951, 'Router', { ok: true }); // baseline up
  assert.equal(fetchCalls.length, 0);
  await maybeNotify('device', 951, 'Router', { ok: false, error: 'timeout' }); // down
  assert.equal(fetchCalls.length, 1);
  assert.match(bodyOf(0).text, /🔴 DOWN — Device: Router/);
  assert.match(bodyOf(0).text, /timeout/);
  await maybeNotify('device', 951, 'Router', { ok: true, latencyMs: 12.5 }); // recovers
  assert.equal(fetchCalls.length, 2);
  assert.match(bodyOf(1).text, /✅ UP — Device: Router/);
  assert.match(bodyOf(1).text, /Latency: 12\.5 ms/);
  restoreFetch();
});

test('maybeNotify does not send while notifications are disabled', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: false, botToken: '123:ABC', chatId: '' });
  db.createTelegramRecipient({ chatId: '1002' });
  await maybeNotify('device', 952, 'X', { ok: true }); // baseline
  await maybeNotify('device', 952, 'X', { ok: false }); // transition, but disabled
  assert.equal(fetchCalls.length, 0);
  restoreFetch();
});

test('maybeNotify without recipients sends nothing', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  await maybeNotify('device', 955, 'Y', { ok: false }); // baseline
  await maybeNotify('device', 955, 'Y', { ok: true }); // transition, but no recipients
  assert.equal(fetchCalls.length, 0);
  restoreFetch();
});

test('maybeNotify honors per-recipient scope and routing', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  const devId = 953;
  await maybeNotify('device', devId, 'Y', { ok: true }); // baseline
  const r = db.createTelegramRecipient({
    chatId: '2001', scope: 'selected', deviceIds: [99999], serviceIds: [],
  });
  await maybeNotify('device', devId, 'Y', { ok: false }); // recipient watches another device
  assert.equal(fetchCalls.length, 0);
  db.updateTelegramRecipient(r.id, { scope: 'selected', deviceIds: [devId], serviceIds: [] });
  await maybeNotify('device', devId, 'Y', { ok: true }); // now it matches
  assert.equal(fetchCalls.length, 1);
  assert.equal(bodyOf(0).text.includes('💥'), false); // sanity
  db.deleteTelegramRecipient(r.id);
  restoreFetch();
});

test('maybeNotify handles services with the Service label', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  db.createTelegramRecipient({ chatId: '3001' });
  const svcId = 954;
  await maybeNotify('service', svcId, 'AdGuard', { ok: false }); // baseline
  assert.equal(fetchCalls.length, 0);
  await maybeNotify('service', svcId, 'AdGuard', { ok: true });
  assert.equal(fetchCalls.length, 1);
  assert.match(bodyOf(0).text, /✅ UP — Service: AdGuard/);
  restoreFetch();
});

test('a recipient disabled or without the right toggle does not receive alerts', async () => {
  resetTelegram();
  stubFetch();
  db.updateTelegramSettings({ enabled: true, botToken: '123:ABC', chatId: '' });
  db.createTelegramRecipient({ chatId: '4001', enabled: false });
  db.createTelegramRecipient({ chatId: '4002', notifyDown: false, notifyUp: false });
  const devId = 956;
  await maybeNotify('device', devId, 'Z', { ok: true }); // baseline
  await maybeNotify('device', devId, 'Z', { ok: false }); // down — both recipients opt out
  assert.equal(fetchCalls.length, 0);
  restoreFetch();
});
