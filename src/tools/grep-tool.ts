import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath, redactCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr'] as const;
const DEFAULT_LIMIT = 250;
const execFileAsync = promisify(execFile);

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

export class GrepTool implements Tool {
  definition: ToolDefinition = {
    name: 'grep',
    description: [
      '在文件内容中搜索文本或正则表达式。',
      '适合查找符号、函数名、配置项、错误文本；路径候选通常先由 glob 缩小范围。',
      '默认返回匹配文件列表；需要具体匹配行时设置 output_mode="content"。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本或正则表达式模式。' },
        path: { type: 'string', description: '搜索的文件或目录路径。可选，默认当前目录。' },
        glob: { type: 'string', description: '文件路径过滤模式，例如 "*.js" 或 "*.{ts,tsx}"。' },
        type: { type: 'string', description: 'ripgrep 文件类型过滤，例如 "js", "py", "rust"。' },
        case_insensitive: { type: 'boolean', description: '是否忽略大小写。默认 false。', default: false },
        context: { type: 'number', description: 'output_mode="content" 时显示匹配行前后的上下文行数。' },
        output_mode: {
          type: 'string',
          description: '输出模式："files" 只返回文件路径；"content" 返回匹配行；"count" 返回匹配计数。',
          enum: ['content', 'files', 'count'],
          default: 'files'
        },
        limit: { type: 'number', description: '限制输出行数或文件数，默认 250。设为 0 表示不限制输出。', default: 250 },
        offset: { type: 'number', description: '跳过前 N 行/文件，用于分页。默认 0。', default: 0 },
        target: targetParameterDescription()
      },
      required: ['pattern']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { pattern, path: searchPath } = args;

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'grep',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteResult = await executeRouteIfRemote(context, route, 'grep', 'grep', args);
    if (remoteResult) return remoteResult;

    const resolvedSearchPath = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
      : context.workingDirectory;

    const pathPermission = isReadPathAllowed(resolvedSearchPath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }
    const visibleSearchPath = formatCatsCoVisiblePath(context, searchPath || '.', { preserveRelative: true });

    // 按优先级尝试各个 fallback
    const fallbacks = [
      { name: 'ripgrep (rg)', fn: () => this.executeWithRipgrep(args, resolvedSearchPath, context, visibleSearchPath) },
      { name: 'system grep', fn: () => this.executeWithSystemGrep(args, resolvedSearchPath, context, visibleSearchPath) },
      { name: 'Node.js glob', fn: () => this.executeWithNodeJS(args, resolvedSearchPath, context, visibleSearchPath) },
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
        if (context.abortSignal?.aborted || error?.message === '搜索已取消') {
          return { ok: false, errorCode: 'EXECUTION_ERROR', message: '搜索已取消' };
        }
        lastError = error;
        // 如果有多个 fallback，继续尝试下一个
        continue;
      }
    }

    // 所有 fallback 都失败
    const rawErrorMsg = lastError?.message || '所有搜索方法都失败了';
    const errorMsg = redactCatsCoVisiblePath(context, rawErrorMsg, resolvedSearchPath, visibleSearchPath);
    return { ok: false, errorCode: 'EXECUTION_ERROR', message: errorMsg };
  }

  private async executeWithRipgrep(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files' } = args;
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
      const { stdout } = await execFileAsync('rg', rgArgs, {
        cwd: context.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        signal: context.abortSignal,
      });
      return { content: this.processOutput(stdout, args, context, visibleSearchPath) };
    } catch (error: any) {
      if (this.isAborted(error, context)) throw new Error('搜索已取消');
      if (error.code === 1) {
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      const errorMsg = error.stderr || `rg 执行失败 (exit ${error.code})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithSystemGrep(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files' } = args;
    const grepArgs: string[] = [];

    if (case_insensitive) grepArgs.push('-i');
    if (output_mode === 'files') grepArgs.push('-l');
    else if (output_mode === 'count') grepArgs.push('-c');
    else { grepArgs.push('-n'); if (contextLines !== undefined) grepArgs.push(`-C${contextLines}`); }

    grepArgs.push('-r');
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) grepArgs.push('--exclude-dir=' + dir);
    grepArgs.push(pattern, searchPath);

    try {
      const { stdout } = await execFileAsync('grep', grepArgs, {
        cwd: context.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        signal: context.abortSignal,
      });
      let processedOutput = stdout;

      if (globPattern) {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const globRegex = new RegExp(globPattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        processedOutput = lines.filter(line => globRegex.test(path.basename(line.split(':')[0]))).join('\n');
      }

      return { content: this.processOutput(processedOutput, args, context, visibleSearchPath) };
    } catch (error: any) {
      if (this.isAborted(error, context)) throw new Error('搜索已取消');
      if (error.code === 1) {
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      const errorMsg = error.stderr || `grep 执行失败 (exit ${error.code})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithNodeJS(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, glob: globPattern, case_insensitive = false, output_mode = 'files' } = args;
    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapeRegex(pattern), case_insensitive ? 'i' : '');
    const globRegex = globPattern
      ? new RegExp('^' + globPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      : undefined;
    const results: string[] = [];

    const ensureNotAborted = () => {
      if (context.abortSignal?.aborted) throw new Error('搜索已取消');
    };

    const searchFile = async (fullPath: string, fileName: string): Promise<void> => {
      ensureNotAborted();
      if (globRegex && !globRegex.test(fileName)) return;
      try {
        const lines = (await fs.promises.readFile(fullPath, 'utf-8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          if (output_mode === 'files') { results.push(fullPath); break; }
          if (output_mode === 'count') { results.push(`${fullPath}:1`); break; }
          results.push(`${fullPath}:${i + 1}:${lines[i]}`);
        }
      } catch (error: any) {
        if (context.abortSignal?.aborted) throw new Error('搜索已取消');
        if (!['EACCES', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
      }
    };

    const walkDir = async (dir: string): Promise<void> => {
      ensureNotAborted();
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error: any) {
        throw new Error(`读取目录失败: ${error.message}`);
      }

      for (const entry of entries) {
        ensureNotAborted();
        if (VCS_DIRECTORIES_TO_EXCLUDE.includes(entry.name as any)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkDir(fullPath);
        else if (entry.isFile()) await searchFile(fullPath, entry.name);
      }
    };

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(searchPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error(`目录不存在: ${searchPath}`);
      throw error;
    }

    if (stats.isDirectory()) await walkDir(searchPath);
    else if (stats.isFile()) await searchFile(searchPath, path.basename(searchPath));
    return { content: this.processOutput(results.join('\n'), args, context, visibleSearchPath) };
  }

  private isAborted(error: any, context: ToolExecutionContext): boolean {
    return context.abortSignal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
  }

  private processOutput(output: string, args: any, context: ToolExecutionContext, visibleSearchPath?: string): string {
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

    return this.formatResult(result, pattern, visibleSearchPath ?? originalPath, globPattern, fileType);
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
