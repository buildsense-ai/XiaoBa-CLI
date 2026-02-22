import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { glob } from 'glob';
import { ToolPolicyGateway } from '../utils/tool-policy-gateway';

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
          description: '返回结果的最大数量（可选，默认 100）',
          default: 100
        }
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { pattern, path: searchPath, limit = 100 } = args;

    try {
      // 确定搜索目录
      const cwd = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
        : context.workingDirectory;

      const pathPermission = ToolPolicyGateway.checkReadPath(cwd, context);
      if (!pathPermission.allowed) {
        return `执行被阻止: ${pathPermission.reason}`;
      }

      // 检查目录是否存在
      if (!fs.existsSync(cwd)) {
        return `错误：目录不存在: ${cwd}`;
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
        return `未找到匹配的文件。\n模式: ${pattern}\n目录: ${cwd}`;
      }

      // 获取文件的修改时间并排序（文件可能在 glob 和 stat 之间被删除）
      const filesWithStats: { path: string; mtime: number }[] = [];
      for (const file of files) {
        try {
          const fullPath = path.join(cwd, file);
          const stats = fs.statSync(fullPath);
          filesWithStats.push({ path: file, mtime: stats.mtime.getTime() });
        } catch {
          // 文件已被删除，跳过
        }
      }

      // 按修改时间降序排序（最新的在前）
      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // 应用限制
      const limitedFiles = filesWithStats.slice(0, limit);
      const hasMore = files.length > limit;

      // 格式化输出
      const fileList = limitedFiles.map((f, index) => {
        const date = new Date(f.mtime).toISOString().split('T')[0];
        return `${(index + 1).toString().padStart(4, ' ')}. ${f.path} (${date})`;
      }).join('\n');

      return `找到 ${files.length} 个匹配文件${hasMore ? `，显示前 ${limit} 个` : ''}:\n模式: ${pattern}\n目录: ${searchPath || '.'}\n\n${fileList}`;
    } catch (error: any) {
      return `Glob 搜索失败: ${error.message}`;
    }
  }
}
