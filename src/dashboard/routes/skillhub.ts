import type { Router } from 'express';
import { SkillHubService } from '../../skillhub/service';
import {
  scheduleCurrentBotSkillSync,
  withCurrentBotSkillWorkspaceWrite,
} from '../../bot-skills/runtime';

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
      const result = await withCurrentBotSkillWorkspaceWrite(() => (
        serviceFrom(req.body).install(
          skillId,
          String(req.body?.version || '').trim() || undefined,
        )
      ));
      scheduleCurrentBotSkillSync();
      res.json(result);
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
      res.status(201).json(await shareLocalSkill(req.body || {}, options));
    } catch (error: any) {
      sendSkillHubError(res, error);
    }
  });

  router.post('/skillhub/share-local-skill', async (req, res) => {
    try {
      res.status(201).json(await shareLocalSkill(req.body || {}, options));
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

async function shareLocalSkill(input: any, options: SkillHubRouteOptions): Promise<any> {
  const expectedBotUid = String(input?.expectedBotUid || '').trim();
  const expectedUserUid = String(input?.expectedUserUid || '').trim();
  if (Boolean(expectedBotUid) !== Boolean(expectedUserUid)) {
    throw skillHubConflict(
      'expectedBotUid and expectedUserUid must be provided together.',
      'skillhub.share_scope_incomplete',
    );
  }

  // Preserve the existing Dashboard flow when no explicit WebApp scope is
  // supplied. The WebApp bridge always sends both values and gets the stricter
  // account/workspace checks below.
  if (!expectedBotUid) return serviceFrom(input).shareLocalSkill(input);
  if (!options.getCatsCoAuth) {
    const error: any = new Error('CatsCo SkillHub login is not configured');
    error.status = 501;
    error.code = 'skillhub.catsco_exchange_unavailable';
    throw error;
  }

  // Keep the existing fast-fail behavior for an already changed CatsCo
  // account. This check is only a preflight; the identity is exchanged and
  // checked again inside the workspace lock immediately before upload.
  const preflightCats = await options.getCatsCoAuth();
  if (String(preflightCats.user?.uid || '').trim() !== expectedUserUid) {
    throw skillHubConflict(
      'The local CatsCo account changed before the Skill was shared.',
      'skillhub.share_user_changed',
    );
  }

  return withCurrentBotSkillWorkspaceWrite(async (context) => {
    assertExpectedLocalSkillShareScope(expectedBotUid, context.botId, context.activeBotId);
    // WebApp shares must not reuse the process-wide SkillHub cookie. Re-exchange
    // the current CatsCo identity inside the workspace lock and keep the
    // resulting SkillHub session in memory for this request only.
    const cats = await options.getCatsCoAuth!();
    const service = serviceFrom(input, { sessionScope: 'memory' });
    const skillHubAuth = await service.loginWithCatsCo(cats);
    const actualUserUid = String(skillHubAuth.catsCo?.uid || '').trim();
    if (!actualUserUid) {
      throw skillHubConflict(
        'SkillHub did not return the CatsCo identity for the exchanged session.',
        'skillhub.share_identity_unavailable',
      );
    }
    if (actualUserUid !== expectedUserUid) {
      throw skillHubConflict(
        'The local CatsCo account changed before the Skill was shared.',
        'skillhub.share_user_changed',
      );
    }
    const result = await service.shareLocalSkill(input);
    return { ...result, botUid: expectedBotUid };
  });
}

export function assertExpectedLocalSkillShareScope(
  expectedBotUid: string,
  configuredBotUid?: string,
  activeBotUid?: string,
): void {
  if (configuredBotUid !== expectedBotUid || activeBotUid !== expectedBotUid) {
    throw skillHubConflict(
      'The active Bot Skill workspace changed before the Skill was shared.',
      'skillhub.share_bot_changed',
    );
  }
}

function skillHubConflict(message: string, code: string): Error {
  const error: any = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

function serviceFrom(_input?: any, options: { sessionScope?: 'persistent' | 'memory' } = {}): SkillHubService {
  return new SkillHubService(options);
}

function sendSkillHubError(res: any, error: any): void {
  const status = Number(error?.status || 500);
  res.status(status).json({
    error: error?.message || String(error),
    code: error?.code || 'skillhub.error',
  });
}
