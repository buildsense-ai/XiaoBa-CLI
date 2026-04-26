import { execFileSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr'] as const;
const DEFAULT_LIMIT = 250;

interface GrepResult {
  mode: 'content' | 'files' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
}

interface FallbackResult {
  content: string;
  error?: string;
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined };
  }
  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
  return parts.join(', ');
}

function toRelativePath(absolutePath: string, cwd: string): string {
  let relative = absolutePath;

  if (path.isAbsolute(absolutePath)) {
    relative = path.relative(cwd, absolutePath);
  } else if (absolutePath.startsWith('./') || absolutePath.startsWith('.\\')) {
    relative = absolutePath.slice(2);
  }

  return relative.replace(/\\/g, '/');
}

function isCommandAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ['--version'], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export class GrepTool implements Tool {
  definition: ToolDefinition = {
    name: 'grep',
    description: '在文件中搜索文本内容。支持正则表达式、上下文行、文件类型过滤等。基于 ripgrep (rg) 实现。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则表达式模式' },
        path: { type: 'string', description: '搜索的文件或目录路径（可选，默认为工作目录）' },
        glob: { type: 'string', description: 'Glob 模式过滤文件，如 "*.js" 或 "*.{ts,tsx}"' },
        type: { type: 'string', description: '文件类型过滤，如 "js", "py", "rust" 等' },
        case_insensitive: { type: 'boolean', description: '是否忽略大小写（默认 false）', default: false },
        context: { type: 'number', description: '显示匹配行前后的上下文行数' },
        output_mode: {
          type: 'string',
          description: '输出模式: "content" 显示匹配内容, "files" 只显示文件路径, "count" 显示匹配计数',
          enum: ['content', 'files', 'count'],
          default: 'files'
        },
        limit: { type: 'number', description: '限制输出行数或文件数（默认 250）。设为 0 表示无限制（谨慎使用）', default: 250 },
        offset: { type: 'number', description: '跳过前N行/文件，用于分页（默认 0）', default: 0 }
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { pattern, path: searchPath } = args;

    const resolvedSearchPath = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
      : context.workingDirectory;

    const pathPermission = isReadPathAllowed(resolvedSearchPath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }

    // 按优先级尝试各个 fallback
    const fallbacks = [
      { name: 'ripgrep (rg)', fn: () => this.executeWithRipgrep(args, resolvedSearchPath, context) },
      { name: 'system grep', fn: () => this.executeWithSystemGrep(args, resolvedSearchPath, context) },
      { name: 'Node.js glob', fn: () => this.executeWithNodeJS(args, resolvedSearchPath, context) },
    ];

    let lastError: Error | null = null;

    for (const { name, fn } of fallbacks) {
      try {
        const result = await fn();
        // 有内容直接返回，无内容继续尝试下一个 fallback
        if (result.content) {
          return { ok: true, content: result.content };
        }
        lastError = null; // 重置错误，因为空结果是正常情况
        continue;
      } catch (error: any) {
        lastError = error;
        // 如果有多个 fallback，继续尝试下一个
        continue;
      }
    }

    // 所有 fallback 都失败
    const errorMsg = lastError?.message || '所有搜索方法都失败了';
    return { ok: false, errorCode: 'EXECUTION_ERROR', message: errorMsg };
  }

  private async executeWithRipgrep(args: any, searchPath: string, context: ToolExecutionContext): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files', limit = DEFAULT_LIMIT, offset = 0 } = args;
    const rgArgs: string[] = ['--color=never', '--no-heading', '--hidden'];
    
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) rgArgs.push('--glob', `!${dir}`);
    rgArgs.push('--max-columns', '500');
    
    if (output_mode === 'files') rgArgs.push('--files-with-matches');
    else if (output_mode === 'count') rgArgs.push('--count');
    else { rgArgs.push('--line-number'); if (contextLines !== undefined) rgArgs.push(`--context=${contextLines}`); }
    
    if (case_insensitive) rgArgs.push('--ignore-case');
    if (fileType) rgArgs.push(`--type=${fileType}`);
    if (globPattern) rgArgs.push(`--glob=${globPattern}`);
    
    if (pattern.startsWith('-')) { rgArgs.push('-e', pattern); } else { rgArgs.push('--', pattern); }
    rgArgs.push(originalPath ? searchPath : '.');

    try {
      const output = execFileSync('rg', rgArgs, { cwd: context.workingDirectory, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }) as string;
      return { content: this.processOutput(output, args, context) };
    } catch (error: any) {
      if (error.status === 1) {
        // 无匹配，返回格式化的"未找到"
        return { content: this.formatNoMatch(pattern, originalPath, globPattern, fileType) };
      }
      // exit code 2 或其他错误，抛出让 execute 统一处理
      const errorMsg = error.stderr || `rg 执行失败 (exit ${error.status})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithSystemGrep(args: any, searchPath: string, context: ToolExecutionContext): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files', limit = DEFAULT_LIMIT, offset = 0 } = args;
    const grepArgs: string[] = [];
    
    if (case_insensitive) grepArgs.push('-i');
    if (output_mode === 'files') grepArgs.push('-l');
    else if (output_mode === 'count') grepArgs.push('-c');
    else { grepArgs.push('-n'); if (contextLines !== undefined) grepArgs.push(`-C${contextLines}`); }
    
    grepArgs.push('-r');
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) grepArgs.push('--exclude-dir=' + dir);
    grepArgs.push(pattern, searchPath);

    try {
      const output = execFileSync('grep', grepArgs, { cwd: context.workingDirectory, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }) as string;
      let processedOutput = output;
      
      if (globPattern) {
        const lines = output.trim().split('\n').filter(Boolean);
        const globRegex = new RegExp(globPattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        processedOutput = lines.filter(line => globRegex.test(path.basename(line.split(':')[0]))).join('\n');
      }
      
      return { content: this.processOutput(processedOutput, args, context) };
    } catch (error: any) {
      if (error.status === 1) {
        return { content: this.formatNoMatch(pattern, originalPath, globPattern, fileType) };
      }
      const errorMsg = error.stderr || `grep 执行失败 (exit ${error.status})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithNodeJS(args: any, searchPath: string, context: ToolExecutionContext): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files', limit = DEFAULT_LIMIT, offset = 0 } = args;
    
    if (!fs.existsSync(searchPath)) {
      throw new Error(`目录不存在: ${searchPath}`);
    }
    
    const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapeRegex(pattern), case_insensitive ? 'i' : '');
    const results: string[] = [];
    
    const walkDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (VCS_DIRECTORIES_TO_EXCLUDE.includes(entry.name as any)) continue;
          if (entry.isDirectory()) { walkDir(fullPath); continue; }
          if (entry.isFile()) {
            if (globPattern) {
              const globRegex = new RegExp('^' + globPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
              if (!globRegex.test(entry.name)) continue;
            }
            try {
              const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  if (output_mode === 'files') { results.push(fullPath); break; }
                  else if (output_mode === 'count') { results.push(`${fullPath}:1`); break; }
                  else results.push(`${fullPath}:${i + 1}:${lines[i]}`);
                }
              }
            } catch {}
          }
        }
      } catch (error: any) {
        throw new Error(`读取目录失败: ${error.message}`);
      }
    };
    
    walkDir(searchPath);
    return { content: this.processOutput(results.join('\n'), args, context) };
  }

  private processOutput(output: string, args: any, context: ToolExecutionContext): string {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, output_mode = 'files', limit = DEFAULT_LIMIT, offset = 0 } = args;
    const allLines = output.trim().split('\n').filter(Boolean);
    const { items: limitedLines, appliedLimit } = applyHeadLimit(allLines, limit, offset);
    const result: GrepResult = { mode: output_mode, numFiles: 0, filenames: [], appliedLimit, appliedOffset: offset > 0 ? offset : undefined };

    if (output_mode === 'content') {
      result.content = limitedLines.map(line => {
        const colonIndex = line.indexOf(':');
        return colonIndex > 0 ? toRelativePath(line.substring(0, colonIndex), context.workingDirectory) + line.substring(colonIndex) : line;
      }).join('\n');
      result.numLines = limitedLines.length;
    } else if (output_mode === 'count') {
      const finalCountLines = limitedLines.map(line => {
        const colonIndex = line.lastIndexOf(':');
        return colonIndex > 0 ? toRelativePath(line.substring(0, colonIndex), context.workingDirectory) + line.substring(colonIndex) : line;
      });
      result.numMatches = finalCountLines.reduce((sum, line) => {
        const count = parseInt(line.substring(line.lastIndexOf(':') + 1), 10);
        return sum + (isNaN(count) ? 0 : count);
      }, 0);
      result.content = finalCountLines.join('\n');
      result.numFiles = finalCountLines.length;
    } else {
      result.filenames = limitedLines.map(line => toRelativePath(line, context.workingDirectory));
      result.numFiles = result.filenames.length;
    }

    return this.formatResult(result, pattern, originalPath, globPattern, fileType);
  }

  private formatNoMatch(pattern: string, searchPath: string | undefined, globPattern: string | undefined, fileType: string | undefined): string {
    return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}`;
  }

  private formatResult(result: GrepResult, pattern: string, searchPath: string | undefined, globPattern: string | undefined, fileType: string | undefined): string {
    const { mode, numFiles, filenames, content, numLines, numMatches, appliedLimit, appliedOffset } = result;
    if (numFiles === 0 && !content) return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}`;
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset);
    if (mode === 'content') return `找到 ${numLines} 行匹配${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content;
    if (mode === 'count') return `找到 ${numMatches} 个匹配，分布在 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content;
    return `找到 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + filenames.map((file, i) => `${(i + 1).toString().padStart(4, ' ')}. ${file}`).join('\n');
  }
}
