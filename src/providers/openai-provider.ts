import axios from 'axios';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { Message, ChatConfig, ChatResponse, ContentBlock, type ProviderApiType, type ProviderStateReference } from '../types';
import { ToolDefinition } from '../types/tool';
import { AIProvider, AIRequestOptions, StreamCallbacks } from './provider';
import { ContextDebugLogger } from '../utils/context-debug-logger';
import { normalizeOpenAIChatCompletionsUrl, normalizeOpenAIResponsesUrl } from './openai-url';
import { resolveMaxTokens } from './output-limits';
import {
  applyOpenAIReasoningOptions,
  supportsOpenAIReasoningReplay,
  supportsReasoningSwitch,
} from '../utils/reasoning-effort';
import { openAIApiModeOrDefault } from '../utils/openai-api-mode';
import { Logger } from '../utils/logger';
import { estimateJsonTokens } from '../core/token-estimator';
import { createProviderStateReference, isProviderStateCompatible } from './provider-state';
import {
  applyDeepSeekResponsesRequestPolicy,
  isDeepSeekResponses,
  isDeepSeekResponsesReplayItem,
  sanitizeDeepSeekResponsesReplayItem,
} from './deepseek/responses-policy';

const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;
const PROVIDER_ERROR_BODY_READ_TIMEOUT_MS = 2_000;
const DEFAULT_RESPONSES_HEADERS_TIMEOUT_MS = 120_000;
const MAX_RESPONSES_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSES_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

type ResponsesFailurePhase = 'headers' | 'stream' | 'terminal_event';

interface ResponsesFailureMetadata {
  failurePhase?: ResponsesFailurePhase;
  terminalEvent?: string;
  responseId?: string;
  requestId?: string;
}

interface ResponsesBreakpointDiagnostic {
  label: 'S';
  prefixHash: string;
  inputItems: number;
  inputTokenEstimate: number;
}

interface ResponsesImplicitBreakpointDiagnostic {
  kind: 'user' | 'tool';
  itemType: string;
  inputItems: number;
  prefixHash: string;
  prefixTokenEstimate: number;
}

interface ResponsesInputLayout {
  input: any[];
  breakpoints: Array<'S'>;
  prefixHashes: Partial<Record<'S', string>>;
  breakpointDiagnostics: ResponsesBreakpointDiagnostic[];
  durableItems: number;
  transientItems: number;
  transientReplayItems: number;
  transientDeveloperItems: number;
}

interface ResponsesWireItemDiagnostic {
  index: number;
  segment: 'anchor' | 'durable' | 'transient_replay' | 'transient_developer';
  role?: string;
  type?: string;
  marker?: string;
  hash: string;
  tokenEstimate: number;
}

const RESPONSES_SESSION_ANCHOR = [
  '[session_protocol]',
  'The following input replays the durable XiaoBa session in chronological order.',
  'Tool calls and tool results must remain paired and ordered.',
  'Request-local context, when present, is appended after the durable session.',
  '[/session_protocol]',
].join('\n');

/**
 * OpenAI Provider
 * 兼容所有 OpenAI API 格式的服务（OpenAI、本地 LLM 等）
 * 支持 SSE streaming
 */
export class OpenAIProvider implements AIProvider {
  private apiUrl: string;
  private chatCompletionsUrl: string;
  private responsesUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private reasoningEffort: ChatConfig['reasoningEffort'];
  private openaiApiMode: ChatConfig['openaiApiMode'];
  private responsesExplicitAnchorSupported: boolean | undefined;
  private responsesTraceSequence = 0;

  constructor(config: ChatConfig) {
    this.apiUrl = config.apiUrl!;
    this.chatCompletionsUrl = normalizeOpenAIChatCompletionsUrl(this.apiUrl);
    this.responsesUrl = normalizeOpenAIResponsesUrl(this.apiUrl);
    this.apiKey = config.apiKey!;
    this.model = config.model || 'gpt-4o';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = resolveMaxTokens(config);
    this.reasoningEffort = config.reasoningEffort;
    this.openaiApiMode = openAIApiModeOrDefault(config.openaiApiMode);
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(messages: Message[], tools?: ToolDefinition[], stream = false): any {
    const sanitizedMessages = messages.map(message => this.sanitizeMessage(message));

    const body: any = {
      model: this.model,
      messages: sanitizedMessages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream,
    };

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    applyOpenAIReasoningOptions(body, {
      apiUrl: this.apiUrl,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    });

    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }

    return body;
  }

  private sanitizeMessage(message: Message): any {
    const sanitized: any = {
      role: message.role,
      content: this.sanitizeContent(message.content),
    };

    if (message.name) {
      sanitized.name = message.name;
    }
    if (message.role === 'assistant' && message.tool_calls) {
      sanitized.tool_calls = message.tool_calls.map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type,
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      }));
      const reasoningContent = this.extractOpenAIReasoningContent(message);
      if (reasoningContent) {
        sanitized.reasoning_content = reasoningContent;
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      sanitized.tool_call_id = message.tool_call_id;
    }

    return sanitized;
  }

  private extractOpenAIReasoningContent(message: Message): string | undefined {
    if (!this.shouldReplayOpenAIReasoningContent()) return undefined;
    if (!this.canReplayProviderContent(message, 'openai-chat-completions')) return undefined;
    if (!Array.isArray(message.providerContent) || !message.tool_calls?.length) return undefined;
    const block = message.providerContent.find(item =>
      item
      && typeof item === 'object'
      && item.type === 'openai_reasoning'
      && typeof (item as any).reasoning_content === 'string'
    );
    const reasoning = typeof (block as any)?.reasoning_content === 'string'
      ? (block as any).reasoning_content.trim()
      : '';
    return reasoning || undefined;
  }

  private shouldReplayOpenAIReasoningContent(): boolean {
    return supportsOpenAIReasoningReplay({
      apiUrl: this.apiUrl,
      model: this.model,
    });
  }

  private providerStateReference(apiType: ProviderApiType): ProviderStateReference {
    return createProviderStateReference({
      apiType,
      endpoint: apiType === 'openai-responses' ? this.responsesUrl : this.chatCompletionsUrl,
      model: this.model,
    });
  }

  private usesDeepSeekResponsesPolicy(): boolean {
    return isDeepSeekResponses(this.openaiApiMode, this.model);
  }

  private canReplayProviderContent(message: Message, apiType: ProviderApiType): boolean {
    return isProviderStateCompatible(message.providerState, this.providerStateReference(apiType));
  }

  private sanitizeContent(content: Message['content']): any {
    if (!Array.isArray(content)) return content ?? '';
    return content.map(block =>
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
    );
  }

  private visibleMessageContent(message: any): string | null {
    const content = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((item: any) => typeof item?.text === 'string' ? item.text : '')
            .join('')
        : '';
    const visible = stripOpenAIThinkingText(content).trim();
    return visible || null;
  }

  /**
   * 构建请求头
   */
  private get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Build Responses-only headers following Pi's OpenAI compatibility convention.
   * The relay may use these stable values for session-affine routing. We keep
   * the behavior off for the native OpenAI endpoint unless explicitly forced.
   */
  private responsesHeaders(options?: AIRequestOptions): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers };
    const sessionKey = options?.promptCacheContext?.sessionKey;
    if (!sessionKey || sessionKey === 'unknown' || sessionKey === 'unscoped' || !this.isResponsesSessionAffinityEnabled()) {
      return headers;
    }

    const affinity = `xiaoba-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`;
    // Pi's OpenAI Responses compatibility mode uses the same stable session
    // value for these two relay-recognized headers.
    headers.session_id = affinity;
    headers['x-client-request-id'] = affinity;
    return headers;
  }

  private isResponsesSessionAffinityEnabled(): boolean {
    const configured = String(process.env.XIAOBA_RESPONSES_SESSION_AFFINITY || 'auto')
      .trim()
      .toLowerCase();
    if (configured === 'off' || configured === 'false' || configured === 'disabled') return false;
    if (configured === 'on' || configured === 'force') return true;
    return !this.isOfficialOpenAIResponsesEndpoint();
  }

  /**
   * 普通调用
   */
  async chat(messages: Message[], tools?: ToolDefinition[], options?: AIRequestOptions): Promise<ChatResponse> {
    if (this.openaiApiMode === 'responses') {
      return this.chatResponses(messages, tools, options);
    }
    const body = this.buildRequestBody(messages, tools, false);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.chatCompletionsUrl,
      body,
    });
    const response = await axios.post(this.chatCompletionsUrl, body, {
      headers: this.headers,
      signal: options?.signal,
    });
    const choice = response.data.choices[0];
    const message = choice.message;
    const usage = response.data.usage;

    ContextDebugLogger.dumpSdkBoundary('after', undefined, {
      response: response.data,
    });

    return {
      content: this.visibleMessageContent(message),
      toolCalls: message.tool_calls,
      stopReason: choice.finish_reason || undefined,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        cachedReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        cachedWriteTokens: usage.prompt_tokens_details?.cache_write_tokens
          ?? usage.prompt_tokens_details?.cached_creation_tokens
          ?? usage.prompt_tokens_details?.cache_creation_tokens
          ?? 0,
      } : undefined,
      ...this.buildOpenAIProviderContent(message),
    };
  }

  /**
   * 流式调用（SSE）
   */
  async chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    options?: AIRequestOptions,
  ): Promise<ChatResponse> {
    if (this.openaiApiMode === 'responses') {
      return this.chatStreamResponses(messages, tools, callbacks, options);
    }
    const body = this.buildRequestBody(messages, tools, true);

    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.chatCompletionsUrl,
      body,
    });

    const response = await this.postProviderRequest(
      this.chatCompletionsUrl,
      body,
      true,
      options,
    );

    return new Promise<ChatResponse>((resolve, reject) => {
      let fullContent = '';
      let fullReasoningContent = '';
      let contentStripper = new OpenAIThinkingStripper();
      const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let streamUsage: ChatResponse['usage'] = undefined;
      let finishReason: string | undefined;

      const stream = response.data;
      const onAbort = () => {
        stream.destroy(createAbortError());
      };
      if (options?.signal?.aborted) {
        onAbort();
      } else {
        options?.signal?.addEventListener('abort', onAbort, { once: true });
      }

      stream.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // 提取 usage（stream_options.include_usage 时在最后一个 chunk 返回）
            if (parsed.usage) {
              streamUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
                cachedReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
                cachedWriteTokens: parsed.usage.prompt_tokens_details?.cache_write_tokens
                  ?? parsed.usage.prompt_tokens_details?.cached_creation_tokens
                  ?? parsed.usage.prompt_tokens_details?.cache_creation_tokens
                  ?? 0,
              };
            }

            const delta = choice?.delta;
            if (!delta) continue;

            // OpenAI-compatible providers may stream hidden reasoning fields
            // (reasoning_content/thinking/etc.). CatsCo treats them as private
            // provider-side work: never render them and never send them back as
            // conversation content.
            const reasoningDelta = extractOpenAIReasoningDelta(delta);
            if (reasoningDelta) fullReasoningContent += reasoningDelta;

            // 文本内容
            if (delta.content) {
              const visibleContent = contentStripper.push(delta.content);
              if (visibleContent) {
                fullContent += visibleContent;
                callbacks?.onText?.(visibleContent);
              }
            }

            // 工具调用（增量拼接）
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  });
                }
                const existing = toolCallsMap.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      });

      stream.on('end', () => {
        options?.signal?.removeEventListener('abort', onAbort);
        buffer += decoder.end();
        const tail = contentStripper.flush();
        if (tail) {
          fullContent += tail;
          callbacks?.onText?.(tail);
        }
        const toolCalls = toolCallsMap.size > 0
          ? Array.from(toolCallsMap.values())
          : undefined;

        const providerContent = toolCalls && fullReasoningContent.trim()
          ? buildOpenAIProviderContentFromToolCalls(toolCalls, fullReasoningContent.trim())
          : undefined;
        const result: ChatResponse = {
          content: fullContent || null,
          toolCalls,
          usage: streamUsage,
          stopReason: finishReason,
          ...(providerContent ? {
            providerContent,
            providerState: this.providerStateReference('openai-chat-completions'),
          } : {}),
        };

        ContextDebugLogger.dumpSdkBoundary('after', undefined, {
          response: result,
        });

        callbacks?.onComplete?.(result);
        resolve(result);
      });

      stream.on('error', (err: Error) => {
        options?.signal?.removeEventListener('abort', onAbort);
        callbacks?.onError?.(err);
        reject(err);
      });
    });
  }

  private buildResponsesRequestBody(
    messages: Message[],
    tools?: ToolDefinition[],
    stream = false,
    options?: AIRequestOptions,
    forceCompatibility = false,
  ): any {
    const requestTraceId = this.nextResponsesTraceId();
    const logicalBody = this.buildResponsesLogicalRequestBody(
      messages,
      tools,
      options,
      forceCompatibility,
      stream,
      requestTraceId,
    );
    const body = {
      ...logicalBody,
      stream,
    };
    Object.defineProperty(body, '__xiaobaResponsesTraceId', {
      value: requestTraceId,
      enumerable: false,
    });
    return body;
  }

  private buildResponsesLogicalRequestBody(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: AIRequestOptions,
    forceCompatibility = false,
    stream = false,
    requestTraceId?: string,
  ): any {
    const instructions = messages
      .filter(message => message.role === 'system' && !this.isDynamicCacheMessage(message))
      .filter(message => !this.isLegacyCheckpointBoundary(message))
      .map(message => this.contentAsText(message.content))
      .filter(Boolean)
      .join('\n\n');
    const responseTools = this.buildCanonicalResponsesTools(tools ?? []);
    const explicitAnchor = !forceCompatibility
      && this.responsesExplicitAnchorSupported !== false
      && options?.promptCacheContext?.explicitCaching === true
      && this.supportsExplicitPromptCaching();
    const layout = this.buildResponsesInput(
      messages,
      explicitAnchor,
    );
    const body: any = {
      model: this.model,
      input: layout.input,
      max_output_tokens: this.maxTokens,
    };
    body.store = false;
    body.prompt_cache_key = this.buildPromptCacheKey(
      instructions,
      responseTools,
      options?.promptCacheContext?.sessionKey,
    );

    if (instructions) body.instructions = instructions;
    if (Number.isFinite(this.temperature)) body.temperature = this.temperature;
    if (responseTools.length > 0) body.tools = responseTools;
    body.include = ['reasoning.encrypted_content'];
    if (this.usesDeepSeekResponsesPolicy()) {
      applyDeepSeekResponsesRequestPolicy(body, this.reasoningEffort);
    } else {
      this.applyResponsesReasoningOptions(body);
    }
    this.logResponsesCacheLayout(
      body.prompt_cache_key || '',
      instructions,
      responseTools,
      layout,
      explicitAnchor,
      options?.promptCacheContext,
      body,
      stream,
      requestTraceId,
    );
    return body;
  }

  private isOfficialOpenAIResponsesEndpoint(): boolean {
    try {
      return new URL(this.responsesUrl).hostname.toLowerCase() === 'api.openai.com';
    } catch {
      return false;
    }
  }

  private buildResponsesInput(
    messages: Message[],
    explicitAnchor = false,
  ): ResponsesInputLayout {
    const requestMessages = messages.filter(message => (
      !this.isLegacyCheckpointBoundary(message)
      && !(message.role === 'system' && !this.isDynamicCacheMessage(message))
    ));
    const transientMessages = requestMessages.filter(message => this.isTurnDeltaMessage(message));
    const transientReplayMessages = transientMessages.filter(message => message.__syntheticObservation === true);
    const transientDeveloperMessages = transientMessages.filter(message => message.__syntheticObservation !== true);
    const durableMessages = requestMessages.filter(message => !this.isTurnDeltaMessage(message));
    const checkpointMessages = durableMessages.filter(message => message.__checkpointSummary === true);
    const chronologicalMessages = durableMessages.filter(message => message.__checkpointSummary !== true);
    const input: any[] = [];
    const breakpoints: Array<'S'> = [];
    const prefixHashes: Partial<Record<'S', string>> = {};
    const breakpointDiagnostics: ResponsesBreakpointDiagnostic[] = [];

    const recordBreakpoint = (label: 'S') => {
      const prefixHash = this.hashWirePrefix(input);
      breakpoints.push(label);
      prefixHashes[label] = prefixHash;
      breakpointDiagnostics.push({
        label,
        prefixHash,
        inputItems: input.length,
        inputTokenEstimate: estimateJsonTokens(input),
      });
    };

    if (explicitAnchor) {
      input.push(this.buildResponsesSessionAnchor());
      recordBreakpoint('S');
    }

    input.push(...this.convertResponsesMessages(checkpointMessages));
    input.push(...this.convertResponsesMessages(chronologicalMessages));
    const stableInputItems = input.length;
    const durableItems = stableInputItems - (explicitAnchor ? 1 : 0);
    const transientReplayInput = this.convertResponsesMessages(transientReplayMessages);
    const transientDeveloperInput = this.convertResponsesMessages(transientDeveloperMessages, true);
    input.push(...transientReplayInput);
    input.push(...transientDeveloperInput);
    return {
      input,
      breakpoints,
      prefixHashes,
      breakpointDiagnostics,
      durableItems,
      transientItems: input.length - stableInputItems,
      transientReplayItems: transientReplayInput.length,
      transientDeveloperItems: transientDeveloperInput.length,
    };
  }

  private convertResponsesMessages(messages: Message[], transientProjection = false): any[] {
    const input: any[] = [];
    for (const message of messages) {
      if (message.role === 'system') {
        input.push({
          role: transientProjection ? 'developer' : 'system',
          content: this.responsesMessageContent(message.content),
        });
        continue;
      }
      if (message.role === 'tool') {
        if (!message.tool_call_id) continue;
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: this.responsesFunctionOutput(message.content),
        });
        continue;
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const replayItems = (this.canReplayProviderContent(message, 'openai-responses')
          ? message.providerContent || []
          : [])
          .filter(item => this.isResponsesReplayItem(item))
          .map(item => JSON.parse(JSON.stringify(item)));
        if (replayItems.length > 0) {
          input.push(...replayItems);
          continue;
        }
        const text = this.contentAsText(message.content);
        if (text) input.push({ role: 'assistant', content: text });
        for (const toolCall of message.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments || '{}',
          });
        }
        continue;
      }
      input.push({
        role: transientProjection ? 'developer' : message.role,
        content: this.responsesMessageContent(message.content),
      });
    }
    return input;
  }

  private isTurnDeltaMessage(message: Message): boolean {
    return this.isDynamicCacheMessage(message)
      || message.__injected === true
      || message.__runtimeFeedback === true
      || message.__syntheticObservation === true;
  }

  private buildResponsesSessionAnchor(): any {
    return {
      role: 'developer',
      content: [{
        type: 'input_text',
        text: RESPONSES_SESSION_ANCHOR,
        prompt_cache_breakpoint: { mode: 'explicit' },
      }],
    };
  }

  private isDynamicCacheMessage(message: Message): boolean {
    if (message.__cacheScope === 'dynamic') return true;
    if (message.__cacheScope === 'stable') return false;
    if (message.role !== 'system' || typeof message.content !== 'string') return false;
    return /^\[(?:transient_[^\]]+|compact_boundary|checkpoint_compaction_boundary)\]/.test(message.content);
  }

  private isLegacyCheckpointBoundary(message: Message): boolean {
    return message.__checkpointBoundary === true || (
      message.role === 'system'
      && typeof message.content === 'string'
      && /^\[(?:checkpoint_compaction_boundary|compact_boundary)\]/.test(message.content)
    );
  }

  private buildCanonicalResponsesTools(tools: ToolDefinition[]): any[] {
    return tools
      .map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map(tool => this.canonicalizeJsonValue(tool));
  }

  private canonicalizeJsonValue(value: any): any {
    if (Array.isArray(value)) return value.map(item => this.canonicalizeJsonValue(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, this.canonicalizeJsonValue(value[key])]),
    );
  }

  private responsesMessageContent(content: Message['content']): any {
    if (!Array.isArray(content)) return content ?? '';
    return content.map(block => block.type === 'text'
      ? { type: 'input_text', text: block.text }
      : { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` });
  }

  private responsesFunctionOutput(content: Message['content']): any {
    if (!Array.isArray(content)) return content ?? '';
    return content.map(block => block.type === 'text'
      ? { type: 'input_text', text: block.text }
      : { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` });
  }

  private contentAsText(content: Message['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  private isResponsesReplayItem(item: any): boolean {
    if (!item || typeof item !== 'object') return false;
    const type = String(item.type || '');
    if (this.usesDeepSeekResponsesPolicy()) return isDeepSeekResponsesReplayItem(item);
    return ['message', 'function_call', 'reasoning'].includes(type);
  }

  private buildPromptCacheKey(instructions: string, tools: any[], sessionKey?: string): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({
        identityVersion: 'responses-cache-v3',
        model: this.model,
        session: createHash('sha256').update(sessionKey || 'unscoped').digest('hex').slice(0, 24),
        instructions,
        tools,
      }))
      .digest('hex')
      .slice(0, 48);
    return `catsco-${digest}`;
  }

  private supportsExplicitPromptCaching(): boolean {
    const configuredMode = String(process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE || 'off')
      .trim()
      .toLowerCase();
    if (['0', 'false', 'off', 'no', 'disabled'].includes(configuredMode)) return false;

    const match = this.model.trim().toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:[-_:]|$)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2] || 0);
    const supportedModel = major > 5 || (major === 5 && minor >= 6);
    if (!supportedModel) return false;

    if (['1', 'true', 'on', 'yes', 'force', 'enabled'].includes(configuredMode)) return true;
    return configuredMode === 'auto' && this.isOfficialOpenAIResponsesEndpoint();
  }

  private hashWirePrefix(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  }

  private nextResponsesTraceId(): string {
    this.responsesTraceSequence++;
    return `${Date.now().toString(36)}-${this.responsesTraceSequence.toString(36)}`;
  }

  private responsesTraceId(body: any): string | undefined {
    const value = body?.__xiaobaResponsesTraceId;
    return typeof value === 'string' ? value : undefined;
  }

  private responsesWireItemMarker(item: any): string | undefined {
    const content = item?.content ?? item?.output;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find(block => block?.type === 'input_text' && typeof block?.text === 'string')?.text
        : undefined;
    const marker = typeof text === 'string' ? text.match(/^\[[^\]\r\n]{1,80}\]/)?.[0] : undefined;
    return marker;
  }

  private buildResponsesWireItemDiagnostics(
    layout: ResponsesInputLayout,
    explicit: boolean,
  ): ResponsesWireItemDiagnostic[] {
    const anchorItems = explicit ? 1 : 0;
    const durableEnd = anchorItems + layout.durableItems;
    const replayEnd = durableEnd + layout.transientReplayItems;
    return layout.input.map((item, index) => {
      const segment: ResponsesWireItemDiagnostic['segment'] = index < anchorItems
        ? 'anchor'
        : index < durableEnd
          ? 'durable'
          : index < replayEnd
            ? 'transient_replay'
            : 'transient_developer';
      const marker = segment === 'durable' ? undefined : this.responsesWireItemMarker(item);
      return {
        index,
        segment,
        ...(item?.role ? { role: String(item.role) } : {}),
        ...(item?.type ? { type: String(item.type) } : {}),
        ...(marker ? { marker } : {}),
        hash: this.hashWirePrefix(item),
        tokenEstimate: estimateJsonTokens(item),
      };
    });
  }

  private logResponsesCacheLayout(
    cacheKey: string,
    instructions: string,
    tools: any[],
    layout: ResponsesInputLayout,
    explicit: boolean,
    cacheContext?: AIRequestOptions['promptCacheContext'],
    logicalBody?: any,
    stream = false,
    requestTraceId?: string,
  ): void {
    const mode = explicit ? 'implicit_with_explicit_s' : 'implicit';
    const implicitDiagnostics = this.buildResponsesImplicitBreakpointDiagnostics(
      instructions,
      tools,
      layout.input,
    );
    const itemDiagnostics = this.buildResponsesWireItemDiagnostics(layout, explicit);
    const stableInputItems = (explicit ? 1 : 0) + layout.durableItems;
    const durableInput = layout.input.slice(0, stableInputItems);
    const transientInput = layout.input.slice(stableInputItems);
    Logger.runtimeEvent('INFO', `responses_cache_layout mode=${mode} breakpoints=${layout.breakpoints.join(',') || 'none'}`, {
      type: 'responses_cache_layout',
      payload: {
        mode,
        request_trace_id: requestTraceId,
        stream,
        transport: stream ? 'sse' : 'json',
        phase: cacheContext?.phase || 'normal',
        session_hash: this.hashWirePrefix(cacheContext?.sessionKey || 'unscoped'),
        cache_key_hash: this.hashWirePrefix(cacheKey),
        instructions_hash: this.hashWirePrefix(instructions),
        tools_hash: this.hashWirePrefix(tools),
        stable_core_token_estimate: estimateJsonTokens({ instructions, tools }),
        breakpoint_sequence: layout.breakpoints,
        prefix_hashes: layout.prefixHashes,
        breakpoint_diagnostics: layout.breakpointDiagnostics,
        implicit_candidate_count: implicitDiagnostics.candidateCount,
        implicit_candidates: implicitDiagnostics.candidates,
        implicit_latest_prefix_hash: implicitDiagnostics.latestPrefixHash,
        implicit_trailing_items: implicitDiagnostics.trailingItems,
        input_items: layout.input.length,
        durable_items: layout.durableItems,
        transient_items: layout.transientItems,
        transient_replay_items: layout.transientReplayItems,
        transient_developer_items: layout.transientDeveloperItems,
        durable_input_hash: this.hashWirePrefix(durableInput),
        transient_input_hash: this.hashWirePrefix(transientInput),
        final_input_hash: this.hashWirePrefix(layout.input),
        session_affinity_enabled: Boolean(
          cacheContext?.sessionKey
          && cacheContext.sessionKey !== 'unknown'
          && cacheContext.sessionKey !== 'unscoped'
          && this.isResponsesSessionAffinityEnabled(),
        ),
        session_affinity_hash: cacheContext?.sessionKey
          ? this.hashWirePrefix(`xiaoba-${createHash('sha256').update(cacheContext.sessionKey).digest('hex').slice(0, 32)}`)
          : undefined,
        input_item_diagnostics: itemDiagnostics,
        logical_body_hash: this.hashWirePrefix({ ...(logicalBody || {}), stream }),
      },
    });
  }

  private buildResponsesImplicitBreakpointDiagnostics(
    instructions: string,
    tools: any[],
    input: any[],
  ): {
      candidateCount: number;
      candidates: ResponsesImplicitBreakpointDiagnostic[];
      latestPrefixHash?: string;
      trailingItems: number;
    } {
    const prefixHash = createHash('sha256');
    prefixHash.update(JSON.stringify({
      model: this.model,
      instructions,
      tools,
    }));
    let prefixTokenEstimate = estimateJsonTokens({ instructions, tools });
    const candidates: ResponsesImplicitBreakpointDiagnostic[] = [];
    let candidateCount = 0;

    for (let index = 0; index < input.length; index++) {
      const item = input[index];
      prefixHash.update('\u0000');
      prefixHash.update(JSON.stringify(item));
      prefixTokenEstimate += estimateJsonTokens(item);
      const kind = this.responsesImplicitBreakpointKind(item);
      if (!kind) continue;
      candidateCount++;
      candidates.push({
        kind,
        itemType: String(item?.type || item?.role || 'unknown'),
        inputItems: index + 1,
        prefixHash: prefixHash.copy().digest('hex').slice(0, 16),
        prefixTokenEstimate,
      });
      if (candidates.length > 80) candidates.shift();
    }

    const latest = candidates.at(-1);
    return {
      candidateCount,
      candidates,
      ...(latest ? { latestPrefixHash: latest.prefixHash } : {}),
      trailingItems: latest ? input.length - latest.inputItems : input.length,
    };
  }

  private responsesImplicitBreakpointKind(item: any): 'user' | 'tool' | undefined {
    if (item?.role === 'user') return 'user';
    const type = String(item?.type || '');
    if (type.endsWith('_call_output') || type === 'tool_search_output') return 'tool';
    return undefined;
  }

  private logResponsesCacheUsage(
    body: any,
    usage: ChatResponse['usage'],
    explicit: boolean,
    rawUsage?: any,
    response?: any,
    headers?: any,
  ): void {
    if (!usage) return;
    const mode = explicit ? 'implicit_with_explicit_s' : 'implicit';
    const details = rawUsage?.input_tokens_details;
    const detailKeys = details && typeof details === 'object' ? Object.keys(details).sort() : [];
    const headerValue = (name: string): string | undefined => {
      const value = headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
      return typeof value === 'string' && value ? value : undefined;
    };
    Logger.runtimeEvent('INFO', `responses_cache_usage mode=${mode} cached=${usage.cachedReadTokens ?? 0} written=${usage.cachedWriteTokens ?? 0}`, {
      type: 'responses_cache_usage',
      payload: {
        mode,
        request_trace_id: this.responsesTraceId(body),
        cache_key_hash: this.hashWirePrefix(body?.prompt_cache_key || ''),
        logical_body_hash: this.hashWirePrefix(body || {}),
        input_tokens: usage.promptTokens,
        cached_tokens: usage.cachedReadTokens ?? 0,
        cache_write_tokens: usage.cachedWriteTokens ?? 0,
        usage_input_detail_keys: detailKeys,
        cache_write_tokens_present: detailKeys.includes('cache_write_tokens'),
        response_id_hash: response?.id ? this.hashWirePrefix(response.id) : undefined,
        response_model: typeof response?.model === 'string' ? response.model : undefined,
        service_tier: typeof response?.service_tier === 'string' ? response.service_tier : undefined,
        upstream_request_id_hash: (() => {
          const requestId = headerValue('x-request-id')
            || headerValue('openai-request-id')
            || headerValue('x-openai-request-id');
          return requestId ? this.hashWirePrefix(requestId) : undefined;
        })(),
      },
    });
  }

  /**
   * Responses-only upload-boundary diagnostics.
   *
   * This is intentionally hash/metadata based: it records the exact logical
   * body immediately before axios serializes and uploads it, without writing
   * Authorization or full prompt contents to the normal session log.
   */
  private logResponsesWireRequest(
    body: any,
    options: AIRequestOptions | undefined,
    stream: boolean,
    headers: Record<string, string>,
  ): void {
    if (String(process.env.XIAOBA_RESPONSES_WIRE_DEBUG || '').trim().toLowerCase() !== 'true') {
      return;
    }
    const input = Array.isArray(body?.input) ? body.input : [];
    const itemDiagnostics = input.map((item: any, index: number) => ({
      index,
      type: typeof item?.type === 'string' ? item.type : undefined,
      role: typeof item?.role === 'string' ? item.role : undefined,
      call_id: typeof item?.call_id === 'string' ? this.hashWirePrefix(item.call_id) : undefined,
      hash: this.hashWirePrefix(item),
      token_estimate: estimateJsonTokens(item),
    }));
    const sessionKey = options?.promptCacheContext?.sessionKey || 'unscoped';
    const affinityHeader = headers['x-client-request-id'] || headers.session_id || '';
    Logger.runtimeEvent('INFO', 'responses_wire_request before_upload', {
      type: 'responses_wire_request',
      payload: {
        stage: 'before_upload',
        request_trace_id: this.responsesTraceId(body),
        stream,
        transport: stream ? 'sse' : 'json',
        phase: options?.promptCacheContext?.phase || 'normal',
        api_mode: 'responses',
        session_hash: this.hashWirePrefix(sessionKey),
        session_affinity_enabled: Boolean(
          sessionKey !== 'unknown'
          && sessionKey !== 'unscoped'
          && this.isResponsesSessionAffinityEnabled(),
        ),
        session_affinity_header_hash: affinityHeader ? this.hashWirePrefix(affinityHeader) : undefined,
        client_request_id_hash: headers['x-client-request-id']
          ? this.hashWirePrefix(headers['x-client-request-id'])
          : undefined,
        session_id_hash: headers.session_id ? this.hashWirePrefix(headers.session_id) : undefined,
        prompt_cache_key_hash: this.hashWirePrefix(body?.prompt_cache_key || ''),
        wire_body_hash: this.hashWirePrefix(body || {}),
        input_items: input.length,
        input_hash: this.hashWirePrefix(input),
        input_item_diagnostics: itemDiagnostics,
      },
    });
  }

  private applyResponsesReasoningOptions(body: any): void {
    const effort = this.reasoningEffort;
    if (!effort || effort === 'default') return;
    if (!this.isOfficialOpenAIResponsesEndpoint() && !supportsReasoningSwitch({
      apiUrl: this.apiUrl,
      model: this.model,
    })) return;
    body.reasoning = {
      effort: effort === 'max' ? 'xhigh' : effort === 'disabled' ? 'none' : effort,
    };
  }

  private responsesFailureError(
    response: any,
    metadata: ResponsesFailureMetadata = {},
  ): Error | undefined {
    if (response?.status !== 'failed' && !response?.error) return undefined;
    const details = response?.error && typeof response.error === 'object'
      ? response.error
      : { message: response?.error };
    const providerCode = String(details?.code || '').trim();
    const providerType = String(details?.type || '').trim();
    const code = providerCode || providerType;
    const statusByCode: Record<string, number> = {
      internal_error: 500,
      internal_server_error: 500,
      server_error: 500,
      rate_limit_exceeded: 429,
      overloaded_error: 529,
      stream_read_error: 502,
      upstream_error: 502,
      server_is_overloaded: 503,
      service_unavailable_error: 503,
    };
    const explicitStatus = Number(details?.status ?? details?.status_code ?? response?.status_code);
    const status = Number.isFinite(explicitStatus) && explicitStatus > 0
      ? explicitStatus
      : statusByCode[providerCode] ?? statusByCode[providerType];
    const responseId = String(
      metadata.responseId
      || response?.id
      || details?.response_id
      || '',
    ).trim();
    const requestId = String(
      details?.request_id
      || response?.request_id
      || metadata.requestId
      || '',
    ).trim();
    return Object.assign(
      new Error(String(details?.message || 'Responses API request failed')),
      {
        ...(code ? { code } : {}),
        ...(providerCode ? { providerCode } : {}),
        ...(providerType ? { providerType } : {}),
        ...(status ? { status } : {}),
        ...(requestId ? { request_id: requestId } : {}),
        ...(responseId ? { responseId } : {}),
        ...(metadata.failurePhase ? { failurePhase: metadata.failurePhase } : {}),
        ...(metadata.terminalEvent ? { terminalEvent: metadata.terminalEvent } : {}),
        error: details,
      },
    );
  }

  private responsesStreamError(
    message: string,
    metadata: ResponsesFailureMetadata,
    cause?: unknown,
  ): Error {
    const details = {
      code: 'stream_read_error',
      type: 'stream_error',
      message,
    };
    const { requestId, ...failureMetadata } = metadata;
    return Object.assign(new Error(message), {
      code: details.code,
      providerCode: details.code,
      providerType: details.type,
      status: 502,
      error: details,
      ...failureMetadata,
      ...(requestId ? { request_id: requestId } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  private responsesRequestIdFromHeaders(headers: any): string | undefined {
    for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'x-openai-request-id']) {
      let value: unknown;
      try {
        value = headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
      } catch {
        // Some Axios-compatible header implementations can throw for unknown keys.
      }
      if (value === undefined && headers && typeof headers === 'object') {
        const matchingKey = Object.keys(headers).find(key => key.toLowerCase() === name);
        if (matchingKey) value = headers[matchingKey];
      }
      if (Array.isArray(value)) value = value[0];
      const requestId = typeof value === 'string' ? value.trim() : '';
      if (requestId) return requestId;
    }
    return undefined;
  }

  private isStructuredResponsesStreamError(error: any): boolean {
    return [
      error?.code,
      error?.status,
      error?.response?.status,
      error?.providerCode,
      error?.providerType,
      error?.error?.code,
      error?.error?.type,
    ].some(value => value !== undefined && value !== null && String(value).trim() !== '');
  }

  private parseResponsesUsage(usage: any): ChatResponse['usage'] {
    if (!usage || typeof usage !== 'object') return undefined;
    const details = usage.input_tokens_details || {};
    const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    const cachedReadTokens = Number(details.cached_tokens ?? 0);
    const cachedWriteTokens = Number(
      details.cache_write_tokens
      ?? details.cached_creation_tokens
      ?? details.cache_creation_tokens
      ?? 0,
    );
    return {
      promptTokens,
      completionTokens,
      totalTokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
      cachedReadTokens,
      cachedWriteTokens,
    };
  }

  private parseResponsesResponse(response: any): ChatResponse {
    const output = Array.isArray(response?.output) ? response.output : [];
    const textParts: string[] = [];
    const toolCalls: NonNullable<ChatResponse['toolCalls']> = [];

    for (const item of output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block?.type === 'output_text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
          if (block?.type === 'refusal' && typeof block.refusal === 'string') {
            textParts.push(block.refusal);
          }
        }
      }
      if (item?.type === 'function_call' && typeof item.name === 'string') {
        toolCalls.push({
          id: String(item.call_id || item.id || ''),
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        });
      }
    }

    const incompleteReason = String(response?.incomplete_details?.reason || '');
    const stopReason = response?.status === 'incomplete'
      ? incompleteReason === 'max_output_tokens' ? 'length' : incompleteReason || 'incomplete'
      : toolCalls.length > 0 ? 'tool_calls' : response?.status || undefined;
    const providerContent = toolCalls.length > 0
      ? output
        .filter((item: any) => this.isResponsesReplayItem(item))
        .map((item: any) => this.responsesReplayItem(item))
        .filter(Boolean)
      : undefined;

    return {
      content: this.visibleMessageContent({ content: textParts.join('') }),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.parseResponsesUsage(response?.usage),
      stopReason,
      ...(providerContent?.length ? { providerContent } : {}),
      ...(providerContent?.length ? { providerState: this.providerStateReference('openai-responses') } : {}),
    };
  }

  private responsesReplayItem(item: any): any | undefined {
    if (this.usesDeepSeekResponsesPolicy()) return sanitizeDeepSeekResponsesReplayItem(item);
    return JSON.parse(JSON.stringify(item));
  }

  private async chatResponses(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: AIRequestOptions,
  ): Promise<ChatResponse> {
    let body = this.buildResponsesRequestBody(messages, tools, false, options);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.responsesUrl,
      body,
    });
    const requestHeaders = this.responsesHeaders(options);
    this.logResponsesWireRequest(body, options, false, requestHeaders);
    let response;
    try {
      response = await this.postProviderRequest(
        this.responsesUrl, body, false, options, requestHeaders,
      );
    } catch (error) {
      if (!this.shouldRetryWithoutExplicitAnchor(error, body)) throw error;
      this.responsesExplicitAnchorSupported = false;
      Logger.warning('Responses endpoint rejected the explicit S cache anchor; retrying once without it.');
      body = this.buildResponsesRequestBody(messages, tools, false, options, true);
      const retryHeaders = this.responsesHeaders(options);
      this.logResponsesWireRequest(body, options, false, retryHeaders);
      response = await this.postProviderRequest(
        this.responsesUrl, body, false, options, retryHeaders,
      );
    }
    ContextDebugLogger.dumpSdkBoundary('after', undefined, { response: response.data });
    const responseRequestId = this.responsesRequestIdFromHeaders(response.headers);
    const failure = this.responsesFailureError(response.data, {
      failurePhase: 'terminal_event',
      terminalEvent: response.data?.status === 'failed' ? 'response.failed' : undefined,
      responseId: response.data?.id,
      requestId: responseRequestId,
    });
    if (failure) throw failure;
    const result = this.parseResponsesResponse(response.data);
    this.logResponsesCacheUsage(
      body,
      result.usage,
      this.hasResponsesExplicitAnchor(body),
      response.data?.usage,
      response.data,
      response.headers,
    );
    return result;
  }

  private async chatStreamResponses(
    messages: Message[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    options?: AIRequestOptions,
  ): Promise<ChatResponse> {
    let body = this.buildResponsesRequestBody(messages, tools, true, options);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.responsesUrl,
      body,
    });
    const requestHeaders = this.responsesHeaders(options);
    this.logResponsesWireRequest(body, options, true, requestHeaders);
    let response;
    try {
      response = await this.postProviderRequest(
        this.responsesUrl, body, true, options, requestHeaders,
      );
    } catch (error) {
      if (!this.shouldRetryWithoutExplicitAnchor(error, body)) throw error;
      this.responsesExplicitAnchorSupported = false;
      Logger.warning('Responses endpoint rejected the explicit S cache anchor; retrying stream once without it.');
      body = this.buildResponsesRequestBody(messages, tools, true, options, true);
      const retryHeaders = this.responsesHeaders(options);
      this.logResponsesWireRequest(body, options, true, retryHeaders);
      response = await this.postProviderRequest(
        this.responsesUrl, body, true, options, retryHeaders,
      );
    }

    const responseRequestId = this.responsesRequestIdFromHeaders(response.headers);

    return new Promise<ChatResponse>((resolve, reject) => {
      const stream = response.data;
      const contentStripper = new OpenAIThinkingStripper();
      const outputItems: any[] = [];
      let streamedVisibleText = '';
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let finalResponse: any;
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      const streamIdleTimeoutMs = this.responsesStreamIdleTimeoutMs(options);

      const clearIdleTimer = () => {
        if (!idleTimer) return;
        clearTimeout(idleTimer);
        idleTimer = undefined;
      };

      const cleanup = () => {
        clearIdleTimer();
        options?.signal?.removeEventListener('abort', onAbort);
      };

      const emitVisibleText = (text: string) => {
        if (!text) return;
        streamedVisibleText += text;
        callbacks?.onText?.(text);
      };

      const finishError = (error: Error) => {
        if (settled) return;
        cleanup();
        if (
          !streamedVisibleText
          && !outputItems.some(Boolean)
          && this.shouldRetryWithoutExplicitAnchor(error, body)
        ) {
          settled = true;
          this.responsesExplicitAnchorSupported = false;
          Logger.warning('Responses stream rejected the explicit S cache anchor; retrying once without it.');
          stream.destroy();
          void this.chatStreamResponses(messages, tools, callbacks, options).then(resolve, reject);
          return;
        }
        settled = true;
        callbacks?.onError?.(error);
        reject(error);
      };
      const onAbort = () => stream.destroy(createAbortError());

      const armIdleWatchdog = () => {
        if (streamIdleTimeoutMs <= 0 || settled) return;
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (settled) return;
          const error = this.responsesStreamError(
            `Responses API stream produced no data for ${streamIdleTimeoutMs}ms`,
            {
              failurePhase: 'stream',
              terminalEvent: 'stream.idle_timeout',
              requestId: responseRequestId,
            },
          );
          Object.assign(error, {
            name: 'ResponsesStreamIdleTimeoutError',
            code: 'XIAOBA_RESPONSES_STREAM_IDLE_TIMEOUT',
            providerCode: 'stream_idle_timeout',
            status: 504,
          });
          stream.destroy();
          finishError(error);
        }, streamIdleTimeoutMs);
      };

      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener('abort', onAbort, { once: true });

      const handleEvent = (event: any) => {
        if (
          (event?.type === 'response.output_text.delta' || event?.type === 'response.refusal.delta')
          && typeof event.delta === 'string'
        ) {
          const visible = contentStripper.push(event.delta);
          emitVisibleText(visible);
          return;
        }
        if (event?.type === 'response.output_item.done' && event.item) {
          outputItems[Number(event.output_index ?? outputItems.length)] = event.item;
          return;
        }
        if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
          finalResponse = event.response;
          return;
        }
        if (event?.type === 'response.failed' || event?.type === 'error') {
          const failure = this.responsesFailureError(event?.response || {
            status: 'failed',
            request_id: event?.request_id,
            error: event?.error || {
              code: event?.code,
              message: event?.message,
            },
          }, {
            failurePhase: 'terminal_event',
            terminalEvent: event?.type,
            responseId: event?.response?.id || event?.response_id,
            requestId: responseRequestId,
          });
          finishError(failure || new Error('Responses API request failed'));
        }
      };

      stream.on('data', (chunk: Buffer) => {
        armIdleWatchdog();
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            handleEvent(JSON.parse(data));
          } catch {
            // Ignore malformed individual SSE events and continue the stream.
          }
        }
      });

      stream.on('end', () => {
        cleanup();
        buffer += decoder.end();
        if (settled) return;
        const tail = contentStripper.flush();
        emitVisibleText(tail);
        if (!finalResponse) {
          finishError(this.responsesStreamError(
            'Responses API stream ended without a terminal response',
            {
              failurePhase: 'stream',
              terminalEvent: 'stream.end',
              requestId: responseRequestId,
            },
          ));
          return;
        }
        const failure = this.responsesFailureError(finalResponse, {
          failurePhase: 'terminal_event',
          terminalEvent: finalResponse?.status === 'failed' ? 'response.failed' : undefined,
          responseId: finalResponse?.id,
          requestId: responseRequestId,
        });
        if (failure) {
          finishError(failure);
          return;
        }
        if (!Array.isArray(finalResponse.output) || finalResponse.output.length === 0) {
          finalResponse.output = outputItems.filter(Boolean);
        }
        const result = this.parseResponsesResponse(finalResponse);
        if (!result.content && streamedVisibleText) {
          result.content = this.visibleMessageContent({ content: streamedVisibleText });
        }
        ContextDebugLogger.dumpSdkBoundary('after', undefined, { response: finalResponse });
        this.logResponsesCacheUsage(
          body,
          result.usage,
          this.hasResponsesExplicitAnchor(body),
          finalResponse?.usage,
          finalResponse,
          response.headers,
        );
        settled = true;
        callbacks?.onComplete?.(result);
        resolve(result);
      });

      stream.on('error', (error: Error) => {
        if (isProviderAbortError(error) || options?.signal?.aborted) {
          finishError(error);
          return;
        }
        if (this.isStructuredResponsesStreamError(error)) {
          const existingRequestId = String(
            (error as any)?.request_id
            || (error as any)?.requestId
            || (error as any)?.error?.request_id
            || (error as any)?.response?.request_id
            || (error as any)?.response?.data?.request_id
            || (error as any)?.response?.data?.error?.request_id
            || '',
          ).trim();
          Object.assign(error, {
            failurePhase: 'stream',
            terminalEvent: 'stream.error',
            ...(!existingRequestId && responseRequestId ? { request_id: responseRequestId } : {}),
          });
          finishError(error);
          return;
        }
        finishError(this.responsesStreamError(
          error?.message || 'Responses API stream read failed',
          {
            failurePhase: 'stream',
            terminalEvent: 'stream.error',
            requestId: responseRequestId,
          },
          error,
        ));
      });

      armIdleWatchdog();
    });
  }

  private buildOpenAIProviderContent(message: any): Pick<ChatResponse, 'providerContent' | 'providerState'> {
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const reasoningContent = typeof message?.reasoning_content === 'string'
      ? message.reasoning_content.trim()
      : '';
    if (!toolCalls.length || !reasoningContent) return {};
    return {
      providerContent: buildOpenAIProviderContentFromToolCalls(toolCalls, reasoningContent),
      providerState: this.providerStateReference('openai-chat-completions'),
    };
  }

  private async postProviderRequest(
    url: string,
    body: any,
    stream: boolean,
    options?: AIRequestOptions,
    headers: Record<string, string> = this.headers,
  ): Promise<any> {
    const headersTimeoutMs = stream && url === this.responsesUrl
      ? this.responsesHeadersTimeoutMs()
      : 0;
    const watchdogController = headersTimeoutMs > 0 ? new AbortController() : undefined;
    let watchdogTimedOut = false;
    let watchdogTimer: NodeJS.Timeout | undefined;
    const onUserAbort = () => watchdogController?.abort();
    if (watchdogController && options?.signal) {
      if (options.signal.aborted) watchdogController.abort();
      else options.signal.addEventListener('abort', onUserAbort, { once: true });
    }
    if (watchdogController) {
      watchdogTimer = setTimeout(() => {
        watchdogTimedOut = true;
        watchdogController.abort();
      }, headersTimeoutMs);
    }

    try {
      return await axios.post(url, body, {
        headers,
        ...(stream ? { responseType: 'stream' as const } : {}),
        signal: watchdogController?.signal ?? options?.signal,
      });
    } catch (error) {
      if (watchdogTimedOut) {
        throw Object.assign(
          new Error(`Responses API did not return headers within ${headersTimeoutMs}ms`),
          {
            name: 'ResponsesHeadersTimeoutError',
            code: 'XIAOBA_RESPONSES_HEADERS_TIMEOUT',
            status: 504,
            providerCode: 'headers_timeout',
            failurePhase: 'headers' as const,
            cause: error,
          },
        );
      }
      if (options?.signal?.aborted || isProviderAbortError(error)) throw error;
      const normalizedError = await this.normalizeProviderErrorResponse(error);
      throw normalizedError;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      options?.signal?.removeEventListener('abort', onUserAbort);
    }
  }

  private responsesHeadersTimeoutMs(): number {
    const raw = String(process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS || '').trim();
    if (!raw) return DEFAULT_RESPONSES_HEADERS_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_RESPONSES_HEADERS_TIMEOUT_MS;
    if (parsed <= 0) return 0;
    return Math.min(MAX_RESPONSES_HEADERS_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
  }

  private responsesStreamIdleTimeoutMs(options?: AIRequestOptions): number {
    const value = Number(options?.streamIdleTimeoutMs);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_RESPONSES_STREAM_IDLE_TIMEOUT_MS, Math.max(1, Math.floor(value)));
  }

  private async normalizeProviderErrorResponse(error: unknown): Promise<unknown> {
    const response = (error as any)?.response;
    if (!response) return error;

    let normalizedData = response.data;
    if (isReadableErrorStream(normalizedData)) {
      const text = await readProviderErrorStream(normalizedData);
      normalizedData = parseProviderErrorBody(text);
      try {
        response.data = normalizedData;
      } catch {
        try {
          Object.defineProperty(error as object, 'response', {
            value: { ...response, data: normalizedData },
            configurable: true,
            writable: true,
          });
        } catch {
          // Error normalization is best-effort and must never replace the provider failure.
        }
      }
    }

    const mutableError = error as any;
    const normalizedStatus = Number(response.status ?? normalizedData?.status ?? normalizedData?.status_code);
    const details = normalizedData?.error && typeof normalizedData.error === 'object'
      ? normalizedData.error
      : normalizedData;
    const providerCode = typeof details?.code === 'string' ? details.code.trim() : '';
    const providerType = typeof details?.type === 'string' ? details.type.trim() : '';
    try {
      if (Number.isFinite(normalizedStatus) && normalizedStatus > 0) mutableError.status = normalizedStatus;
      if (providerCode && !mutableError.providerCode) mutableError.providerCode = providerCode;
      if (providerType && !mutableError.providerType) mutableError.providerType = providerType;
    } catch {
      // Preserve the original provider error when it is non-extensible.
    }
    return error;
  }

  private shouldRetryWithoutExplicitAnchor(error: unknown, body: any): boolean {
    if (!this.hasResponsesExplicitAnchor(body)) return false;
    if (/^(?:1|true|yes|on)$/i.test(String(process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT || '').trim())) {
      return false;
    }
    const status = Number((error as any)?.response?.status ?? (error as any)?.status);
    const data = (error as any)?.response?.data;
    const detail = `${(error as any)?.message || ''} ${safeProviderErrorDetail(data)}`.toLowerCase();
    if (detail.includes('prompt_cache_breakpoint') || detail.includes('prompt_cache_options')) {
      return /unsupported|not supported|unknown|invalid|extra|unrecognized/.test(detail);
    }
    return (status === 400 || status === 422)
      && detail.includes('prompt cache')
      && /unsupported|not supported|unknown|invalid|extra|unrecognized/.test(detail);
  }

  private hasResponsesExplicitAnchor(body: any): boolean {
    return countPromptCacheBreakpoints(body) > 0;
  }
}

function countPromptCacheBreakpoints(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countPromptCacheBreakpoints(item), 0);
  const record = value as Record<string, unknown>;
  return (record.prompt_cache_breakpoint ? 1 : 0)
    + Object.values(record).reduce<number>((sum, item) => sum + countPromptCacheBreakpoints(item), 0);
}

type ReadableErrorStream = {
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
  destroy?: () => void;
  destroyed?: boolean;
  pipe: (...args: any[]) => unknown;
};

function isReadableErrorStream(value: unknown): value is ReadableErrorStream {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as any).on === 'function'
    && typeof (value as any).once === 'function'
    && typeof (value as any).pipe === 'function',
  );
}

function readProviderErrorStream(stream: ReadableErrorStream): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let truncated = false;

    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (destroy = false) => {
      if (settled) return;
      settled = true;
      if (destroy && !stream.destroyed && typeof stream.destroy === 'function') {
        // Keep a listener attached while destroy settles: a socket may emit a
        // delayed error after the normal read listeners have been removed.
        stream.once('error', () => undefined);
      }
      cleanup();
      if (destroy && !stream.destroyed) {
        try {
          stream.destroy?.();
        } catch {
          // Releasing a broken response stream is best-effort.
        }
      }
      const body = Buffer.concat(chunks, totalBytes).toString('utf8').trim();
      resolve(truncated && body ? `${body}\n[truncated]` : body);
    };
    const onData = (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const remaining = MAX_PROVIDER_ERROR_BODY_BYTES - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        finish(true);
        return;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        totalBytes += remaining;
        truncated = true;
        finish(true);
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.length;
      if (totalBytes >= MAX_PROVIDER_ERROR_BODY_BYTES) {
        truncated = true;
        finish(true);
      }
    };
    const onEnd = () => finish();
    const onError = () => finish();
    const onClose = () => finish();
    const timer = setTimeout(() => finish(true), PROVIDER_ERROR_BODY_READ_TIMEOUT_MS);

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

function parseProviderErrorBody(text: string): unknown {
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function isProviderAbortError(error: unknown): boolean {
  const code = String((error as any)?.code || '').toUpperCase();
  const name = String((error as any)?.name || '');
  return code === 'ERR_CANCELED' || name === 'CanceledError' || name === 'AbortError';
}

function safeProviderErrorDetail(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, MAX_PROVIDER_ERROR_BODY_BYTES);
  if (Buffer.isBuffer(data)) {
    return data.subarray(0, MAX_PROVIDER_ERROR_BODY_BYTES).toString('utf8');
  }
  if (!data || isReadableErrorStream(data)) return '';
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(data, (_key, value) => {
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      return value;
    }).slice(0, MAX_PROVIDER_ERROR_BODY_BYTES);
  } catch {
    return '';
  }
}

function extractOpenAIReasoningDelta(delta: any): string {
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta?.reasoning === 'string') return '';
  if (typeof delta?.thinking === 'string') return '';
  return '';
}

function buildOpenAIProviderContentFromToolCalls(
  toolCalls: NonNullable<ChatResponse['toolCalls']>,
  reasoningContent: string,
): NonNullable<ChatResponse['providerContent']> {
  return [
    { type: 'openai_reasoning', reasoning_content: reasoningContent },
    ...toolCalls.map(toolCall => ({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseOpenAIToolArguments(toolCall.function.arguments),
    })),
  ];
}

function parseOpenAIToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson || '{}');
  } catch {
    return argumentsJson || '';
  }
}

function stripOpenAIThinkingText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/^\s*<think\b[^>]*>[\s\S]*$/i, '');
}

function longestThinkTagPrefixSuffix(value: string, tag: string): number {
  const lower = value.toLowerCase();
  const max = Math.min(lower.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (lower.slice(-length) === tag.slice(0, length)) return length;
  }
  return 0;
}

class OpenAIThinkingStripper {
  private buffer = '';
  private inThinking = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let output = '';

    while (this.buffer) {
      const lower = this.buffer.toLowerCase();

      if (this.inThinking) {
        const closeIndex = lower.indexOf('</think>');
        if (closeIndex < 0) {
          const keep = longestThinkTagPrefixSuffix(this.buffer, '</think>');
          this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
          break;
        }
        this.buffer = this.buffer.slice(closeIndex + '</think>'.length);
        this.inThinking = false;
        continue;
      }

      const openIndex = lower.indexOf('<think');
      if (openIndex < 0) {
        const keep = longestThinkTagPrefixSuffix(this.buffer, '<think');
        output += keep > 0 ? this.buffer.slice(0, -keep) : this.buffer;
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
        break;
      }

      output += this.buffer.slice(0, openIndex);
      const openEndIndex = this.buffer.indexOf('>', openIndex);
      if (openEndIndex < 0) {
        this.buffer = this.buffer.slice(openIndex);
        break;
      }
      this.buffer = this.buffer.slice(openEndIndex + 1);
      this.inThinking = true;
    }

    return output;
  }

  flush(): string {
    if (this.inThinking) {
      this.buffer = '';
      this.inThinking = false;
      return '';
    }
    const output = this.buffer;
    this.buffer = '';
    return output;
  }
}

function createAbortError(): Error {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}
