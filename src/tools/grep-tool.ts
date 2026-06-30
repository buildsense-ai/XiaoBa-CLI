import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath, redactCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr'] as const;
const DEFAULT_LIMIT = 250;
const MAX_GREP_LIMIT = 2000;
const MAX_GREP_OUTPUT_BYTES = 512 * 1024;
const GREP_COMMAND_TIMEOUT_MS = 30_000;

interface GrepResult {
  mode: 'content' | 'files' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
  requestedLimit?: number;
  limitWasCapped?: boolean;
  reachedOutputLimit?: boolean;
  nextOffset?: number;
}

interface NormalizedGrepPaging {
  offset: number;
  limit: number;
  requestedLimit?: number;
  limitWasCapped: boolean;
}

interface FallbackResult {
  content: string;
}

interface SearchCommandResult {
  output: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reachedOutputLimit: boolean;
}

function applyHeadLimit<T>(
  items: T[],
  paging: NormalizedGrepPaging,
  reachedOutputLimit: boolean,
): { items: T[]; appliedLimit: number | undefined; nextOffset?: number } {
  const sliced = items.slice(paging.offset, paging.offset + paging.limit);
  const wasTruncated = reachedOutputLimit || items.length - paging.offset > paging.limit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? paging.limit : undefined,
    nextOffset: wasTruncated ? paging.offset + sliced.length : undefined,
  };
}

function normalizeGrepPaging(limit: unknown, offset: unknown): NormalizedGrepPaging {
  const parsedOffset = Number(offset);
  const normalizedOffset = Number.isFinite(parsedOffset) && parsedOffset > 0
    ? Math.floor(parsedOffset)
    : 0;

  if (limit === 0 || limit === '0') {
    return {
      offset: normalizedOffset,
      limit: MAX_GREP_LIMIT,
      requestedLimit: 0,
      limitWasCapped: true,
    };
  }

  const parsedLimit = Number(limit);
  const hasExplicitLimit = limit !== undefined && limit !== null && limit !== '';
  const requestedLimit = hasExplicitLimit && Number.isFinite(parsedLimit)
    ? Math.floor(parsedLimit)
    : undefined;

  if (!hasExplicitLimit || requestedLimit === undefined || requestedLimit <= 0) {
    return {
      offset: normalizedOffset,
      limit: DEFAULT_LIMIT,
      limitWasCapped: false,
    };
  }

  return {
    offset: normalizedOffset,
    limit: Math.min(requestedLimit, MAX_GREP_LIMIT),
    requestedLimit,
    limitWasCapped: requestedLimit > MAX_GREP_LIMIT,
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
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'grep requires a non-empty pattern.',
      };
    }

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
        if (this.isCancellationError(error)) {
          return {
            ok: false,
            errorCode: 'EXECUTION_TIMEOUT',
            message: String(error?.message || error || 'grep execution was interrupted'),
          };
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

  private runSearchCommand(
    command: string,
    commandArgs: string[],
    cwd: string,
    context: ToolExecutionContext,
    lineBudget: number,
  ): Promise<SearchCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const lines: string[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutCarry = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let reachedOutputLimit = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (abortHandler) context.abortSignal?.removeEventListener('abort', abortHandler);
      };

      const terminate = () => {
        try { child.kill(); } catch {}
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const appendStdout = (chunk: Buffer) => {
        if (reachedOutputLimit) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_GREP_OUTPUT_BYTES) {
          reachedOutputLimit = true;
          terminate();
          return;
        }

        const parts = (stdoutCarry + chunk.toString('utf8')).split(/\r?\n/);
        stdoutCarry = parts.pop() || '';
        for (const line of parts) {
          lines.push(line);
          if (lines.length >= lineBudget) {
            reachedOutputLimit = true;
            terminate();
            break;
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => appendStdout(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes <= 64 * 1024) stderrChunks.push(buffer);
      });

      child.on('error', error => {
        settle(() => reject(error));
      });

      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, GREP_COMMAND_TIMEOUT_MS);
      timer.unref?.();

      abortHandler = () => {
        aborted = true;
        terminate();
      };
      if (context.abortSignal?.aborted) {
        abortHandler();
      } else {
        context.abortSignal?.addEventListener('abort', abortHandler, { once: true });
      }

      child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
        settle(() => {
          if (aborted) {
            reject(this.createGrepAbortError());
            return;
          }
          if (timedOut) {
            reject(this.createGrepTimeoutError());
            return;
          }
          if (!reachedOutputLimit && stdoutCarry) lines.push(stdoutCarry);
          resolve({
            output: lines.join('\n'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode,
            signal,
            reachedOutputLimit,
          });
        });
      });
    });
  }

  private createGrepTimeoutError(): Error {
    const error: any = new Error(`grep timed out after ${GREP_COMMAND_TIMEOUT_MS}ms`);
    error.code = 'ETIMEDOUT';
    return error;
  }

  private createGrepAbortError(): Error {
    const error: any = new Error('grep aborted by user');
    error.code = 'ABORT_ERR';
    return error;
  }

  private isCancellationError(error: any): boolean {
    const code = String(error?.code || '');
    return code === 'ETIMEDOUT' || code === 'ABORT_ERR';
  }

  private async executeWithRipgrep(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files' } = args;
    const paging = normalizeGrepPaging(args?.limit, args?.offset);
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
      const searchResult = await this.runSearchCommand('rg', rgArgs, context.workingDirectory, context, paging.offset + paging.limit + 1);
      if (searchResult.exitCode === 1 && !searchResult.output) {
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      if (searchResult.exitCode === 0 || searchResult.reachedOutputLimit) {
        return { content: this.processOutput(searchResult.output, args, context, visibleSearchPath, searchResult.reachedOutputLimit) };
      }
      throw new Error(searchResult.stderr || `rg execution failed (exit ${searchResult.exitCode ?? searchResult.signal ?? 'unknown'})`);
    } catch (error: any) {
      if (this.isCancellationError(error)) throw error;
      if (error.status === undefined && !error.stderr) throw error;
      if (error.status === 1) {
        // 无匹配，返回格式化的"未找到"
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      // exit code 2 或其他错误，抛出让 execute 统一处理
      const errorMsg = error.stderr || `rg 执行失败 (exit ${error.status})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithSystemGrep(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files' } = args;
    const paging = normalizeGrepPaging(args?.limit, args?.offset);
    const grepArgs: string[] = [];

    if (case_insensitive) grepArgs.push('-i');
    if (output_mode === 'files') grepArgs.push('-l');
    else if (output_mode === 'count') grepArgs.push('-c');
    else { grepArgs.push('-n'); if (contextLines !== undefined) grepArgs.push(`-C${contextLines}`); }

    grepArgs.push('-r');
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) grepArgs.push('--exclude-dir=' + dir);
    grepArgs.push('-e', pattern, searchPath);

    try {
      const searchResult = await this.runSearchCommand('grep', grepArgs, context.workingDirectory, context, paging.offset + paging.limit + 1);
      if (searchResult.exitCode === 1 && !searchResult.output) {
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      if (searchResult.exitCode !== 0 && !searchResult.reachedOutputLimit) {
        throw new Error(searchResult.stderr || `grep execution failed (exit ${searchResult.exitCode ?? searchResult.signal ?? 'unknown'})`);
      }
      let processedOutput = searchResult.output;

      if (globPattern) {
        const lines = searchResult.output.trim().split('\n').filter(Boolean);
        const globRegex = new RegExp(globPattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        processedOutput = lines.filter(line => globRegex.test(path.basename(line.split(':')[0]))).join('\n');
      }

      return { content: this.processOutput(processedOutput, args, context, visibleSearchPath, searchResult.reachedOutputLimit) };
    } catch (error: any) {
      if (this.isCancellationError(error)) throw error;
      if (error.status === undefined && !error.stderr) throw error;
      if (error.status === 1) {
        return { content: this.formatNoMatch(pattern, visibleSearchPath ?? originalPath, globPattern, fileType) };
      }
      const errorMsg = error.stderr || `grep 执行失败 (exit ${error.status})`;
      throw new Error(errorMsg);
    }
  }

  private async executeWithNodeJS(args: any, searchPath: string, context: ToolExecutionContext, visibleSearchPath?: string): Promise<FallbackResult> {
    const { pattern, glob: globPattern, case_insensitive = false, output_mode = 'files' } = args;
    const paging = normalizeGrepPaging(args?.limit, args?.offset);

    if (!fs.existsSync(searchPath)) {
      throw new Error(`目录不存在: ${searchPath}`);
    }

    const regex = new RegExp(pattern, case_insensitive ? 'i' : '');
    const results: string[] = [];
    const lineBudget = paging.offset + paging.limit + 1;
    let resultBytes = 0;
    let reachedOutputLimit = false;

    const addResult = (value: string) => {
      if (reachedOutputLimit) return;
      results.push(value);
      resultBytes += Buffer.byteLength(value, 'utf8') + 1;
      if (results.length >= lineBudget || resultBytes >= MAX_GREP_OUTPUT_BYTES) {
        reachedOutputLimit = true;
      }
    };

    const walkDir = (dir: string) => {
      if (reachedOutputLimit) return;
      if (context.abortSignal?.aborted) throw this.createGrepAbortError();
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (reachedOutputLimit) return;
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
              let fileMatchCount = 0;
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  if (output_mode === 'files') { addResult(fullPath); break; }
                  else if (output_mode === 'count') { fileMatchCount++; }
                  else addResult(`${fullPath}:${i + 1}:${lines[i]}`);
                  if (reachedOutputLimit) break;
                }
              }
              if (output_mode === 'count' && fileMatchCount > 0) addResult(`${fullPath}:${fileMatchCount}`);
            } catch {}
          }
        }
      } catch (error: any) {
        throw new Error(`读取目录失败: ${error.message}`);
      }
    };

    walkDir(searchPath);
    return { content: this.processOutput(results.join('\n'), args, context, visibleSearchPath, reachedOutputLimit) };
  }

  private processOutput(output: string, args: any, context: ToolExecutionContext, visibleSearchPath?: string, reachedOutputLimit: boolean = false): string {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, output_mode = 'files' } = args;
    const paging = normalizeGrepPaging(args?.limit, args?.offset);
    const allLines = output.trim().split('\n').filter(Boolean);
    const { items: limitedLines, appliedLimit, nextOffset } = applyHeadLimit(allLines, paging, reachedOutputLimit);
    const result: GrepResult = {
      mode: output_mode,
      numFiles: 0,
      filenames: [],
      appliedLimit,
      appliedOffset: paging.offset > 0 ? paging.offset : undefined,
      requestedLimit: paging.requestedLimit,
      limitWasCapped: paging.limitWasCapped,
      reachedOutputLimit,
      nextOffset,
    };

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

  private formatResultNotes(result: GrepResult): string {
    const notes: string[] = [];
    if (result.limitWasCapped) {
      if (result.requestedLimit === 0) {
        notes.push(`Note: limit=0 is capped to ${MAX_GREP_LIMIT} results for safety.`);
      } else if (result.requestedLimit !== undefined) {
        notes.push(`Note: requested limit=${result.requestedLimit} was capped to ${MAX_GREP_LIMIT} results.`);
      }
    }
    if (result.reachedOutputLimit) {
      notes.push('Note: grep stopped collecting output after reaching the safety limit. Narrow pattern/path/glob or continue with offset.');
    }
    if (result.nextOffset !== undefined && result.appliedLimit !== undefined) {
      notes.push(`Next page: call grep with offset=${result.nextOffset}, limit=${result.appliedLimit}.`);
    }
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  private formatResult(result: GrepResult, pattern: string, searchPath: string | undefined, globPattern: string | undefined, fileType: string | undefined): string {
    const { mode, numFiles, filenames, content, numLines, numMatches, appliedLimit, appliedOffset } = result;
    const notes = this.formatResultNotes(result);
    if (numFiles === 0 && !content) return `未找到匹配项。\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}${notes}`;
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset);
    if (mode === 'content') return `找到 ${numLines} 行匹配${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content + notes;
    if (mode === 'count') return `找到 ${numMatches} 个匹配，分布在 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content + notes;
    return `找到 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + filenames.map((file, i) => `${(i + 1).toString().padStart(4, ' ')}. ${file}`).join('\n') + notes;
  }
}
