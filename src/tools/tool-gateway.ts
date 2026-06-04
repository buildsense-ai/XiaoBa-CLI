import type { DeviceGrantOperation, ScopedDeviceGrant } from '../types/session-identity';
import type { ToolErrorCode, ToolExecutionContext } from '../types/tool';
import { resolveDeviceGrant } from '../core/device-grants';

export type ToolGatewayDecision =
  | { ok: true; grant?: ScopedDeviceGrant }
  | { ok: false; errorCode: ToolErrorCode; message: string };

export interface ResolveToolGatewayAccessOptions {
  toolName: string;
  operation: DeviceGrantOperation;
  targetLabel?: string;
  allowCatsCoShell?: boolean;
}

export interface CatsCoVisiblePathOptions {
  fallback?: string;
  preserveRelative?: boolean;
}

export function isCatsCoToolGatewayContext(context: ToolExecutionContext): boolean {
  return context.surface === 'catscompany' || context.executionScope?.source === 'catscompany';
}

export function formatCatsCoVisiblePath(
  context: ToolExecutionContext,
  value: string | undefined,
  options: CatsCoVisiblePathOptions = {},
): string {
  const fallback = options.fallback ?? '[current CatsCo device]';
  const text = String(value || '').trim();
  if (!isCatsCoToolGatewayContext(context)) {
    return text || fallback;
  }
  if (!text) return fallback;
  if (/^catsco_attachment:[A-Za-z0-9._:-]+$/.test(text)) return text;
  if (/^\[CatsCo [^\]]+\]$/.test(text)) return text;
  if (options.preserveRelative && !looksLikeAbsoluteLocalPath(text)) return text;
  return fallback;
}

export function redactCatsCoVisiblePath(
  context: ToolExecutionContext,
  message: unknown,
  rawPath: string,
  visiblePath?: string,
): string {
  const text = String(message || '');
  if (!isCatsCoToolGatewayContext(context) || !rawPath) return text;
  const replacement = visiblePath ?? formatCatsCoVisiblePath(context, rawPath);
  return text.split(rawPath).join(replacement);
}

export function resolveToolGatewayAccess(
  context: ToolExecutionContext,
  options: ResolveToolGatewayAccessOptions,
): ToolGatewayDecision {
  if (!isCatsCoToolGatewayContext(context)) {
    return { ok: true };
  }

  if (options.operation === 'execute_shell' && !options.allowCatsCoShell) {
    return denied([
      'CatsCo 会话暂不允许通过 execute_shell 直接操作本机命令行。',
      '当前 PR 只开放文件级设备授权；命令执行需要后续独立审批和更细的命令策略。',
    ], options.targetLabel);
  }

  const scope = context.executionScope;
  if (!scope || scope.source !== 'catscompany') {
    return denied(['当前工具调用缺少 CatsCo 执行身份，已阻止本地设备操作。'], options.targetLabel);
  }

  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return denied(['当前消息身份未通过服务端一致性校验，已阻止本地设备操作。'], options.targetLabel);
  }

  const localDevice = context.localDeviceGrant;
  if (!localDevice || localDevice.source !== 'catscompany') {
    return denied(['当前运行体缺少 CatsCo 本机设备绑定，已阻止本地设备操作。'], options.targetLabel);
  }

  const targetDeviceId = localDevice.deviceId || localDevice.installationId || localDevice.bodyId;
  const decision = resolveDeviceGrant(context, {
    operation: options.operation,
    deviceId: targetDeviceId,
  });
  if (!decision.ok) {
    return denied([
      `当前会话没有允许当前设备执行 ${options.operation} 的短期授权，已阻止 ${options.toolName}。`,
      '请确认用户已在对应设备授权，或等待服务端为本轮消息下发匹配的 device_grant。',
    ], options.targetLabel);
  }

  const grant = decision.grant;
  const mismatches: string[] = [];
  if (grant.deviceBodyId && localDevice.bodyId && grant.deviceBodyId !== localDevice.bodyId) {
    mismatches.push('device body');
  }
  if (grant.deviceInstallationId && localDevice.installationId && grant.deviceInstallationId !== localDevice.installationId) {
    mismatches.push('device installation');
  }
  if (mismatches.length > 0) {
    return denied([
      '设备授权与当前运行体不一致，已阻止本地设备操作以避免串设备。',
      `不一致字段: ${mismatches.join(', ')}`,
    ], options.targetLabel);
  }

  return { ok: true, grant };
}

function denied(lines: string[], targetLabel?: string): ToolGatewayDecision {
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: [
      ...lines,
      targetLabel ? `Target: ${sanitizeTargetLabel(targetLabel)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function sanitizeTargetLabel(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '[current CatsCo device]';
  if (/^catsco_attachment:[A-Za-z0-9._:-]+$/.test(text)) return text;
  if (/^\[CatsCo [^\]]+\]$/.test(text)) return text;
  return '[current CatsCo device]';
}

function looksLikeAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^\//.test(value)
    || /^~[\\/]/.test(value);
}
