import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { jsonToolError, jsonToolResult, MemoryLogStore, type ArchiveTurnPin } from '../core/memory-log-store';

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

/** One verified claim, published before the investigation ends. */
export interface MemoryPublishFindingPayload {
  subject: string;
  claim: string;
  refs: string[];
  qualification?: string;
  supersedes?: string[];
}

export type MemoryPublishFindingResult = {
  ok: boolean;
  observation_id?: string;
  verified_through_input?: number;
  reason?: string;
};

export const MEMORY_PUBLISH_MAX_INVALID_ATTEMPTS = 3;

const CANONICAL_REF_PATTERN = /^[^/\\#]+\/\d{4}-\d{2}-\d{2}\/[^/\\#]+\.jsonl#(?:\d+|(?:run|input|legacy):[a-zA-Z0-9:_-]+)$/;

export class MemorySearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_search',
    description: [
      '搜索历史 session turn 日志，召回与当前任务相关的记忆。',
      'keywords 是独立关键词数组，多个关键词按 OR 召回；底层是子串匹配，不会自动分词，也不是语义搜索。',
      '不要把多个词用空格拼成一个 keyword；请把它们拆成多个数组元素。',
      '返回命中字段、附近原文和会话首行作为不可信候选预览。只用预览筛选；需要引用时必须读取完整来源。',
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
          description: '最多返回多少个候选。默认 8，最多 16。',
          default: 8,
        },
      },
      required: ['keywords'],
    },
  };

  constructor(private readonly store: MemoryLogStore, private readonly excludeRun?: {sessionId: string; runId: string}) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const matches = await this.store.search({
        keywords: args?.keywords,
        startTime: args?.start_time,
        endTime: args?.end_time,
        limit: Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(16, args.limit) : 8,
        excludeRun: this.excludeRun,
      }, context.abortSignal);
      return {
        ok: true,
        content: jsonToolResult({
          count: matches.length,
          matches: matches.map(({ ref, hits, title, field, preview }) => ({ ref, hits, title, field, preview })),
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

  constructor(private readonly store: MemoryLogStore, private readonly onRead?: (ref: string, archive?: ArchiveTurnPin, truncated?: boolean) => void) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.store.readTurn(String(args?.ref || ''), {
        budgetChars: args?.budget_chars,
      }, context.abortSignal);
      const {archive, ...visible} = result;
      this.onRead?.(result.ref, archive, result.truncated);
      return { ok: true, content: jsonToolResult(visible) };
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

  constructor(private readonly store: MemoryLogStore, private readonly onRead?: (ref: string, archive?: ArchiveTurnPin, truncated?: boolean) => void) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.store.readNeighbors(String(args?.ref || ''), {
        previous: args?.previous,
        next: args?.next,
        budgetChars: args?.budget_chars,
      }, context.abortSignal);
      const turns = result.turns.map(({archive, ...visible}) => {
        this.onRead?.(visible.ref, archive, visible.truncated);
        return visible;
      });
      return { ok: true, content: jsonToolResult({...result, turns}) };
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
 * Exact read of one readable handle this run issued: a Memory node (canonical
 * memory-graph/3 view) or a session turn / learning node (one complete source),
 * cited by a Diary entry the main agent read or reached through memory_links.
 * Whole or not at all.
 */
export class MemoryNodeReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_node_read',
    description: [
      '读取一个本 run 发出的可读句柄：memory-node:…（精确记忆节点及其条件/省略）或 source:…（完整的历史会话 turn / 学习节点）。',
      '句柄来自 document_graph_seeds 或 memory_links 结果中 readable:true 的端点；entry:… 句柄只能用于 memory_links，不能读取。',
      '与 memory_source_read 共享整轮调用与视图预算；只交付完整内容，否则返回 reference_only。成功结果中的 ref（catslog:source:…）可写入 finish evidence。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '原样给出的 memory-node:… 或 source:… 句柄。' },
      },
      required: ['node'],
    },
  };

  constructor(
    private readonly read: (node: string, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      return { ok: true, content: jsonToolResult(await this.read(String(args?.node || ''), context?.abortSignal)) };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

/**
 * One body-free page of stored graph links around an issued handle. The
 * session resolves the handle to its exact anchor, validates every endpoint
 * and issues opaque handles for resolved remotes; coordinates never reach the model.
 */
export class MemoryLinksTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_links',
    description: [
      '沿 CatsLog 已存储的图关系做联想：给一个本 run 发出的句柄（entry:… / source:… / memory-node:…），返回与它相连的端点。',
      '结果只有关系类型（corrects/supplements/requires/derived_from/continues/related/used）、方向和新句柄，没有正文；有记忆图投影覆盖的会话 turn 直接给出记忆节点句柄（via 标明原端点类型）；entry 端点只能继续 memory_links，readable:true 的端点可用 memory_node_read 读取。',
      'paths 是本 run 中通往同一端点的不同关系数，越多说明关联越集中。每 run 最多 3 次，每次最多 16 条边。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '原样给出的 entry:… / source:… / memory-node:… 句柄。' },
        direction: { type: 'string', enum: ['in', 'out', 'both'], description: '可选。out=该端点指向别处，in=别处指向该端点；默认 both。' },
      },
      required: ['handle'],
    },
  };

  constructor(
    private readonly expand: (handle: string, direction: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      return { ok: true, content: jsonToolResult(await this.expand(String(args?.handle || ''), args?.direction, context?.abortSignal)) };
    } catch (error: any) {
      return toolError(error);
    }
  }
}

/**
 * Bounded closure of one assertion under a Collection/Delta root this run
 * already expanded. The session owns locator membership and the shared
 * two-read budget; the server revalidates capability, member and range.
 */
export class MemorySourceAssertionReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_assertion_read',
    description: [
      '只为当前问题中的一个明确断言，读取已展开 Collection/Delta 根下对应 member 的限定闭包。',
      '必须先用 memory_source_read 展开同一 ref，并依据其 Delta relation/节点或 Collection 成员选定 member_ref 与 node_id。',
      '每个 run 最多一次，与 memory_source_read 共享整轮调用预算；服务器限 12 KiB/16 nodes。',
      'Collection 成员列表本身不是结论；只有 status 为 complete 的闭包才可写入 finish evidence。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '本 run 已展开的 Collection/Delta ref_<64hex>。' },
        member_ref: { type: 'string', description: '该根的成员 ref_<64hex>；Delta 自身的新断言使用根 ref。' },
        node_id: { type: 'string', description: '64 位十六进制 assertion 节点 ID。' },
      },
      required: ['ref', 'member_ref', 'node_id'],
    },
  };

  constructor(
    private readonly read: (input: { ref: string; memberRef: string; nodeId: string }, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const ref = typeof args?.ref === 'string' ? args.ref.trim() : '';
    const memberRef = typeof args?.member_ref === 'string' ? args.member_ref.trim() : '';
    const nodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
    if (!CATSLOG_POOL_CITATION_REF_PATTERN.test(ref) || !CATSLOG_POOL_CITATION_REF_PATTERN.test(memberRef)
      || !/^[a-f0-9]{64}$/.test(nodeId)) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'An expanded root ref, an exact member ref and an assertion node ID are required.', retryable: true };
    }
    try {
      return { ok: true, content: jsonToolResult(await this.read({ ref, memberRef, nodeId }, context?.abortSignal)) };
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
    private readonly isReadLocalRef?: (ref: string) => boolean,
  ) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validateFinishArgs(args, this.isDeliveredPoolRef, this.isReadLocalRef);
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

/**
 * Publishes one verified claim without ending the investigation. The finish
 * tool still ends it: a Branch can keep exploring after a publication, and a
 * later source can correct the earlier claim with `supersedes`.
 */
export class PublishMemoryFindingTool implements Tool {
  definition: ToolDefinition = {
    name: 'publish_memory_finding',
    description: [
      '发布一条已核实的记忆发现；不结束 investigation。',
      '只用于已经通过 read 工具完整交付的证据；搜索结果本身只是线索。',
      'subject 是被讨论的对象，claim 是可被主 agent 直接使用的断言，evidence 是支撑它的 canonical refs。',
      'qualification 写明限制条件（例如“已修复，但该导出未验证”）。',
      '发现重复或错误时，用 supersedes 指出被更正的 observation_id。',
      '同一 subject/claim/refs 只会入队一次；重复发布会被拒绝并返回 duplicate。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '被讨论的对象（项目、导出、版本或事件）。' },
        claim: { type: 'string', description: '一条可被主 agent 使用的断言。' },
        evidence: { type: 'array', description: '支撑该断言的 canonical refs；必须已完整读取。', items: { type: 'string' } },
        qualification: { type: 'string', description: '改变该断言可用方式的限定（可选）。' },
        supersedes: { type: 'array', description: '被本发现更正的 observation_id 或 claimKey（可选）。', items: { type: 'string' } },
      },
      required: ['subject', 'evidence', 'claim'],
    },
  };

  private invalidAttempts = 0;

  constructor(
    private readonly onPublish: (payload: MemoryPublishFindingPayload) => MemoryPublishFindingResult,
    private readonly isDeliveredPoolRef: (ref: string) => boolean = () => false,
    private readonly isReadLocalRef?: (ref: string) => boolean,
  ) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validatePublishFindingArgs(args, this.isDeliveredPoolRef, this.isReadLocalRef);
    if (!validation.ok) return this.invalidResult(validation.error);
    this.invalidAttempts = 0;
    const result = this.onPublish(validation.payload);
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.reason === 'duplicate' ? 'DUPLICATE_OBSERVATION' : 'PUBLICATION_REJECTED',
        message: jsonToolError(`${result.reason || 'publication_rejected'}${result.observation_id ? `: ${result.observation_id}` : ''}`),
        retryable: result.reason === 'duplicate',
      };
    }
    return {
      ok: true,
      content: jsonToolResult({
        ok: true,
        observation_id: result.observation_id,
        verified_through_input: result.verified_through_input,
        note: 'Published. The investigation continues; finish_memory_search still ends it.',
      }),
    };
  }

  async handleInvalidArguments(message: string): Promise<ToolExecutionResult> {
    return this.invalidResult(message);
  }

  private invalidResult(error: string): ToolExecutionResult {
    this.invalidAttempts += 1;
    return {
      ok: false,
      errorCode: 'INVALID_TOOL_ARGUMENTS',
      message: jsonToolError([
        error,
        `Attempt ${this.invalidAttempts}/${MEMORY_PUBLISH_MAX_INVALID_ATTEMPTS}. Correct format:`,
        'publish={"subject":"...","claim":"...","evidence":["chat/2026-08-13/demo.jsonl#1"],"qualification":"..."}',
      ].join(' ')),
      retryable: this.invalidAttempts < MEMORY_PUBLISH_MAX_INVALID_ATTEMPTS,
    };
  }
}

/**
 * Resolves an observation published for an older input: after consuming the
 * new user input the Branch either stands behind the claim (reconfirm) or
 * withdraws it. Nothing is delivered until this runs.
 */
export class ResolveHeldObservationTool implements Tool {
  definition: ToolDefinition = {
    name: 'resolve_held_memory_observation',
    description: [
      '处理因新用户输入而被 hold 的已发布发现。',
      '消费新输入后，如果该断言仍然成立，用 decision=reconfirm 推进它的 verified_through_input；',
      '如果新输入换了话题、取消了该结论或证据已过期，用 decision=withdraw 撤回。',
      '未处理的 hold 发现不会进入主 agent 的请求。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        observation_id: { type: 'string', description: 'held_observations 中的 observationId。' },
        decision: { type: 'string', enum: ['reconfirm', 'withdraw'], description: '仍成立则 reconfirm，否则 withdraw。' },
        reason: { type: 'string', description: '撤回或确认的简短原因（可选）。' },
      },
      required: ['observation_id', 'decision'],
    },
  };

  constructor(private readonly resolve: (
    observationId: string,
    decision: 'reconfirm' | 'withdraw',
    reason?: string,
  ) => MemoryPublishFindingResult) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const observationId = String(args?.observation_id || '').trim();
    const decision = args?.decision;
    if (!observationId || (decision !== 'reconfirm' && decision !== 'withdraw')) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: jsonToolError('resolve_held_memory_observation requires observation_id and decision=reconfirm|withdraw'),
        retryable: true,
      };
    }
    const result = this.resolve(observationId, decision, typeof args?.reason === 'string' ? args.reason : undefined);
    if (!result.ok) {
      return {
        ok: false,
        errorCode: 'OBSERVATION_NOT_HELD',
        message: jsonToolError(result.reason || 'observation_not_held'),
        retryable: false,
      };
    }
    return {
      ok: true,
      content: jsonToolResult({ ok: true, observation_id: result.observation_id, decision }),
    };
  }
}

function validatePublishFindingArgs(
  args: any,
  isDeliveredPoolRef: (ref: string) => boolean,
  isReadLocalRef?: (ref: string) => boolean,
): { ok: true; payload: MemoryPublishFindingPayload } | { ok: false; error: string } {
  const subject = String(args?.subject || '').trim();
  const claim = String(args?.claim || '').trim();
  if (!subject) return { ok: false, error: 'subject must be a non-empty string' };
  if (!claim) return { ok: false, error: 'claim must be a non-empty string' };
  const rawEvidence: unknown[] = Array.isArray(args?.evidence) ? args.evidence as unknown[] : [];
  if (rawEvidence.length === 0) {
    return { ok: false, error: 'publish_memory_finding requires evidence: string[] with at least one fully read ref' };
  }
  if (rawEvidence.some(ref => typeof ref !== 'string')) {
    return { ok: false, error: 'evidence must contain strings only' };
  }
  const refs: string[] = Array.from(new Set((rawEvidence as string[]).map(ref => ref.trim()).filter(Boolean)));
  for (const ref of refs) {
    if (CANONICAL_REF_PATTERN.test(ref) && isReadLocalRef && !isReadLocalRef(ref)) {
      return { ok: false, error: 'Use memory_read_turn or memory_neighbors to read each local evidence ref before publishing.' };
    }
    if (!CANONICAL_REF_PATTERN.test(ref)
      && !((CATSLOG_POOL_CITATION_REF_PATTERN.test(ref) || CATSLOG_SOURCE_REF_PATTERN.test(ref)) && isDeliveredPoolRef(ref))) {
      return { ok: false, error: `invalid canonical ref: ${ref}` };
    }
  }
  return {
    ok: true,
    payload: {
      subject,
      claim,
      refs,
      ...(typeof args?.qualification === 'string' && args.qualification.trim()
        ? { qualification: args.qualification.trim() }
        : {}),
      ...(Array.isArray(args?.supersedes)
        ? { supersedes: (args.supersedes as unknown[]).map(value => String(value || '').trim()).filter(Boolean) }
        : {}),
    },
  };
}

function validateFinishArgs(args: any, isDeliveredPoolRef: (ref: string) => boolean, isReadLocalRef?: (ref: string) => boolean):
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
    if (CANONICAL_REF_PATTERN.test(ref) && isReadLocalRef && !isReadLocalRef(ref)) {
      return { ok: false, error: 'Use memory_read_turn or memory_neighbors to read each local evidence ref before finishing.' };
    }
    // The active local grammar remains unchanged. Pool and Memory node refs are
    // explicit run-local extensions, admitted only after complete delivery.
    if (!CANONICAL_REF_PATTERN.test(ref)
      && !((CATSLOG_POOL_CITATION_REF_PATTERN.test(ref) || CATSLOG_SOURCE_REF_PATTERN.test(ref)) && isDeliveredPoolRef(ref))) {
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
const CATSLOG_SOURCE_REF_PATTERN = /^catslog:source:[a-f0-9]{64}$/;
// Local distilled-knowledge citations: managed KB documents and raw source
// Markdown under the KB store's documents/ tree (see xiaoba-knowledge). The
// path grammar is deliberately narrower than the store accepts: ASCII
// segments without dot-leading/dot-dot components, so a citation ref can
// never double as a traversal path or URL.
const KNOWLEDGE_KB_REF_PATTERN = /^kb:KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KNOWLEDGE_FILE_REF_PATTERN = /^file:documents\/(?:[A-Za-z0-9][A-Za-z0-9 ._-]*\/)*[A-Za-z0-9][A-Za-z0-9 ._-]*\.[mM][dD]$/;

/**
 * Citable ref for one entry revision of the Agent-private daily knowledge
 * corpus: `catslog:knowledge:<document_id>:<revision>:<entry_id>`. Segments
 * use the shared package's opaque-ID charset, so branch refs and
 * `stream#line` strings can never masquerade as corpus refs. This is a NEW,
 * distinct identity domain — it does not widen the local-KB grammar.
 */
const CATSLOG_KNOWLEDGE_REF_PATTERN = /^catslog:knowledge:([A-Za-z0-9_-]{1,256}):([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,256})$/;

/** Build the citable ref for an exact day/document/revision/entry anchor. */
export function catslogKnowledgeCitationRef(
  documentId: string,
  revision: string,
  entryId: string,
): string | null {
  const ref = `catslog:knowledge:${documentId}:${revision}:${entryId}`;
  return CATSLOG_KNOWLEDGE_REF_PATTERN.test(ref) ? ref : null;
}

/** True when `ref` is a typed daily-knowledge corpus ref. */
export function isCatsLogKnowledgeCitationRef(ref: string): boolean {
  return CATSLOG_KNOWLEDGE_REF_PATTERN.test(ref);
}

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
  // Typed daily-knowledge corpus refs (knowledge/1). Identity domains stay
  // disjoint: the ref carries document/revision/entry exactly as served.
  if (isCatsLogKnowledgeCitationRef(ref) || CATSLOG_SOURCE_REF_PATTERN.test(ref)) return true;
  const stream = ref.match(CATSLOG_STREAM_REF_PATTERN);
  if (stream && isSafeCatsLogOpaqueIdentifier(stream[1], 256)) return true;
  const skill = ref.match(CATSLOG_SKILL_REF_PATTERN);
  return Boolean(skill && isSafeCatsLogSkillHandle(skill[1]) && Number.isSafeInteger(Number(skill[2])));
}
