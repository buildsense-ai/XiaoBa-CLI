import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { jsonToolError, jsonToolResult, MemoryLogStore } from '../core/memory-log-store';

export interface MemorySearchFinishPayload {
  summary: string;
  refs: string[];
}

export type MemorySearchFinishHandler = (payload: MemorySearchFinishPayload) => void;

const CANONICAL_REF_PATTERN = /^[^/\\#]+\/\d{4}-\d{2}-\d{2}\/[^/\\#]+\.jsonl#\d+$/;

export class MemorySearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_search',
    description: [
      'Search prior session turn logs for memory relevant to the current task.',
      'Use specific keywords, not broad phrases. Multiple keywords use OR recall.',
      'Returns compact JSON containing canonical refs and matched keywords only.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          description: 'Specific keywords or fixed terms to search for. Avoid generic words.',
          items: { type: 'string' },
        },
        start_time: {
          type: 'string',
          description: 'Optional inclusive ISO time or YYYY-MM-DD lower bound.',
        },
        end_time: {
          type: 'string',
          description: 'Optional inclusive ISO time or YYYY-MM-DD upper bound.',
        },
        limit: {
          type: 'number',
          description: 'Maximum returned refs. Default 80, hard max 120.',
          default: 80,
        },
      },
      required: ['keywords'],
    },
  };

  constructor(private readonly store: MemoryLogStore) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const matches = await this.store.search({
        keywords: args?.keywords,
        startTime: args?.start_time,
        endTime: args?.end_time,
        limit: args?.limit,
      }, context.abortSignal);
      return {
        ok: true,
        content: jsonToolResult({
          count: matches.length,
          matches: matches.map(match => ({
            ref: match.ref,
            hits: match.hits,
          })),
        }),
      };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

export class MemoryReadTurnTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_read_turn',
    description: 'Read one memory episode by canonical ref. Returns compact JSON with ref, text, and truncation flag.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Canonical memory ref, e.g. catscompany/2026-06-16/file.jsonl#42.',
        },
        budget_chars: {
          type: 'number',
          description: 'Approximate maximum characters returned. Default 12000, hard max 40000.',
          default: 12000,
        },
      },
      required: ['ref'],
    },
  };

  constructor(private readonly store: MemoryLogStore) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.store.readTurn(String(args?.ref || ''), {
        budgetChars: args?.budget_chars,
      }, context.abortSignal);
      return { ok: true, content: jsonToolResult(result) };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

export class MemoryNeighborsTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_neighbors',
    description: 'Read nearby memory episodes from the same log file by canonical ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Canonical memory ref.',
        },
        previous: {
          type: 'number',
          description: 'How many preceding episodes to include. Default 1, hard max 20.',
          default: 1,
        },
        next: {
          type: 'number',
          description: 'How many following episodes to include. Default 1, hard max 20.',
          default: 1,
        },
        budget_chars: {
          type: 'number',
          description: 'Approximate total character budget. Default 20000, hard max 60000.',
          default: 20000,
        },
      },
      required: ['ref'],
    },
  };

  constructor(private readonly store: MemoryLogStore) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.store.readNeighbors(String(args?.ref || ''), {
        previous: args?.previous,
        next: args?.next,
        budgetChars: args?.budget_chars,
      }, context.abortSignal);
      return { ok: true, content: jsonToolResult(result) };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

export class FinishMemorySearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'finish_memory_search',
    description: [
      'Finish the memory search branch.',
      'Call this exactly once when you have enough memory evidence or when no useful memory exists.',
      'The successful call ends the branch immediately.',
    ].join(' '),
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Concise task-focused memory summary. Say no useful memory was found if applicable.',
        },
        refs: {
          type: 'array',
          description: 'Canonical refs supporting the summary. Empty when no useful memory was found.',
          items: { type: 'string' },
        },
      },
      required: ['summary', 'refs'],
    },
  };

  constructor(private readonly onFinish: MemorySearchFinishHandler) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validateFinishArgs(args);
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: jsonToolError(validation.error),
        retryable: false,
      };
    }
    this.onFinish(validation.payload);
    return {
      ok: true,
      content: jsonToolResult({ ok: true }),
    };
  }
}

function validateFinishArgs(args: any):
  | { ok: true; payload: MemorySearchFinishPayload }
  | { ok: false; error: string } {
  const summary = String(args?.summary || '').trim();
  if (!summary) {
    return { ok: false, error: 'summary must be a non-empty string' };
  }
  if (!Array.isArray(args?.refs)) {
    return { ok: false, error: 'refs must be an array of canonical memory refs' };
  }
  const refs = args.refs.map((ref: unknown) => String(ref || '').trim()).filter(Boolean);
  for (const ref of refs) {
    if (!CANONICAL_REF_PATTERN.test(ref)) {
      return { ok: false, error: `invalid canonical ref: ${ref}` };
    }
  }
  return {
    ok: true,
    payload: {
      summary,
      refs: Array.from(new Set(refs)),
    },
  };
}

function toolError(error: any): ToolExecutionResult {
  return {
    ok: false,
    errorCode: error?.errorCode || 'TOOL_EXECUTION_ERROR',
    message: jsonToolError(String(error?.message || error || 'tool error')),
    retryable: false,
  };
}
