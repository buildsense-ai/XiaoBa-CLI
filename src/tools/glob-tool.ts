import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { formatCatsCoVisiblePath, isCatsCoToolGatewayContext } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

type GlobEntryKind = 'file' | 'directory' | 'symlink' | 'other';
type GlobKindFilter = 'files' | 'directories' | 'all';

interface GlobEntry {
  path: string;
  kind: GlobEntryKind;
  mtime: number;
  size?: number;
  matchedPatterns: string[];
}

interface GlobResult {
  numEntries: number;
  totalMatches: number;
  entries: GlobEntry[];
  truncated: boolean;
  durationMs: number;
  patterns: string[];
  kind: GlobKindFilter;
  filters: {
    modifiedAfter?: string;
    modifiedBefore?: string;
    maxDepth?: number;
  };
  summary?: GlobSummary;
}

interface GlobSummary {
  byTopDirectory: Array<{ key: string; count: number }>;
  byExtension: Array<{ key: string; count: number }>;
  byModifiedDay: Array<{ key: string; count: number }>;
}

export class GlobTool implements Tool {
  definition: ToolDefinition = {
    name: 'glob',
    description: [
      'Find files or directories by path pattern and metadata.',
      'Use this to discover candidate paths before grep/read_file. Use grep for content search.',
      'Supports multiple filename patterns, file/directory kind, modified time filters, max depth, and result summaries.',
      'For broad recent-file questions, prefer patterns + modified_after + max_depth + summary over repeated one-off glob calls.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Single glob pattern, e.g. "**/*.ts" or "src/**/*.js". Use either pattern or patterns.',
        },
        patterns: {
          type: 'array',
          description: 'Multiple glob patterns to search in one call. Results are deduplicated and can show matched patterns.',
          items: { type: 'string' },
        },
        path: {
          type: 'string',
          description: 'Search root directory. Defaults to the current working directory. Can use resolve_common_directory output.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 100.',
          default: 100,
        },
        kind: {
          type: 'string',
          description: 'Return files, directories, or all entries. Defaults to files.',
          enum: ['files', 'directories', 'all'],
          default: 'files',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum search depth relative to path. Use 1-3 for shallow structure checks.',
        },
        modified_after: {
          type: 'string',
          description: 'Only return entries modified after this time. Accepts ISO time or YYYY-MM-DD.',
        },
        modified_before: {
          type: 'string',
          description: 'Only return entries modified before this time. Accepts ISO time or YYYY-MM-DD.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include dotfiles and dot-directories. Defaults to false.',
          default: false,
        },
        summary: {
          type: 'boolean',
          description: 'Include summary facets by top directory, extension, and modified day.',
          default: false,
        },
        target: targetParameterDescription(),
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const searchPath = args?.path;
    const patterns = normalizePatterns(args);
    const limit = normalizeLimit(args?.limit);
    const kind = normalizeKind(args?.kind);
    const maxDepth = normalizePositiveInteger(args?.max_depth);
    const modifiedAfter = parseDateFilter(args?.modified_after);
    const modifiedBefore = parseDateFilter(args?.modified_before);
    const includeHidden = args?.include_hidden === true;
    const includeSummary = args?.summary === true;
    const startTime = Date.now();

    if (patterns.length === 0) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'glob requires either pattern or patterns.',
      };
    }

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'glob',
      target: args?.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteArgs = typeof args?.pattern === 'string' && args.pattern.trim()
      ? args
      : (patterns.length > 0 ? { ...args, pattern: patterns[0] } : args);
    const remoteResult = await executeRouteIfRemote(context, route, 'glob', 'glob', remoteArgs);
    if (remoteResult) return remoteResult;

    const cwd = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(context.workingDirectory, searchPath))
      : context.workingDirectory;

    const pathPermission = isReadPathAllowed(cwd, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Execution blocked: ${pathPermission.reason}` };
    }

    const visibleSearchPath = formatCatsCoVisiblePath(context, searchPath || '.', { preserveRelative: true });
    const visibleCwd = formatCatsCoVisiblePath(context, cwd);

    if (!fs.existsSync(cwd)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `Directory not found: ${visibleCwd}` };
    }

    const shouldReturnAbsolutePaths = !isCatsCoToolGatewayContext(context) && Boolean(searchPath && path.isAbsolute(searchPath));
    const matchedPaths = new Map<string, Set<string>>();

    for (const candidatePattern of patterns) {
      const matches = await glob(candidatePattern, {
        cwd,
        absolute: false,
        nodir: kind === 'files',
        dot: includeHidden,
        maxDepth,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        windowsPathsNoEscape: process.platform === 'win32',
      });
      for (const match of matches) {
        const normalized = normalizeRelativePath(String(match));
        if (!matchedPaths.has(normalized)) matchedPaths.set(normalized, new Set());
        matchedPaths.get(normalized)!.add(candidatePattern);
      }
    }

    const entries = await collectEntries(cwd, matchedPaths, {
      kind,
      modifiedAfter,
      modifiedBefore,
    });
    entries.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));

    const truncated = entries.length > limit;
    const limitedEntries = entries.slice(0, limit).map(entry => ({
      ...entry,
      path: shouldReturnAbsolutePaths ? path.join(cwd, entry.path) : entry.path,
    }));

    const result: GlobResult = {
      numEntries: limitedEntries.length,
      totalMatches: entries.length,
      entries: limitedEntries,
      truncated,
      durationMs: Date.now() - startTime,
      patterns,
      kind,
      filters: {
        modifiedAfter: modifiedAfter?.label,
        modifiedBefore: modifiedBefore?.label,
        maxDepth,
      },
      summary: includeSummary ? buildSummary(entries) : undefined,
    };

    return { ok: true, content: this.formatResult(result, visibleSearchPath, visibleCwd, limit) };
  }

  private formatResult(
    result: GlobResult,
    visibleSearchPath: string,
    visibleCwd: string,
    limit: number,
  ): string {
    const { numEntries, totalMatches, entries, truncated, durationMs, patterns, kind, filters, summary } = result;
    const noun = kind === 'files' ? 'files' : kind === 'directories' ? 'directories' : 'entries';
    const header = [
      `Found ${numEntries}/${totalMatches} ${noun} (${durationMs}ms)${truncated ? ' - truncated' : ''}:`,
      `Patterns: ${patterns.join(', ')}`,
      `Directory: ${visibleSearchPath}`,
      `Path: ${visibleCwd}`,
      `Kind: ${kind}`,
      filters.maxDepth !== undefined ? `Max depth: ${filters.maxDepth}` : '',
      filters.modifiedAfter ? `Modified after: ${filters.modifiedAfter}` : '',
      filters.modifiedBefore ? `Modified before: ${filters.modifiedBefore}` : '',
      '',
    ].filter(line => line !== '').join('\n');

    const summaryText = summary ? [
      'Summary:',
      formatFacet('top directories', summary.byTopDirectory),
      formatFacet('extensions', summary.byExtension),
      formatFacet('modified days', summary.byModifiedDay),
      '',
    ].join('\n') : '';

    if (entries.length === 0) {
      return [
        header,
        summaryText,
        'No matching entries.',
        'Try broader patterns, a wider modified_after/modified_before range, or a higher max_depth.',
      ].filter(Boolean).join('\n');
    }

    const entryList = entries.map((entry, i) => {
      const kindLabel = entry.kind.padEnd(9, ' ');
      const modified = entry.mtime > 0 ? new Date(entry.mtime).toISOString() : 'unknown';
      const size = entry.kind === 'file' ? formatBytes(entry.size ?? 0).padStart(9, ' ') : ''.padStart(9, ' ');
      const suffix = entry.kind === 'directory' ? '/' : '';
      const matched = entry.matchedPatterns.length > 1 ? ` [${entry.matchedPatterns.join(', ')}]` : '';
      return `${(i + 1).toString().padStart(4, ' ')}. [${kindLabel}] ${size} ${modified} ${entry.path}${suffix}${matched}`;
    }).join('\n');

    return [
      header,
      summaryText,
      entryList,
      truncated ? `\nHint: results were limited to ${limit}. Use narrower patterns, modified_after/modified_before, max_depth, or a more specific path to continue.` : '',
    ].filter(Boolean).join('\n');
  }
}

function normalizePatterns(args: any): string[] {
  const values: string[] = [];
  if (typeof args?.pattern === 'string' && args.pattern.trim()) values.push(args.pattern.trim());
  if (Array.isArray(args?.patterns)) {
    for (const item of args.patterns) {
      if (typeof item === 'string' && item.trim()) values.push(item.trim());
    }
  }
  return [...new Set(values)].slice(0, 20);
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.floor(parsed);
}

function normalizeKind(value: unknown): GlobKindFilter {
  if (value === 'directories' || value === 'all') return value;
  return 'files';
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseDateFilter(value: unknown): { timestamp: number; label: string } | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const label = String(value).trim();
  if (!label) return undefined;
  const timestamp = typeof value === 'number' ? value : Date.parse(label);
  if (!Number.isFinite(timestamp)) return undefined;
  return { timestamp, label };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

async function collectEntries(
  cwd: string,
  matchedPaths: Map<string, Set<string>>,
  options: {
    kind: GlobKindFilter;
    modifiedAfter?: { timestamp: number };
    modifiedBefore?: { timestamp: number };
  },
): Promise<GlobEntry[]> {
  const entries: GlobEntry[] = [];
  for (const [relativePath, matchedPatterns] of matchedPaths) {
    const fullPath = path.join(cwd, relativePath);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(fullPath);
    } catch {
      continue;
    }
    const kind = entryKind(stats);
    if (options.kind === 'files' && kind !== 'file') continue;
    if (options.kind === 'directories' && kind !== 'directory') continue;
    const mtime = stats.mtime.getTime();
    if (options.modifiedAfter && mtime < options.modifiedAfter.timestamp) continue;
    if (options.modifiedBefore && mtime > options.modifiedBefore.timestamp) continue;
    entries.push({
      path: relativePath,
      kind,
      mtime,
      size: kind === 'file' ? stats.size : undefined,
      matchedPatterns: [...matchedPatterns],
    });
  }
  return entries;
}

function entryKind(stats: fs.Stats): GlobEntryKind {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function buildSummary(entries: GlobEntry[]): GlobSummary {
  return {
    byTopDirectory: topFacet(entries.map(entry => topDirectory(entry.path))),
    byExtension: topFacet(entries.map(entry => entry.kind === 'directory' ? '[directory]' : extensionOf(entry.path))),
    byModifiedDay: topFacet(entries.map(entry => entry.mtime > 0 ? new Date(entry.mtime).toISOString().slice(0, 10) : 'unknown')),
  };
}

function topFacet(values: string[], limit = 8): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function topDirectory(filePath: string): string {
  const normalized = normalizeRelativePath(filePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '.';
  return parts[0];
}

function extensionOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext || '[no extension]';
}

function formatFacet(label: string, values: Array<{ key: string; count: number }>): string {
  if (values.length === 0) return `  ${label}: none`;
  return `  ${label}: ${values.map(item => `${item.key}=${item.count}`).join(', ')}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
