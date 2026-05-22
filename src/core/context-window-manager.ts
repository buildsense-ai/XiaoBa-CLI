import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { ContextCompressor } from './context-compressor';

export interface ContextWindowManagerOptions {
  maxContextTokens?: number;
  compactionThreshold?: number;
}

export interface CompactIfNeededOptions {
  sessionKey: string;
  reason?: string;
  signal?: AbortSignal;
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
    Logger.info(`[${options.sessionKey}] ${reason}上下文即将压缩: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);

    try {
      const compacted = await this.compressor.compact(durable, { signal: options.signal });
      const result = [...compacted, ...transient];
      Logger.info(`[${options.sessionKey}] 压缩完成，当前消息数: ${result.length}`);
      return result;
    } catch (err) {
      Logger.error(`[${options.sessionKey}] 压缩失败: ${err}`);
      return messages;
    }
  }

  getUsageInfo(messages: Message[]): ReturnType<ContextCompressor['getUsageInfo']> {
    const { durable } = splitDurableAndTransient(messages);
    return this.compressor.getUsageInfo(durable);
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
  if (message.__transient || message.__injected || message.__runtimeFeedback) return true;
  if (message.role !== 'system' || typeof message.content !== 'string') return false;
  return message.content.startsWith('[transient_');
}
