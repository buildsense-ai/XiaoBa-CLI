import type { Router } from 'express';
import { getPetService } from '../../pet/pet-service';
import {
  applyPromptCompanionProposal,
  dismissPromptCompanionProposal,
  getCachedPromptCompanionProposal,
  getPromptCompanionProposal,
} from '../../pet/prompt-companion';
import { getDailyReport, saveDailyReport } from '../../pet/daily-report-companion';
import { applySkillDraft, getSkillDrafts } from '../../pet/skill-draft-companion';
import { getSkillCompanionRecommendations } from '../../pet/skill-companion';

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

  router.get('/pet/skill-recommendations', (req, res) => {
    try {
      res.json(getSkillCompanionRecommendations({
        days: req.query.days ? Number(req.query.days) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/pet/skill-drafts', (req, res) => {
    try {
      res.json(getSkillDrafts({
        days: req.query.days ? Number(req.query.days) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/pet/daily-report', (req, res) => {
    try {
      res.json(getDailyReport({
        date: req.query.date ? String(req.query.date) : undefined,
        days: req.query.days ? Number(req.query.days) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.post('/pet/daily-report/save', (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(saveDailyReport({
        date: req.body?.date ? String(req.body.date) : undefined,
        days: req.body?.days ? Number(req.body.days) : undefined,
        limit: req.body?.limit ? Number(req.body.limit) : undefined,
      }));
    } catch (error: any) {
      res.status(Number(error?.status || 500)).json({ error: error?.message || String(error) });
    }
  });

  router.post('/pet/skill-drafts/apply', (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(applySkillDraft(String(req.body?.id || '')));
    } catch (error: any) {
      res.status(Number(error?.status || 500)).json({ error: error?.message || String(error) });
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
