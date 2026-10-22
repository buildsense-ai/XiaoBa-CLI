import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { jsonToolError, jsonToolResult, MemoryLogStore } from '../core/memory-log-store';

import {
  CATSLOG_POOL_CITATION_REF_PATTERN,
  hasCatsLogControlCodePoint,
  isSafeCatsLogOpaqueIdentifier,
  isSafeCatsLogSkillHandle,
} from '../utils/catsco-log-agent-client';

export interface MemorySearchFinishPayload {
  summary: string;
  refs: string[];
  inject: boolean;
  terminalReason?: 'invalid_finalization_exhausted';
}

export type MemorySearchFinishHandler = (payload: MemorySearchFinishPayload) => void;

export const MEMORY_FINISH_MAX_INVALID_ATTEMPTS = 3;

const CANONICAL_REF_PATTERN = /^[^/\\#]+\/\d{4}-\d{2}-\d{2}\/[^/\\#]+\.jsonl#\d+$/;

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

/**
 * In-loop expansion of a typed CatsLog `source_reference` locator
 * Candidates discovered during the 3s metadata prefetch remain eligible
 * for an explicit read with its own 15s deadline. The session owns the
 * two-read/16KB whole-run budget and delivered-reference membership.
 */
export class MemorySourceReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_source_read',
    description: [
      '按 ref_<64hex> 展开一个已发现的 source_reference 定位符为完整派生投影。',
      '只能读取本次检索中 agent_memory 通道实际返回的 source_reference ref；读取共享整轮调用与视图预算，耗尽后返回 reference_only。',
      '返回紧凑 JSON：{ref,status:"expanded"|"reference_only"|"rejected",semantic_view?|expansion_error?}。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: '本 run 发现的 source_reference 的 ref_<64hex>。',
        },
      },
      required: ['ref'],
    },
  };

  constructor(
    private readonly expand: (ref: string, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.expand(String(args?.ref || ''), context?.abortSignal);
      return { ok: true, content: jsonToolResult(result) };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

/**
 * Model-driven remote recall over the device-bound agent_memory branch lane.
 * One model-selected literal term (<=64 code points) per search. Empty-query
 * prefetch enumerates bounded candidates in server source-native order;
 * it makes no relevance claim. Expansion remains a separate bounded read.
 */
export class MemorySourceAssertionReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_assertion_read',
    description: [
      '只为当前用户问题中的一个明确断言，读取已发现 Collection/Delta 根下对应 member 的限定闭包。',
      '必须先用 memory_source_read 展开同一 ref，并依据其 typed Delta relation/Collection binding 选定 member_ref 与 node_id。',
      '服务器重新验证当前 capability、源范围和 member，客户端每个 run 只允许一次、不超过 12 KiB/16 nodes。',
      'Collection membership 本身不是结论；只有 complete 的 assertion closure 才可支持 finish_memory_search。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '本 run 已发现并展开的 Collection/Delta ref_<64hex>。' },
        member_ref: { type: 'string', description: '所展开根的 exact member ref_<64hex>。' },
        node_id: { type: 'string', description: '本 run 已读 Delta relation 中的 assertion node ID。' },
      },
      required: ['ref', 'member_ref', 'node_id'],
    },
  };
  constructor(private readonly read: (input: { ref: string; memberRef: string; nodeId: string }, signal?: AbortSignal) => Promise<Record<string, unknown>>) {}
  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const ref = typeof args?.ref === 'string' ? args.ref.trim() : '';
    const memberRef = typeof args?.member_ref === 'string' ? args.member_ref.trim() : '';
    const nodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
    if (!CATSLOG_POOL_CITATION_REF_PATTERN.test(ref) || !CATSLOG_POOL_CITATION_REF_PATTERN.test(memberRef)
      || !/^[a-f0-9]{64}$/.test(nodeId)) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'A discovered collection ref, exact member ref, and assertion node ID are required.', retryable: true };
    }
    try { return { ok: true, content: jsonToolResult(await this.read({ ref, memberRef, nodeId }, context?.abortSignal)) }; }
    catch (error: any) { return toolError(error); }
  }
}

export class MemoryRemoteSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_remote_search',
    description: [
      '按关键词检索 device-bound CatsLog agent_memory 通道的 typed source_reference 定位符。',
      'keywords 只能传一个由你选择的 literal 子串（≤64 code points）；底层为 ILIKE，不是语义检索。',
      '返回紧凑 JSON {status,items:[{ref,kind,text}]}；item 只是元数据定位符，需要 memory_source_read 展开。',
      '整句任务描述几乎不可能命中——请拆成具体实体名、术语、项目名等短关键词。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          description: '一个具体检索词（单元素数组，每项 ≤64 个 code point）。',
          items: { type: 'string' },
        },
      },
      required: ['keywords'],
    },
  };

  constructor(
    private readonly search: (keywords: string[], signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const keywords = Array.isArray(args?.keywords) ? args.keywords : [];
      if (keywords.some((keyword: unknown) => typeof keyword !== 'string')) return {
        ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'keywords must contain strings only', retryable: true,
      };
      const result = await this.search(keywords, context?.abortSignal);
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
      'inject 是必填布尔值，不得省略。',
      '找到有新增价值的记忆时设置 inject:true，并必须提供支撑 summary 的 evidence。',
      '如果只找到 recent context 已覆盖的信息，或没有值得注入给主 agent 的额外记忆，设置 inject:false 并传空 evidence。',
      '示例：有证据时 {"summary":"...","evidence":["chat/2026-08-13/demo.jsonl#1"],"inject":true}；无新增记忆时 {"summary":"No useful memory.","evidence":[],"inject":false}。',
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
        evidence: {
          type: 'array',
          description: '支撑 summary 的 canonical evidence。inject:true 时至少一个；inject:false 时传空数组。',
          items: { type: 'string' },
        },
        inject: {
          type: 'boolean',
          description: '必填。找到有新增价值且 evidence 非空时传 true；没有新增价值且 evidence 为空时传 false。不得省略。',
        },
      },
      required: ['summary', 'evidence', 'inject'],
    },
  };

  private invalidAttempts = 0;

  constructor(
    private readonly onFinish: MemorySearchFinishHandler,
    private readonly isDeliveredPoolRef: (ref: string) => boolean = () => false,
  ) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validateFinishArgs(args, this.isDeliveredPoolRef);
    if (!validation.ok) {
      return this.invalidResult(validation.error);
    }
    this.invalidAttempts = 0;
    this.onFinish(validation.payload);
    return {
      ok: true,
      content: jsonToolResult({ ok: true }),
    };
  }

  async handleInvalidArguments(message: string): Promise<ToolExecutionResult> {
    return this.invalidResult(message);
  }

  private invalidResult(error: string): ToolExecutionResult {
    this.invalidAttempts += 1;
    if (this.invalidAttempts >= MEMORY_FINISH_MAX_INVALID_ATTEMPTS) {
      this.onFinish({
        summary: 'Memory search stopped after repeated invalid finalization calls; no observation was injected.',
        refs: [],
        inject: false,
        terminalReason: 'invalid_finalization_exhausted',
      });
      return {
        ok: true,
        content: jsonToolResult({
          ok: false,
          terminal: true,
          reason: 'invalid_finalization_exhausted',
          invalid_attempts: this.invalidAttempts,
        }),
      };
    }
    return {
      ok: false,
      errorCode: 'INVALID_TOOL_ARGUMENTS',
      message: jsonToolError([
        error,
        `Attempt ${this.invalidAttempts}/${MEMORY_FINISH_MAX_INVALID_ATTEMPTS}. Correct format:`,
        'publish={"summary":"...","evidence":["chat/2026-08-13/demo.jsonl#1"],"inject":true}',
        'suppress={"summary":"No useful memory.","evidence":[],"inject":false}',
      ].join(' ')),
      retryable: true,
    };
  }
}

function validateFinishArgs(args: any, isDeliveredPoolRef: (ref: string) => boolean):
  | { ok: true; payload: MemorySearchFinishPayload }
  | { ok: false; error: string } {
  const summary = String(args?.summary || '').trim();
  if (!summary) {
    return { ok: false, error: 'summary must be a non-empty string' };
  }
  if (!Array.isArray(args?.evidence)) {
    return { ok: false, error: 'finish_memory_search requires evidence: string[]. Do not use ref or refs, or a scalar string; read tools still use ref: string' };
  }
  if (typeof args?.inject !== 'boolean') {
    return { ok: false, error: 'inject must be explicitly true or false' };
  }
  const inject = args.inject;
  if (args.evidence.some((ref: unknown) => typeof ref !== 'string')) {
    return { ok: false, error: 'evidence must contain strings only; use [] when inject is false' };
  }
  const evidence: string[] = args.evidence.map((ref: string) => ref.trim()).filter(Boolean);
  const uniqueRefs: string[] = Array.from(new Set(evidence));
  for (const ref of uniqueRefs) {
    // The active local grammar remains unchanged. Pool refs are an explicit
    // run-local extension, admitted only after complete delivery.
    if (!CANONICAL_REF_PATTERN.test(ref)
      && !(CATSLOG_POOL_CITATION_REF_PATTERN.test(ref) && isDeliveredPoolRef(ref))) {
      return { ok: false, error: `invalid canonical ref: ${ref}` };
    }
  }
  if (inject && uniqueRefs.length === 0) {
    return { ok: false, error: 'evidence must include at least one canonical memory ref unless inject is false' };
  }
  if (!inject && uniqueRefs.length > 0) {
    return { ok: false, error: 'evidence must be empty when inject is false' };
  }
  return {
    ok: true,
    payload: {
      summary,
      refs: uniqueRefs,
      inject,
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

// CatsLog refs are path-free stream citations (or explicitly namespaced
// hash/skill citations produced by the remote projection). Keep this grammar
// narrow so finish refs can never become URLs, filesystem paths, or tokens.
const CATSLOG_STREAM_REF_PATTERN = /^(.+)#(?:[1-9][0-9]*|summary)$/;
const CATSLOG_SESSION_HASH_REF_PATTERN = /^catslog:session:[a-f0-9]{24}$/;
const CATSLOG_SKILL_REF_PATTERN = /^catslog:skill:(.+)@([1-9][0-9]*)$/;
const CATSLOG_REF_HASH_PATTERN = /^catslog:ref:[a-f0-9]{24}$/;
// Local distilled-knowledge citations: managed KB documents and raw source
// Markdown under the KB store's documents/ tree (see xiaoba-knowledge). The
// path grammar is deliberately narrower than the store accepts: ASCII
// segments without dot-leading/dot-dot components, so a citation ref can
// never double as a traversal path or URL.
const KNOWLEDGE_KB_REF_PATTERN = /^kb:KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KNOWLEDGE_FILE_REF_PATTERN = /^file:documents\/(?:[A-Za-z0-9][A-Za-z0-9 ._-]*\/)*[A-Za-z0-9][A-Za-z0-9 ._-]*\.[mM][dD]$/;

/**
 * Citable ref form of a local distilled-knowledge document: `kb:<KB-ID>` for
 * managed documents, `file:documents/...` for raw source Markdown.
 */
export function isKnowledgeCitationRef(ref: string): boolean {
  if (KNOWLEDGE_KB_REF_PATTERN.test(ref)) return true;
  return KNOWLEDGE_FILE_REF_PATTERN.test(ref) && ref.length <= 512 && !ref.includes('..');
}

export function isMemoryCitationRef(ref: string): boolean {
  if (CANONICAL_REF_PATTERN.test(ref) || CATSLOG_SESSION_HASH_REF_PATTERN.test(ref) || CATSLOG_REF_HASH_PATTERN.test(ref)) {
    return true;
  }
  if (isKnowledgeCitationRef(ref)) return true;
  // Server pool-citation refs pass through the branch projection unchanged;
  // the observed-refs tracker still gates any citation of them.
  if (CATSLOG_POOL_CITATION_REF_PATTERN.test(ref)) return true;
  const stream = ref.match(CATSLOG_STREAM_REF_PATTERN);
  if (stream && isSafeCatsLogOpaqueIdentifier(stream[1], 256)) return true;
  const skill = ref.match(CATSLOG_SKILL_REF_PATTERN);
  return Boolean(skill && isSafeCatsLogSkillHandle(skill[1]) && Number.isSafeInteger(Number(skill[2])));
}
