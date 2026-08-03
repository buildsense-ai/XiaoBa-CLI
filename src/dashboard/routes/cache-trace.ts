import type { Router } from 'express';
import { readCacheTraceStore, type CacheTraceStore } from '../../observability/cache-trace-reader';
import {
  isCacheTraceEnabled,
  resolveCacheTraceDir,
} from '../../observability/cache-trace';
import { PathResolver } from '../../utils/path-resolver';
import { writeDashboardEnvUpdates } from '../settings';
import type { ServiceManager } from '../service-manager';

export interface CacheTraceRouteOptions {
  traceDir?: string;
  cacheMs?: number;
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  serviceManager?: Pick<ServiceManager, 'getService' | 'restart'>;
}

export function registerCacheTraceRoutes(router: Router, options: CacheTraceRouteOptions = {}): void {
  const env = options.env ?? process.env;
  const runtimeRoot = options.runtimeRoot ?? PathResolver.getRuntimeDataRoot(env);
  let cached: CacheTraceStore | undefined;
  let cachedAt = 0;
  const load = async (): Promise<CacheTraceStore> => {
    const now = Date.now();
    if (cached && now - cachedAt < (options.cacheMs ?? 3000)) return cached;
    cached = await readCacheTraceStore(options.traceDir || resolveCacheTraceDir());
    cachedAt = now;
    return cached;
  };

  router.get('/cache-trace/status', async (_req, res) => {
    try {
      const store = await load();
      res.json({ ok: true, traceDir: store.traceDir, scannedFiles: store.scannedFiles, malformedFiles: store.malformedFiles, records: store.records.length, sessions: store.sessions.length });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.get('/cache-trace/config', (_req, res) => {
    const connector = options.serviceManager?.getService('catscompany');
    res.json({
      ok: true,
      enabled: isCacheTraceEnabled(env),
      dashboardAvailable: true,
      connectorStatus: connector?.status ?? 'unmanaged',
    });
  });

  router.put('/cache-trace/config', (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
      }

      const enabled = req.body.enabled;
      const value = enabled ? 'true' : 'false';
      writeDashboardEnvUpdates(runtimeRoot, { XIAOBA_CACHE_TRACE: value });
      env.XIAOBA_CACHE_TRACE = value;

      const connector = options.serviceManager?.getService('catscompany');
      const connectorRestarted = connector?.status === 'running';
      if (connectorRestarted) options.serviceManager?.restart('catscompany');

      res.json({
        ok: true,
        enabled,
        dashboardAvailable: true,
        connectorRestarted,
        appliesOnNextStart: !connectorRestarted,
      });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.get('/cache-trace/sessions', async (_req, res) => {
    try {
      const store = await load();
      res.json({ ok: true, sessions: store.sessions });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.get('/cache-trace/session/:sessionId', async (req, res) => {
    try {
      const store = await load();
      const sessionId = String(req.params.sessionId || '');
      const records = store.records.filter(record => record.sessionId === sessionId);
      if (records.length === 0) return res.status(404).json({ ok: false, error: 'cache trace session not found' });
      res.json({ ok: true, session: store.sessions.find(item => item.sessionId === sessionId), records });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
}
