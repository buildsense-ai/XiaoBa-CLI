import type { ContentBlock, Message } from '../types';
import type { SessionIdentitySnapshot } from '../types/session-identity';
import {
  SessionToolCallLog,
  SessionTurnLogger,
} from '../utils/session-turn-logger';
import type { RunResult } from './conversation-runner';

export interface RecordTurnParams {
  userInput: string | ContentBlock[];
  result: RunResult;
  tokens: {
    prompt: number;
    completion: number;
  };
  runtimeFeedback?: string[];
  runtimeObservationSource?: string;
  sessionIdentity?: SessionIdentitySnapshot;
}

/**
 * Converts a completed turn into the stable session JSONL schema.
 */
export class TurnLogRecorder {
  constructor(private readonly logger: SessionTurnLogger) {}

  recordTurn(params: RecordTurnParams): void {
    const durableNewMessages = params.result.newMessages.filter(message => !message.__transient);
    this.logger.logTurn(
      params.userInput,
      params.result.response || '',
      this.extractToolCalls(durableNewMessages),
      params.tokens,
      {
        runtimeFeedback: params.runtimeFeedback,
        runtimeObservationSource: params.runtimeObservationSource,
        sessionIdentity: params.sessionIdentity,
      },
    );
  }

  private extractToolCalls(messages: Message[]): SessionToolCallLog[] {
    return messages
      .filter(message => message.role === 'assistant' && message.tool_calls)
      .flatMap(message => message.tool_calls || [])
      .map(toolCall => {
        const resultMsg = messages.find(message =>
          message.role === 'tool' && message.tool_call_id === toolCall.id
        );

        return {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          result: this.contentToString(resultMsg?.content || ''),
        };
      });
  }

  private contentToString(content: Message['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map(block => block.type === 'text' ? block.text : '[非文本内容]')
      .join('');
  }
}
