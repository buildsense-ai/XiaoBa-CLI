import type { ContentBlock, Message } from '../types';
import { createHash } from 'node:crypto';
import {
  SessionPromptTurnLog,
  SessionToolCallLog,
  SessionOutputLog,
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
}

/**
 * Converts a completed turn into the stable session JSONL schema.
 */
export class TurnLogRecorder {
  private prompt?: SessionPromptTurnLog;

  constructor(private readonly logger: SessionTurnLogger) {}

  setPromptMetadata(prompt: SessionPromptTurnLog | undefined): void {
    this.prompt = prompt;
  }

  recordTurn(params: RecordTurnParams): void {
    const extracted = this.extractOutputs(params.result.newMessages);
    this.logger.logTurn(
      params.userInput,
      params.result.response || '',
      this.extractToolCalls(params.result.newMessages),
      params.tokens,
      {
        runtimeFeedback: params.runtimeFeedback,
        runtimeObservationSource: params.runtimeObservationSource,
        prompt: this.prompt,
        outputs: extracted.outputs,
        outputsContract: 'session-output/1',
        outputsComplete: extracted.complete,
      },
    );
  }

  private extractOutputs(messages: Message[]): { outputs: SessionOutputLog[]; complete: boolean } {
    const outputs: SessionOutputLog[] = [];
    let totalBytes = 0;
    let complete = true;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const episodeId = message.__executionSourceEpisodeId || message.__episodeId;
      const modelCallId = message.__executionSourceModelCallId;
      if (!episodeId || !modelCallId) continue;
      const add = (output: SessionOutputLog): void => {
        const bytes = Buffer.byteLength(output.body, 'utf8');
        if (!output.ref || bytes > 64 * 1024 || totalBytes + bytes > 256 * 1024) {
          complete = false;
          return;
        }
        totalBytes += bytes;
        outputs.push(output);
      };
      let outputPosition = 0;
      for (const toolCall of message.tool_calls || []) {
        const body = toolCall.function.arguments || '';
        add({
          kind: 'tool_call', ref: `provider-call:${toolCall.id}`, subtype: toolCall.function.name,
          episode_id: episodeId, model_call_id: modelCallId, output_position: outputPosition++,
          body_path: `assistant.outputs[${outputs.length}].body`, body,
          body_sha256: this.outputBodyHash('tool_call', toolCall.id, toolCall.function.name, body),
          body_complete: true, body_truncated: false,
        });
      }
      const content = typeof message.content === 'string' ? message.content : '';
      if (content) {
        add({
          kind: 'message', ref: message.__executionNodeRef || '', subtype: 'assistant_text',
          episode_id: episodeId, model_call_id: modelCallId, output_position: outputPosition,
          body_path: `assistant.outputs[${outputs.length}].body`, body: content,
          body_sha256: this.outputBodyHash('message', '', '', content),
          body_complete: true, body_truncated: false,
        });
      }
      if (message.content && typeof message.content !== 'string') complete = false;
    }
    return { outputs, complete };
  }

  private outputBodyHash(kind: 'message' | 'tool_call', ref: string, name: string, body: string): string {
    if (kind === 'message') return createHash('sha256').update(body, 'utf8').digest('hex');
    const hash = createHash('sha256');
    for (const field of [ref, name, body]) {
      const bytes = Buffer.from(field, 'utf8');
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.length);
      hash.update(length).update(bytes);
    }
    return hash.digest('hex');
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
