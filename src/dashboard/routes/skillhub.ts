import type { Router } from 'express';
import { SkillHubService } from '../../skillhub/service';

export interface SkillHubCatsCoAuthPayload {
  token: string;
  baseUrl: string;
  user?: {
    uid?: string;
    username?: string;
    displayName?: string;
  };
}

export interface SkillHubRouteOptions {
  getCatsCoAuth?: () => Promise<SkillHubCatsCoAuthPayload> | SkillHubCatsCoAuthPayload;
  mutate?<T>(operation: () => Promise<T> | T): Promise<T>;
}

export function registerSkillHubRoutes(router: Router, options: SkillHubRouteOptions = {}): void {
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

  router.post('/skillhub/auth/catsco', async (req, res) => {
    try {
      if (!options.getCatsCoAuth) {
        return res.status(501).json({
          error: 'CatsCo SkillHub login is not configured',
          code: 'skillhub.catsco_exchange_unavailable',
        });
      }
      const cats = await options.getCatsCoAuth();
      res.json(await serviceFrom(req.body).loginWithCatsCo(cats));
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

  router.get('/skillhub/versions', async (req, res) => {
    try {
      const skillId = String(req.query.skillId || '').trim();
      if (!skillId) return res.status(400).json({ error: 'skillId required' });
      res.json(await serviceFrom(req.query).versions(skillId));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/install', async (req, res) => {
    try {
      const skillId = String(req.body?.skillId || '').trim();
      if (!skillId) return res.status(400).json({ error: 'skillId required' });
      const install = () => serviceFrom(req.body).install(
        skillId,
        String(req.body?.version || '').trim() || undefined,
      );
      res.json(await (options.mutate ? options.mutate(install) : install()));
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
      res.status(410).json({
        error: 'SkillHub developer applications are retired. Logged-in users can share Skills directly.',
        code: 'skillhub.developer_flow_retired',
      });
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/manifest-draft', async (req, res) => {
    try {
      res.status(410).json({
        error: 'SkillHub manifest draft generation is retired. Share a local Skill directly.',
        code: 'skillhub.review_flow_retired',
      });
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/submissions', async (req, res) => {
    try {
      res.status(410).json({
        error: 'SkillHub review submissions are retired. Use direct Skill sharing.',
        code: 'skillhub.review_flow_retired',
      });
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/share-local-skill', async (req, res) => {
    try {
      const share = () => serviceFrom(req.body).shareLocalSkill(req.body || {});
      res.status(201).json(await (options.mutate ? options.mutate(share) : share()));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/share-local-skill', async (req, res) => {
    try {
      const share = () => serviceFrom(req.body).shareLocalSkill(req.body || {});
      res.status(201).json(await (options.mutate ? options.mutate(share) : share()));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/developer/package-versions/:id/yank', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).yankOwnPackageVersion(String(req.params.id || ''), String(req.body?.reason || '')));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/me/package-versions/:id/yank', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).yankOwnPackageVersion(String(req.params.id || ''), String(req.body?.reason || '')));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/me/package-versions/:id/restore', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).restoreOwnPackageVersion(String(req.params.id || '')));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.delete('/skillhub/me/package-versions/:id', async (req, res) => {
    try {
      res.json(await serviceFrom(req.body).deleteOwnPackageVersion(String(req.params.id || '')));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });
}

function serviceFrom(_input?: any): SkillHubService {
  return new SkillHubService();
}

function sendSkillHubError(res: any, error: any): void {
  const status = Number(error?.status || 500);
  res.status(status).json({
    error: error?.message || String(error),
    code: error?.code || 'skillhub.error',
  });
}
