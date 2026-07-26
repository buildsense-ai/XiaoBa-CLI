import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

export const CATSCOMPANY_ATTACHMENT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CATSCOMPANY_ATTACHMENT_CACHE_HIGH_WATER_BYTES = 5 * 1024 * 1024 * 1024;
export const CATSCOMPANY_ATTACHMENT_CACHE_LOW_WATER_BYTES = 4 * 1024 * 1024 * 1024;

export interface AttachmentCacheCleanupSummary {
  scanned: number;
  removed: number;
  bytesBefore: number;
  bytesAfter: number;
}

interface CacheFileInfo {
  filePath: string;
  size: number;
  recencyMs: number;
  mtimeMs: number;
}

let cleanupRunning = false;

export function getCatsCoAttachmentCacheRoot(): string {
  return PathResolver.getAttachmentsPath('catscompany');
}

export function buildCatsCoAttachmentCachePath(
  sessionKey: string | undefined,
  fileName: string,
  now = new Date(),
): string {
  const dir = getCatsCoAttachmentCacheSessionRoot(sessionKey);

  const safeName = sanitizeFileName(fileName || 'attachment');
  const stamp = formatTimestamp(now);
  const nonce = randomUUID().slice(0, 8);
  return path.join(dir, `${stamp}_${nonce}_${safeName}`);
}

export function getCatsCoAttachmentCacheSessionRoot(sessionKey: string | undefined): string {
  const sessionSegment = sanitizePathSegment(sessionKey || 'unknown-session');
  return path.join(getCatsCoAttachmentCacheRoot(), sessionSegment);
}

export function isInsideCatsCoAttachmentCacheRoot(filePath: string): boolean {
  return isPathInsideRoot(filePath, getCatsCoAttachmentCacheRoot());
}

export function scheduleCatsCoAttachmentCacheCleanup(): void {
  if (cleanupRunning) return;
  cleanupRunning = true;
  setTimeout(() => {
    cleanupCatsCoAttachmentCache()
      .catch((err: any) => {
        Logger.warning(`[CatsCo] attachment cache cleanup failed: ${err?.message || err}`);
      })
      .finally(() => {
        cleanupRunning = false;
      });
  }, 0);
}

export async function cleanupCatsCoAttachmentCache(
  root = getCatsCoAttachmentCacheRoot(),
  options: {
    now?: number;
    maxAgeMs?: number;
    highWaterBytes?: number;
    lowWaterBytes?: number;
  } = {},
): Promise<AttachmentCacheCleanupSummary> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? CATSCOMPANY_ATTACHMENT_CACHE_MAX_AGE_MS;
  const highWaterBytes = options.highWaterBytes ?? CATSCOMPANY_ATTACHMENT_CACHE_HIGH_WATER_BYTES;
  const lowWaterBytes = options.lowWaterBytes ?? CATSCOMPANY_ATTACHMENT_CACHE_LOW_WATER_BYTES;

  if (!fs.existsSync(root)) {
    return { scanned: 0, removed: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  let files = await listCacheFiles(root);
  const bytesBefore = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;

  for (const file of files) {
    if (now - file.recencyMs <= maxAgeMs) continue;
    if (await removeFileIfExists(file.filePath)) {
      removed += 1;
    }
  }

  files = await listCacheFiles(root);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > highWaterBytes) {
    const byOldestFirst = [...files].sort((a, b) => {
      if (a.recencyMs !== b.recencyMs) return a.recencyMs - b.recencyMs;
      return a.mtimeMs - b.mtimeMs;
    });

    for (const file of byOldestFirst) {
      if (total <= lowWaterBytes) break;
      if (await removeFileIfExists(file.filePath)) {
        removed += 1;
        total -= file.size;
      }
    }
  }

  await removeEmptyDirectories(root);
  const remaining = await listCacheFiles(root);
  const bytesAfter = remaining.reduce((sum, file) => sum + file.size, 0);

  if (removed > 0) {
    Logger.info(`[CatsCo] attachment cache cleanup removed=${removed} before=${bytesBefore} after=${bytesAfter}`);
  }

  return {
    scanned: files.length,
    removed,
    bytesBefore,
    bytesAfter,
  };
}

async function listCacheFiles(root: string): Promise<CacheFileInfo[]> {
  const results: CacheFileInfo[] = [];
  await visit(root, results);
  return results;
}

async function visit(dir: string, results: CacheFileInfo[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.part')) continue;

    try {
      const stats = await fsp.stat(fullPath);
      results.push({
        filePath: fullPath,
        size: stats.size,
        recencyMs: Math.max(stats.atimeMs || 0, stats.mtimeMs || 0),
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // File disappeared during cleanup; ignore it.
    }
  }
}

async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    Logger.warning(`[CatsCo] attachment cache file delete failed: ${filePath}: ${err?.message || err}`);
    return false;
  }
}

async function removeEmptyDirectories(root: string): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return true;
  }

  let empty = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false;
      continue;
    }
    const child = path.join(root, entry.name);
    const childEmpty = await removeEmptyDirectories(child);
    if (childEmpty) {
      try {
        await fsp.rmdir(child);
      } catch {
        empty = false;
      }
    } else {
      empty = false;
    }
  }

  return empty;
}

function sanitizePathSegment(value: string): string {
  const text = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return text.slice(0, 120) || 'unknown';
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim();
  const normalized = base.replace(/\s+/g, ' ');
  return normalized.slice(0, 160) || 'attachment';
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '_',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const target = normalizeForCompare(filePath);
  const base = normalizeForCompare(root);
  if (target === base) return true;
  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target.startsWith(baseWithSep);
}

function normalizeForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    // Missing paths still need a stable lexical comparison.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
