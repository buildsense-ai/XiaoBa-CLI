import type { Router } from 'express';
import { getPetService } from '../../pet/pet-service';

export function registerPetRoutes(router: Router): void {
  router.get('/pet/status', (_req, res) => {
    try {
      res.json(getPetService().status());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/pet/timeline', (req, res) => {
    try {
      res.json({
        events: getPetService().timeline(Number(req.query.limit || 20)),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/pet/progress', (_req, res) => {
    try {
      res.json(getPetService().progress());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });
}
