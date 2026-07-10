import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { ContextCompressor } from './context-compressor';

export interface ContextWindowManagerOptions {
  maxContextTokens?: number;
  compactionThreshold?: number;
  summaryContentBudget?: number;
}

export interface CompactIfNeededOptions {
  sessionKey: string;
  reason?: string;
  signal?: AbortSignal;
  onStatus?: (event: ContextCompactionStatusEvent) => void | Promise<void>;
}

export type ContextCompactionStatus = 'start' | 'complete' | 'error';

export interface ContextCompactionStatusEvent {
  status: ContextCompactionStatus;
  sessionKey: string;
  reason?: string;
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  toolResultCount?: number;
  toolResultTokens?: number;
  toolResultChars?: number;
  messageCount?: number;
  error?: unknown;
}

/**
 * Owns pre-turn context-window checks for durable transcript only.
 *
 * Transient provider hints are preserved in memory but never summarized into
 * long-lived compacted history.
 */
export class ContextWindowManager {
  private compressor: ContextCompressor;

  constructor(aiService: AIService, options?: ContextWindowManagerOptions) {
    this.compressor = new ContextCompressor(aiService, options);
  }

  async compactIfNeeded(
    messages: Message[],
    options: CompactIfNeededOptions,
  ): Promise<Message[]> {
    const { durable, transient } = splitDurableAndTransient(messages);
    if (!this.compressor.needsCompaction(durable)) {
      return messages;
    }

    const usage = this.compressor.getUsageInfo(durable);
    const reason = options.reason ? `${options.reason} ` : '';
    Logger.info(
      `[${options.sessionKey}] ${reason}上下文即将压缩: `
      + `${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%), `
      + `tool_results=${usage.toolResultCount}/${usage.toolResultTokens} tokens`,
    );
    await this.emitStatus(options, {
      status: 'start',
      sessionKey: options.sessionKey,
      reason: options.reason,
      ...usage,
    });

    try {
      const compacted = await this.compressor.compact(durable, { signal: options.signal });
      const result = [...compacted, ...transient];
      Logger.info(`[${options.sessionKey}] 压缩完成，当前消息数: ${result.length}`);
      await this.emitStatus(options, {
        status: 'complete',
        sessionKey: options.sessionKey,
        reason: options.reason,
        messageCount: result.length,
        ...usage,
      });
      return result;
    } catch (err) {
      Logger.error(`[${options.sessionKey}] 压缩失败: ${err}`);
      await this.emitStatus(options, {
        status: 'error',
        sessionKey: options.sessionKey,
        reason: options.reason,
        error: err,
        ...usage,
      });
      return messages;
    }
  }

  getUsageInfo(messages: Message[]): ReturnType<ContextCompressor['getUsageInfo']> {
    const { durable } = splitDurableAndTransient(messages);
    return this.compressor.getUsageInfo(durable);
  }

  private async emitStatus(
    options: CompactIfNeededOptions,
    event: ContextCompactionStatusEvent,
  ): Promise<void> {
    if (!options.onStatus) return;
    try {
      await options.onStatus(event);
    } catch (err) {
      Logger.warning(`[${options.sessionKey}] 上下文压缩状态通知失败: ${err}`);
    }
  }
}

function splitDurableAndTransient(messages: Message[]): {
  durable: Message[];
  transient: Message[];
} {
  const durable: Message[] = [];
  const transient: Message[] = [];

  for (const message of messages) {
    if (isTransientMessage(message)) {
      transient.push(message);
    } else {
      durable.push(message);
    }
  }

  return { durable, transient };
}

function isTransientMessage(message: Message): boolean {
  if (message.__injected || message.__runtimeFeedback) return true;
  if (message.role !== 'system' || typeof message.content !== 'string') return false;
  return message.content.startsWith('[transient_');
}
