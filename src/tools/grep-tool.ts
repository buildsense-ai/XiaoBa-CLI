import * as path from 'path';
import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath, redactCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';
import { boundGrepOutput } from './grep-output';
import {
  GrepBackendError,
  GrepBackendName,
  GrepCancelledError,
  GrepDeadline,
  GrepInvalidPatternError,
  GrepMatcher,
  GrepOverflowError,
  GrepSearchError,
  GrepTimeoutError,
  GrepTimingCollector,
  GrepUnsupportedTypeError,
  globToRegExp,
  matchGlob,
  outcomeForError,
  resolveGrepSearchTimeoutMs,
  resolveTypeFilterGlobs,
  spawnGrepCommand,
} from './grep-runtime';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr'] as const;
const SKIPPABLE_FILE_READ_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOENT', 'ESTALE']);
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

/** One completed backend run. `no_match` is definitive: the whole chain stops. */
type GrepBackendRunResult = { kind: 'matches'; stdout: string; content?: string } | { kind: 'no_match' };

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

/** Per-file result cap for the Node fallback: enough to satisfy limit+offset. */
function nodeMatchCap(outputMode: string, limit: number | undefined, offset: number): number {
  if (outputMode === 'files') {
    return limit === 0 ? 0 : (limit ?? DEFAULT_LIMIT) + offset;
  }
  if (outputMode === 'content') {
    return limit === 0 ? 0 : (limit ?? DEFAULT_LIMIT) + offset;
  }
  return 0; // count mode needs every matching line of every file
}

export class GrepTool implements Tool {
  definition: ToolDefinition = {
    name: 'grep',
    description: [
      '在文件内容中搜索文本或正则表达式。',
      '适合查找符号、函数名、配置项、错误文本；路径候选通常先由 glob 缩小范围。',
      '默认返回匹配文件列表；需要具体匹配行时设置 output_mode="content"。',
      '所有本地后端共享一个绝对截止时间；超时/取消/结果溢出会返回类型化错误，不会伪装成“无匹配”。',
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
        limit: { type: 'number', description: '限制输出行数或文件数，默认 250。0 仅取消行数限制，不关闭搜索截止时间或文本大小上限。', default: 250 },
        offset: { type: 'number', description: '跳过前 N 行/文件，用于分页。默认 0。', default: 0 },
        timeout_ms: {
          type: 'number',
          description: '可选。本地搜索的绝对截止毫秒数，100..30000，默认 15000。超时返回 SEARCH_TIMEOUT（结果不完整，绝不返回空匹配）。',
          default: 15000,
        },
        backend_timing: {
          type: 'boolean',
          description: '可选。为 true 时在结果末尾附加各后端耗时统计（仅后端名/毫秒数/结果枚举，不含路径、模式或内容）。默认 false。',
          default: false,
        },
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
    if (remoteResult) return this.withTiming(remoteResult, undefined);

    const resolvedSearchPath = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
      : context.workingDirectory;

    const pathPermission = isReadPathAllowed(resolvedSearchPath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }
    const visibleSearchPath = formatCatsCoVisiblePath(context, searchPath || '.', { preserveRelative: true });

    let budgetMs: number;
    try {
      budgetMs = resolveGrepSearchTimeoutMs(args.timeout_ms);
    } catch (error) {
      if (error instanceof RangeError) {
        return {
          ok: false,
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          message: `timeout_ms 参数无效: ${error.message}`,
        };
      }
      throw error;
    }

    const deadline = new GrepDeadline(budgetMs, context.abortSignal);
    const timing = args.backend_timing === true ? new GrepTimingCollector() : undefined;
    const globPattern: string | undefined = args.glob || undefined;
    const fileType: string | undefined = args.type || undefined;
    const patternText: string = String(pattern ?? '');

    try {
      const backends: Array<{ name: GrepBackendName; run: () => Promise<GrepBackendRunResult> }> = [
        { name: 'ripgrep', run: () => this.executeWithRipgrep(args, resolvedSearchPath, context, visibleSearchPath, deadline) },
        { name: 'grep', run: () => this.executeWithSystemGrep(args, resolvedSearchPath, context, visibleSearchPath, deadline) },
        { name: 'node', run: () => this.executeWithNodeJS(args, resolvedSearchPath, context, visibleSearchPath, deadline) },
      ];

      let lastBackendError: GrepBackendError | undefined;

      for (const backend of backends) {
        // 绝对截止时间已过期时不再启动任何后端，也绝不返回“空匹配”。
        deadline.check();
        const startedAt = Date.now();
        try {
          const runResult = await backend.run();
          const durationMs = Date.now() - startedAt;
          if (runResult.kind === 'no_match') {
            timing?.record(backend.name, 'no_match', durationMs);
            const content = this.formatNoMatch(patternText, visibleSearchPath ?? searchPath, globPattern, fileType);
            return this.withTiming({ ok: true, content }, timing);
          }
          timing?.record(backend.name, 'ok', durationMs);
          const content = this.processOutput(runResult.stdout, args, context, visibleSearchPath);
          return this.withTiming({ ok: true, content }, timing);
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const typed = error instanceof GrepSearchError
            ? error
            : new GrepBackendError(String((error as any)?.message || error));
          timing?.record(backend.name, outcomeForError(typed), durationMs);
          // 超时 / 取消 / 溢出 / 模式无效 / 类型不支持：终态，不再尝试其他后端。
          if (typed instanceof GrepTimeoutError) {
            return this.withTiming({ ok: false, errorCode: typed.errorCode, message: typed.message }, timing);
          }
          if (typed instanceof GrepCancelledError) {
            return this.withTiming({ ok: false, errorCode: typed.errorCode, message: typed.message }, timing);
          }
          if (typed instanceof GrepOverflowError) {
            return this.withTiming({ ok: false, errorCode: typed.errorCode, message: typed.message }, timing);
          }
          if (typed instanceof GrepInvalidPatternError || typed instanceof GrepUnsupportedTypeError) {
            return this.withTiming({ ok: false, errorCode: typed.errorCode, message: typed.message }, timing);
          }
          lastBackendError = typed;
          // 真实后端故障（rg 缺失、权限等）才继续下一个后端。
          continue;
        }
      }

      const rawMessage = lastBackendError?.message || '所有搜索方法都失败了';
      const message = redactCatsCoVisiblePath(context, rawMessage, resolvedSearchPath, visibleSearchPath);
      return this.withTiming(
        { ok: false, errorCode: 'SEARCH_BACKEND_ERROR', message: `本地搜索失败: ${message}` },
        timing,
      );
    } finally {
      deadline.dispose();
    }
  }

  private withTiming(
    result: ToolExecutionResult,
    timing: GrepTimingCollector | undefined,
  ): ToolExecutionResult {
    const suffix = timing ? `\n\n${timing.format()}` : '';
    if (result.ok) {
      if (typeof result.content !== 'string') {
        return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: 'grep 返回了非文本结果，无法作为搜索证据使用。', retryable: false };
      }
      return { ...result, content: boundGrepOutput(result.content + suffix) };
    }
    return { ...result, message: boundGrepOutput(result.message + suffix) };
  }

  private async executeWithRipgrep(
    args: any,
    searchPath: string,
    context: ToolExecutionContext,
    _visibleSearchPath: string | undefined,
    deadline: GrepDeadline,
  ): Promise<GrepBackendRunResult> {
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

    rgArgs.push('-e', String(pattern));
    rgArgs.push('--');
    rgArgs.push(originalPath ? searchPath : '.');

    const run = await this.runBackendCommand('rg', rgArgs, context, deadline);
    if (run.exitCode === 1) return { kind: 'no_match' };
    return { kind: 'matches', stdout: run.stdout };
  }

  private async executeWithSystemGrep(
    args: any,
    searchPath: string,
    context: ToolExecutionContext,
    _visibleSearchPath: string | undefined,
    deadline: GrepDeadline,
  ): Promise<GrepBackendRunResult> {
    const { pattern, path: originalPath, glob: globPattern, type: fileType, case_insensitive = false, context: contextLines, output_mode = 'files' } = args;
    const grepArgs: string[] = ['--binary-files=without-match'];

    if (case_insensitive) grepArgs.push('-i');
    if (output_mode === 'files') grepArgs.push('-l');
    else if (output_mode === 'count') grepArgs.push('-c');
    else { grepArgs.push('-n'); if (contextLines !== undefined) grepArgs.push(`-C${contextLines}`); }

    // 单个普通文件目标：非递归，include 过滤在结果侧应用（见下）。
    let singleFile = false;
    try {
      const stats = await fs.promises.stat(searchPath);
      singleFile = stats.isFile();
    } catch {
      singleFile = false; // 不存在的路径由 grep 报错，走统一 GrepBackendError 链
    }

    const typeGlobs = resolveTypeFilterGlobs(fileType);
    if (fileType && !typeGlobs) throw new GrepUnsupportedTypeError(fileType, 'grep');

    const includeGlobs: string[] = [];
    if (globPattern) includeGlobs.push(globPattern);
    for (const typeGlob of typeGlobs ?? []) includeGlobs.push(typeGlob);

    if (!singleFile) {
      grepArgs.push('-r');
      for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) grepArgs.push('--exclude-dir=' + dir);
      // glob/type 过滤在扫描前应用（--include），而不是扫完再事后过滤。
      for (const include of includeGlobs) grepArgs.push(`--include=${include}`);
    }

    // -E: 常见正则与 rg 语义对齐；-e: 模式以 "-" 开头也安全；--: 路径操作数安全。
    grepArgs.push('-E', '-e', String(pattern), '--', searchPath);

    const run = await this.runBackendCommand('grep', grepArgs, context, deadline);
    if (run.exitCode === 1) return { kind: 'no_match' };

    let stdout = run.stdout;
    if (singleFile && includeGlobs.length && stdout.trim()) {
      const matchers = includeGlobs.map(globToRegExp);
      const relativePath = path.basename(searchPath);
      const allowed = matchers.some(matcher => matchGlob(matcher, relativePath, relativePath));
      if (!allowed) return { kind: 'no_match' };
    }
    return { kind: 'matches', stdout };
  }

  private async executeWithNodeJS(
    args: any,
    searchPath: string,
    context: ToolExecutionContext,
    visibleSearchPath: string | undefined,
    deadline?: GrepDeadline,
  ): Promise<GrepBackendRunResult> {
    const { pattern, glob: globPattern, type: fileType, case_insensitive = false, output_mode = 'files', limit, offset = 0 } = args;

    const ownedDeadline = deadline ?? new GrepDeadline(resolveGrepSearchTimeoutMs(args.timeout_ms), context.abortSignal);
    const shouldDisposeDeadline = !deadline;

    const globMatcher = globPattern ? globToRegExp(globPattern) : undefined;
    const typeGlobs = resolveTypeFilterGlobs(fileType);
    if (fileType && !typeGlobs) {
      if (shouldDisposeDeadline) ownedDeadline.dispose();
      throw new GrepUnsupportedTypeError(fileType, 'node');
    }
    const typeMatchers = (typeGlobs ?? []).map(globToRegExp);

    // 正则在独立 worker 线程中编译并执行：灾难性回溯不会阻塞主线程，
    // deadline/abort 通过 terminate() 强制终止并由同一截止时间监督。
    const matcher = new GrepMatcher(String(pattern), case_insensitive ? 'i' : '', ownedDeadline);
    const results: string[] = [];
    let accumulatedChars = 0;
    const maxOutputChars = 10 * 1024 * 1024;
    const matchCap = nodeMatchCap(output_mode, limit, offset);

    const reachedCap = (): boolean => matchCap > 0 && results.length >= matchCap;

    const pushResult = (line: string): void => {
      results.push(line);
      accumulatedChars += line.length + 1;
    };

    const searchFile = async (fullPath: string, fileName: string, relativePath: string): Promise<void> => {
      ownedDeadline.check();
      if (globMatcher && !matchGlob(globMatcher, relativePath, fileName)) return;
      if (typeMatchers.length && !typeMatchers.some(matcher0 => matchGlob(matcher0, relativePath, fileName))) return;
      if (reachedCap()) return;

      let text: Buffer | string;
      try {
        text = await fs.promises.readFile(fullPath, { signal: ownedDeadline.signal });
      } catch (error: any) {
        ownedDeadline.rethrowIfExpired();
        if (SKIPPABLE_FILE_READ_ERROR_CODES.has(error?.code)) return;
        throw new GrepBackendError(`读取文件失败: ${error?.message || error}`);
      }

      let matched: number[];
      try {
        matched = await matcher.match(text, matchCap);
      } catch (error: any) {
        ownedDeadline.rethrowIfExpired();
        throw error;
      }
      if (!matched.length) return;

      if (output_mode === 'files') {
        pushResult(fullPath);
        return;
      }
      if (output_mode === 'count') {
        pushResult(`${fullPath}:${matched.length}`);
        return;
      }
      const lines = (typeof text === 'string' ? text : text.toString('utf8')).split('\n');
      for (const index of matched) {
        if (reachedCap()) break;
        pushResult(`${fullPath}:${index + 1}:${lines[index] ?? ''}`);
      }
    };

    const walkDir = async (dir: string, relativeDir: string): Promise<void> => {
      ownedDeadline.check();
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error: any) {
        ownedDeadline.rethrowIfExpired();
        // 无权限的目录按权限语义跳过（与 grep -r 行为一致），不让整个扫描失败。
        if (SKIPPABLE_FILE_READ_ERROR_CODES.has(error?.code)) return;
        throw new GrepBackendError(`读取目录失败: ${error?.message || error}`);
      }

      for (const entry of entries) {
        ownedDeadline.check();
        if (VCS_DIRECTORIES_TO_EXCLUDE.includes(entry.name as any)) continue;
        // 绝不展开符号链接（目录与文件都不跟随），避免搜索范围被 symlink 撑大。
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walkDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          // FIFO/socket/设备等非普通文件一律跳过。
          await searchFile(fullPath, entry.name, relativePath);
        }
        if (reachedCap()) return;
      }
    };

    try {
      try {
        await matcher.ensureReady();
      } catch (error: any) {
        ownedDeadline.rethrowIfExpired();
        throw error;
      }

      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(searchPath);
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw new GrepBackendError(`目录不存在: ${searchPath}`);
        throw new GrepBackendError(`读取路径失败: ${error?.message || error}`);
      }

      if (stats.isDirectory()) await walkDir(searchPath, '');
      else if (stats.isFile()) await searchFile(searchPath, path.basename(searchPath), path.basename(searchPath));

      if (accumulatedChars > maxOutputChars) throw new GrepOverflowError(maxOutputChars);
      const stdout = results.join('\n');
      return {
        kind: 'matches',
        stdout,
        // 兼容直接调用本方法的旧测试/调用方：格式化后的最终文本。
        content: this.processOutput(stdout, args, context, visibleSearchPath),
      };
    } finally {
      matcher.dispose();
      if (shouldDisposeDeadline) ownedDeadline.dispose();
    }
  }

  private async runBackendCommand(
    command: string,
    args: string[],
    context: ToolExecutionContext,
    deadline: GrepDeadline,
  ) {
    return spawnGrepCommand(command, args, {
      cwd: context.workingDirectory,
      deadline,
    });
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
    if (numFiles === 0 && !content) return this.formatNoMatch(pattern, searchPath, globPattern, fileType);
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset);
    if (mode === 'content') return `找到 ${numLines} 行匹配${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content;
    if (mode === 'count') return `找到 ${numMatches} 个匹配，分布在 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + content;
    return `找到 ${numFiles} 个文件${limitInfo ? ` (${limitInfo})` : ''}:\n模式: ${pattern}\n路径: ${searchPath || '.'}\n${globPattern ? `Glob: ${globPattern}\n` : ''}${fileType ? `类型: ${fileType}\n` : ''}\n` + filenames.map((file, i) => `${(i + 1).toString().padStart(4, ' ')}. ${file}`).join('\n');
  }
}
