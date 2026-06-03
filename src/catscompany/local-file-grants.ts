import * as fs from 'fs';
import * as path from 'path';
import type {
  ExecutionScope,
  LocalFileGrantFileType,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
} from '../types/session-identity';

export const CATSCOMPANY_ATTACHMENT_GRANT_TTL_MS = 30 * 60 * 1000;

export interface CatsCoDeviceGrantInput {
  bodyId?: string;
  installationId?: string;
  deviceId?: string;
}

export interface CatsCoAttachmentGrantInput {
  localPath: string;
  fileName: string;
  type?: LocalFileGrantFileType;
  workspaceRoot?: string;
}

export function createCatsCoLocalDeviceGrant(input: CatsCoDeviceGrantInput): ScopedLocalDeviceGrant | undefined {
  const bodyId = safeString(input.bodyId);
  if (!bodyId) return undefined;

  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    bodyId,
    installationId: safeString(input.installationId),
    deviceId: safeString(input.deviceId),
    createdAt: Date.now(),
  };
}

export function createCatsCoAttachmentGrant(
  scope: ExecutionScope | undefined,
  localDeviceGrant: ScopedLocalDeviceGrant | undefined,
  input: CatsCoAttachmentGrantInput,
): ScopedLocalFileGrant | undefined {
  if (!scope || scope.source !== 'catscompany') return undefined;
  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted) return undefined;
  if (!scope.agentBodyId) return undefined;
  if (!localDeviceGrant || localDeviceGrant.source !== 'catscompany') return undefined;
  if (scope.agentBodyId !== localDeviceGrant.bodyId) return undefined;

  const filePath = normalizeLocalPath(input.localPath);
  if (!isInsideDownloadsRoot(filePath, input.workspaceRoot)) return undefined;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  const createdAt = Date.now();

  return {
    kind: 'catscompany_attachment',
    source: 'catscompany',
    filePath,
    fileName: input.fileName,
    fileType: input.type || 'unknown',
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    agentBodyId: scope.agentBodyId,
    deviceBodyId: localDeviceGrant.bodyId,
    deviceInstallationId: localDeviceGrant.installationId,
    identityTrust: scope.identityTrust,
    operations: ['read_file', 'send_file'],
    createdAt,
    expiresAt: createdAt + CATSCOMPANY_ATTACHMENT_GRANT_TTL_MS,
  };
}

export function normalizeLocalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsideDownloadsRoot(filePath: string, workspaceRoot = process.cwd()): boolean {
  const downloadsRoot = normalizeLocalPath(path.join(workspaceRoot, 'tmp', 'downloads'));
  const target = normalizeForCompare(filePath);
  const root = normalizeForCompare(downloadsRoot);
  if (target === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(rootWithSep);
}

function normalizeForCompare(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}
