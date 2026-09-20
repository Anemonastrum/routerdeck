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

test('Ruijie add device menu supports custom Cloud region with custom hostname/ip input', () => {
  assert.match(html, /id="ruijie-region"[\s\S]*option value="custom">Custom IP \/ hostname<\/option>/);
  assert.match(html, /id="ruijie-custom-region-row"[\s\S]*name="ruijieBaseUrl"/);
  assert.match(app, /customRegion\?\.classList\.toggle\('hidden',\s*!isCustom\)/);
  assert.match(app, /customRegionInput\.disabled = false/);
});

test('connection analytics renders exact source and destination endpoints', () => {
  assert.match(app, /connectionsTable\(data\.connections\|\|\[\]\)/);
});
