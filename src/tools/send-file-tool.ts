import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveToolPath } from '../utils/tool-path-resolver';
import { resolveLocalFileAccess, resolveLocalFileReference } from './local-file-gateway';
import { resolveOutboundTarget } from './outbound-gateway';
import { formatCatsCoVisiblePath, isCatsCoToolGatewayContext } from './tool-gateway';

export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: [
      '向当前聊天会话发送一个已存在的本地文件。',
      'file_path 接受绝对路径、相对当前目录的路径，或当前 CatsCo 用户轮次授权的 catsco_attachment:<id> 引用。',
      '只发送文件本身；如果只是回复文字，请用普通 assistant 回复或 send_text。',
    ].join('\n'),
    transcriptMode: 'outbound_file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的本地文件路径或授权附件引用。支持绝对路径、相对当前目录路径、catsco_attachment:<id>。',
        },
        file_name: {
          type: 'string',
          description: '发送给用户时显示的文件名，应包含扩展名，例如 "report.md"。',
        },
      },
      required: ['file_path', 'file_name'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { file_path, file_name } = args;

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '文件路径不能为空' };
    }

    if (!file_name || typeof file_name !== 'string') {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '文件名不能为空' };
    }

    let absolutePath: string;
    let displayPath: string;
    let visibleInputPath = file_path;
    let resolvedFromAttachmentRef = false;
    let authorizedByLocalFileGrant = false;

    const reference = resolveLocalFileReference(context, {
      operation: 'send_file',
      inputPath: file_path,
    });
    if (reference.matched) {
      if (!reference.ok) {
        return {
          ok: false,
          errorCode: reference.errorCode,
          message: reference.message,
        };
      }
      absolutePath = reference.absolutePath;
      displayPath = reference.displayPath;
      visibleInputPath = reference.displayPath;
      resolvedFromAttachmentRef = true;
      authorizedByLocalFileGrant = true;
    } else {
      const resolved = resolveToolPath(file_path, context);
      absolutePath = resolved.absolutePath;
      displayPath = resolved.absolutePath;
    }

    if (!resolvedFromAttachmentRef) {
      const localAccess = resolveLocalFileAccess(context, {
        operation: 'send_file',
        absolutePath,
      });
      if (!localAccess.ok) {
        return {
          ok: false,
          errorCode: localAccess.errorCode,
          message: localAccess.message,
        };
      }
      if (localAccess.displayPath) {
        displayPath = localAccess.displayPath;
        visibleInputPath = localAccess.displayPath;
      }
      authorizedByLocalFileGrant = Boolean(localAccess.grant);
    }

    const earlyTarget = resolveOutboundTarget(context, {
      operation: 'send_file',
      missingChannelMessage: '当前不在聊天会话中，无法发送文件',
    });
    if (!earlyTarget.ok && /外发目标与当前执行身份不一致/.test(earlyTarget.message)) {
      return {
        ok: false,
        errorCode: earlyTarget.errorCode,
        message: earlyTarget.message,
      };
    }

    if (!authorizedByLocalFileGrant) {
      const identity = validateCatsCoLocalSendFileContext(context, displayPath);
      if (!identity.ok) {
        return {
          ok: false,
          errorCode: identity.errorCode,
          message: identity.message,
        };
      }
      displayPath = formatCatsCoVisiblePath(context, displayPath, { preserveRelative: true });
      visibleInputPath = displayPath;
    }

    if (!fs.existsSync(absolutePath)) {
      return {
        ok: false,
        errorCode: 'FILE_NOT_FOUND',
        message: [
          'File not found.',
          `Input path: ${visibleInputPath}`,
          `Resolved path: ${displayPath}`,
        ].join('\n'),
      };
    }

    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: [
            'Path is not a file.',
            `Input path: ${visibleInputPath}`,
            `Resolved path: ${displayPath}`,
          ].join('\n'),
        };
      }
    } catch {
      return {
        ok: false,
        errorCode: 'FILE_NOT_FOUND',
        message: [
          'File not found.',
          `Input path: ${visibleInputPath}`,
          `Resolved path: ${displayPath}`,
        ].join('\n'),
      };
    }

    try {
      fs.accessSync(absolutePath, fs.constants.R_OK);
    } catch {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: [
          'File is not readable.',
          `Input path: ${visibleInputPath}`,
          `Resolved path: ${displayPath}`,
        ].join('\n'),
      };
    }

    const channel = context.channel;
    const target = earlyTarget.ok ? earlyTarget : resolveOutboundTarget(context, {
      operation: 'send_file',
      missingChannelMessage: '当前不在聊天会话中，无法发送文件',
    });
    if (!target.ok) {
      return {
        ok: false,
        errorCode: target.errorCode,
        message: target.message,
      };
    }

    try {
      await channel!.sendFile(target.chatId, absolutePath, file_name);
      Logger.info(`[send_file] 已发送: ${file_name} (${absolutePath})`);
      return {
        ok: true,
        content: [
          'File sent to current chat.',
          `Path: ${displayPath}`,
          `Name: ${file_name}`,
        ].join('\n'),
      };
    } catch (error: any) {
      const safeErrorMessage = redactToolVisiblePath(error.message, absolutePath, displayPath);
      Logger.error(`文件发送失败 (sendFile): ${error.message}`);
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: [
          `File send failed: ${safeErrorMessage}`,
          `Path: ${displayPath}`,
          `Name: ${file_name}`,
        ].join('\n'),
      };
    }
  }
}

function validateCatsCoLocalSendFileContext(
  context: ToolExecutionContext,
  targetLabel: string,
): { ok: true } | { ok: false; errorCode: 'PERMISSION_DENIED'; message: string } {
  if (!isCatsCoToolGatewayContext(context)) return { ok: true };

  const scope = context.executionScope;
  if (!scope || scope.source !== 'catscompany') {
    return denyLocalSendFile('Current tool call is missing CatsCo execution identity.', targetLabel);
  }
  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return denyLocalSendFile('Current CatsCo message identity is not server-canonical, so send_file is blocked.', targetLabel);
  }
  if (!context.localDeviceGrant || context.localDeviceGrant.source !== 'catscompany') {
    return denyLocalSendFile('Current runtime is missing its CatsCo local device binding, so send_file is blocked.', targetLabel);
  }
  return { ok: true };
}

function denyLocalSendFile(reason: string, targetLabel: string): { ok: false; errorCode: 'PERMISSION_DENIED'; message: string } {
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: [
      reason,
      `Target: ${targetLabel || '[current CatsCo device]'}`,
    ].join('\n'),
  };
}

function redactToolVisiblePath(message: unknown, absolutePath: string, displayPath: string): string {
  const text = String(message || '');
  if (!absolutePath || !displayPath || absolutePath === displayPath) return text;
  return text.split(absolutePath).join(displayPath);
}
