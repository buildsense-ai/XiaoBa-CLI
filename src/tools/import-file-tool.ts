import * as fs from 'fs';
import * as path from 'path';
import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  UploadedFileResult,
} from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveToolPath } from '../utils/tool-path-resolver';
import {
  buildExecutionRouteTargetContext,
  executeRouteIfRemote,
  resolveExecutionRoute,
} from './execution-router';

type UploadImportFileSource = (
  absolutePath: string,
  fileName: string,
) => Promise<UploadedFileResult>;

export class ImportFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'import_file',
    description: [
      '把聊天参与者电脑上的原始文件复制到当前 agent 的托管工作区。',
      '当用户要求把自己电脑上的文件传给云端虚拟员工继续处理时使用此工具，不要使用 send_file。',
      'file_path 是目标参与者电脑上的文件路径，可以是 Windows、macOS 或 Linux 路径。',
      'target 必须填写聊天参与者的显示名或用户 ID；目标电脑需要在线且已出现在当前运行时设备上下文中。',
      '成功后返回当前 agent 工作区中的绝对路径，不会把附件发送到聊天。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要从目标参与者电脑复制的文件路径。',
        },
        file_name: {
          type: 'string',
          description: '文件进入当前 agent 工作区后使用的文件名，应包含扩展名，例如 "report.xlsx"。',
        },
        target: {
          type: 'string',
          description: '必填。文件所在聊天参与者的显示名或用户 ID。不能填写 agent_self。',
        },
      },
      required: ['file_path', 'file_name', 'target'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const validation = validateImportFileArgs(args, true);
    if (!validation.ok) return validation;

    const route = resolveExecutionRoute(context, {
      toolName: 'import_file',
      operation: 'send_file',
      target: validation.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    if (route.mode !== 'remote') {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'import_file 只能从聊天参与者的远程电脑导入文件；target 不能是 agent_self。发送 agent 本机文件到聊天请使用 send_file。',
      };
    }
    if (!context.channel?.receiveUploadedFile) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '当前运行体不支持把远程设备上传的文件保存到托管工作区。',
      };
    }

    const result = await executeRouteIfRemote(context, route, 'import_file', 'send_file', args);
    if (!result) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '远程设备文件上传未返回结果。',
      };
    }
    if (!result.ok) return rewriteUnsupportedImportFileError(result, route.label);
    if (!result.uploadedFile) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '远程设备没有返回已上传文件的元数据。',
        targetContext: result.targetContext,
      };
    }

    try {
      const localPath = path.resolve(await context.channel.receiveUploadedFile(result.uploadedFile));
      const stats = fs.statSync(localPath);
      if (!stats.isFile()) {
        throw new Error(`保存结果不是文件: ${localPath}`);
      }
      if (stats.size !== result.uploadedFile.size) {
        try {
          fs.unlinkSync(localPath);
        } catch {
          // Ignore cleanup failure; the size mismatch is the primary error.
        }
        throw new Error(`文件大小校验失败: expected=${result.uploadedFile.size}, actual=${stats.size}`);
      }
      Logger.info(`[import_file] 已把远程文件保存到当前运行体: ${result.uploadedFile.name} -> ${localPath} (${route.label})`);
      return {
        ok: true,
        content: [
          'File imported from remote computer into this agent workspace.',
          `Source target: ${route.label}`,
          `Source path: ${validation.filePath}`,
          `Agent path: ${localPath}`,
          `Name: ${result.uploadedFile.name}`,
          `Size: ${stats.size}`,
        ].join('\n'),
        targetContext: buildExecutionRouteTargetContext({
          ok: true,
          mode: 'local',
          target: 'agent_self',
          label: 'current agent workspace',
        }, {
          toolName: 'import_file',
          operation: 'send_file',
          cwd: path.dirname(localPath),
        }),
      };
    } catch (error: any) {
      Logger.error(`远程文件保存到当前运行体失败: ${error.message}`);
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Remote file import to agent workspace failed: ${error.message || error}`,
        targetContext: result.targetContext,
      };
    }
  }
}

function rewriteUnsupportedImportFileError(
  result: Extract<ToolExecutionResult, { ok: false }>,
  targetLabel: string,
): ToolExecutionResult {
  const unsupported = result.errorCode === 'TOOL_NOT_FOUND'
    || /does not have tool:\s*import_file/i.test(result.message);
  if (!unsupported) return result;

  return {
    ...result,
    message: `目标用户电脑（${targetLabel}）上的 XiaoBa 版本过旧，不支持 import_file。请让该用户升级或重启电脑端 XiaoBa 后再重试。`,
    retryable: false,
  };
}

/** Runs only inside the already-selected target runtime. */
export async function uploadImportFileSource(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  upload: UploadImportFileSource,
): Promise<ToolExecutionResult> {
  const validation = validateImportFileArgs(args, false);
  if (!validation.ok) return validation;

  const resolved = resolveToolPath(validation.filePath, context);
  if (!resolved.exists) {
    return {
      ok: false,
      errorCode: 'FILE_NOT_FOUND',
      message: `File not found on target computer: ${resolved.absolutePath}`,
    };
  }
  if (!resolved.isFile) {
    return {
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Path is not a file on target computer: ${resolved.absolutePath}`,
    };
  }
  try {
    fs.accessSync(resolved.absolutePath, fs.constants.R_OK);
  } catch {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `File is not readable on target computer: ${resolved.absolutePath}`,
    };
  }

  try {
    const sourceSize = fs.statSync(resolved.absolutePath).size;
    const uploadedFile = await upload(resolved.absolutePath, validation.fileName);
    if (uploadedFile.size !== sourceSize) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Remote upload size mismatch: expected=${sourceSize}, actual=${uploadedFile.size}`,
      };
    }
    return {
      ok: true,
      content: [
        'Target computer uploaded the original file.',
        `Path: ${resolved.absolutePath}`,
        `Name: ${uploadedFile.name}`,
        `Size: ${uploadedFile.size}`,
      ].join('\n'),
      uploadedFile,
    };
  } catch (error: any) {
    return {
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Target computer failed to upload file: ${error?.message || error}`,
    };
  }
}

function validateImportFileArgs(
  args: Record<string, unknown> | undefined,
  requireTarget: boolean,
):
  | { ok: true; filePath: string; fileName: string; target?: string }
  | { ok: false; errorCode: 'INVALID_TOOL_ARGUMENTS'; message: string } {
  const filePath = typeof args?.file_path === 'string' ? args.file_path.trim() : '';
  const fileName = typeof args?.file_name === 'string' ? args.file_name.trim() : '';
  const target = typeof args?.target === 'string' ? args.target.trim() : '';
  if (!filePath) {
    return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'import_file 的 file_path 不能为空。' };
  }
  if (!fileName) {
    return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'import_file 的 file_name 不能为空。' };
  }
  if (requireTarget && !target) {
    return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'import_file 的 target 为必填项，请填写文件所在参与者的显示名或用户 ID。' };
  }
  return { ok: true, filePath, fileName, target: target || undefined };
}
