import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamError, sendUpstreamError } from '../etc/http-errors.js';

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) { res.body = obj; return res; };
  return res;
}

test('upstreamError prefers response.data.detail', () => {
  const err = { message: 'generic', response: { data: { detail: 'detail wins' } } };
  assert.equal(upstreamError(err), 'detail wins');
});

test('upstreamError falls back to response.data.message', () => {
  const err = { message: 'generic', response: { data: { message: 'data message' } } };
  assert.equal(upstreamError(err), 'data message');
});

test('upstreamError falls back to error.message', () => {
  assert.equal(upstreamError({ message: 'top level' }), 'top level');
});

test('upstreamError treats a string response body as opaque', () => {
  const err = { message: 'top level', response: { data: 'plain string body' } };
  assert.equal(upstreamError(err), 'top level');
});

test('upstreamError returns the default when nothing is available', () => {
  assert.equal(upstreamError(undefined), 'Upstream request failed');
  assert.equal(upstreamError({}), 'Upstream request failed');
  assert.equal(upstreamError(null), 'Upstream request failed');
});

test('sendUpstreamError writes 502 with a normalized message', () => {
  const res = mockRes();
  sendUpstreamError(res, { message: 'boom', response: { data: { detail: 'API said no' } } });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'API said no' });
});

test('sendUpstreamError honors a custom status code', () => {
  const res = mockRes();
  sendUpstreamError(res, { message: 'x' }, 504);
  assert.equal(res.statusCode, 504);
});
