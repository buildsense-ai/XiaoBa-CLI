import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveToolPath } from '../utils/tool-path-resolver';
import { formatCatsCoVisiblePath } from './tool-gateway';

export const CONNECTOR_READ_MAX_LINES = 2_000;
export const CONNECTOR_READ_MAX_BYTES = 256 * 1024;

/**
 * Small text-file reader used by Connector Lite.
 *
 * The full ReadTool also contains PDF rendering, image analysis and model
 * vision fallback code. Those features belong to the Agent Runtime and are
 * intentionally not part of a device execution endpoint.
 */
export class ConnectorReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_file',
    description: 'Read a UTF-8 text file on this authorized computer. Use glob or grep first when the path is unknown.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path or path relative to the current working directory.' },
        offset: { type: 'number', description: '1-based starting line. Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines. Defaults to ${CONNECTOR_READ_MAX_LINES}.` },
      },
      required: ['file_path'],
    },
  };

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const inputPath = typeof args?.file_path === 'string' ? args.file_path.trim() : '';
    if (!inputPath) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'file_path is required.' };
    }

    const resolved = resolveToolPath(inputPath, context);
    const visiblePath = formatCatsCoVisiblePath(context, inputPath, { preserveRelative: true });
    if (!resolved.exists) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `File not found: ${visiblePath}` };
    }
    if (!resolved.isFile) {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `Path is not a file: ${visiblePath}` };
    }

    const offset = normalizeInteger(args?.offset, 1, 1);
    const requestedLimit = normalizeInteger(args?.limit, CONNECTOR_READ_MAX_LINES, 0);
    const limit = Math.min(requestedLimit === 0 ? CONNECTOR_READ_MAX_LINES : requestedLimit, CONNECTOR_READ_MAX_LINES);
    const stat = fs.statSync(resolved.absolutePath);
    if (stat.size > CONNECTOR_READ_MAX_BYTES) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `File is larger than Connector Lite's ${CONNECTOR_READ_MAX_BYTES} byte text-read limit: ${visiblePath}`,
      };
    }

    let content: string;
    try {
      content = fs.readFileSync(resolved.absolutePath, 'utf8');
    } catch (error: any) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Unable to read ${visiblePath}: ${error?.message || error}` };
    }
    const lines = content.split(/\r?\n/);
    const start = Math.min(offset - 1, lines.length);
    const selected = lines.slice(start, start + limit);
    const end = selected.length > 0 ? start + selected.length : start;
    const suffix = end < lines.length ? `\n\n[truncated; continue with offset=${end + 1}]` : '';
    return {
      ok: true,
      content: [
        `File: ${visiblePath}`,
        `Lines: ${start + 1}-${end} of ${lines.length}`,
        '',
        selected.join('\n'),
        suffix,
      ].join('\n'),
    };
  }
}

function normalizeInteger(value: unknown, fallback: number, minimum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}
