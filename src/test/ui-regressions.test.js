import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

test('IP camera is a network device type with stream URL field and player', () => {
  assert.match(html, /id="os-type"[\s\S]*option value="ip_camera">IP camera<\/option>/);
  assert.doesNotMatch(html, /id="entry-kind"[\s\S]*option value="camera">IP camera<\/option>/);
  assert.match(html, /name="rtspUrl"/);
  assert.match(app, /camera-stream-player/);
  assert.match(app, /\/api\/devices\/\$\{d\.id\}\/camera\/stream/);
});

test('connection analytics renders exact source and destination endpoints', () => {
  assert.match(app, /connectionsTable\(data\.connections\|\|\[\]\)/);
});
