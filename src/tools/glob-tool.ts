import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { glob } from 'glob';
import { isReadPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath, isCatsCoToolGatewayContext } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

interface GlobResult {
  numFiles: number;
  filenames: string[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Glob 工具 - 文件模式匹配搜索
 */
export class GlobTool implements Tool {
  definition: ToolDefinition = {
    name: 'glob',
    description: [
      '按 glob 模式查找文件路径，返回匹配文件列表并按修改时间倒序排列。',
      '适合先定位候选文件；要搜索文件内容请使用 grep。',
      '当用户问“桌面/下载/文档里有哪些文件”时，先用 resolve_common_directory 解析目录，再用本工具列出文件；不要用 execute_shell 跑 dir/ls。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob 模式，例如 "**/*.ts"、"src/**/*.js"。'
        },
        path: {
          type: 'string',
          description: '搜索起始目录。可选，默认当前目录。可以使用 resolve_common_directory 返回的绝对路径。'
        },
        limit: {
          type: 'number',
          description: '返回结果最大数量，默认 100。',
          default: 100
        },
        target: targetParameterDescription()
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { pattern, path: searchPath, limit = 100 } = args;
    const startTime = Date.now();

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'glob',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteResult = await executeRouteIfRemote(context, route, 'glob', 'glob', args);
    if (remoteResult) return remoteResult;

    // 确定搜索目录
    const cwd = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
      : context.workingDirectory;

    const pathPermission = isReadPathAllowed(cwd, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }

    const visibleSearchPath = formatCatsCoVisiblePath(context, searchPath || '.', { preserveRelative: true });
    const visibleCwd = formatCatsCoVisiblePath(context, cwd);

    // 检查目录是否存在
    if (!fs.existsSync(cwd)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `目录不存在: ${visibleCwd}` };
    }

    // 执行 glob 搜索
    const shouldReturnAbsolutePaths = !isCatsCoToolGatewayContext(context) && Boolean(searchPath && path.isAbsolute(searchPath));

    const files = await glob(pattern, {
      cwd,
      absolute: false,
      nodir: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
    });

    if (files.length === 0) {
      return { ok: true, content: `未找到匹配的文件。\n模式: ${pattern}\n目录: ${visibleSearchPath}\nPath: ${visibleCwd}` };
    }

    // 使用Promise.allSettled容错处理stat（文件可能在glob后被删除）
    const statsPromises = files.map(file => {
      const fullPath = path.join(cwd, file);
      return fs.promises.stat(fullPath)
        .then(stats => ({ file, mtime: stats.mtime.getTime() }))
        .catch(() => ({ file, mtime: 0 })); // 失败的文件排在最后
    });

    const filesWithStats = await Promise.all(statsPromises);

    // 按修改时间降序排序（最新的在前）
    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    // 应用限制
    const truncated = files.length > limit;
    const limitedFiles = filesWithStats.slice(0, limit);

    const result: GlobResult = {
      numFiles: limitedFiles.length,
      filenames: limitedFiles.map(f => shouldReturnAbsolutePaths ? path.join(cwd, f.file) : f.file),
      truncated,
      durationMs: Date.now() - startTime
    };

    return { ok: true, content: this.formatResult(result, pattern, visibleSearchPath, visibleCwd) };
  }

  private formatResult(
    result: GlobResult,
    pattern: string,
    visibleSearchPath: string,
    visibleCwd: string,
  ): string {
    const { numFiles, filenames, truncated, durationMs } = result;

    const header = `找到 ${numFiles} 个文件 (${durationMs}ms)${truncated ? ' - 结果已截断，考虑使用更精确的模式' : ''}:\n模式: ${pattern}\n目录: ${visibleSearchPath}\nPath: ${visibleCwd}\n\n`;
    const fileList = filenames.map((file, i) => `${(i + 1).toString().padStart(4, ' ')}. ${file}`).join('\n');
    
    return header + fileList + (truncated ? '\n\n提示: 结果被限制在前 100 个文件。使用更具体的路径或模式来缩小范围。' : '');
  }
}
