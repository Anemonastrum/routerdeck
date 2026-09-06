process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'topology-test-secret-0123456789abcdefgh';
process.env.ADMIN_PASSWORD = 'test-admin-pw';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../db/index.js');
const topo = await import('../db/topology.js');

function addGeneric(name, host) {
  return db.createDevice({ name, host, osType: 'generic' });
}

test('getTopology auto-creates one node per device with layout coordinates', () => {
  const d0 = addGeneric('D0', '10.0.0.60');
  const d1 = addGeneric('D1', '10.0.0.61');
  const d2 = addGeneric('D2', '10.0.0.62');
  const d3 = addGeneric('D3', '10.0.0.63');
  const d4 = addGeneric('D4', '10.0.0.64');
  const topoData = topo.getTopology();
  assert.equal(topoData.nodes.length, 5);
  const byDevice = Object.fromEntries(topoData.nodes.map(n => [n.entityId, n]));
  assert.equal(byDevice[d0.id].x, 70);   // column 0, slot 0
  assert.equal(byDevice[d0.id].y, 72);
  assert.equal(byDevice[d1.id].y, 292);  // slot 1
  assert.equal(byDevice[d4.id].x, 690);  // column 1 (index 4)
  assert.equal(byDevice[d4.id].y, 72);
  assert.ok(topoData.nodes.every(n => n.entityType === 'device'));
});

test('saveTopology moves nodes and clamps coordinates', () => {
  const topoData = topo.getTopology();
  const first = topoData.nodes[0];
  const saved = topo.saveTopology({
    nodes: [{ id: first.id, x: 100, y: 200 }],
    links: [],
  });
  const moved = saved.nodes.find(n => n.id === first.id);
  assert.equal(moved.x, 100);
  assert.equal(moved.y, 200);
  // Clamping: negatives -> 0, huge -> max, non-finite -> 0.
  const clamped = topo.saveTopology({
    nodes: [
      { id: first.id, x: -5, y: 50000 },
      { id: first.id + 1, x: 'abc', y: 3.7 },
    ],
    links: [],
  });
  const c1 = clamped.nodes.find(n => n.id === first.id);
  assert.equal(c1.x, 0);
  assert.equal(c1.y, 10000);
  const c2 = clamped.nodes.find(n => n.id === first.id + 1);
  assert.equal(c2.x, 0);
  assert.equal(c2.y, 4);
});

test('saveTopology ignores unknown or invalid node ids', () => {
  const before = topo.getTopology();
  const saved = topo.saveTopology({
    nodes: [{ id: 999999, x: 5, y: 5 }, { id: 'xx', x: 5, y: 5 }],
    links: [],
  });
  assert.deepEqual(saved.nodes.map(n => n.id), before.nodes.map(n => n.id));
});

test('saveTopology dedupes links, normalizes direction and skips invalid ones', () => {
  const nodes = topo.getTopology().nodes;
  const [a, b, c] = [nodes[0], nodes[1], nodes[2]];
  const saved = topo.saveTopology({
    nodes: [],
    links: [
      { sourceNodeId: b.id, targetNodeId: a.id }, // reversed pair
      { sourceNodeId: a.id, targetNodeId: b.id }, // duplicate of the same pair
      { sourceNodeId: a.id, targetNodeId: a.id }, // self-link -> skipped
      { sourceNodeId: a.id, targetNodeId: 999999 }, // unknown target -> skipped
      { sourceNodeId: a.id, targetNodeId: c.id },
    ],
  });
  const byKeys = saved.links.map(l => `${l.sourceNodeId}:${l.targetNodeId}`).sort();
  assert.deepEqual(byKeys, [`${a.id}:${b.id}`, `${a.id}:${c.id}`]);
  assert.ok(saved.links.every(l => l.sourceNodeId < l.targetNodeId));
});

test('deleting a device removes its topology node and links', () => {
  const dev = addGeneric('Doomed', '10.0.0.65');
  const prev = topo.getTopology();
  const node = prev.nodes.find(n => n.entityId === dev.id);
  topo.saveTopology({ nodes: [], links: [{ sourceNodeId: node.id, targetNodeId: prev.nodes[0].id }] });
  assert.equal(topo.getTopology().links.length, 1);
  assert.equal(db.deleteDevice(dev.id), true);
  const now = topo.getTopology();
  assert.equal(now.nodes.some(n => n.entityId === dev.id), false);
  assert.equal(now.links.length, 0);
});
