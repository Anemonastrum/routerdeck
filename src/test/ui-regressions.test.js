import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

test('IP camera has separate add choice, stream URL field, and player', () => {
  assert.match(html, /option value="camera">IP camera<\/option>/);
  assert.match(html, /name="rtspUrl"/);
  assert.match(app, /camera-stream-player/);
  assert.match(app, /\/api\/devices\/\$\{d\.id\}\/camera\/stream/);
});

test('connection analytics renders exact source and destination endpoints', () => {
  assert.match(app, /connectionsTable\(data\.connections\|\|\[\]\)/);
});
