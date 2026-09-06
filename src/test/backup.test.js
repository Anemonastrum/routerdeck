process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'backup-test-secret-0123456789abcdefghij';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../db/index.js');
const { createConfigurationBackup, restoreConfigurationBackup } = await import('../configs/backup.js');

test('createConfigurationBackup produces a versioned encrypted envelope', () => {
  db.createDevice({ name: 'B1', host: '10.0.0.70', osType: 'generic' });
  const backup = createConfigurationBackup('mypassword');
  assert.equal(backup.format, 'routerdeck-config-backup-v1');
  assert.equal(backup.version, 1);
  assert.equal(backup.mode, 'password');
  for (const field of ['salt', 'iv', 'tag', 'payload']) {
    assert.equal(typeof backup[field], 'string');
    assert.ok(backup[field].length > 0, `${field} should be non-empty`);
  }
});

test('password backup roundtrips devices with credentials', () => {
  const backup = createConfigurationBackup('mypassword');
  const restored = restoreConfigurationBackup(backup, 'mypassword');
  assert.deepEqual(restored, { ok: true, devices: 1, services: 0 });
  const dev = db.listDevices().find(d => d.name === 'B1');
  assert.ok(dev);
  assert.equal(dev.host, '10.0.0.70');
});

test('wrong password fails to restore', () => {
  const backup = createConfigurationBackup('right-password');
  assert.throws(
    () => restoreConfigurationBackup(backup, 'wrong-password'),
    /Could not decrypt or restore this backup/,
  );
});

test('app-secret mode encrypts with APP_SECRET when no password is given', () => {
  const backup = createConfigurationBackup('');
  assert.equal(backup.mode, 'app-secret');
  const restored = restoreConfigurationBackup(backup, '');
  assert.deepEqual(restored, { ok: true, devices: 1, services: 0 });
});

test('unsupported formats are rejected', () => {
  assert.throws(
    () => restoreConfigurationBackup({ format: 'something-else', version: 1 }, 'x'),
    /not a supported RouterDeck configuration backup/,
  );
  assert.throws(() => restoreConfigurationBackup(null, 'x'), /not a supported/);
});

test('tampered payloads are rejected as decryption failures', () => {
  const backup = createConfigurationBackup('pw');
  const tampered = { ...backup, payload: 'AAAA' + backup.payload.slice(4) };
  assert.throws(() => restoreConfigurationBackup(tampered, 'pw'), /Could not decrypt or restore/);
});
