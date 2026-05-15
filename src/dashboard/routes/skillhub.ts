import type { Router } from 'express';
import { SkillHubService } from '../../skillhub/service';

export function registerSkillHubRoutes(router: Router): void {
  router.get('/skillhub/status', async (req, res) => {
    try {
      res.json(await serviceFrom(req.query).status());
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/auth/register', async (req, res) => {
    try {
      res.status(201).json(await serviceFrom(req.body).register(req.body || {}));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/auth/login', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).login(req.body || {}));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/auth/logout', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).logout());
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.get('/skillhub/search', async (req, res) => {
    try {
      res.json(await serviceFrom(req.query).search(String(req.query.q || ''), {
        category: String(req.query.category || ''),
      }));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/install', async (req, res) => {
    try {
      const skillId = String(req.body?.skillId || '').trim();
      if (!skillId) return res.status(400).json({ error: 'skillId required' });
      res.json(await serviceFrom(req.body).install(skillId, String(req.body?.version || '').trim() || undefined));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.get('/skillhub/developer', async (req, res) => {
    try {
      res.json(await serviceFrom(req.query).developerDashboard());
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/apply', async (req, res) => {
    try {
      res.status(201).json(await serviceFrom(req.body).applyDeveloper(req.body || {}));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/manifest-draft', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).createManifestDraft(req.body || {}));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/submissions', async (req, res) => {
    try {
      res.status(201).json(await serviceFrom(req.body).createSubmission(req.body || {}));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });
}

function serviceFrom(input: any): SkillHubService {
  return new SkillHubService({ baseUrl: input?.baseUrl });
}

function sendSkillHubError(res: any, error: any): void {
  const status = Number(error?.status || 500);
  res.status(status).json({
    error: error?.message || String(error),
    code: error?.code || 'skillhub.error',
  });
}
