import { Router } from 'express';
import { getPublicIp } from '../etc/public-ip.js';
import { sendUpstreamError } from '../etc/http-errors.js';

export function createNetworkRouter() {
  const router = Router();

  router.get('/network/public-ip', async (req, res) => {
    try {
      res.json(await getPublicIp(req.query.force === '1'));
    } catch (error) {
      sendUpstreamError(res, error);
    }
  });

  return router;
}
