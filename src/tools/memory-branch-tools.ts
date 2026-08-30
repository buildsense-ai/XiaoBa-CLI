import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { jsonToolError, jsonToolResult, MemoryLogStore } from '../core/memory-log-store';
import { isSafeCatsLogOpaqueIdentifier, isSafeCatsLogSkillHandle } from '../utils/catsco-log-agent-client';

export interface MemorySearchFinishPayload {
  summary: string;
  refs: string[];
  inject: boolean;
  /** Explicitly separates parent-context delivery from audit-only retention. */
  delivery?: 'context' | 'audit' | 'discard';
}

export type MemorySearchFinishHandler = (payload: MemorySearchFinishPayload) => void;

const CANONICAL_REF_PATTERN = /^[^/\\#]+\/\d{4}-\d{2}-\d{2}\/[^/\\#]+\.jsonl#\d+$/;
// CatsLog refs are path-free stream citations (or explicitly namespaced
// hash/skill citations produced by the remote projection). Keep this grammar
// narrow so finish refs can never become URLs, filesystem paths, or tokens.
const CATSLOG_STREAM_REF_PATTERN = /^(.+)#(?:[1-9][0-9]*|summary)$/;
const CATSLOG_SESSION_HASH_REF_PATTERN = /^catslog:session:[a-f0-9]{24}$/;
const CATSLOG_SKILL_REF_PATTERN = /^catslog:skill:(.+)@([1-9][0-9]*)$/;
const CATSLOG_REF_HASH_PATTERN = /^catslog:ref:[a-f0-9]{24}$/;

export function isMemoryCitationRef(ref: string): boolean {
  if (CANONICAL_REF_PATTERN.test(ref) || CATSLOG_SESSION_HASH_REF_PATTERN.test(ref) || CATSLOG_REF_HASH_PATTERN.test(ref)) {
    return true;
  }
  const stream = ref.match(CATSLOG_STREAM_REF_PATTERN);
  if (stream && isSafeCatsLogOpaqueIdentifier(stream[1], 256)) return true;
  const skill = ref.match(CATSLOG_SKILL_REF_PATTERN);
  return Boolean(skill && isSafeCatsLogSkillHandle(skill[1]) && Number.isSafeInteger(Number(skill[2])));
}

export class MemorySearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_search',
    description: [
      '搜索历史 session turn 日志，召回与当前任务相关的记忆。',
      'keywords 是独立关键词数组，多个关键词按 OR 召回；底层是子串匹配，不会自动分词，也不是语义搜索。',
      '不要把多个词用空格拼成一个 keyword；请把它们拆成多个数组元素。',
      '返回紧凑 JSON，只包含 canonical refs 和命中的关键词。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          description: '要搜索的具体关键词、固定术语、工具名、文件名或项目名。每个数组元素都是一个独立 substring query；不要传入长句或用空格拼接多个词。',
          items: { type: 'string' },
        },
        start_time: {
          type: 'string',
          description: '可选的包含式时间下界，支持 ISO time 或 YYYY-MM-DD。',
        },
        end_time: {
          type: 'string',
          description: '可选的包含式时间上界，支持 ISO time 或 YYYY-MM-DD。',
        },
        limit: {
          type: 'number',
          description: '最多返回多少个 refs。默认 80，硬上限 120。',
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
    description: '按 canonical ref 读取一个历史 episode。返回紧凑 JSON，包含 ref、text，以及可选的 truncated 标记。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'canonical memory ref，例如 catscompany/2026-06-16/file.jsonl#42。',
        },
        budget_chars: {
          type: 'number',
          description: '返回文本的近似字符预算。默认 12000，硬上限 40000。',
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
    description: '按 canonical ref 读取同一个日志文件中的相邻历史 episodes，用于沿线追踪上下文。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'canonical memory ref。',
        },
        previous: {
          type: 'number',
          description: '要包含多少个前序 episodes。默认 1，硬上限 20。',
          default: 1,
        },
        next: {
          type: 'number',
          description: '要包含多少个后续 episodes。默认 1，硬上限 20。',
          default: 1,
        },
        budget_chars: {
          type: 'number',
          description: '总返回文本的近似字符预算。默认 20000，硬上限 60000。',
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
      '结束 memory search branch。',
      '当你已经拿到足够的记忆证据，或确认没有有用记忆时，调用这个工具。',
      '正常找到有新增价值的记忆时不需要设置 inject，并必须提供支撑 summary 的 refs。',
      '如果证据只需要留在 branch 审计日志、不应注入主 agent，可设置 delivery:"audit"、inject:false，并保留 refs。',
      '如果完全没有可保留的价值，设置 delivery:"discard"、inject:false，并传空 refs。',
      '调用成功后 branch 会立刻结束。',
    ].join(' '),
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '面向当前任务的简洁记忆总结。保留当前任务需要的具体锚点；没有新增有用记忆时也要简短说明。',
        },
        refs: {
          type: 'array',
          description: '支撑 summary 的 canonical refs。context/audit 至少一个；discard 必须为空。',
          items: { type: 'string' },
        },
        inject: {
          type: 'boolean',
          description: '可选，兼容旧调用。默认根据 delivery 推导；audit/discard 必须为 false，context 为 true。',
        },
        delivery: {
          type: 'string',
          enum: ['context', 'audit', 'discard'],
          description: '可选。context 注入主 agent，audit 只留审计证据，discard 完全丢弃；省略时沿用 inject 兼容语义。',
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
  if (typeof args?.inject !== 'undefined' && typeof args.inject !== 'boolean') {
    return { ok: false, error: 'inject must be a boolean when provided' };
  }
  const rawDelivery = args?.delivery;
  if (rawDelivery !== undefined && rawDelivery !== 'context' && rawDelivery !== 'audit' && rawDelivery !== 'discard') {
    return { ok: false, error: 'delivery must be context, audit, or discard when provided' };
  }
  const hasExplicitInject = typeof args?.inject !== 'undefined';
  const inject = hasExplicitInject
    ? args.inject === true
    : rawDelivery === undefined || rawDelivery === 'context';
  const delivery: MemorySearchFinishPayload['delivery'] = rawDelivery
    || (inject ? 'context' : 'discard');
  const refs: string[] = args.refs.map((ref: unknown) => String(ref || '').trim()).filter(Boolean);
  for (const ref of refs) {
    if (!isMemoryCitationRef(ref)) {
      return { ok: false, error: `invalid canonical ref: ${ref}` };
    }
  }
  const uniqueRefs: string[] = Array.from(new Set(refs));
  if (delivery === 'context' && !inject) {
    return { ok: false, error: 'inject must be true when delivery is context' };
  }
  if (delivery !== 'context' && inject) {
    return { ok: false, error: `inject must be false when delivery is ${delivery}` };
  }
  if (delivery === 'context' && uniqueRefs.length === 0) {
    return {
      ok: false,
      error: rawDelivery === undefined
        ? 'refs must include at least one canonical memory ref unless inject is false'
        : 'refs must include at least one canonical memory ref for context delivery',
    };
  }
  if (delivery === 'discard' && uniqueRefs.length > 0) {
    return {
      ok: false,
      error: rawDelivery === undefined
        ? 'refs must be empty when inject is false'
        : 'refs must be empty when delivery is discard',
    };
  }
  if (delivery === 'audit' && uniqueRefs.length === 0) {
    return { ok: false, error: 'refs must include at least one canonical memory ref for audit delivery' };
  }
  return {
    ok: true,
    payload: {
      summary,
      refs: uniqueRefs,
      inject,
      ...(rawDelivery !== undefined ? { delivery } : {}),
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
