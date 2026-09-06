process.env.APP_SECRET = 'auth-test-secret-0123456789abcdefgh';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const auth = await import('../etc/auth.js');
const { safeEqual, makeToken, verifyToken, login, logout, requireAuth, socketAuthorized } = auth;

const COOKIE = 'routerdeck_auth';

function signedToken(exp) {
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function mockRes() {
  const res = { statusCode: 200, body: null, cookies: [] };
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) { res.body = obj; return res; };
  res.cookie = function (name, value, opts) { res.cookies.push({ name, value, opts }); return res; };
  res.clearCookie = function (name) { res.cookies.push({ name, cleared: true }); return res; };
  return res;
}

test('safeEqual accepts equal strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('safeEqual rejects different values of equal length', () => {
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('safeEqual rejects length mismatches', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('safeEqual handles non-string inputs without throwing', () => {
  assert.equal(safeEqual(undefined, undefined), true);
  assert.equal(safeEqual(null, null), true);
  assert.equal(safeEqual(1, 2), false);
  assert.equal(safeEqual('1', 1), true);
});

test('makeToken produces a verifiable, two-part token', () => {
  const token = makeToken();
  assert.equal(token.includes('.'), true);
  assert.equal(verifyToken(token), true);
});

test('verifyToken rejects tampered signatures', () => {
  const token = makeToken();
  const [head, sig] = token.split('.');
  assert.equal(verifyToken(`${head}.${sig.slice(0, -1)}x`), false);
  assert.equal(verifyToken(`${head}xx.${sig}`), false);
});

test('verifyToken rejects expired tokens', () => {
  assert.equal(verifyToken(signedToken(Date.now() - 1000)), false);
  assert.equal(verifyToken(signedToken(0)), false);
});

test('verifyToken accepts valid future tokens', () => {
  assert.equal(verifyToken(signedToken(Date.now() + 3600_000)), true);
});

test('verifyToken rejects malformed input', () => {
  assert.equal(verifyToken(''), false);
  assert.equal(verifyToken(null), false);
  assert.equal(verifyToken('no-dot'), false);
  assert.equal(verifyToken('a.b'), false);
  assert.equal(verifyToken('bm9uY2U.garbage'), false);
});

test('login rejects a wrong password with 401', () => {
  const res = mockRes();
  login({ body: { password: 'wrong' } }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid password' });
});

test('login accepts the right password and sets an httpOnly session cookie', () => {
  const res = mockRes();
  login({ body: { password: 'test-admin-pw' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].name, COOKIE);
  assert.equal(res.cookies[0].opts.httpOnly, true);
  assert.equal(res.cookies[0].opts.sameSite, 'strict');
  assert.ok(Number.isFinite(res.cookies[0].opts.maxAge));
});

test('logout clears the auth cookie', () => {
  const res = mockRes();
  logout({}, res);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.cookies[0].cleared, true);
});

test('requireAuth blocks requests without a cookie', () => {
  const res = mockRes();
  let nextCalled = false;
  requireAuth({ cookies: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Unauthorized');
  assert.equal(nextCalled, false);
});

test('requireAuth allows a valid cookie through to next()', () => {
  const res = mockRes();
  let nextCalled = false;
  requireAuth({ cookies: { [COOKIE]: makeToken() } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);
});

test('requireAuth rejects an expired cookie', () => {
  const res = mockRes();
  let nextCalled = false;
  requireAuth({ cookies: { [COOKIE]: signedToken(Date.now() - 1000) } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('socketAuthorized parses the cookie header', () => {
  const token = makeToken();
  const ok = { handshake: { headers: { cookie: `${COOKIE}=${token}` } } };
  const together = { handshake: { headers: { cookie: `other=x; ${COOKIE}=${token}` } } };
  const none = { handshake: { headers: { cookie: 'other=x' } } };
  const empty = { handshake: { headers: {} } };
  assert.equal(socketAuthorized(ok), true);
  assert.equal(socketAuthorized(together), true);
  assert.equal(socketAuthorized(none), false);
  assert.equal(socketAuthorized(empty), false);
});
