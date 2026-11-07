import type { ContentBlock, Message } from '../types';
import { outputBodyHash } from './output-body-proof';
import {
  SessionPromptTurnLog,
  SessionToolCallLog,
  SessionOutputLog,
  SessionTurnLogger,
} from '../utils/session-turn-logger';
import type { RunResult } from './conversation-runner';

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

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
        outputsOmittedCount: extracted.omittedCount,
        outputsOmissionReasons: extracted.reasons,
      },
    );
  }

  private extractOutputs(messages: Message[]): { outputs: SessionOutputLog[]; complete: boolean; omittedCount: number; reasons: string[] } {
    const outputs: SessionOutputLog[] = [];
    const reasons = new Set<string>();
    const seenOutputRefs = new Set<string>();
    let omittedCount = 0;
    let bodyBytes = 0;
    const maxOutputs = 128;
    const maxBodyBytes = 48 * 1024;
    const omit = (reason: string): void => { omittedCount++; reasons.add(reason); };
    let descriptorBytes = 0;
    let sawAssistant = false;
    let sawOutput = false;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      sawAssistant = true;
      const episodeId = message.__executionSourceEpisodeId || message.__episodeId;
      const modelCallId = message.__executionSourceModelCallId;
      const sourceSessionId = message.__executionSourceSessionId;
      if (!episodeId || !modelCallId || sourceSessionId !== this.logger.getSessionId()) {
        if (message.content || message.tool_calls?.length) omit(sourceSessionId && sourceSessionId !== this.logger.getSessionId() ? 'foreign_session_origin' : 'missing_origin');
        continue;
      }
      const add = (output: SessionOutputLog): void => {
        const bodyLength = Buffer.byteLength(output.body, 'utf8');
        const outputEncodedBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
        const outputKey = `${output.model_call_id}\u0000${output.ref}`;
        if (seenOutputRefs.has(outputKey)) { omit('duplicate_output_ref'); return; }
        if (!output.ref || Buffer.byteLength(output.ref) > 512 || Buffer.byteLength(output.subtype || '') > 256) { omit('output_identity_overbound'); return; }
        if (hasUnpairedSurrogate(output.body)) { omit('invalid_utf8_body'); return; }
        if (bodyLength > 16 * 1024 || bodyBytes + bodyLength > maxBodyBytes) { omit('body_byte_limit'); return; }
        if (outputs.length >= maxOutputs) { omit('output_count_limit'); return; }
        if (descriptorBytes + outputEncodedBytes > 56 * 1024) { omit('encoded_descriptor_limit'); return; }
        bodyBytes += bodyLength;
        descriptorBytes += outputEncodedBytes;
        seenOutputRefs.add(outputKey);
        outputs.push(output);
        sawOutput = true;
      };
      const toolCalls = message.tool_calls || [];
      const toolCallLimit = Math.min(toolCalls.length, maxOutputs);
      for (let toolIndex = 0; toolIndex < toolCallLimit; toolIndex++) {
        const toolCall = toolCalls[toolIndex];
        if (!toolCall.id || Buffer.byteLength(toolCall.id, 'utf8') > 512 || !toolCall.function?.name || Buffer.byteLength(toolCall.function.name, 'utf8') > 256) {
          omit('output_identity_overbound');
          continue;
        }
        if (typeof toolCall.function.arguments !== 'string') {
          omit('unsupported_tool_arguments');
          continue;
        }
        const body = toolCall.function.arguments;
        const ref = `provider-call:${toolCall.id}`;
        add({
          kind: 'tool_call', source_session_id: sourceSessionId, ref, subtype: toolCall.function.name,
          episode_id: episodeId, model_call_id: modelCallId, output_position: toolIndex,
          body_path: `assistant.outputs[${outputs.length}].body`, body,
          body_sha256: outputBodyHash('tool_call', toolCall.id, toolCall.function.name, body),
          body_complete: true, body_truncated: false,
        });
      }
      if (toolCalls.length > toolCallLimit) omit('output_count_limit');
      const content = typeof message.content === 'string' ? message.content : '';
      if (content) {
        add({
          kind: 'message', source_session_id: sourceSessionId, ref: message.__executionNodeRef || '', subtype: 'assistant_text',
          episode_id: episodeId, model_call_id: modelCallId, output_position: toolCalls.length,
          body_path: `assistant.outputs[${outputs.length}].body`, body: content,
          body_sha256: outputBodyHash('message', '', '', content),
          body_complete: true, body_truncated: false,
        });
      }
      if (message.content && typeof message.content !== 'string') omit('unsupported_multiblock_content');
    }
    if (!sawAssistant) omit('no_assistant_output');
    else if (!sawOutput) omit('no_proven_output');
    const complete = omittedCount === 0;
    return { outputs, complete, omittedCount, reasons: [...reasons].sort() };
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
