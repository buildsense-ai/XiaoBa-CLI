import { randomUUID } from 'crypto';
import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Tool } from '../types/tool';
import {
  FinishMemorySearchTool,
  MemoryNeighborsTool,
  MemoryReadTurnTool,
  MemorySearchFinishPayload,
  MemorySearchTool,
} from '../tools/memory-branch-tools';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';
import { BranchSession } from './branch-session';
import { MemoryLogStore } from './memory-log-store';

export interface MemorySearchBranchSessionOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
  logEnabled?: boolean;
}

export class MemorySearchBranchSession extends BranchSession {
  private readonly store: MemoryLogStore;
  private finishPayload: MemorySearchFinishPayload | null = null;

  constructor(private readonly memoryOptions: MemorySearchBranchSessionOptions) {
    super({
      id: `memory-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      type: 'memory',
      aiService: memoryOptions.aiService,
      workingDirectory: memoryOptions.workingDirectory,
      signal: memoryOptions.signal,
      logEnabled: memoryOptions.logEnabled,
    });
    this.store = new MemoryLogStore(memoryOptions.workingDirectory);
  }

  async run(): Promise<void> {
    try {
      while (this.shouldContinue() && !this.finishPayload) {
        const outcome = await this.runConversation();
        if (this.finishPayload || !this.shouldContinue()) break;

        const strayOutput = String(outcome.result?.response || '').trim();
        if (strayOutput) {
          this.logger.write('stray_assistant_output', { text: strayOutput });
        }
        this.messages.push({
          role: 'user',
          content: [
            'Your previous response was not delivered to the main agent.',
            'This branch can only finish by calling finish_memory_search.',
            'Call finish_memory_search now with the best available summary and refs.',
          ].join(' '),
        });
      }

      if (!this.finishPayload) {
        if (!this.shouldContinue()) {
          this.logger.write('cancelled_before_finish', {
            message_count: this.messages.length,
          });
        }
        return;
      }
      if (!this.shouldContinue()) {
        this.logger.write('finished_after_cancel', {
          refs: this.finishPayload.refs,
          summary: this.finishPayload.summary,
        });
        return;
      }
      const observation = this.buildObservation(this.finishPayload);
      const pushed = this.memoryOptions.queue.push(observation);
      if (pushed) {
        this.logger.write('published_observation', {
          observation_id: observation.id,
          refs: this.finishPayload.refs,
          summary: this.finishPayload.summary,
          tool_result_content: observation.formattedContent,
        });
      } else {
        this.logger.write('discarded_observation', {
          observation_id: observation.id,
          reason: 'queue_closed_or_duplicate',
          refs: this.finishPayload.refs,
          summary: this.finishPayload.summary,
          tool_result_content: observation.formattedContent,
        });
      }
    } catch (error: any) {
      if (this.isAbortError(error) || !this.shouldContinue()) {
        this.logger.write('cancelled_before_finish', {
          message_count: this.messages.length,
          has_finish_payload: Boolean(this.finishPayload),
        });
      } else {
        this.logFailure(error);
      }
    }
  }

  protected async buildInitialMessages(): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: buildMemorySearchSystemPrompt(),
      },
      {
        role: 'user',
        content: buildMemorySearchUserInput({
          input: this.memoryOptions.input,
          recentMessages: this.memoryOptions.recentMessages,
          hasMemoryRoots: this.store.hasRoots(),
        }),
      },
    ];
  }

  protected buildTools(): Tool[] {
    return [
      new MemorySearchTool(this.store),
      new MemoryReadTurnTool(this.store),
      new MemoryNeighborsTool(this.store),
      new FinishMemorySearchTool(payload => {
        this.finishPayload = payload;
      }),
    ];
  }

  private buildObservation(payload: MemorySearchFinishPayload): SyntheticObservation {
    return {
      id: `memory-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      source: 'memory',
      status: 'completed',
      relevance: payload.refs.length > 0 ? 'medium' : 'low',
      summary: payload.summary,
      metadata: {
        branchId: this.options.id,
        branchType: this.options.type,
        refs: payload.refs,
      },
      formattedContent: JSON.stringify({
        source: 'memory',
        summary: payload.summary,
        refs: payload.refs,
      }),
    };
  }
}

function buildMemorySearchSystemPrompt(): string {
  return [
    'You are MemorySearchBranchSession, a background memory retrieval branch.',
    'You do not answer the user directly. Your only job is to help the main agent with relevant prior session memory.',
    '',
    'Workflow:',
    '1. Read the current user input and the compact recent context.',
    '2. Extract specific keywords and fixed technical terms. Avoid generic words and avoid long phrase queries unless the phrase is a fixed name.',
    '3. Search from recent to older ranges. Choose start_time and end_time yourself when useful.',
    '4. Use memory_search for broad recall. It returns JSON refs only. Use memory_read_turn or memory_neighbors to inspect promising refs.',
    '5. Analyze the retrieved turns for what helps the current task. Do not merely copy raw snippets.',
    '6. End only by calling finish_memory_search with a concise summary and canonical refs. If nothing useful exists, call finish_memory_search with an empty refs array.',
    '',
    'Tool result convention: memory tools return compact JSON strings. Parse them and continue.',
    'Canonical refs are editable: if you see ...#42, you may read ...#41 or ...#43 to inspect adjacent episodes.',
    'Current time: ' + new Date().toISOString(),
  ].join('\n');
}

function buildMemorySearchUserInput(options: {
  input: string | ContentBlock[];
  recentMessages: Message[];
  hasMemoryRoots: boolean;
}): string {
  const recentTurns = extractRecentCompletedTurns(options.recentMessages).slice(-2);
  const payload = {
    current_user_input: contentToText(options.input),
    recent_completed_turns: recentTurns,
    memory_source_available: options.hasMemoryRoots,
  };
  return JSON.stringify(payload, null, 2);
}

interface RecentCompletedTurn {
  user: string;
  assistant_final: string;
}

function extractRecentCompletedTurns(messages: Message[]): RecentCompletedTurn[] {
  const turns: RecentCompletedTurn[] = [];
  let current: RecentCompletedTurn | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      if (current && current.assistant_final.trim()) {
        turns.push(current);
      }
      current = {
        user: contentToText(message.content),
        assistant_final: '',
      };
      continue;
    }

    if (
      current
      && message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.trim()
      && (!message.tool_calls || message.tool_calls.length === 0)
    ) {
      current.assistant_final = message.content;
    }
  }

  if (current && current.assistant_final.trim()) {
    turns.push(current);
  }
  return turns;
}

function contentToText(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[image]').join('\n');
}
