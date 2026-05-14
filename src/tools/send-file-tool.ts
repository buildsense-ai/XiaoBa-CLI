import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveToolPath } from '../utils/tool-path-resolver';

export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: `Send a local file to the current chat.

Use this only when file_path points to a real local file that should be sent to the user. file_path can be absolute or relative to the current directory.

CatsCo file selection rules:
- tmp/downloads/... is the local cache for files/images received from chat. Do not use it when the user asks for a new/local file or a file they have not sent before.
- If the user did not provide an exact local path, ask for the path or search likely local folders first.
    - Only resend tmp/downloads/... files when the user explicitly asks to resend/open an earlier chat attachment.
    - After sending a file, keep the final reply short.`,
    transcriptMode: 'outbound_file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的文件路径，可以是绝对路径，也可以是相对当前目录的路径。',
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

    const resolved = resolveToolPath(file_path, context);
    if (!resolved.exists) {
      return {
        ok: false,
        errorCode: 'FILE_NOT_FOUND',
        message: [
          'File not found.',
          `Input path: ${resolved.inputPath}`,
          `Resolved path: ${resolved.absolutePath}`,
        ].join('\n'),
      };
    }

    if (!resolved.isFile) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: [
          'Path is not a file.',
          `Input path: ${resolved.inputPath}`,
          `Resolved path: ${resolved.absolutePath}`,
        ].join('\n'),
      };
    }

    try {
      fs.accessSync(resolved.absolutePath, fs.constants.R_OK);
    } catch {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: [
          'File is not readable.',
          `Input path: ${resolved.inputPath}`,
          `Resolved path: ${resolved.absolutePath}`,
        ].join('\n'),
      };
    }

    const channel = context.channel;
    if (!channel) {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '当前不在聊天会话中，无法发送文件' };
    }

    try {
      await channel.sendFile(channel.chatId, resolved.absolutePath, file_name);
      Logger.info(`[send_file] 已发送: ${file_name} (${resolved.absolutePath})`);
      return {
        ok: true,
        content: [
          'File sent to current chat.',
          `Path: ${resolved.absolutePath}`,
          `Name: ${file_name}`,
        ].join('\n'),
      };
    } catch (error: any) {
      Logger.error(`文件发送失败 (sendFile): ${error.message}`);
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: [
          `File send failed: ${error.message}`,
          `Path: ${resolved.absolutePath}`,
          `Name: ${file_name}`,
        ].join('\n'),
      };
    }
  }
}
