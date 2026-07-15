import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ExecutionScope } from '../types/session-identity';
import { isImageFile } from '../utils/image-utils';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import {
  buildCatsCoAttachmentCachePath,
  CATSCOMPANY_ATTACHMENT_CACHE_MAX_AGE_MS,
  isInsideCatsCoAttachmentCacheRoot,
  scheduleCatsCoAttachmentCacheCleanup,
} from './attachment-cache';

export type CatsCoImageCatalogSource = 'user_upload' | 'agent_output';

export interface CatsCoImageCatalogEntry {
  id: string;
  sessionKey: string;
  topicId: string;
  topicType: ExecutionScope['topicType'];
  actorUserId: string;
  agentId?: string;
  agentBodyId: string;
  source: CatsCoImageCatalogSource;
  fileName: string;
  filePath: string;
  originPath?: string;
  receivedAt: number;
  messageSeq?: number;
}

interface CatsCoImageCatalogDocument {
  schemaVersion: 1;
  sessionKey: string;
  nextSequence: number;
  entries: CatsCoImageCatalogEntry[];
}

export interface RegisterCatsCoImageInput {
  scope?: ExecutionScope;
  fileName: string;
  filePath: string;
  source: CatsCoImageCatalogSource;
  receivedAt?: number;
  messageSeq?: number;
  originPath?: string;
}

const CATSCOMPANY_IMAGE_CATALOG_MAX_ENTRIES = 64;
export const CATSCOMPANY_IMAGE_CATALOG_PROMPT_LIMIT = 8;

export function registerCatsCoImage(input: RegisterCatsCoImageInput): CatsCoImageCatalogEntry | undefined {
  const scope = trustedCatsCoScope(input.scope);
  if (!scope) return undefined;

  const filePath = normalizeExistingImagePath(input.filePath);
  if (!filePath || !isInsideCatsCoAttachmentCacheRoot(filePath)) return undefined;

  const originPath = normalizeOptionalPath(input.originPath);
  const document = loadCatalog(scope.sessionKey);
  const existing = document.entries.find(entry => (
    entry.actorUserId === scope.actorUserId
    && normalizePath(entry.filePath) === filePath
  ));
  if (existing) return existing;

  const entry: CatsCoImageCatalogEntry = {
    id: formatImageId(document.nextSequence),
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    agentBodyId: scope.agentBodyId!,
    source: input.source,
    fileName: safeFileName(input.fileName, filePath),
    filePath,
    ...(originPath && originPath !== filePath ? { originPath } : {}),
    receivedAt: input.receivedAt ?? Date.now(),
    ...(Number.isFinite(input.messageSeq) ? { messageSeq: input.messageSeq } : {}),
  };

  document.nextSequence += 1;
  document.entries.push(entry);
  document.entries = pruneEntries(document.entries)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, CATSCOMPANY_IMAGE_CATALOG_MAX_ENTRIES);
  saveCatalog(document);
  return entry;
}

export function importCatsCoAgentImage(input: Omit<RegisterCatsCoImageInput, 'source'>): CatsCoImageCatalogEntry | undefined {
  const scope = trustedCatsCoScope(input.scope);
  if (!scope) return undefined;

  const sourcePath = normalizeExistingImagePath(input.filePath);
  if (!sourcePath) return undefined;

  const document = loadCatalog(scope.sessionKey);
  const existing = document.entries.find(entry => (
    entry.actorUserId === scope.actorUserId
    && entry.source === 'agent_output'
    && normalizeOptionalPath(entry.originPath) === sourcePath
    && Boolean(normalizeExistingImagePath(entry.filePath))
  ));
  if (existing) return existing;

  try {
    const stablePath = isInsideCatsCoAttachmentCacheRoot(sourcePath)
      ? sourcePath
      : copyIntoManagedCache(scope.sessionKey, input.fileName, sourcePath);
    const entry = registerCatsCoImage({
      ...input,
      scope,
      source: 'agent_output',
      filePath: stablePath,
      originPath: sourcePath,
    });
    scheduleCatsCoAttachmentCacheCleanup();
    return entry;
  } catch (error: any) {
    Logger.warning(`[CatsCo] outgoing image catalog registration failed: ${error?.message || error}`);
    return undefined;
  }
}

export function listRecentCatsCoImages(
  scope: ExecutionScope | undefined,
  limit = CATSCOMPANY_IMAGE_CATALOG_PROMPT_LIMIT,
): CatsCoImageCatalogEntry[] {
  const trustedScope = trustedCatsCoScope(scope);
  if (!trustedScope) return [];

  const document = loadCatalog(trustedScope.sessionKey);
  const pruned = pruneEntries(document.entries);
  if (pruned.length !== document.entries.length) {
    document.entries = pruned;
    saveCatalog(document);
  }

  return pruned
    .filter(entry => entry.actorUserId === trustedScope.actorUserId)
    .filter(entry => entry.topicId === trustedScope.topicId)
    .filter(entry => !entry.agentId || !trustedScope.agentId || entry.agentId === trustedScope.agentId)
    .filter(entry => entry.agentBodyId === trustedScope.agentBodyId)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, Math.max(0, limit));
}

export function clearCatsCoImageCatalog(sessionKey: string): void {
  const filePath = getCatsCoImageCatalogPath(sessionKey);
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error: any) {
    Logger.warning(`[CatsCo] image catalog clear failed: ${error?.message || error}`);
  }
}

export function getCatsCoImageCatalogPath(sessionKey: string): string {
  const safeSession = sessionKey.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
  const digest = createHash('sha256').update(sessionKey).digest('hex').slice(0, 12);
  return PathResolver.getDataPath('image-catalogs', 'catscompany', `${safeSession}_${digest}.json`);
}

function trustedCatsCoScope(scope: ExecutionScope | undefined): ExecutionScope | undefined {
  if (!scope || scope.source !== 'catscompany') return undefined;
  if (!scope.isTrusted || scope.identityTrust !== 'server_canonical') return undefined;
  if (!scope.sessionKey || !scope.topicId || !scope.actorUserId || !scope.agentBodyId) return undefined;
  return scope;
}

function loadCatalog(sessionKey: string): CatsCoImageCatalogDocument {
  const empty = emptyCatalog(sessionKey);
  const filePath = getCatsCoImageCatalogPath(sessionKey);
  if (!fs.existsSync(filePath)) return empty;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CatsCoImageCatalogDocument>;
    if (parsed.schemaVersion !== 1 || parsed.sessionKey !== sessionKey || !Array.isArray(parsed.entries)) {
      return empty;
    }
    const entries = parsed.entries.filter(isCatalogEntry);
    const largestSequence = entries.reduce((max, entry) => Math.max(max, parseImageSequence(entry.id)), 0);
    const nextSequence = Number.isInteger(parsed.nextSequence) && Number(parsed.nextSequence) > largestSequence
      ? Number(parsed.nextSequence)
      : largestSequence + 1;
    return { schemaVersion: 1, sessionKey, nextSequence, entries };
  } catch (error: any) {
    Logger.warning(`[CatsCo] image catalog read failed, rebuilding: ${error?.message || error}`);
    return empty;
  }
}

function saveCatalog(document: CatsCoImageCatalogDocument): void {
  const filePath = getCatsCoImageCatalogPath(document.sessionKey);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error: any) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    Logger.warning(`[CatsCo] image catalog write failed: ${error?.message || error}`);
  }
}

function emptyCatalog(sessionKey: string): CatsCoImageCatalogDocument {
  return { schemaVersion: 1, sessionKey, nextSequence: 1, entries: [] };
}

function pruneEntries(entries: CatsCoImageCatalogEntry[], now = Date.now()): CatsCoImageCatalogEntry[] {
  return entries.filter(entry => {
    if (now - entry.receivedAt > CATSCOMPANY_ATTACHMENT_CACHE_MAX_AGE_MS) return false;
    if (!isInsideCatsCoAttachmentCacheRoot(entry.filePath)) return false;
    return Boolean(normalizeExistingImagePath(entry.filePath));
  });
}

function copyIntoManagedCache(sessionKey: string, fileName: string, sourcePath: string): string {
  const targetPath = buildCatsCoAttachmentCachePath(sessionKey, safeFileName(fileName, sourcePath));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return normalizePath(targetPath);
}

function normalizeExistingImagePath(filePath: string): string | undefined {
  const normalized = normalizeOptionalPath(filePath);
  if (!normalized || !isImageFile(normalized)) return undefined;
  try {
    const stats = fs.statSync(normalized);
    return stats.isFile() ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalPath(filePath: string | undefined): string | undefined {
  if (typeof filePath !== 'string' || !filePath.trim()) return undefined;
  return normalizePath(filePath);
}

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function safeFileName(fileName: string, filePath: string): string {
  const preferred = path.basename(String(fileName || '').trim());
  return preferred || path.basename(filePath) || 'image';
}

function formatImageId(sequence: number): string {
  return `img_${String(Math.max(1, sequence)).padStart(4, '0')}`;
}

function parseImageSequence(id: string): number {
  const match = /^img_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function isCatalogEntry(value: unknown): value is CatsCoImageCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CatsCoImageCatalogEntry>;
  return typeof entry.id === 'string'
    && /^img_\d+$/.test(entry.id)
    && typeof entry.sessionKey === 'string'
    && typeof entry.topicId === 'string'
    && typeof entry.actorUserId === 'string'
    && typeof entry.agentBodyId === 'string'
    && (entry.source === 'user_upload' || entry.source === 'agent_output')
    && typeof entry.fileName === 'string'
    && typeof entry.filePath === 'string'
    && typeof entry.receivedAt === 'number';
}
