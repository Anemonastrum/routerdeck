import db from './connection.js';

const MAX_COORDINATE = 10000;

function clampCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(MAX_COORDINATE, Math.round(number)));
}

function syncTopologyNodes() {
  // Topology intentionally contains network devices only. Older 1.17.3 service
  // nodes are removed once; cascading foreign keys clean their saved links.
  db.prepare('DELETE FROM topology_nodes WHERE service_id IS NOT NULL').run();

  const devices = db.prepare('SELECT id FROM devices ORDER BY display_order ASC, id ASC').all();
  const existing = new Set(
    db.prepare('SELECT device_id FROM topology_nodes WHERE device_id IS NOT NULL').all()
      .map(row => Number(row.device_id)),
  );
  const insert = db.prepare('INSERT OR IGNORE INTO topology_nodes(device_id,service_id,x,y,updated_at) VALUES (?,NULL,?,?,?)');
  const now = Date.now();

  devices.forEach((row, index) => {
    if (existing.has(Number(row.id))) return;
    const column = Math.floor(index / 4);
    const slot = index % 4;
    insert.run(row.id, 70 + column * 620, 72 + slot * 220, now);
  });
}

export function getTopology() {
  syncTopologyNodes();
  const nodes = db.prepare(`
    SELECT id, device_id, x, y, updated_at
    FROM topology_nodes
    WHERE device_id IS NOT NULL
    ORDER BY id ASC
  `).all().map(row => ({
    id: Number(row.id),
    entityType: 'device',
    entityId: Number(row.device_id),
    x: Number(row.x || 0),
    y: Number(row.y || 0),
    updatedAt: Number(row.updated_at || 0),
  }));

  const nodeIds = new Set(nodes.map(node => node.id));
  const links = db.prepare('SELECT id, source_node_id, target_node_id, created_at FROM topology_links ORDER BY id ASC').all()
    .filter(row => nodeIds.has(Number(row.source_node_id)) && nodeIds.has(Number(row.target_node_id)))
    .map(row => ({
      id: Number(row.id),
      sourceNodeId: Number(row.source_node_id),
      targetNodeId: Number(row.target_node_id),
      createdAt: Number(row.created_at || 0),
    }));

  return { nodes, links };
}

export function saveTopology(input = {}) {
  syncTopologyNodes();
  const currentNodeIds = new Set(
    db.prepare('SELECT id FROM topology_nodes WHERE device_id IS NOT NULL').all().map(row => Number(row.id)),
  );
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const links = Array.isArray(input.links) ? input.links : [];
  const updateNode = db.prepare('UPDATE topology_nodes SET x=?, y=?, updated_at=? WHERE id=? AND device_id IS NOT NULL');
  const insertLink = db.prepare('INSERT OR IGNORE INTO topology_links(source_node_id,target_node_id,created_at) VALUES (?,?,?)');

  const transaction = db.transaction(() => {
    const now = Date.now();
    for (const node of nodes) {
      const id = Number(node?.id);
      if (!Number.isInteger(id) || !currentNodeIds.has(id)) continue;
      updateNode.run(clampCoordinate(node.x), clampCoordinate(node.y), now, id);
    }

    db.prepare('DELETE FROM topology_links').run();
    const seen = new Set();
    for (const link of links) {
      let source = Number(link?.sourceNodeId);
      let target = Number(link?.targetNodeId);
      if (!Number.isInteger(source) || !Number.isInteger(target) || source === target) continue;
      if (!currentNodeIds.has(source) || !currentNodeIds.has(target)) continue;
      if (source > target) [source, target] = [target, source];
      const key = `${source}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insertLink.run(source, target, now);
    }
  });

  transaction();
  return getTopology();
}
