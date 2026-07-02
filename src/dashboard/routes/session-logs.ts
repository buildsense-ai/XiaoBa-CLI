import type { Router } from 'express';
import {
  listRecentSessionLogs,
  readSessionLogByFileId,
} from '../session-logs';

export function registerSessionLogRoutes(router: Router): void {
  router.get('/sessions/recent', (req, res) => {
    try {
      res.json({
        sessions: listRecentSessionLogs({
          days: req.query.days ? Number(req.query.days) : undefined,
          type: String(req.query.type || 'all'),
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/sessions/:id', (req, res) => {
    try {
      const detail = readSessionLogByFileId(String(req.params.id || ''));
      if (!detail) {
        res.status(404).json({ error: 'session log not found' });
        return;
      }
      res.json(detail);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });
}
