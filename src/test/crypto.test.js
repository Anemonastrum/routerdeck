process.env.APP_SECRET = 'test-secret-0123456789abcdefghijklmnop';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { encryptJson, decryptJson } = await import('../etc/crypto.js');

test('roundtrips a nested object', () => {
  const value = { name: 'router', creds: { user: 'admin', pass: 's3cret' } };
  assert.deepEqual(decryptJson(encryptJson(value)), value);
});

test('roundtrips arrays, strings and numbers', () => {
  assert.deepEqual(decryptJson(encryptJson([1, 2, 3])), [1, 2, 3]);
  assert.equal(decryptJson(encryptJson('hello')), 'hello');
  assert.equal(decryptJson(encryptJson(42)), 42);
  assert.equal(decryptJson(encryptJson(true)), true);
});

test('encryptJson(null) produces an empty object payload', () => {
  assert.deepEqual(decryptJson(encryptJson(null)), {});
});

test('decryptJson returns {} for missing input', () => {
  assert.deepEqual(decryptJson(''), {});
  assert.deepEqual(decryptJson(null), {});
  assert.deepEqual(decryptJson(undefined), {});
});

test('produces unique ciphertext per call thanks to a random IV', () => {
  const a = encryptJson({ v: 1 });
  const b = encryptJson({ v: 1 });
  assert.notEqual(a, b);
  assert.deepEqual(decryptJson(a), decryptJson(b));
});

test('throws when the ciphertext is tampered with (GCM auth tag)', () => {
  const payload = encryptJson({ v: 1 });
  const raw = Buffer.from(payload, 'base64url');
  raw[raw.length - 1] ^= 0xff; // flip one bit in the encrypted bytes
  assert.throws(() => decryptJson(raw.toString('base64url')));
});

test('throws on garbage input', () => {
  assert.throws(() => decryptJson('not-base64-url-content!!!'));
  assert.throws(() => decryptJson('aGVsbG8='));
});
