import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';
import { PathResolver } from './path-resolver';
import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import { TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../core/runtime-context-builder';

const DEFAULT_TRACE_DIR = PathResolver.getLogsPath('cache-trace');

export interface CacheTraceProviderInfo {
  provider: 'anthropic' | 'openai';
  /** Concrete request API. Absent only on traces written before this field existed. */
  api_type?: 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
  /** Sanitized, SDK-final request payload. Present only when XIAOBA_CACHE_TRACE is enabled. */
  request_snapshot?: {
    endpoint: string;
    payload: unknown;
    sha256: string;
    chars: number;
  };
  // Anthropic-specific
  anthropic?: {
    blocks: Array<{
      index: number;
      cache_control: boolean;
      sha256: string;
      chars: number;
    }>;
  };
  // OpenAI Chat Completions-specific
  openai_chat?: {
    system_first_message_sha256: string;
  };
  // OpenAI Responses-specific
  openai_responses?: {
    prompt_cache_key: string;
    instructions_sha256: string;
    instructions_chars: number;
    dynamic_system_chars: number;
  };
}

export interface CacheTraceSystemInfo {
  stable_sha256: string;
  stable_blocks: number;
  stable_chars: number;
  dynamic_blocks: number;
  dynamic_chars: number;
}

export interface CacheTraceUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cache_hit_ratio: number;
}

export interface CacheTraceDiff {
  previous_run_id: string;
  stable_system_identical: boolean;
  dynamic_system_sha256: string;
  tools_identical: boolean;
  message_prefix_identical_until_index: number | null;
  message_identical_count: number;
  message_changed_count: number;
}

export interface CacheTraceEntry {
  schema: string;
  session: {
    session_id: string;
    session_type: string;
    surface: string;
  };
  episode: {
      episode_number: number;
    run_id: string;
    episode_id?: string;
  };
  request: {
    timestamp: string;
    provider: string;
    model: string;
    system_prompt: CacheTraceSystemInfo;
    message_count: number;
    estimated_tokens: number;
    tools_count: number;
    tools_sha256: string;
    message_sha256s?: string[];
  };
  request_provider: CacheTraceProviderInfo;
  response: {
    timestamp: string;
    duration_ms: number;
    stop_reason?: string;
  };
  response_usage: CacheTraceUsage;
  diff: CacheTraceDiff;
}

interface PendingEntry {
  entry: CacheTraceEntry;
  messages: Message[];
}

export class CacheTraceLogger {
  private readonly enabled: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionId: string;
  private readonly sessionType: string;
  private readonly surface: string;
  private readonly episodeId?: string;
  private pending: PendingEntry | null = null;
  private previousEntry: CacheTraceEntry | null = null;

  constructor(params: {
    sessionId?: string;
    sessionType?: string;
    surface?: string;
    episodeId?: string;
    env?: NodeJS.ProcessEnv;
  }) {
    this.env = params.env ?? process.env;
    this.enabled = this.resolveEnabled();
    this.sessionId = params.sessionId ?? 'unknown';
    this.sessionType = params.sessionType ?? 'unknown';
    this.surface = params.surface ?? 'unknown';
    this.episodeId = params.episodeId;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private resolveEnabled(): boolean {
    const raw = (this.env.XIAOBA_CACHE_TRACE ?? '').trim();
    if (raw === '1' || raw.toLowerCase() === 'true') {
      // Check session whitelist if set
      const sessions = (this.env.XIAOBA_CACHE_TRACE_SESSIONS ?? '').trim();
      if (sessions) {
        return sessions.split(',').map(s => s.trim()).includes(this.sessionId);
      }
      return true;
    }
    return false;
  }

  recordRequest(params: {
    episodeNumber: number;
    runId: string;
    provider: string;
    model: string;
    messages: Message[];
    tools: ToolDefinition[];
    providerInfo: CacheTraceProviderInfo;
  }): void {
    if (!this.enabled) return;

    const systemInfo = this.buildSystemInfo(params.messages);
    const messageShas = params.messages.map(msg => this.messageSha256(msg));
    const toolsSha256 = this.sha256Hex(JSON.stringify(params.tools.map(t => ({ name: t.name, description: t.description }))));

    const entry: CacheTraceEntry = {
      schema: 'xiaoba.cache_trace.v2',
      session: {
        session_id: this.sessionId,
        session_type: this.sessionType,
        surface: this.surface,
      },
      episode: {
        episode_number: params.episodeNumber,
        run_id: params.runId,
        ...(this.episodeId ? { episode_id: this.episodeId } : {}),
      },
      request: {
        timestamp: new Date().toISOString(),
        provider: params.provider,
        model: params.model,
        system_prompt: systemInfo,
        message_count: params.messages.length,
        estimated_tokens: estimateMessagesTokens(params.messages) + estimateToolsTokens(params.tools),
        tools_count: params.tools.length,
        tools_sha256: toolsSha256,
        message_sha256s: messageShas,
      },
      request_provider: params.providerInfo,
      response: {
        timestamp: '',
        duration_ms: 0,
      },
      response_usage: {
        input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        cache_hit_ratio: 0,
      },
      diff: {
        previous_run_id: '',
        stable_system_identical: true,
        dynamic_system_sha256: '',
        tools_identical: true,
        message_prefix_identical_until_index: null,
        message_identical_count: 0,
        message_changed_count: 0,
      },
    };

    this.pending = { entry, messages: params.messages };
  }

  recordResponse(params: {
    usage?: {
      promptTokens: number;
      completionTokens: number;
      cachedReadTokens?: number;
      cachedWriteTokens?: number;
    };
    durationMs: number;
    stopReason?: string;
  }): void {
    if (!this.enabled || !this.pending) return;

    const usage = params.usage;
    const cachedRead = usage?.cachedReadTokens ?? 0;
    const cachedWrite = usage?.cachedWriteTokens ?? 0;
    const inputTokens = usage?.promptTokens ?? 0;
    const freshInput = Math.max(0, inputTokens - cachedRead - cachedWrite);
    const ratio = inputTokens > 0
      ? (cachedRead + cachedWrite) / inputTokens
      : 0;

    this.pending.entry.response = {
      timestamp: new Date().toISOString(),
      duration_ms: params.durationMs,
      ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
    };

    this.pending.entry.response_usage = {
      input_tokens: inputTokens,
      cache_read_tokens: cachedRead,
      cache_write_tokens: cachedWrite,
      output_tokens: usage?.completionTokens ?? 0,
      cache_hit_ratio: Math.round(ratio * 1000) / 1000,
    };
  }

  flush(): void {
    if (!this.enabled || !this.pending) return;

    // Compute diff against previous entry
    this.computeDiff();

    this.writeEntry(this.pending.entry);
    this.previousEntry = this.pending.entry;
    this.pending = null;
  }

  private computeDiff(): void {
    if (!this.pending) return;

    // When previousEntry is null (e.g. first turn after runner recreation),
    // try to load the last entry from the session directory on disk.
    let prev: CacheTraceEntry | null = this.previousEntry;
    if (!prev) {
      try {
        const dir = this.resolveDir();
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .sort();
          if (files.length > 0) {
            const lastFile = path.join(dir, files[files.length - 1]);
            prev = JSON.parse(fs.readFileSync(lastFile, 'utf-8')) as CacheTraceEntry;
          }
        }
      } catch {
        // can't load previous — leave prev as null, will fill defaults below
      }
    }

    if (!prev) {
      this.pending.entry.diff = {
        previous_run_id: '',
        stable_system_identical: true,
        dynamic_system_sha256: '',
        tools_identical: true,
        message_prefix_identical_until_index: null,
        message_identical_count: 0,
        message_changed_count: 0,
      };
      return;
    }

    const current = this.pending.entry;

    current.diff.previous_run_id = prev.episode.run_id;
    current.diff.stable_system_identical =
      current.request.system_prompt.stable_sha256 === prev.request.system_prompt.stable_sha256;
    current.diff.dynamic_system_sha256 =
      `${prev.request.system_prompt.stable_sha256.slice(0, 8)}... → ${current.request.system_prompt.stable_sha256.slice(0, 8)}...`;
    current.diff.tools_identical =
      current.request.tools_sha256 === prev.request.tools_sha256;

    // Message-level diff: compare SHA256 from start until first mismatch
    const currentShas = current.request.message_sha256s ?? [];
    const prevShas = prev.request.message_sha256s ?? [];
    const maxLen = Math.max(currentShas.length, prevShas.length);
    let matchUntilIndex: number | null = null;
    let identicalCount = 0;

    for (let i = 0; i < maxLen; i++) {
      if (currentShas[i] && prevShas[i] && currentShas[i] === prevShas[i]) {
        identicalCount++;
      } else {
        if (matchUntilIndex === null) matchUntilIndex = i;
      }
    }

    current.diff.message_prefix_identical_until_index = matchUntilIndex === 0 ? 0 : matchUntilIndex;
    current.diff.message_identical_count = identicalCount;
    current.diff.message_changed_count = Math.abs(currentShas.length - prevShas.length);
  }

  private buildSystemInfo(messages: Message[]): CacheTraceSystemInfo {
    const systemMessages = messages.filter(
      msg => msg.role === 'system' && typeof msg.content === 'string' && msg.content.length > 0,
    );

    let stableBlocks = 0;
    let stableChars = 0;
    let dynamicBlocks = 0;
    let dynamicChars = 0;
    const stableParts: string[] = [];

    for (const msg of systemMessages) {
      const text = msg.content as string;
      const isDynamic = this.isDynamicSystemMessage(msg);
      if (isDynamic) {
        dynamicBlocks++;
        dynamicChars += text.length;
      } else {
        stableBlocks++;
        stableChars += text.length;
        stableParts.push(text);
      }
    }

    return {
      stable_sha256: this.sha256Hex(stableParts.join('\n\n')),
      stable_blocks: stableBlocks,
      stable_chars: stableChars,
      dynamic_blocks: dynamicBlocks,
      dynamic_chars: dynamicChars,
    };
  }

  private isDynamicSystemMessage(msg: Message): boolean {
    if (msg.__cacheScope === 'dynamic') return true;
    if (msg.__cacheScope === 'stable') return false;
    if (msg.role !== 'system' || typeof msg.content !== 'string') return false;
    return /^\[(?:transient_[^\]]+|compact_boundary)\]/.test(msg.content);
  }

  private messageSha256(msg: Message): string {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(b => b.type === 'text' ? b.text : '[image]').join('')
        : '';
    return this.sha256Hex(`${msg.role}|${content}`);
  }

  private sha256Hex(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private writeEntry(entry: CacheTraceEntry): void {
    try {
      const dir = this.resolveDir();
      fs.mkdirSync(dir, { recursive: true });

      const fileName = `T${String(entry.episode.episode_number).padStart(3, '0')}_${entry.episode.run_id}.json`;
      const filePath = path.join(dir, fileName);

      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err: any) {
      // Silent fail - don't break the main flow for tracing
    }
  }

  private resolveDir(): string {
    const root = (this.env.XIAOBA_CACHE_TRACE_DIR ?? '').trim() || DEFAULT_TRACE_DIR;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const safeSession = this.sanitizeFileSegment(this.sessionId);
    return path.join(root, dateStr, safeSession);
  }

  private sanitizeFileSegment(value: string): string {
    return value.replace(/[:<>"|?*\\\/]/g, '_').slice(0, 120) || 'unknown';
  }
}

export function createRunId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}
