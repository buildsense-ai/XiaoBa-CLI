import type { Router } from 'express';
import { getPetService } from '../../pet/pet-service';
import {
  applyPromptCompanionProposal,
  dismissPromptCompanionProposal,
  getCachedPromptCompanionProposal,
  getPromptCompanionProposal,
} from '../../pet/prompt-companion';

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

  router.get('/pet/prompt-proposal', async (_req, res) => {
    try {
      res.json(await getCachedPromptCompanionProposal());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.post('/pet/prompt-proposal', async (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(await getPromptCompanionProposal({
        includeDismissed: Boolean(req.body?.include_dismissed),
        note: String(req.body?.note || ''),
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.post('/pet/prompt-proposal/apply', async (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(await applyPromptCompanionProposal(String(req.body?.id || '')));
    } catch (error: any) {
      res.status(400).json({ error: error?.message || String(error) });
    }
  });

  router.post('/pet/prompt-proposal/dismiss', async (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(await dismissPromptCompanionProposal(String(req.body?.id || '')));
    } catch (error: any) {
      res.status(400).json({ error: error?.message || String(error) });
    }
  });
}

function requireJsonWrite(req: any, res: any): boolean {
  if (req.is('application/json')) return true;
  res.status(415).json({ error: 'application/json required' });
  return false;
}
