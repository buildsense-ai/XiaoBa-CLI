import { execSync } from 'child_process';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * Grep 工具 - 代码内容搜索（基于 ripgrep）
 */
export class GrepTool implements Tool {
  definition: ToolDefinition = {
    name: 'grep',
    description: '在文件中搜索文本内容。支持正则表达式、上下文行、文件类型过滤等。基于 ripgrep (rg) 实现。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '要搜索的正则表达式模式'
        },
        path: {
          type: 'string',
          description: '搜索的文件或目录路径（可选，默认为工作目录）'
        },
        glob: {
          type: 'string',
          description: 'Glob 模式过滤文件，如 "*.js" 或 "*.{ts,tsx}"'
        },
        type: {
          type: 'string',
          description: '文件类型过滤，如 "js", "py", "rust" 等'
        },
        case_insensitive: {
          type: 'boolean',
          description: '是否忽略大小写（默认 false）',
          default: false
        },
        context: {
          type: 'number',
          description: '显示匹配行前后的上下文行数'
        },
        output_mode: {
          type: 'string',
          description: '输出模式: "content" 显示匹配内容, "files" 只显示文件路径, "count" 显示匹配计数',
          enum: ['content', 'files', 'count'],
          default: 'files'
        },
        limit: {
          type: 'number',
          description: '限制输出行数或文件数（默认 100）',
          default: 100
        }
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      type: fileType,
      case_insensitive = false,
      context: contextLines,
      output_mode = 'files',
      limit = 100
    } = args;

    try {
      // 检查是否安装了 ripgrep
      try {
        execSync('rg --version', { stdio: 'pipe' });
      } catch {
        return '错误：未找到 ripgrep (rg)。请先安装: https://github.com/BurntSushi/ripgrep#installation';
      }

      // 构建 rg 命令
      const rgArgs: string[] = [];

      // 基础参数
      rgArgs.push('--color=never');
      rgArgs.push('--no-heading');

      // 输出模式
      if (output_mode === 'files') {
        rgArgs.push('--files-with-matches');
      } else if (output_mode === 'count') {
        rgArgs.push('--count');
      } else {
        // content 模式
        rgArgs.push('--line-number');
        if (contextLines !== undefined) {
          rgArgs.push(`--context=${contextLines}`);
        }
      }

      // 大小写
      if (case_insensitive) {
        rgArgs.push('--ignore-case');
      }

      // 文件类型过滤
      if (fileType) {
        rgArgs.push(`--type=${fileType}`);
      }

      // Glob 过滤
      if (globPattern) {
        rgArgs.push(`--glob=${globPattern}`);
      }

      // 限制结果数量
      rgArgs.push(`--max-count=${limit}`);

      // 模式和路径
      rgArgs.push(pattern);
      if (searchPath) {
        const absolutePath = path.isAbsolute(searchPath)
          ? searchPath
          : path.join(context.workingDirectory, searchPath);
        rgArgs.push(absolutePath);
      }

      // 执行命令
      const command = `rg ${rgArgs.join(' ')}`;
      let output: string;

      try {
        output = execSync(command, {
          cwd: context.workingDirectory,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error: any) {
        // rg 返回非零退出码表示未找到匹配
        if (error.status === 1) {
          return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}`;
        }
        throw error;
      }

      // 处理输出
      const lines = output.trim().split('\n');
      const totalMatches = lines.length;
      const limitedLines = lines.slice(0, limit);
      const hasMore = totalMatches > limit;

      let result = `找到 ${totalMatches} 个匹配${hasMore ? `，显示前 ${limit} 个` : ''}:\n`;
      result += `模式: ${pattern}\n`;
      result += `路径: ${searchPath || '.'}\n`;
      if (globPattern) result += `Glob: ${globPattern}\n`;
      if (fileType) result += `类型: ${fileType}\n`;
      result += '\n';

      if (output_mode === 'content') {
        result += limitedLines.join('\n');
      } else if (output_mode === 'files') {
        result += limitedLines.map((line, i) => `${(i + 1).toString().padStart(4, ' ')}. ${line}`).join('\n');
      } else {
        // count 模式
        result += limitedLines.map(line => {
          const [file, count] = line.split(':');
          return `${count.padStart(4, ' ')} matches: ${file}`;
        }).join('\n');
      }

      return result;
    } catch (error: any) {
      return `Grep 搜索失败: ${error.message}`;
    }
  }
}
