import { Tool, ToolDefinition, ToolExecutionResult } from '../types/tool';
import { isSafeCatsLogOpaqueIdentifier, isSafeCatsLogSkillHandle } from '../utils/catsco-log-agent-client';

/** Serialize one bounded JSON tool result (moved from the removed local MemoryLogStore). */
export function jsonToolResult(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonToolError(message: string): string {
  return JSON.stringify({ error: message });
}

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

/**
 * Pass-1 decision payload of the v1.3 two-call pipeline (structured output
 * contract, same style as the finish payload).
 */
export type AssessMemoryNeedPayload =
  | { action: 'recall'; queryText: string; keywords: string[]; sources?: string[] }
  | { action: 'skip'; reason: string };

/** Handler returns the bounded ack object that becomes the tool result. */
export type AssessMemoryNeedHandler = (
  payload: AssessMemoryNeedPayload,
  context: import('../types/tool').ToolExecutionContext,
) => Promise<Record<string, unknown>>;

const ASSESS_SOURCES = ['agent_memory', 'session_graph', 'skill'] as const;
const MAX_ASSESS_KEYWORDS = 32;
/**
 * Server search_any contract: at most 64 Unicode code points per keyword
 * (measured in code points, not JS UTF-16 units — an astral emoji counts as
 * one). Longer keywords are a structured validation error the model can fix;
 * the pipeline additionally bounds defensively with a visible note.
 */
export const MAX_ASSESS_KEYWORD_CODE_POINTS = 64;
const MAX_ASSESS_QUERY_CHARS = 8_192;
const MAX_ASSESS_REASON_CHARS = 512;
const DEFAULT_SKIP_REASON = '当前输入无需历史记忆，主 agent 仅凭上下文即可回答。';

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function keywordViolation(text: string): string | null {
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return 'keyword must not contain control characters';
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return 'keyword must not contain unpaired surrogates';
    }
  }
  const length = codePointLength(text);
  if (length > MAX_ASSESS_KEYWORD_CODE_POINTS) {
    const preview = Array.from(text).slice(0, 16).join('');
    return `keyword must be at most ${MAX_ASSESS_KEYWORD_CODE_POINTS} Unicode code points (got ${length}); shorten it: "${preview}…"`;
  }
  return null;
}

/**
 * Pass-1 assess tool (v1.3). The branch has no open tool loop anymore: this
 * is the only model-facing call before the mechanical retrieval stage, and
 * pause_turn ends the pass immediately after it so the run always converges
 * to at most one refine (finish) call.
 */
export class AssessMemoryNeedTool implements Tool {
  definition: ToolDefinition = {
    name: 'assess_memory_need',
    description: [
      '对当前输入做一次记忆检索决策（本 branch 第一步，也是收尾前的唯一决策点）。',
      'action:"skip"：主 agent 仅凭当前上下文就能回答，无需历史记忆；branch 将以 delivery:discard 结束。',
      'action:"recall"：需要历史记忆；给出远端检索词 query_text 与服务器会话检索 OR 关键词 keywords（可选 sources）。',
      '调用后系统会机械地并行执行检索并把证据包交给你收尾；你不需要也无法在本次调用中检索。',
    ].join(' '),
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recall', 'skip'],
          description: '决策：recall 检索历史记忆；skip 跳过检索并结束本 branch。',
        },
        query_text: {
          type: 'string',
          description: 'recall 必填。远端检索词：实体名、工具名、项目名、决策关键词组合；不要传整段对话或秘密。',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'recall 必填。服务器会话检索的 OR 关键词；每一项独立命中即可召回，且每项不超过 64 个 Unicode 码点（超长会被拒绝，请拆短）。只发送前 8 个不同关键词，超出部分会在证据包中标注为未检索；不要把多个词拼进同一项。',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: [...ASSESS_SOURCES] },
          description: '可选来源：agent_memory、session_graph、skill；省略时查询全部三类。',
        },
        reason: {
          type: 'string',
          description: 'skip 时的简短原因。',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly onDecision: AssessMemoryNeedHandler) {}

  async execute(args: any, context: import('../types/tool').ToolExecutionContext): Promise<ToolExecutionResult> {
    const validation = validateAssessArgs(args);
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: jsonToolError(validation.error),
        retryable: false,
      };
    }
    const ack = await this.onDecision(validation.payload, context);
    return {
      ok: true,
      content: jsonToolResult(ack),
    };
  }
}

export function validateAssessArgs(args: any):
  | { ok: true; payload: AssessMemoryNeedPayload }
  | { ok: false; error: string } {
  const action = args?.action;
  if (action === 'skip') {
    const reason = boundedAssessText(args?.reason, MAX_ASSESS_REASON_CHARS) || DEFAULT_SKIP_REASON;
    return { ok: true, payload: { action: 'skip', reason } };
  }
  if (action !== 'recall') {
    return { ok: false, error: 'action must be "recall" or "skip"' };
  }
  const queryText = boundedAssessText(args?.query_text, MAX_ASSESS_QUERY_CHARS);
  if (!queryText) {
    return { ok: false, error: 'query_text must be a non-empty string when action is recall' };
  }
  if (!Array.isArray(args?.keywords)) {
    return { ok: false, error: 'keywords must be an array of short search keywords when action is recall' };
  }
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const item of args.keywords) {
    // Keywords are validated on the raw trimmed value (no length prefilter):
    // anything oversized or malformed must surface as a structured error.
    const text = String(item ?? '').trim();
    if (!text) continue;
    const violation = keywordViolation(text);
    if (violation) return { ok: false, error: violation };
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(text);
    if (keywords.length >= MAX_ASSESS_KEYWORDS) break;
  }
  if (keywords.length === 0) {
    return { ok: false, error: 'keywords must contain at least one non-empty keyword when action is recall' };
  }
  const sources = normalizeAssessSources(args?.sources);
  if (sources.error) return { ok: false, error: sources.error };
  return {
    ok: true,
    payload: {
      action: 'recall',
      queryText,
      keywords,
      ...(sources.value ? { sources: sources.value } : {}),
    },
  };
}

function boundedAssessText(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) return '';
  return text;
}

function normalizeAssessSources(value: unknown): { value?: string[]; error?: string } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return { error: 'sources must be an array when provided' };
  const normalized: string[] = [];
  for (const entry of value) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    if (!(ASSESS_SOURCES as readonly string[]).includes(text)) {
      return { error: 'sources entries must be agent_memory, session_graph, or skill' };
    }
    if (!normalized.includes(text)) normalized.push(text);
    if (normalized.length > ASSESS_SOURCES.length) {
      return { error: 'sources may contain at most one entry per source type' };
    }
  }
  return normalized.length > 0 ? { value: normalized } : {};
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
