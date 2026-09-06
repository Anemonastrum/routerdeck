import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironment } from '../configs/environment.js';

const valid = { APP_SECRET: 'x'.repeat(40), ADMIN_PASSWORD: 'test-password-123' };

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = String(overrides[key]);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('loadEnvironment applies defaults when nothing is set', () => {
  withEnv({ ...valid, PORT: undefined, POLL_INTERVAL_MS: undefined, UPTIME_INTERVAL_MS: undefined, COOKIE_SECURE: undefined }, () => {
    const config = loadEnvironment();
    assert.equal(config.port, 8080);
    assert.equal(config.pollIntervalMs, 15000);
    assert.equal(config.uptimeIntervalMs, 30000);
    assert.equal(config.cookieSecure, false);
  });
});

test('port parsing: numeric string, float truncation, fallback on bad input', () => {
  withEnv({ ...valid, PORT: '3000' }, () => assert.equal(loadEnvironment().port, 3000));
  withEnv({ ...valid, PORT: '8080.9' }, () => assert.equal(loadEnvironment().port, 8080));
  withEnv({ ...valid, PORT: 'abc' }, () => assert.equal(loadEnvironment().port, 8080));
  withEnv({ ...valid, PORT: '-1' }, () => assert.equal(loadEnvironment().port, 8080));
  withEnv({ ...valid, PORT: '0' }, () => assert.equal(loadEnvironment().port, 8080));
  withEnv({ ...valid, PORT: '65535' }, () => assert.equal(loadEnvironment().port, 65535));
});

test('intervals are clamped to their documented minimums', () => {
  withEnv({ ...valid, POLL_INTERVAL_MS: '100' }, () => assert.equal(loadEnvironment().pollIntervalMs, 5000));
  withEnv({ ...valid, UPTIME_INTERVAL_MS: '50' }, () => assert.equal(loadEnvironment().uptimeIntervalMs, 10000));
  withEnv({ ...valid, POLL_INTERVAL_MS: '60000' }, () => assert.equal(loadEnvironment().pollIntervalMs, 60000));
  withEnv({ ...valid, UPTIME_INTERVAL_MS: '12345' }, () => assert.equal(loadEnvironment().uptimeIntervalMs, 12345));
});

test('cookieSecure is true only for the literal "true"', () => {
  withEnv({ ...valid, COOKIE_SECURE: 'true' }, () => assert.equal(loadEnvironment().cookieSecure, true));
  withEnv({ ...valid, COOKIE_SECURE: 'TRUE' }, () => assert.equal(loadEnvironment().cookieSecure, false));
  withEnv({ ...valid, COOKIE_SECURE: '1' }, () => assert.equal(loadEnvironment().cookieSecure, false));
});

test('throws when APP_SECRET is shorter than 32 characters', () => {
  withEnv({ ...valid, APP_SECRET: 'short' }, () => {
    assert.throws(() => loadEnvironment(), /APP_SECRET must be set to at least 32 characters/);
  });
});

test('throws when ADMIN_PASSWORD is missing or still the default', () => {
  withEnv({ APP_SECRET: 'x'.repeat(40), ADMIN_PASSWORD: '' }, () => {
    assert.throws(() => loadEnvironment(), /ADMIN_PASSWORD must be set/);
  });
  withEnv({ APP_SECRET: 'x'.repeat(40), ADMIN_PASSWORD: 'change-this-password' }, () => {
    assert.throws(() => loadEnvironment(), /ADMIN_PASSWORD must be set/);
  });
});

test('returned config is frozen so nothing can mutate it at runtime', () => {
  withEnv(valid, () => {
    const config = loadEnvironment();
    assert.equal(Object.isFrozen(config), true);
    assert.throws(() => { config.port = 1; }, TypeError);
  });
});
