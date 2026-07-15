import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveToolPath } from '../utils/tool-path-resolver';
import { resolveLocalFileAccess, resolveLocalFileReference } from './local-file-gateway';
import { resolveOutboundTarget } from './outbound-gateway';
import { formatCatsCoVisiblePath, isCatsCoToolGatewayContext } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: [
      '向当前聊天会话发送一个已存在的本地文件。',
      'file_path 接受绝对路径或相对当前目录的路径。CatsCo 附件请优先使用消息中显示的本地缓存路径。',
      'catsco_attachment:<id> 仅用于兼容当前轮旧附件引用；后续转发应使用历史消息里的本地缓存路径。',
      '如果 file_path 位于聊天参与者的电脑上，并且运行时设备上下文列出了该参与者，必须把参与者显示名或用户 ID 填入 target，让目标电脑上传原始文件；不要因为 agent 运行在另一种操作系统上就拒绝。',
      '远程发送不会把文件内容交给模型：目标电脑直接上传原始字节，本工具再把上传结果作为附件发送到当前聊天。',
      '只发送文件本身；如果只是回复文字，请用普通 assistant 回复或 send_text。',
    ].join('\n'),
    transcriptMode: 'outbound_file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的本地文件路径。支持绝对路径、相对当前目录路径；CatsCo 附件优先使用消息中的本地缓存路径，catsco_attachment:<id> 仅作旧引用兼容。',
        },
        file_name: {
          type: 'string',
          description: '发送给用户时显示的文件名，应包含扩展名，例如 "report.md"。',
        },
        target: {
          ...targetParameterDescription(),
          description: '可选。如果 file_path 是聊天参与者电脑上的路径，必须填写该参与者的显示名或用户 ID。省略时只会在当前 agent 主机上查找文件。',
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

    const route = resolveExecutionRoute(context, {
      toolName: 'send_file',
      operation: 'send_file',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    if (route.mode === 'remote') {
      return this.executeRemote(args, context, route);
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

  private async executeRemote(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    route: Extract<ReturnType<typeof resolveExecutionRoute>, { ok: true; mode: 'remote' }>,
  ): Promise<ToolExecutionResult> {
    const target = resolveOutboundTarget(context, {
      operation: 'send_file',
      missingChannelMessage: '当前不在聊天会话中，无法发送文件',
    });
    if (!target.ok) {
      return { ok: false, errorCode: target.errorCode, message: target.message };
    }
    if (!context.channel?.sendUploadedFile) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '当前聊天通道不支持发送远程设备上传的文件。',
      };
    }

    const result = await executeRouteIfRemote(context, route, 'send_file', 'send_file', args);
    if (!result) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '远程设备文件上传未返回结果。',
      };
    }
    if (!result.ok) return result;
    if (!result.uploadedFile) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '远程设备没有返回已上传文件的元数据。',
        targetContext: result.targetContext,
      };
    }

    try {
      await context.channel.sendUploadedFile(target.chatId, result.uploadedFile);
      Logger.info(`[send_file] 已发送远程文件: ${result.uploadedFile.name} (${route.label})`);
      return {
        ...result,
        content: [
          'File sent to current chat from remote computer.',
          `Target: ${route.label}`,
          `Path: ${String(args.file_path || '')}`,
          `Name: ${result.uploadedFile.name}`,
        ].join('\n'),
      };
    } catch (error: any) {
      Logger.error(`远程文件发送失败 (sendUploadedFile): ${error.message}`);
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Remote file send failed: ${error.message || error}`,
        targetContext: result.targetContext,
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
  const lines = [reason];
  if (targetLabel) lines.push(`Target: ${targetLabel}`);
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: lines.join('\n'),
  };
}

function redactToolVisiblePath(message: unknown, absolutePath: string, displayPath: string): string {
  const text = String(message || '');
  if (!absolutePath || !displayPath || absolutePath === displayPath) return text;
  return text.split(absolutePath).join(displayPath);
}
