import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { isToolAllowed, isPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

function invalidArguments(message: string): ToolExecutionResult {
  return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message };
}

/**
 * Write 工具 - 写入文件内容
 */
export class WriteTool implements Tool {
  definition: ToolDefinition = {
    name: 'write_file',
    description: [
      '创建或完整覆盖一个用户明确需要保留的 UTF-8 文本文件。',
      '适合生成新文件或重写整个文件；对已有文件做小范围修改时优先使用 edit_file。',
      '当用户要求在桌面、下载、文档等常见目录创建文件时，先用 resolve_common_directory 解析目录，再把目标文件路径传给本工具。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要写入的文件路径。支持绝对路径或相对当前目录的路径；可以使用 resolve_common_directory 返回的路径拼出目标文件。'
        },
        content: {
          type: 'string',
          description: '要写入文件的完整 UTF-8 文本内容。'
        },
        target: targetParameterDescription()
      },
      required: ['file_path', 'content']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!args || typeof args !== 'object') {
      return invalidArguments('write_file requires an arguments object.');
    }
    const { file_path, content } = args;
    if (typeof file_path !== 'string' || file_path.trim().length === 0) {
      return invalidArguments('write_file requires a non-empty file_path string.');
    }
    if (typeof content !== 'string') {
      return invalidArguments('write_file requires content to be a string.');
    }

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${toolPermission.reason}` };
    }

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'write_file',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteResult = await executeRouteIfRemote(context, route, 'write_file', 'write_file', args);
    if (remoteResult) return remoteResult;

    // 解析文件路径
    const absolutePath = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.workingDirectory, file_path);

    const pathPermission = isPathAllowed(absolutePath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }

    // 获取相对路径用于显示
    const relativePath = path.relative(context.workingDirectory, absolutePath);
    const rawDisplayPath = relativePath.startsWith('..') ? absolutePath : relativePath;
    const displayPath = formatCatsCoVisiblePath(context, rawDisplayPath, { preserveRelative: true });

    // 检查文件是否已存在
    let fileExists = false;
    try {
      const targetStats = fs.statSync(absolutePath);
      fileExists = true;
      if (!targetStats.isFile()) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `错误：write_file 只能创建或覆盖普通文本文件，目标路径不是文件。\n文件: ${displayPath}`,
        };
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `错误：检查目标文件失败。\n文件: ${displayPath}\n原因: ${error?.message || error}`,
        };
      }
    }
    const operation = fileExists ? '覆盖' : '创建';

    // 确保目录存在
    const dir = path.dirname(absolutePath);
    if (fs.existsSync(dir)) {
      try {
        const dirStats = fs.statSync(dir);
        if (!dirStats.isDirectory()) {
          return {
            ok: false,
            errorCode: 'TOOL_EXECUTION_ERROR',
            message: `错误：父路径不是目录，无法创建文件。\n父路径: ${formatCatsCoVisiblePath(context, path.relative(context.workingDirectory, dir) || dir, { preserveRelative: true })}\n文件: ${displayPath}`,
          };
        }
      } catch (error: any) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `错误：检查父目录失败。\n文件: ${displayPath}\n原因: ${error?.message || error}`,
        };
      }
    } else {
      try {
        Logger.info(`创建目录: ${path.relative(context.workingDirectory, dir)}`);
        fs.mkdirSync(dir, { recursive: true });
      } catch (error: any) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `错误：创建父目录失败。\n文件: ${displayPath}\n原因: ${error?.message || error}`,
        };
      }
    }

    Logger.info(`${operation}文件: ${displayPath}`);

    // 计算文件信息
    const lines = content.split('\n').length;
    const bytes = Buffer.byteLength(content, 'utf-8');
    const sizeKB = (bytes / 1024).toFixed(2);

    // 写入文件
    fs.writeFileSync(absolutePath, content, 'utf-8');

    // 显示内容预览（前3行）
    const previewLines = content.split('\n').slice(0, 3);
    const preview = previewLines.join('\n');
    const hasMore = lines > 3;

    Logger.success(`✓ 成功${operation}文件: ${displayPath}`);
    Logger.info(`  行数: ${lines} | 大小: ${sizeKB} KB (${bytes} bytes)`);

    if (preview.trim()) {
      Logger.info(`  内容预览:`);
      previewLines.forEach((line: string) => {
        const displayLine = line.length > 80 ? line.substring(0, 77) + '...' : line;
        Logger.info(`    ${displayLine}`);
      });
      if (hasMore) {
        Logger.info(`    ... (还有 ${lines - 3} 行)`);
      }
    }

    return { ok: true, content: `成功${operation}文件: ${displayPath}\nPath: ${displayPath}\n行数: ${lines}\n大小: ${sizeKB} KB (${bytes} bytes)` };
  }
}
