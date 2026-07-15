import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ExecutionScope,
  LocalFileGrantFileType,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
} from '../types/session-identity';
import { isInsideCatsCoAttachmentCacheRoot } from './attachment-cache';

export const CATSCOMPANY_ATTACHMENT_GRANT_TTL_MS = 30 * 60 * 1000;
export const CATSCOMPANY_ATTACHMENT_REF_PREFIX = 'catsco_attachment:';

export interface CatsCoDeviceGrantInput {
  bodyId?: string;
  installationId?: string;
  deviceId?: string;
  ownerUserId?: string;
  capabilities?: ScopedLocalDeviceGrant['capabilities'];
}

export interface CatsCoAttachmentGrantInput {
  localPath: string;
  fileName: string;
  type?: LocalFileGrantFileType;
  workspaceRoot?: string;
  attachmentId?: string;
  receivedAt?: number;
  attachmentSource?: 'user_upload' | 'agent_output';
}

export function createCatsCoLocalDeviceGrant(input: CatsCoDeviceGrantInput): ScopedLocalDeviceGrant | undefined {
  const bodyId = safeString(input.bodyId);
  if (!bodyId) return undefined;

  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: normalizeCatsCoUserId(input.ownerUserId),
    bodyId,
    installationId: safeString(input.installationId),
    deviceId: safeString(input.deviceId),
    capabilities: input.capabilities,
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
  if (!isInsideManagedAttachmentRoot(filePath, input.workspaceRoot)) return undefined;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  const createdAt = Date.now();
  const attachmentId = normalizeAttachmentId(input.attachmentId);

  return {
    kind: 'catscompany_attachment',
    source: 'catscompany',
    attachmentRef: `${CATSCOMPANY_ATTACHMENT_REF_PREFIX}${attachmentId || randomUUID()}`,
    ...(attachmentId && { attachmentId }),
    ...(Number.isFinite(input.receivedAt) && { attachmentReceivedAt: input.receivedAt }),
    ...(input.attachmentSource && { attachmentSource: input.attachmentSource }),
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

function isInsideManagedAttachmentRoot(filePath: string, workspaceRoot = process.cwd()): boolean {
  if (isInsideCatsCoAttachmentCacheRoot(filePath)) return true;

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

function normalizeCatsCoUserId(value: unknown): string | undefined {
  const text = safeString(value);
  if (!text) return undefined;
  return /^\d+$/.test(text) ? `usr${text}` : text;
}

function normalizeAttachmentId(value: unknown): string | undefined {
  const text = safeString(value);
  if (!text || !/^[a-zA-Z0-9._-]{1,80}$/.test(text)) return undefined;
  return text;
}
