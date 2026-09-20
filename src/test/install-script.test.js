import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');

test('installer deploys published image with persistent data', () => {
  assert.match(script, /anemonastrum\/routerdeck:\$\{ROUTERDECK_TAG:-latest\}/);
  assert.match(script, /routerdeck-data:\/data/);
  assert.match(script, /\$DOCKER compose/);
  assert.doesNotMatch(script, /build:/);
});

test('installer generates secrets without replacing an existing environment', () => {
  assert.match(script, /\/dev\/urandom/);
  assert.match(script, /if \[ ! -f "\$ENV_FILE" \]/);
  assert.match(script, /umask 077/);
});
