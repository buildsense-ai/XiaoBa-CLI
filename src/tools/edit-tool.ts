import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isToolAllowed, isPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_CHECK_BYTES = 8192;
const BINARY_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.mov', '.avi',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

function invalidArguments(message: string): ToolExecutionResult {
  return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message };
}

function isLikelyBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_FILE_EXTENSIONS.has(ext)) return true;

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Edit 工具 - 精确字符串替换
 */
export class EditTool implements Tool {
  definition: ToolDefinition = {
    name: 'edit_file',
    description: [
      '在一个已有文本文件中执行精确字符串替换。',
      'old_string 必须与文件内容完全匹配；默认要求唯一匹配，多处替换时显式设置 replace_all=true。',
      '适合小范围修改代码、配置或文档；需要重写整个文件时使用 write_file。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要编辑的文件路径。支持绝对路径或相对当前目录的路径。'
        },
        old_string: {
          type: 'string',
          description: '要替换掉的原始字符串，必须与文件内容完全一致。'
        },
        new_string: {
          type: 'string',
          description: '替换后的新字符串。'
        },
        replace_all: {
          type: 'boolean',
          description: '是否替换所有匹配项。默认 false，此时 old_string 必须唯一。',
          default: false
        },
        target: targetParameterDescription()
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!args || typeof args !== 'object') {
      return invalidArguments('edit_file requires an arguments object.');
    }
    const { file_path, old_string, new_string, replace_all = false } = args;
    if (typeof file_path !== 'string' || file_path.length === 0) {
      return invalidArguments('edit_file requires a non-empty file_path string.');
    }
    if (typeof old_string !== 'string' || old_string.length === 0) {
      return invalidArguments('edit_file requires a non-empty old_string string.');
    }
    if (typeof new_string !== 'string') {
      return invalidArguments('edit_file requires new_string to be a string.');
    }
    if (replace_all !== undefined && typeof replace_all !== 'boolean') {
      return invalidArguments('edit_file requires replace_all to be a boolean when provided.');
    }

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${toolPermission.reason}` };
    }

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'edit_file',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteResult = await executeRouteIfRemote(context, route, 'edit_file', 'edit_file', args);
    if (remoteResult) return remoteResult;

    // 解析文件路径
    const absolutePath = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.workingDirectory, file_path);

    const pathPermission = isPathAllowed(absolutePath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }
    const displayPath = formatCatsCoVisiblePath(context, file_path, { preserveRelative: true });

    // 检查文件是否存在
    if (!fs.existsSync(absolutePath)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${displayPath}` };
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${displayPath}` };
    }

    if (!stats.isFile()) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `错误：edit_file 只能编辑普通文本文件，目标不是文件。\n文件: ${displayPath}`,
      };
    }

    if (stats.size > MAX_EDIT_FILE_BYTES) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `错误：文件过大，edit_file 只处理 ${MAX_EDIT_FILE_BYTES} bytes 以内的文本文件。\n文件: ${displayPath}\n大小: ${stats.size} bytes`,
      };
    }

    let likelyBinary: boolean;
    try {
      likelyBinary = isLikelyBinaryFile(absolutePath);
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `错误：读取文件失败。\n文件: ${displayPath}\n原因: ${error?.message || error}`,
      };
    }

    if (likelyBinary) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `错误：目标看起来不是普通文本文件，已阻止 edit_file 以避免损坏二进制文件。\n文件: ${displayPath}`,
      };
    }

    // 读取文件内容
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `错误：读取文件失败。\n文件: ${displayPath}\n原因: ${error?.message || error}`,
      };
    }

    // 检查 old_string 是否存在
    if (!content.includes(old_string)) {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `错误：在文件中未找到要替换的字符串。\n文件: ${displayPath}\n查找: ${old_string.substring(0, 100)}${old_string.length > 100 ? '...' : ''}` };
    }

    // 检查唯一性（如果不是 replace_all）
    if (!replace_all) {
      const occurrences = content.split(old_string).length - 1;
      if (occurrences > 1) {
        return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `错误：找到 ${occurrences} 个匹配项，但 replace_all=false。\n请提供更具体的字符串以确保唯一性，或设置 replace_all=true 替换所有匹配项。\n文件: ${displayPath}` };
      }
    }

    // 执行替换
    let newContent: string;
    let replacedCount: number;

    if (replace_all) {
      // 替换所有匹配项
      const occurrences = content.split(old_string).length - 1;
      newContent = content.split(old_string).join(new_string);
      replacedCount = occurrences;
    } else {
      // 只替换第一个匹配项
      newContent = content.replace(old_string, new_string);
      replacedCount = 1;
    }

    // 写入文件
    fs.writeFileSync(absolutePath, newContent, 'utf-8');

    // 计算变化
    const oldLines = content.split('\n').length;
    const newLines = newContent.split('\n').length;
    const lineDiff = newLines - oldLines;

    return { ok: true, content: `成功编辑文件: ${displayPath}\nPath: ${displayPath}\n替换次数: ${replacedCount}\n原始行数: ${oldLines}\n新行数: ${newLines}${lineDiff !== 0 ? `\n行数变化: ${lineDiff > 0 ? '+' : ''}${lineDiff}` : ''}` };
  }
}
