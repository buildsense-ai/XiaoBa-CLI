import * as fs from 'fs';
import * as path from 'path';
import type { LocalFileGrantOperation, ScopedLocalFileGrant } from '../types/session-identity';
import type { ToolErrorCode, ToolExecutionContext } from '../types/tool';

export type LocalFileOperation = 'read_file' | 'send_file';

export type LocalFileAccessDecision =
  | { ok: true; grant?: ScopedLocalFileGrant; displayPath?: string }
  | { ok: false; errorCode: ToolErrorCode; message: string };

export type LocalFileReferenceDecision =
  | { matched: false }
  | { matched: true; ok: true; absolutePath: string; displayPath: string; grant: ScopedLocalFileGrant }
  | { matched: true; ok: false; errorCode: ToolErrorCode; message: string };

interface ResolveLocalFileAccessOptions {
  operation: LocalFileOperation;
  absolutePath: string;
}

interface ResolveLocalFileReferenceOptions {
  operation: LocalFileOperation;
  inputPath: string;
}

const CATSCOMPANY_ATTACHMENT_REF_PREFIX = 'catsco_attachment:';
const MANAGED_ATTACHMENT_CACHE_DISPLAY_PATH = '[CatsCo managed attachment cache]';

export function resolveLocalFileAccess(
  context: ToolExecutionContext,
  options: ResolveLocalFileAccessOptions,
): LocalFileAccessDecision {
  if (context.surface !== 'catscompany') {
    return { ok: true };
  }

  const absolutePath = normalizePath(options.absolutePath);
  const matchingGrant = findMatchingGrant(context.localFileGrants, absolutePath);
  if (matchingGrant) {
    const displayPath = displayPathForGrant(matchingGrant);
    const access = validateGrant(context, matchingGrant, absolutePath, options.operation, displayPath);
    if (!access.ok) return access;
    return { ok: true, grant: matchingGrant, displayPath };
  }

  if (!isManagedCatsCoDownloadPath(context, absolutePath)) {
    return { ok: true };
  }

  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: [
      '该本地附件缓存不属于当前已授权的用户消息，已阻止访问。',
      '请让用户在当前会话重新上传附件，或使用本轮消息中明确提供的授权附件引用。',
      `Path: ${MANAGED_ATTACHMENT_CACHE_DISPLAY_PATH}`,
    ].join('\n'),
  };
}

export function resolveLocalFileReference(
  context: ToolExecutionContext,
  options: ResolveLocalFileReferenceOptions,
): LocalFileReferenceDecision {
  const attachmentRef = normalizeAttachmentReference(options.inputPath);
  if (!attachmentRef) return { matched: false };

  if (context.surface !== 'catscompany') {
    return {
      matched: true,
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: 'CatsCo 附件引用只能在当前 CatsCo 会话中使用。',
    };
  }

  const matchingGrant = findMatchingGrantByReference(context.localFileGrants, attachmentRef);
  if (!matchingGrant) {
    return {
      matched: true,
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        '该附件引用不属于当前已授权的用户消息，已阻止访问。',
        '请让用户在当前会话重新上传附件，或使用本轮消息中明确提供的授权附件引用。',
        `Attachment ref: ${attachmentRef}`,
      ].join('\n'),
    };
  }

  const absolutePath = normalizePath(matchingGrant.filePath);
  const access = validateGrant(context, matchingGrant, absolutePath, options.operation, attachmentRef);
  if (!access.ok) {
    return {
      matched: true,
      ok: false,
      errorCode: access.errorCode,
      message: access.message,
    };
  }

  return {
    matched: true,
    ok: true,
    absolutePath,
    displayPath: attachmentRef,
    grant: matchingGrant,
  };
}

function validateGrant(
  context: ToolExecutionContext,
  grant: ScopedLocalFileGrant,
  absolutePath: string,
  operation: LocalFileGrantOperation,
  displayPath = absolutePath,
): LocalFileAccessDecision {
  const scope = context.executionScope;
  if (!scope || scope.source !== 'catscompany') {
    return denied('当前工具调用缺少 CatsCo 执行身份，无法访问本地附件缓存。', displayPath);
  }

  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return denied('当前消息身份未通过服务端一致性校验，无法访问本地附件缓存。', displayPath);
  }

  if (grant.identityTrust !== 'server_canonical' || grant.source !== 'catscompany') {
    return denied('本地文件授权不是服务端可信 CatsCo 身份生成的授权，已阻止访问。', displayPath);
  }

  if (!grant.operations.includes(operation)) {
    return denied(`本地文件授权不允许执行 ${operation}。`, displayPath);
  }

  if (grant.expiresAt <= Date.now()) {
    return denied('本地文件授权已过期，请让用户在当前会话重新上传附件。', displayPath);
  }

  const localDeviceGrant = context.localDeviceGrant;
  if (!localDeviceGrant || localDeviceGrant.source !== 'catscompany') {
    return denied('当前本机运行体缺少 CatsCo body 授权，无法访问本地附件缓存。', displayPath);
  }

  const mismatches = [
    ['sessionKey', grant.sessionKey, scope.sessionKey],
    ['topicId', grant.topicId, scope.topicId],
    ['actorUserId', grant.actorUserId, scope.actorUserId],
    ['agentBodyId', grant.agentBodyId, scope.agentBodyId],
    ['deviceBodyId', grant.deviceBodyId, localDeviceGrant.bodyId],
  ].filter(([, grantValue, scopeValue]) => grantValue !== scopeValue);

  if (grant.deviceInstallationId
    && localDeviceGrant.installationId
    && grant.deviceInstallationId !== localDeviceGrant.installationId) {
    mismatches.push(['deviceInstallationId', grant.deviceInstallationId, localDeviceGrant.installationId]);
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        '本地文件授权与当前执行身份不一致，已阻止访问以避免串用户或串设备。',
        ...mismatches.map(([field, grantValue, scopeValue]) => `${field}: grant=${grantValue || '(empty)'} scope=${scopeValue || '(empty)'}`),
        targetLine(displayPath),
      ].join('\n'),
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return denied('授权附件文件已不存在，请让用户重新上传。', displayPath);
  }
  if (!stats.isFile()) {
    return denied('授权附件路径已不再指向文件，请让用户重新上传。', displayPath);
  }
  if (stats.size !== grant.size || stats.mtimeMs !== grant.mtimeMs) {
    return denied('授权附件文件在授权后发生变化，请让用户重新上传。', displayPath);
  }

  return { ok: true, grant };
}

function denied(reason: string, absolutePath: string): LocalFileAccessDecision {
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: [reason, targetLine(absolutePath)].join('\n'),
  };
}

function targetLine(displayPath: string): string {
  return normalizeAttachmentReference(displayPath)
    ? `Attachment ref: ${displayPath}`
    : `Path: ${displayPath}`;
}

function findMatchingGrant(
  grants: ScopedLocalFileGrant[] | undefined,
  absolutePath: string,
): ScopedLocalFileGrant | undefined {
  if (!Array.isArray(grants)) return undefined;
  return grants.find(grant => normalizePath(grant.filePath) === absolutePath);
}

function findMatchingGrantByReference(
  grants: ScopedLocalFileGrant[] | undefined,
  attachmentRef: string,
): ScopedLocalFileGrant | undefined {
  if (!Array.isArray(grants)) return undefined;
  return grants.find(grant => normalizeAttachmentReference(grant.attachmentRef) === attachmentRef);
}

function displayPathForGrant(grant: ScopedLocalFileGrant): string {
  return normalizeAttachmentReference(grant.attachmentRef)
    || (grant.fileName ? `[CatsCo authorized attachment: ${grant.fileName}]` : MANAGED_ATTACHMENT_CACHE_DISPLAY_PATH);
}

function normalizeAttachmentReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text.startsWith(CATSCOMPANY_ATTACHMENT_REF_PREFIX)) return undefined;
  const id = text.slice(CATSCOMPANY_ATTACHMENT_REF_PREFIX.length).trim();
  return id ? `${CATSCOMPANY_ATTACHMENT_REF_PREFIX}${id}` : undefined;
}

function isManagedCatsCoDownloadPath(context: ToolExecutionContext, absolutePath: string): boolean {
  const root = path.resolve(context.workspaceRoot || process.cwd(), 'tmp', 'downloads');
  return isPathInside(absolutePath, root);
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizeForCompare(targetPath);
  const normalizedRoot = normalizeForCompare(rootPath);
  if (normalizedTarget === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget.startsWith(rootWithSep);
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function normalizeForCompare(filePath: string): string {
  return normalizePath(filePath).toLowerCase();
}
