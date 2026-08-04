import type { Router } from 'express';
import { readTurnErrorReport } from '../../observability/turn-error-reader';

export function registerTurnErrorRoutes(router: Router): void {
  router.get('/observability/turn-errors', (req, res) => {
    try {
      const days = firstQueryValue(req.query.days);
      const limit = firstQueryValue(req.query.limit);
      res.json(readTurnErrorReport({
        ...(days && { days: Number(days) }),
        ...(limit && { limit: Number(limit) }),
      }));
    } catch (error: any) {
      res.status(500).json({
        error: 'turn_error_report_failed',
        message: String(error?.message || error || 'unknown error').slice(0, 240),
      });
    }
  });
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}
