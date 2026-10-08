import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import { CatsLogMemoryUnavailableError } from '../utils/catslog-memory-provider';
import type {
  CatsLogKnowledgeAnchor,
  CatsLogKnowledgeExpandQuery,
  CatsLogKnowledgeReadQuery,
  CatsLogKnowledgeSearchQuery,
} from '../utils/catslog-knowledge-types';

export const CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME = 'catslog_knowledge_recall';

/**
 * Query shape for one recall invocation. Actions map 1:1 onto the CatsLog
 * daily knowledge API paths (search / read / expand) plus the explicit
 * `history` action over the existing device-bound session query route.
 */
interface RecallArgs {
  action?: unknown;
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
  // expand
  anchor?: unknown;
  direction?: unknown;
  kinds?: unknown;
  // history (explicit source only)
  search_any?: unknown;
}

const HISTORY_MAX_KEYWORDS = 8;

/**
 * Native read-only mainAgent recall tool over the Agent-private CatsLog
 * daily knowledge corpus (contract `knowledge/1`). One small tool, three
 * API-backed actions plus an explicit history lane:
 *
 * - `search` — bounded entry search (metadata hits + follow-on hints).
 * - `read`   — full document/entry text (json pages or raw OKF markdown).
 * - `expand` — in/out/both link views around one typed anchor.
 * - `history`— ONLY when the caller explicitly asks for raw session history;
 *   delegated to the existing device-bound `querySessions` route with
 *   faithful cursor paging.
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
 * - Read-only: no local writes, no localKB sync, no automatic anything.
 */
export class CatsLogKnowledgeRecallTool implements Tool {
  definition: ToolDefinition = {
    name: CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME,
    description: [
      '按需检索本 Agent 在 CatsLog 的私有每日知识与历史会话（只读）。',
      'action=search：按关键词搜索每日知识条目（默认包含 draft 未审定条目，status 字段可见，draft 不代表已核验；命中标题/状态/所在文档与日期，全文需 read）。',
      'action=read：读取指定文档（可选 revision/entry_id）；format=json 返回条目全文分页，format=okf 返回整篇 Open Knowledge Format Markdown。',
      'action=expand：沿某个 typed anchor 展开来向/去向链接（supplements/corrects/…），remote 状态显式返回。',
      'action=history：仅当确实需要原始历史会话时使用，按关键词检索设备绑定的会话记录投影。',
      '响应中的 cursor 是不透明令牌：翻页时必须原样传回，不要猜测或改写；有 next_cursor 就继续翻页，不要假设内容已读完或不存在。',
      '不可用时返回明确错误，不会伪装成空结果。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'read', 'expand', 'history'],
          description: 'search=搜索每日知识；read=读取文档全文；expand=沿链接扩展；history=显式检索原始历史会话。',
        },
        query: { type: 'string', description: 'search 必填。检索词。' },
        limit: { type: 'number', description: '可选。每页条数上限（服务端有默认值与上限）。' },
        cursor: { type: 'string', description: '可选。上一页响应原样返回的 next_cursor，翻页时必须逐字节一致。' },
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
        anchor: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['session_query', 'session_result', 'graph_node', 'learning_node', 'knowledge_entry'],
            },
            id: { type: 'string' },
            document_id: { type: 'string', description: 'knowledge_entry 锚点必填；其他 kind 禁止。' },
            revision: { type: 'string' },
            session_id: { type: 'string' },
            stream_id: { type: 'string' },
            byte_offset: { type: 'number' },
            byte_length: { type: 'number' },
          },
          description: 'expand 必填。typed anchor（kind 与 id 必填；knowledge_entry 还需 document_id），各身份域不可互换。',
        },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: '可选。expand 方向，默认 both。' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['derived_from', 'supplements', 'corrects', 'continues', 'related', 'used'] },
          description: '可选。expand 按关系类型过滤。',
        },
        search_any: {
          type: 'array',
          items: { type: 'string' },
          description: 'history 必填。最多 8 个 OR 关键词，每个不超过 64 个码点。',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly backend: CatsLogMemoryBackend) {}

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const input = (args ?? {}) as RecallArgs;
    const signal = context.abortSignal;
    try {
      switch (input.action) {
        case 'search':
          return await this.search(input, signal);
        case 'read':
          return await this.read(input, signal);
        case 'expand':
          return await this.expand(input, signal);
        case 'history':
          return await this.history(input, signal);
        default:
          return {
            ok: false,
            errorCode: 'INVALID_TOOL_ARGUMENTS',
            retryable: false,
            message: 'action 必须是 search / read / expand / history 之一',
          };
      }
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
    return this.pageResult(page, page.next_cursor, page.exhausted);
  }

  private async expand(input: RecallArgs, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const anchor = this.optionalAnchor(input.anchor);
    if (!anchor) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        retryable: false,
        message: 'expand 需要 anchor（kind + id；knowledge_entry 还需 document_id）',
      };
    }
    const query: CatsLogKnowledgeExpandQuery = {
      anchor,
      ...(input.direction === 'out' || input.direction === 'in' || input.direction === 'both'
        ? { direction: input.direction }
        : {}),
      ...(Array.isArray(input.kinds) ? { kinds: input.kinds as CatsLogKnowledgeExpandQuery['kinds'] } : {}),
      ...(this.optionalLimit(input.limit) !== undefined ? { limit: this.optionalLimit(input.limit) } : {}),
      ...(this.optionalCursor(input.cursor) !== undefined ? { cursor: this.optionalCursor(input.cursor) } : {}),
    };
    if (!this.backend.expandKnowledge) {
      return this.unavailableResult('当前运行环境未接入 CatsLog 每日知识扩展');
    }
    const page = await this.backend.expandKnowledge(query, signal);
    return this.pageResult(page, page.next_cursor, page.exhausted);
  }

  /**
   * Explicit raw-history lane: only routed through the existing device-bound
   * session query. There is no silent fallback from knowledge actions to
   * history or back — each lane reports its own typed availability.
   */
  private async history(input: RecallArgs, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.backend.querySessions) {
      return this.unavailableResult('当前运行环境未接入 CatsLog 历史会话检索');
    }
    if (!Array.isArray(input.search_any)) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        retryable: false,
        message: 'history 需要 search_any（1..8 个关键词）',
      };
    }
    const keywords = input.search_any
      .filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
      .map(keyword => keyword.trim());
    if (keywords.length === 0 || keywords.length > HISTORY_MAX_KEYWORDS) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        retryable: false,
        message: `history 的 search_any 需要 1..${HISTORY_MAX_KEYWORDS} 个关键词`,
      };
    }
    const result = await this.backend.querySessions({
      searchAny: keywords,
      latest: true,
      ...(this.optionalLimit(input.limit) !== undefined ? { limit: this.optionalLimit(input.limit) } : {}),
      ...(this.optionalCursor(input.cursor) !== undefined ? { cursor: this.optionalCursor(input.cursor) } : {}),
    }, signal);
    return this.pageResult(result, result.next_cursor, result.truncated !== true && !result.next_cursor);
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

  private optionalAnchor(value: unknown): CatsLogKnowledgeAnchor | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.kind !== 'string' || typeof raw.id !== 'string' || !raw.id.trim()) return undefined;
    return {
      kind: raw.kind as CatsLogKnowledgeAnchor['kind'],
      id: raw.id,
      ...(typeof raw.document_id === 'string' && raw.document_id.trim() ? { document_id: raw.document_id.trim() } : {}),
      ...(typeof raw.revision === 'string' && raw.revision.trim() ? { revision: raw.revision.trim() } : {}),
      ...(typeof raw.session_id === 'string' && raw.session_id.trim() ? { session_id: raw.session_id.trim() } : {}),
      ...(typeof raw.session_type === 'string' && raw.session_type.trim() ? { session_type: raw.session_type.trim() } : {}),
      ...(typeof raw.stream_id === 'string' && raw.stream_id.trim() ? { stream_id: raw.stream_id.trim() } : {}),
      ...(typeof raw.byte_offset === 'number' && Number.isSafeInteger(raw.byte_offset) && raw.byte_offset >= 0
        ? { byte_offset: raw.byte_offset }
        : {}),
      ...(typeof raw.byte_length === 'number' && Number.isSafeInteger(raw.byte_length) && raw.byte_length > 0
        ? { byte_length: raw.byte_length }
        : {}),
    };
  }

  /** Success envelope with faithful pagination: next_cursor verbatim or exhausted. */
  private pageResult(payload: unknown, nextCursor: string | undefined, exhausted: boolean): ToolExecutionResult {
    const body = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    return {
      ok: true,
      content: JSON.stringify({
        ...body,
        next_cursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined,
        exhausted: exhausted || !nextCursor,
        ...(typeof nextCursor === 'string' && nextCursor ? {
          note: '还有后续页：用相同 action 与参数、原样传回 next_cursor 继续读取；不要假设未返回的内容不存在。',
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
