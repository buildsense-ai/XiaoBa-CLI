import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { Logger } from '../utils/logger';

const AUTH_HEADER_BEARER = 'authorization';
const AUTH_HEADER_API_KEY = 'x-api-key';

// Routes that don't require authentication for safe read-only methods.
// NOTE: When this middleware is mounted at '/api' via app.use('/api', middleware, router),
// Express strips the '/api' prefix from req.path. So we match on the relative path
// (e.g. '/status' instead of '/api/status').
const PUBLIC_API_ROUTES = new Set([
  '/readiness',
  '/status',
]);
const PUBLIC_API_METHODS = new Set(['GET', 'HEAD']);

// Rate limiting: track failed auth attempts per IP
const MAX_FAILED_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

export interface DashboardAuthConfig {
  /** The API key required for authentication, or undefined to disable auth */
  apiKey?: string;
}

export interface DashboardAuthStatus {
  enabled: boolean;
  configured: boolean;
}

export interface DashboardAuthController {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getStatus: () => DashboardAuthStatus;
}

/**
 * Create dashboard authentication middleware.
 * The config and rate-limit state are instance-scoped so multiple dashboard
 * servers/tests do not overwrite each other through module-level globals.
 */
export function createDashboardAuth(config: DashboardAuthConfig): DashboardAuthController {
  // Trim the API key to prevent mismatches caused by accidental whitespace
  // in environment variables. If the key is empty or whitespace-only after
  // trimming, treat auth as disabled to avoid a permanent lockout.
  const apiKey = config.apiKey?.trim() || undefined;
  const failedAttempts = new Map<string, { count: number; resetAt: number }>();

  if (apiKey) {
    Logger.info('Dashboard API authentication is enabled (DASHBOARD_API_KEY set)');
  } else {
    Logger.info('Dashboard API authentication is disabled (no DASHBOARD_API_KEY)');
  }

  function getStatus(): DashboardAuthStatus {
    return {
      enabled: Boolean(apiKey),
      configured: Boolean(apiKey),
    };
  }

  function cleanupExpiredAttempts(now = Date.now()): void {
    for (const [ip, entry] of failedAttempts) {
      if (now >= entry.resetAt) {
        failedAttempts.delete(ip);
      }
    }
  }

  function getRateLimitEntry(ip: string): { count: number; resetAt: number } | undefined {
    const entry = failedAttempts.get(ip);
    if (!entry) return undefined;
    if (Date.now() >= entry.resetAt) {
      failedAttempts.delete(ip);
      return undefined;
    }
    return entry;
  }

  function isRateLimited(ip: string): boolean {
    const entry = getRateLimitEntry(ip);
    return Boolean(entry && entry.count >= MAX_FAILED_ATTEMPTS);
  }

  function retryAfterSeconds(ip: string): number {
    const entry = getRateLimitEntry(ip);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }

  function recordFailedAttempt(ip: string): void {
    const now = Date.now();
    cleanupExpiredAttempts(now);
    const entry = failedAttempts.get(ip);
    if (!entry || now >= entry.resetAt) {
      failedAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  function clearFailedAttempts(ip: string): void {
    failedAttempts.delete(ip);
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // Skip auth if no API key is configured
    if (!apiKey) {
      next();
      return;
    }

    // Allow public health/status routes only for read-only methods.
    // req.path is relative to the '/api' mount point. Strip trailing slash so
    // /status/ is treated the same as /status.
    const normalizedPath = req.path.endsWith('/') && req.path.length > 1
      ? req.path.slice(0, -1)
      : req.path;
    if (PUBLIC_API_METHODS.has(req.method.toUpperCase()) && PUBLIC_API_ROUTES.has(normalizedPath)) {
      next();
      return;
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const providedKey = extractApiKey(req);

    // A correct key should always recover from previous failures. This avoids
    // locking out the local dashboard after startup noise or stale stored keys.
    if (providedKey && safeCompare(providedKey, apiKey)) {
      clearFailedAttempts(clientIp);
      next();
      return;
    }

    if (isRateLimited(clientIp)) {
      res.setHeader('Retry-After', String(retryAfterSeconds(clientIp)));
      res.status(429).json({
        error: 'Too many requests',
        code: 'dashboard_auth_rate_limited',
        message: 'Too many failed authentication attempts. Please try again later.',
      });
      return;
    }

    if (!providedKey) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'dashboard_auth_required',
        message: 'Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.',
      });
      return;
    }

    recordFailedAttempt(clientIp);
    res.status(403).json({
      error: 'Forbidden',
      code: 'dashboard_auth_invalid',
      message: 'Invalid API key.',
    });
    return;
  }

  return { middleware, getStatus };
}

/**
 * Fixed-size digest comparison to avoid timingSafeEqual length errors and avoid
 * directly comparing variable-length API key buffers.
 */
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function extractApiKey(req: Request): string | undefined {
  // Try Authorization: Bearer <key>
  const authHeader = req.headers[AUTH_HEADER_BEARER];
  if (authHeader) {
    const parts = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const match = parts.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const key = match[1].trim();
      if (key) return key;
    }
  }

  // Try X-API-Key header
  const apiKeyHeader = req.headers[AUTH_HEADER_API_KEY];
  if (apiKeyHeader) {
    const key = Array.isArray(apiKeyHeader) ? apiKeyHeader[0].trim() : apiKeyHeader.trim();
    if (key) return key;
  }

  return undefined;
}
