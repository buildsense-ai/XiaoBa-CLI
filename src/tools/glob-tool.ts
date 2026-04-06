import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { glob } from 'glob';
import { isReadPathAllowed } from '../utils/safety';

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
    description: '使用 glob 模式搜索文件。支持通配符如 **/*.ts, src/**/*.js 等。返回匹配的文件路径列表，按修改时间排序。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob 模式，如 "**/*.ts" 或 "src/**/*.js"'
        },
        path: {
          type: 'string',
          description: '搜索的起始目录（可选，默认为工作目录）'
        },
        limit: {
          type: 'number',
          description: '返回结果的最大数量（默认 100）',
          default: 100
        }
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { pattern, path: searchPath, limit = 100 } = args;
    const startTime = Date.now();

    try {
      // 确定搜索目录
      const cwd = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
        : context.workingDirectory;

      const pathPermission = isReadPathAllowed(cwd, context.workingDirectory);
      if (!pathPermission.allowed) {
        return JSON.stringify({ error: `执行被阻止: ${pathPermission.reason}` });
      }

      // 检查目录是否存在
      if (!fs.existsSync(cwd)) {
        return JSON.stringify({ error: `目录不存在: ${cwd}` });
      }

      // 执行 glob 搜索
      const files = await glob(pattern, {
        cwd,
        absolute: false,
        nodir: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
      });

      if (files.length === 0) {
        return `未找到匹配的文件。\n模式: ${pattern}\n目录: ${searchPath || '.'}`;
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
        filenames: limitedFiles.map(f => f.file),
        truncated,
        durationMs: Date.now() - startTime
      };

      return this.formatResult(result, pattern, searchPath);
    } catch (error: any) {
      return JSON.stringify({ error: `Glob 搜索失败: ${error.message}` });
    }
  }

  private formatResult(
    result: GlobResult,
    pattern: string,
    searchPath: string | undefined
  ): string {
    const { numFiles, filenames, truncated, durationMs } = result;

    const header = `找到 ${numFiles} 个文件 (${durationMs}ms)${truncated ? ' - 结果已截断，考虑使用更精确的模式' : ''}:\n模式: ${pattern}\n目录: ${searchPath || '.'}\n\n`;
    const fileList = filenames.map((file, i) => `${(i + 1).toString().padStart(4, ' ')}. ${file}`).join('\n');
    
    return header + fileList + (truncated ? '\n\n提示: 结果被限制在前 100 个文件。使用更具体的路径或模式来缩小范围。' : '');
  }
}
