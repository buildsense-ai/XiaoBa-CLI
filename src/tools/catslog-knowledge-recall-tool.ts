import { validateKnowledgeGraph, validateKnowledgeGraphQuery, type CatsLogKnowledgeGraphQuery } from '../utils/catslog-knowledge-graph';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import { CatsLogMemoryUnavailableError } from '../utils/catslog-memory-provider';
import type {
  CatsLogKnowledgeAnchor,
  CatsLogKnowledgeReadQuery,
  CatsLogKnowledgeSearchQuery,
} from '../utils/catslog-knowledge-types';
import { recallTextHash, dailyKnowledgeRef, hashedRecallRef, nativeRecallAttribution, type NativeRecallSource } from '../core/native-recall-attribution';
export const CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME = 'catslog_knowledge_recall';

/**
 * Query shape for one recall invocation. Actions map 1:1 onto the CatsLog
 * Diary document API paths: search / read / graph.
 */
interface RecallArgs {
  action?: unknown;
  seeds?: unknown;
  node_budget?: unknown;
  edge_budget?: unknown;
  byte_budget?: unknown;
  // search
  query?: unknown;
  limit?: unknown;
  cursor?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  statuses?: unknown;
  include_draft?: unknown;
  // read
  document_id?: unknown;
  revision?: unknown;
  entry_id?: unknown;
  format?: unknown;
}

const DOCUMENT_ACTIONS = ['search', 'read', 'graph'] as const;

/**
 * Native read-only mainAgent recall over the Agent-private CatsLog Diary
 * documents (contract `knowledge/1`, closures `memory-graph/1`). The main
 * agent converges on maintained documents; sessions, sources and Memory
 * graphs belong to the Memory Branch (docs/catslog-recall-layering.md).
 *
 * - `search` — bounded entry search (metadata hits + follow-on hints).
 * - `read`   — full document/entry text (json pages or raw OKF markdown).
 * - `graph`  — complete required-condition/correction closure of exact entries.
 *
 * Contract rules enforced here:
 * - Cursors are opaque bytes passed back byte-exact; the tool never parses,
 *   trims, or rewrites them, and page bounds are reported via
 *   `next_cursor`/`exhausted` so no page content is silently skipped.
 * - No fake-empty: an unavailable backend/404 surfaces as a typed error
 *   result, never as an empty-but-successful page.
 * - Tokens and scope identifiers never enter tool results: the provider
 *   injects the capability token out-of-band and server responses carry no
 *   principal/agent/scope fields.
 * - Evidence is read-only. Attribution events are persisted by the runner's
 *   existing local session log.
 */
export class CatsLogKnowledgeRecallTool implements Tool {
  definition: ToolDefinition = {
    name: CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME,
    description: [
      '按需检索本 Agent 在 CatsLog 的私有日记文档（只读）。历史会话与来源记忆由后台记忆 branch 负责，不在此工具中。',
      'action=search：按关键词搜索每日知识条目（默认包含 draft 未审定条目，status 字段可见，draft 不代表已核验；命中标题/状态/所在文档与日期，全文需 read）。',
      'action=graph：读取精确条目 seeds 的完整必要条件与补充/修正子图；预算不足整组失败，不返回省掉条件的正文。优先用于搜索后的记忆读取。Skill 是日记经验的可选补充。',
      'action=read：读取指定文档（可选 revision/entry_id）；format=json 返回条目全文分页，format=okf 返回整篇 Open Knowledge Format Markdown。',
      '每次成功返回 recall_attribution.trace_id 和稳定 ref；引用事实时复制对应正文 ref。披露/交付不等于已使用；引用与最终保留在本地分别统计，远端 typed-source feedback 尚未接入。',
      '响应中的 cursor 是不透明令牌：翻页时必须原样传回，不要猜测或改写；有 next_cursor 就继续翻页，不要假设内容已读完或不存在。',
      '不可用时返回明确错误，不会伪装成空结果。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...DOCUMENT_ACTIONS],
          description: 'search=搜索日记条目；read=读取文档；graph=读取条目的完整必要条件与修正子图。',
        },
        seeds: { type: 'array', items: { type: 'object' }, description: 'graph 必填：1..8 个精确 knowledge_entry anchor（kind/id/document_id/revision）。' },
        node_budget: { type: 'number', description: 'graph 节点预算 1..32，默认16。' },
        edge_budget: { type: 'number', description: 'graph 关系预算 1..128，默认64。' },
        byte_budget: { type: 'number', description: 'graph 完整 JSON 字节预算 256..262144，默认65536。' },
        query: { type: 'string', description: 'search 必填。检索词。' },
        limit: { type: 'number', description: '可选。每页条数上限（服务端有默认值与上限）。' },
        cursor: { type: 'string', description: '可选。上一页响应原样返回的 next_cursor、before_cursor 或 after_cursor，翻页时必须逐字节一致。' },
        date_from: { type: 'string', description: '可选。YYYY-MM-DD 起始日（含）。' },
        date_to: { type: 'string', description: '可选。YYYY-MM-DD 结束日（含）。' },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['draft', 'active', 'superseded', 'retired'] },
          description: '可选。按条目状态过滤。',
        },
        include_draft: { type: 'boolean', description: '可选。search 是否包含 draft 条目。默认包含：draft 是未审定的每日新知识，status=draft 仅表示未核验，不等于不存在。传 false 可排除。' },
        document_id: { type: 'string', description: 'read 必填。文档 ID（akd-…）。' },
        revision: { type: 'string', description: '可选。留空读最新版本；指定则读不可变历史版本。' },
        entry_id: { type: 'string', description: '可选。只读该条目（ake-…）。' },
        format: { type: 'string', enum: ['json', 'okf'], description: '可选。read 输出格式，默认 json；okf 为整篇 Markdown 文本。' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly backend: CatsLogMemoryBackend) {}

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const input = (args ?? {}) as RecallArgs;
    const signal = context.abortSignal;
    try {
      // The native surface shares one per-invocation gate.
      // Older embedders may omit discovery; their route methods remain the
      // compatibility boundary. Never fall back to isAvailable: that check
      // belongs to automatic Branch and has a separate feature switch.
      if (this.backend.isKnowledgeRecallAvailable?.() === false) {
        return this.unavailableResult('CatsLog recall 已禁用或没有有效读取能力');
      }
      let result: ToolExecutionResult;
      switch (input.action) {
        case 'search':
          result = await this.search(input, signal); break;
        case 'graph':
          result = await this.graph(input, signal); break;
        case 'read':
          result = await this.read(input, signal); break;
        default:
          return {
            ok: false,
            errorCode: 'INVALID_TOOL_ARGUMENTS',
            retryable: false,
            message: 'action 必须是 search / read / graph 之一；历史会话与来源记忆由记忆 branch 检索',
          };
      }
      return this.withAttribution(result, String(input.action));
    } catch (error: any) {
      return this.errorResult(error);
    }
  }

  private async search(input: RecallArgs, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (typeof input.query !== 'string' || !input.query.trim()) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', retryable: false, message: 'search 需要 query' };
    }
    const query: CatsLogKnowledgeSearchQuery = {
      query: input.query,
      ...(this.optionalLimit(input.limit) !== undefined ? { limit: this.optionalLimit(input.limit) } : {}),
      ...(this.optionalCursor(input.cursor) !== undefined ? { cursor: this.optionalCursor(input.cursor) } : {}),
      ...(typeof input.date_from === 'string' && input.date_from.trim() ? { date_from: input.date_from.trim() } : {}),
      ...(typeof input.date_to === 'string' && input.date_to.trim() ? { date_to: input.date_to.trim() } : {}),
      ...(Array.isArray(input.statuses) ? { statuses: input.statuses as CatsLogKnowledgeSearchQuery['statuses'] } : {}),
      // Explicit opt-out must reach the wire: the client defaults drafts in,
      // so only an explicit boolean false may exclude them.
      ...(typeof input.include_draft === 'boolean' ? { include_draft: input.include_draft } : {}),
    };
    if (!this.backend.searchKnowledge) {
      return this.unavailableResult('当前运行环境未接入 CatsLog 每日知识检索');
    }
    const page = await this.backend.searchKnowledge(query, signal);
    return this.pageResult(page, page.next_cursor, page.exhausted);
  }

  private async graph(input: RecallArgs, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.backend.readKnowledgeGraph) return this.unavailableResult('当前运行环境未接入完整记忆子图读取');
    const query = validateKnowledgeGraphQuery({ seeds: input.seeds, node_budget: input.node_budget,
      edge_budget: input.edge_budget, byte_budget: input.byte_budget } as CatsLogKnowledgeGraphQuery);
    const graph = validateKnowledgeGraph(await this.backend.readKnowledgeGraph(query, signal), query);
    return { ok: true, content: JSON.stringify(graph) };
  }

  private async read(input: RecallArgs, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (typeof input.document_id !== 'string' || !input.document_id.trim()) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', retryable: false, message: 'read 需要 document_id' };
    }
    const query: CatsLogKnowledgeReadQuery = {
      document_id: input.document_id,
      ...(typeof input.revision === 'string' && input.revision.trim() ? { revision: input.revision.trim() } : {}),
      ...(typeof input.entry_id === 'string' && input.entry_id.trim() ? { entry_id: input.entry_id.trim() } : {}),
      ...(input.format === 'okf' || input.format === 'json' ? { format: input.format } : {}),
      ...(this.optionalLimit(input.limit) !== undefined ? { limit: this.optionalLimit(input.limit) } : {}),
      ...(this.optionalCursor(input.cursor) !== undefined ? { cursor: this.optionalCursor(input.cursor) } : {}),
    };
    if (!this.backend.readKnowledge) {
      return this.unavailableResult('当前运行环境未接入 CatsLog 每日知识读取');
    }
    const result = await this.backend.readKnowledge(query, signal);
    if (result.format === 'okf') {
      return {
        ok: true,
        content: JSON.stringify({
          format: 'okf',
          document_id: query.document_id,
          okf: result.body,
          note: 'OKF 全文为渲染后的 Markdown；如需结构化条目/游标请改用 format=json。',
        }),
      };
    }
    const page = result.page;
    if (query.entry_id && this.backend.readKnowledgeGraph) {
      return this.graph({ seeds: [{ kind: 'knowledge_entry', id: query.entry_id, document_id: page.document_id, revision: page.revision }] }, signal);
    }
    return this.pageResult(page, page.next_cursor, page.exhausted);
  }

  private withAttribution(result: ToolExecutionResult, action: string): ToolExecutionResult {
    if (!result.ok || typeof result.content !== 'string') return result;
    const body = JSON.parse(result.content);
    const sources: NativeRecallSource[] = [];
    // Canonical feedback envelope (kc-feedback-source-contract): the durable
    // outbox only ships sources carrying an exact anchor + revision; bare
    // hashed refs (okf documents) stay local-only by contract.
    const daily = (document: string, revision: string, entry: string, disclosure: NativeRecallSource['disclosure'], text?: string) => {
      const ref = dailyKnowledgeRef(document, revision, entry);
      const anchor: CatsLogKnowledgeAnchor = { kind: 'knowledge_entry', id: entry, document_id: document, revision };
      sources.push({ ref, anchor, disclosure, ...(text !== undefined ? { disclosed_text_hash: recallTextHash(text) } : {}) });
      return ref;
    };
    if ((action === 'graph' || action === 'read') && body.contract === 'memory-graph/1') {
      body.nodes = body.nodes.map((node: any) => ({ ...node,
        ref: daily(node.anchor.document_id, node.anchor.revision, node.anchor.id, 'text', node.entry.text) }));
    } else if (action === 'search') {
      body.hits = (body.hits || []).map((hit: any) => ({ ...hit,
        ref: daily(hit.document_id, hit.revision, hit.entry_id, 'metadata'),
      }));
    } else if (action === 'read' && Array.isArray(body.entries)) {
      body.entries = body.entries.map((entry: any) => ({ ...entry,
        ref: daily(body.document_id, body.revision, entry.id, 'text', entry.text),
      }));
    } else if (action === 'read' && body.format === 'okf') {
      body.ref = hashedRecallRef('document', [body.document_id, body.okf]);
      sources.push({ ref: body.ref, disclosure: 'text', disclosed_text_hash: recallTextHash(body.okf) });
    }
    body.recall_attribution = nativeRecallAttribution(sources);
    return { ...result, content: JSON.stringify(body) };
  }

  private optionalLimit(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  /**
   * Cursors are opaque: pass the caller's string through byte-exact or omit
   * it. Never trim, decode, or default it — server cursors are query-bound.
   */
  private optionalCursor(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** Success envelope preserving the server's exhaustion and incomplete state. */
  private pageResult(payload: unknown, nextCursor: string | undefined, exhausted: boolean): ToolExecutionResult {
    const body = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    return {
      ok: true,
      content: JSON.stringify({
        ...body,
        next_cursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined,
        exhausted,
        ...(!exhausted ? { incomplete: true } : {}),
        ...(typeof nextCursor === 'string' && nextCursor ? {
          note: '还有后续页：用相同 action 与参数、原样传回 next_cursor 继续读取；不要假设未返回的内容不存在。',
        } : !exhausted ? {
          note: '本次响应不完整且未提供续页 cursor；不能据此声称已读完或历史不存在。',
        } : {}),
      }),
    };
  }

  private unavailableResult(message: string): ToolExecutionResult {
    return {
      ok: false,
      errorCode: 'CATSLOG_MEMORY_UNAVAILABLE',
      retryable: false,
      message: `${message}（不会返回伪造的空结果）`,
    };
  }

  /**
   * Typed error pass-through. Provider errors carry HTTP status and server
   * detail only — never tokens, and server pages never echo principal/scope
   * identifiers, so this string is safe for the transcript.
   */
  private errorResult(error: unknown): ToolExecutionResult {
    if (error instanceof CatsLogMemoryUnavailableError) {
      return this.unavailableResult(String(error.message));
    }
    const status = Number((error as any)?.status);
    const message = String((error as any)?.message || error || 'CatsLog knowledge recall failed');
    return {
      ok: false,
      errorCode: Number.isFinite(status) && status === 401
        ? 'CATSLOG_AUTH_REQUIRED'
        : Number.isFinite(status)
          ? `CATSLOG_HTTP_${status}`
          : 'CATSLOG_KNOWLEDGE_ERROR',
      retryable: Number.isFinite(status) && (status === 429 || status >= 500),
      message,
    };
  }
}
