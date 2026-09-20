import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTimeZone } from '../../public/js/format.js';

test('browserTimeZone returns browser-resolved IANA timezone', () => {
  const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Jakarta' }) }) };
  assert.equal(browserTimeZone(intl), 'Asia/Jakarta');
});

test('browserTimeZone falls back to auto when detection fails', () => {
  assert.equal(browserTimeZone({ DateTimeFormat: () => { throw new Error('unavailable'); } }), 'auto');
});
