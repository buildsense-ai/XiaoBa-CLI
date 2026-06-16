import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveToolPath } from '../utils/tool-path-resolver';
import { resolveLocalFileAccess, resolveLocalFileReference } from './local-file-gateway';
import { resolveOutboundTarget } from './outbound-gateway';
import { formatCatsCoVisiblePath, resolveToolGatewayAccess } from './tool-gateway';

export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: `Send a local file or authorized CatsCo attachment reference to the current chat.

Accepted file_path formats:
- Absolute or relative path to a readable local file.
- catsco_attachment:<id> reference authorized by the current user turn.

The tool uploads the file to the active chat and returns the visible path and file name.`,
    transcriptMode: 'outbound_file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的文件路径，或当前 CatsCo 用户轮次中的授权附件引用。可以是绝对路径、相对当前目录的路径，或 catsco_attachment:<id>。',
        },
        file_name: {
          type: 'string',
          description: '文件名（含扩展名），如 "论文精读.md"',
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
      const gateway = resolveToolGatewayAccess(context, {
        toolName: this.definition.name,
        operation: 'send_file',
        targetLabel: displayPath,
      });
      if (!gateway.ok) {
        return {
          ok: false,
          errorCode: gateway.errorCode,
          message: gateway.message,
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

function redactToolVisiblePath(message: unknown, absolutePath: string, displayPath: string): string {
  const text = String(message || '');
  if (!absolutePath || !displayPath || absolutePath === displayPath) return text;
  return text.split(absolutePath).join(displayPath);
}
