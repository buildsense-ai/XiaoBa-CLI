import { execFileSync, spawnSync } from 'child_process';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { ToolPolicyGateway } from '../utils/tool-policy-gateway';

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
      const resolvedSearchPath = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
        : context.workingDirectory;
      const pathPermission = ToolPolicyGateway.checkReadPath(resolvedSearchPath, context);
      if (!pathPermission.allowed) {
        return `执行被阻止: ${pathPermission.reason}`;
      }

      // 检查是否安装了 ripgrep
      const rgVersion = spawnSync('rg', ['--version'], { stdio: 'pipe' });
      const useRg = rgVersion.status === 0;

      let output: string;

      if (useRg) {
        // ---- ripgrep 路径 ----
        const rgArgs: string[] = [];

        rgArgs.push('--color=never');
        rgArgs.push('--no-heading');

        if (output_mode === 'files') {
          rgArgs.push('--files-with-matches');
        } else if (output_mode === 'count') {
          rgArgs.push('--count');
        } else {
          rgArgs.push('--line-number');
          if (contextLines !== undefined) {
            rgArgs.push(`--context=${contextLines}`);
          }
        }

        if (case_insensitive) {
          rgArgs.push('--ignore-case');
        }

        if (fileType) {
          rgArgs.push(`--type=${fileType}`);
        }

        if (globPattern) {
          rgArgs.push(`--glob=${globPattern}`);
        }

        rgArgs.push(`--max-count=${limit}`);

        rgArgs.push('--');
        rgArgs.push(pattern);
        if (searchPath) {
          rgArgs.push(resolvedSearchPath);
        }

        try {
          output = execFileSync('rg', rgArgs, {
            cwd: context.workingDirectory,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe']
          }) as string;
        } catch (error: any) {
          if (error.status === 1) {
            return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}`;
          }
          const stderrText = (error?.stderr?.toString?.() || '').trim();
          throw new Error(stderrText || error.message);
        }
      } else {
        // ---- 系统 grep 回退路径 ----
        const grepArgs: string[] = [];

        grepArgs.push('--color=never');
        grepArgs.push('-r'); // 递归搜索

        if (output_mode === 'files') {
          grepArgs.push('-l');
        } else if (output_mode === 'count') {
          grepArgs.push('-c');
        } else {
          // content 模式
          grepArgs.push('-n');
          if (contextLines !== undefined) {
            grepArgs.push(`-C${contextLines}`);
          }
        }

        if (case_insensitive) {
          grepArgs.push('-i');
        }

        // grep 没有 --type，用 --include 模拟 glob 过滤
        // 优先使用 glob 参数；如果只有 fileType 则映射为 --include
        if (globPattern) {
          grepArgs.push(`--include=${globPattern}`);
        } else if (fileType) {
          // 常见文件类型到扩展名的映射
          const typeToGlob: Record<string, string[]> = {
            js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
            ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
            py: ['*.py', '*.pyi'],
            rust: ['*.rs'],
            go: ['*.go'],
            java: ['*.java'],
            c: ['*.c', '*.h'],
            cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hxx', '*.h'],
            css: ['*.css'],
            html: ['*.html', '*.htm'],
            json: ['*.json'],
            yaml: ['*.yml', '*.yaml'],
            md: ['*.md', '*.markdown'],
            sh: ['*.sh', '*.bash'],
            rb: ['*.rb'],
            php: ['*.php'],
          };
          const exts = typeToGlob[fileType];
          if (exts) {
            for (const ext of exts) {
              grepArgs.push(`--include=${ext}`);
            }
          } else {
            // 未知类型，尝试直接作为扩展名
            grepArgs.push(`--include=*.${fileType}`);
          }
        }

        // grep 没有 --max-count 的全局等价，-m 是按文件的
        // 对 content/count 模式用 -m 做近似限制
        if (output_mode !== 'files') {
          grepArgs.push(`-m${limit}`);
        }

        grepArgs.push('--');
        grepArgs.push(pattern);
        grepArgs.push(resolvedSearchPath);

        try {
          output = execFileSync('grep', grepArgs, {
            cwd: context.workingDirectory,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe']
          }) as string;
        } catch (error: any) {
          if (error.status === 1) {
            return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}`;
          }
          const stderrText = (error?.stderr?.toString?.() || '').trim();
          throw new Error(stderrText || error.message);
        }
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
