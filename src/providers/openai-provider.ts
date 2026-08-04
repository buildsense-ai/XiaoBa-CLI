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

interface ResponsesBreakpointDiagnostic {
  label: 'S' | 'A' | 'B';
  prefixHash: string;
  inputItems: number;
  inputTokenEstimate: number;
}

interface ResponsesInputLayout {
  input: any[];
  breakpoints: Array<'S' | 'A' | 'B'>;
  prefixHashes: Partial<Record<'S' | 'A' | 'B', string>>;
  breakpointDiagnostics: ResponsesBreakpointDiagnostic[];
}

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
  private responsesExplicitCacheSupported: boolean | undefined;

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

    const response = await axios.post(this.chatCompletionsUrl, body, {
      headers: this.headers,
      responseType: 'stream',
      signal: options?.signal,
    });

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
    const instructions = messages
      .filter(message => message.role === 'system' && !this.isDynamicCacheMessage(message))
      .filter(message => !this.isLegacyCheckpointBoundary(message))
      .map(message => this.contentAsText(message.content))
      .filter(Boolean)
      .join('\n\n');
    const responseTools = this.buildCanonicalResponsesTools(tools ?? []);
    const explicitCaching = !forceCompatibility
      && this.responsesExplicitCacheSupported !== false
      && options?.promptCacheContext?.explicitCaching === true
      && this.supportsExplicitPromptCaching();
    const layout = this.buildResponsesInput(
      messages,
      options?.promptCacheContext,
      explicitCaching,
    );
    const body: any = {
      model: this.model,
      input: layout.input,
      max_output_tokens: this.maxTokens,
      stream,
      store: false,
      prompt_cache_key: this.buildPromptCacheKey(
        instructions,
        responseTools,
        options?.promptCacheContext?.sessionKey,
      ),
    };

    if (instructions) body.instructions = instructions;
    if (Number.isFinite(this.temperature)) body.temperature = this.temperature;
    if (responseTools.length > 0) body.tools = responseTools;
    if (explicitCaching) body.prompt_cache_options = { mode: 'explicit' };
    body.include = ['reasoning.encrypted_content'];
    this.applyResponsesReasoningOptions(body);
    this.logResponsesCacheLayout(
      body.prompt_cache_key,
      instructions,
      responseTools,
      layout,
      explicitCaching,
      options?.promptCacheContext,
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
    cacheContext?: AIRequestOptions['promptCacheContext'],
    explicitCaching = false,
  ): ResponsesInputLayout {
    const requestMessages = messages.filter(message => (
      !this.isLegacyCheckpointBoundary(message)
      && !(message.role === 'system' && !this.isDynamicCacheMessage(message))
    ));
    const currentEpisodeId = cacheContext?.currentEpisodeId;
    const transientMessages = requestMessages.filter(message => this.isTurnDeltaMessage(message));
    const durableMessages = requestMessages.filter(message => !this.isTurnDeltaMessage(message));
    const checkpointMessages = durableMessages.filter(message => message.__checkpointSummary === true);
    const chronologicalMessages = durableMessages.filter(message => message.__checkpointSummary !== true);
    const inferredGroups = currentEpisodeId
      ? []
      : this.groupResponsesExchanges(chronologicalMessages);
    const completedEpisodeMessages = currentEpisodeId
      ? chronologicalMessages.filter(message => message.__episodeId !== currentEpisodeId)
      : inferredGroups.slice(0, -1).flat();
    const currentEpisodeMessages = currentEpisodeId
      ? chronologicalMessages.filter(message => message.__episodeId === currentEpisodeId)
      : [];
    const currentGroups = this.groupResponsesExchanges(currentEpisodeMessages);
    const latestGroup = currentEpisodeId
      ? (currentGroups[currentGroups.length - 1] || [])
      : (inferredGroups[inferredGroups.length - 1] || []);
    const completedCurrentGroups = currentEpisodeId ? currentGroups.slice(0, -1) : [];
    const input: any[] = [];
    const breakpoints: Array<'S' | 'A' | 'B'> = [];
    const prefixHashes: Partial<Record<'S' | 'A' | 'B', string>> = {};
    const breakpointDiagnostics: ResponsesBreakpointDiagnostic[] = [];

    const recordBreakpoint = (label: 'S' | 'A' | 'B') => {
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

    if (explicitCaching) {
      input.push(this.buildBreakpointCarrier());
      recordBreakpoint('S');
    }

    input.push(...this.convertResponsesMessages(checkpointMessages));
    input.push(...this.convertResponsesMessages(completedEpisodeMessages));
    if (explicitCaching && completedEpisodeMessages.length > 0) {
      input.push(this.buildBreakpointCarrier());
      recordBreakpoint('A');
    }

    for (const group of completedCurrentGroups) {
      input.push(...this.convertResponsesMessages(group));
    }
    if (explicitCaching && completedCurrentGroups.length > 0) {
      input.push(this.buildBreakpointCarrier());
      recordBreakpoint('B');
    }

    input.push(...this.convertResponsesMessages(transientMessages));
    input.push(...this.convertResponsesMessages(latestGroup));
    return { input, breakpoints, prefixHashes, breakpointDiagnostics };
  }

  private convertResponsesMessages(messages: Message[]): any[] {
    const input: any[] = [];
    for (const message of messages) {
      if (message.role === 'system') {
        input.push({ role: 'system', content: this.responsesMessageContent(message.content) });
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
      input.push({ role: message.role, content: this.responsesMessageContent(message.content) });
    }
    return input;
  }

  private groupResponsesExchanges(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    for (let index = 0; index < messages.length;) {
      const message = messages[index];
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const expected = new Set(message.tool_calls.map(call => call.id));
        const group = [message];
        index++;
        while (index < messages.length && messages[index].role === 'tool') {
          const tool = messages[index];
          group.push(tool);
          if (tool.tool_call_id) expected.delete(tool.tool_call_id);
          index++;
          if (expected.size === 0) break;
        }
        groups.push(group);
        continue;
      }
      groups.push([message]);
      index++;
    }
    return groups;
  }

  private isTurnDeltaMessage(message: Message): boolean {
    return this.isDynamicCacheMessage(message)
      || message.__injected === true
      || message.__runtimeFeedback === true
      || message.__syntheticObservation === true;
  }

  private buildBreakpointCarrier(): any {
    return {
      role: 'system',
      content: [{
        type: 'input_text',
        text: '\n',
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
    return Boolean(item && typeof item === 'object' && [
      'message',
      'function_call',
      'reasoning',
    ].includes(String(item.type || '')));
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
    const match = this.model.trim().toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:[-_:]|$)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2] || 0);
    return major > 5 || (major === 5 && minor >= 6);
  }

  private hashWirePrefix(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  }

  private logResponsesCacheLayout(
    cacheKey: string,
    instructions: string,
    tools: any[],
    layout: ResponsesInputLayout,
    explicit: boolean,
    cacheContext?: AIRequestOptions['promptCacheContext'],
  ): void {
    Logger.runtimeEvent('INFO', `responses_cache_layout mode=${explicit ? 'explicit' : 'compatibility'} breakpoints=${layout.breakpoints.join(',') || 'none'}`, {
      type: 'responses_cache_layout',
      payload: {
        mode: explicit ? 'explicit' : 'compatibility',
        phase: cacheContext?.phase || 'normal',
        session_hash: this.hashWirePrefix(cacheContext?.sessionKey || 'unscoped'),
        cache_key_hash: this.hashWirePrefix(cacheKey),
        instructions_hash: this.hashWirePrefix(instructions),
        tools_hash: this.hashWirePrefix(tools),
        stable_core_token_estimate: estimateJsonTokens({ instructions, tools }),
        breakpoint_sequence: layout.breakpoints,
        prefix_hashes: layout.prefixHashes,
        breakpoint_diagnostics: layout.breakpointDiagnostics,
        input_items: layout.input.length,
      },
    });
  }

  private logResponsesCacheUsage(
    cacheKey: string,
    usage: ChatResponse['usage'],
    explicit: boolean,
  ): void {
    if (!usage) return;
    Logger.runtimeEvent('INFO', `responses_cache_usage mode=${explicit ? 'explicit' : 'compatibility'} cached=${usage.cachedReadTokens ?? 0} written=${usage.cachedWriteTokens ?? 0}`, {
      type: 'responses_cache_usage',
      payload: {
        mode: explicit ? 'explicit' : 'compatibility',
        cache_key_hash: this.hashWirePrefix(cacheKey),
        input_tokens: usage.promptTokens,
        cached_tokens: usage.cachedReadTokens ?? 0,
        cache_write_tokens: usage.cachedWriteTokens ?? 0,
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

  private responsesFailureError(response: any): Error | undefined {
    if (response?.status !== 'failed' && !response?.error) return undefined;
    const details = response?.error && typeof response.error === 'object'
      ? response.error
      : { message: response?.error };
    const code = String(details?.code || details?.type || '').trim();
    const statusByCode: Record<string, number> = {
      server_error: 500,
      rate_limit_exceeded: 429,
      overloaded_error: 529,
    };
    const explicitStatus = Number(details?.status ?? details?.status_code ?? response?.status_code);
    const status = Number.isFinite(explicitStatus) && explicitStatus > 0
      ? explicitStatus
      : statusByCode[code];
    return Object.assign(
      new Error(String(details?.message || 'Responses API request failed')),
      {
        ...(code ? { code } : {}),
        ...(status ? { status } : {}),
        error: details,
      },
    );
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
      ? output.filter((item: any) => this.isResponsesReplayItem(item)).map((item: any) => JSON.parse(JSON.stringify(item)))
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
    let response;
    try {
      response = await axios.post(this.responsesUrl, body, {
        headers: this.headers,
        signal: options?.signal,
      });
    } catch (error) {
      if (!this.shouldRetryWithoutExplicitCaching(error, body)) throw error;
      this.responsesExplicitCacheSupported = false;
      Logger.warning('Responses endpoint rejected explicit prompt caching; retrying once in compatibility mode.');
      body = this.buildResponsesRequestBody(messages, tools, false, options, true);
      response = await axios.post(this.responsesUrl, body, {
        headers: this.headers,
        signal: options?.signal,
      });
    }
    ContextDebugLogger.dumpSdkBoundary('after', undefined, { response: response.data });
    const failure = this.responsesFailureError(response.data);
    if (failure) throw failure;
    const result = this.parseResponsesResponse(response.data);
    this.logResponsesCacheUsage(body.prompt_cache_key, result.usage, Boolean(body.prompt_cache_options));
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
    let response;
    try {
      response = await axios.post(this.responsesUrl, body, {
        headers: this.headers,
        responseType: 'stream',
        signal: options?.signal,
      });
    } catch (error) {
      if (!this.shouldRetryWithoutExplicitCaching(error, body)) throw error;
      this.responsesExplicitCacheSupported = false;
      Logger.warning('Responses endpoint rejected explicit prompt caching; retrying stream once in compatibility mode.');
      body = this.buildResponsesRequestBody(messages, tools, true, options, true);
      response = await axios.post(this.responsesUrl, body, {
        headers: this.headers,
        responseType: 'stream',
        signal: options?.signal,
      });
    }

    return new Promise<ChatResponse>((resolve, reject) => {
      const stream = response.data;
      const contentStripper = new OpenAIThinkingStripper();
      const outputItems: any[] = [];
      let streamedVisibleText = '';
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let finalResponse: any;
      let settled = false;

      const emitVisibleText = (text: string) => {
        if (!text) return;
        streamedVisibleText += text;
        callbacks?.onText?.(text);
      };

      const finishError = (error: Error) => {
        if (settled) return;
        if (
          !streamedVisibleText
          && !outputItems.some(Boolean)
          && this.shouldRetryWithoutExplicitCaching(error, body)
        ) {
          settled = true;
          options?.signal?.removeEventListener('abort', onAbort);
          this.responsesExplicitCacheSupported = false;
          Logger.warning('Responses stream rejected explicit prompt caching; retrying once in compatibility mode.');
          stream.destroy();
          void this.chatStreamResponses(messages, tools, callbacks, options).then(resolve, reject);
          return;
        }
        settled = true;
        callbacks?.onError?.(error);
        reject(error);
      };
      const onAbort = () => stream.destroy(createAbortError());
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
            error: event?.error || { message: event?.message },
          });
          finishError(failure || new Error('Responses API request failed'));
        }
      };

      stream.on('data', (chunk: Buffer) => {
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
        options?.signal?.removeEventListener('abort', onAbort);
        buffer += decoder.end();
        if (settled) return;
        const tail = contentStripper.flush();
        emitVisibleText(tail);
        if (!finalResponse) {
          finishError(new Error('Responses API stream ended without a terminal response'));
          return;
        }
        const failure = this.responsesFailureError(finalResponse);
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
        this.logResponsesCacheUsage(body.prompt_cache_key, result.usage, Boolean(body.prompt_cache_options));
        settled = true;
        callbacks?.onComplete?.(result);
        resolve(result);
      });

      stream.on('error', (error: Error) => {
        options?.signal?.removeEventListener('abort', onAbort);
        finishError(error);
      });
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

  private shouldRetryWithoutExplicitCaching(error: unknown, body: any): boolean {
    if (!body?.prompt_cache_options) return false;
    if (/^(?:1|true|yes|on)$/i.test(String(process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT || '').trim())) {
      return false;
    }
    const status = Number((error as any)?.response?.status ?? (error as any)?.status);
    const data = (error as any)?.response?.data;
    const detail = `${(error as any)?.message || ''} ${typeof data === 'string' ? data : JSON.stringify(data || {})}`.toLowerCase();
    if (detail.includes('prompt_cache_breakpoint') || detail.includes('prompt_cache_options')) {
      return /unsupported|not supported|unknown|invalid|extra|unrecognized/.test(detail);
    }
    return (status === 400 || status === 422)
      && detail.includes('prompt cache')
      && /unsupported|not supported|unknown|invalid|extra|unrecognized/.test(detail);
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
