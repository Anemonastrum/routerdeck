import { Router } from 'express';
import { getTopology, saveTopology } from '../db/topology.js';

export function createTopologyRouter() {
  const router = Router();

  router.get('/topology', (_req, res) => {
    try {
      res.json(getTopology());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/topology', (req, res) => {
    try {
      res.json(saveTopology(req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}
