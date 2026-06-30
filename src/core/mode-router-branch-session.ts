import { randomUUID } from 'crypto';
import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Tool } from '../types/tool';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';
import { ObservationBranchDisposition, ObservationBranchSession } from './observation-branch-session';
import {
  FinishPromptModeRoutingTool,
  PromptModeRouterFinishPayload,
} from '../tools/prompt-mode-router-tools';
import {
  PromptModeRuntimeState,
  buildPromptModeRouterObservation,
} from './prompt-mode-runtime';
import {
  PromptModeDefinition,
  getPromptModeDefinition,
  listPromptModeDefinitions,
} from '../runtime/prompt-modes';
import { getPromptBaseDir } from '../utils/prompt-template';

export interface ModeRouterBranchSessionOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  activeMode?: PromptModeRuntimeState | null;
  signal?: AbortSignal;
  logEnabled?: boolean;
  promptsDir?: string;
  modelTimeoutMs?: number;
}

export class ModeRouterBranchSession extends ObservationBranchSession<PromptModeRouterFinishPayload> {
  private readonly promptsDir: string;

  constructor(private readonly modeOptions: ModeRouterBranchSessionOptions) {
    super({
      id: `prompt-mode-router-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      type: 'prompt-mode-router',
      aiService: modeOptions.aiService,
      workingDirectory: modeOptions.workingDirectory,
      queue: modeOptions.queue,
      signal: modeOptions.signal,
      logEnabled: modeOptions.logEnabled,
      modelTimeoutMs: modeOptions.modelTimeoutMs,
    });
    this.promptsDir = modeOptions.promptsDir ?? getPromptBaseDir();
  }

  protected async buildInitialMessages(): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: buildModeRouterSystemPrompt(),
      },
      {
        role: 'user',
        content: buildModeRouterUserInput({
          input: this.modeOptions.input,
          recentMessages: this.modeOptions.recentMessages,
          activeMode: this.modeOptions.activeMode,
          modes: listPromptModeDefinitions(this.promptsDir),
        }),
      },
    ];
  }

  protected buildTools(): Tool[] {
    return [
      new FinishPromptModeRoutingTool(payload => {
        this.complete(payload);
      }),
    ];
  }

  protected buildFinishReminderMessage(): Message {
    return {
      role: 'user',
      content: [
        'Your previous response will not be sent to the parent agent.',
        'This branch can only finish by calling finish_prompt_mode_routing.',
        'Use action:ignore if there is no clear mode decision.',
      ].join(' '),
    };
  }

  protected getObservationDisposition(payload: PromptModeRouterFinishPayload): ObservationBranchDisposition {
    return {
      inject: true,
      logPayload: {
        action: payload.action,
        mode: payload.mode,
        confidence: payload.confidence,
        reason: payload.reason,
      },
    };
  }

  protected buildObservation(payload: PromptModeRouterFinishPayload): SyntheticObservation {
    const definition = payload.action === 'activate'
      ? getPromptModeDefinition(payload.mode, this.promptsDir)
      : undefined;
    return buildPromptModeRouterObservation(payload, definition);
  }
}

function buildModeRouterSystemPrompt(): string {
  return [
    'You are PromptModeRouterBranchSession, a background routing branch for a parent agent.',
    'You do not answer the user and your text output is discarded.',
    'Your only job is to decide whether the runtime should activate, clear, or ignore a prompt mode for the parent agent.',
    '',
    'Decision rules:',
    '- action=activate when the current user request clearly benefits from one available mode.',
    '- action=clear when an active mode exists and the current user request clearly changes away from that mode.',
    '- action=ignore when there is no clear decision, confidence is low, or the active mode can safely remain unchanged.',
    '- Prefer ignore over weak guesses.',
    '- Do not infer hidden file contents or facts; route only from the user request and recent context summary.',
    '- Call finish_prompt_mode_routing exactly once.',
  ].join('\n');
}

function buildModeRouterUserInput(options: {
  input: string | ContentBlock[];
  recentMessages: Message[];
  activeMode?: PromptModeRuntimeState | null;
  modes: PromptModeDefinition[];
}): string {
  const payload = {
    current_user_input: contentToText(options.input),
    current_active_mode: options.activeMode
      ? {
        id: options.activeMode.mode,
        title: options.activeMode.title,
        confidence: options.activeMode.confidence,
        reason: options.activeMode.reason,
      }
      : null,
    available_modes: options.modes.map(mode => ({
      id: mode.id,
      title: mode.title,
      description: mode.description,
    })),
    recent_context: extractRecentContext(options.recentMessages),
  };
  return JSON.stringify(payload, null, 2);
}

function extractRecentContext(messages: Message[]): Array<{ role: string; content: string }> {
  return messages
    .filter(message => (
      (message.role === 'user' || message.role === 'assistant')
      && !message.__injected
      && !message.__runtimeFeedback
      && !message.__syntheticObservation
    ))
    .slice(-6)
    .map(message => ({
      role: message.role,
      content: truncate(contentToText(message.content), 800),
    }))
    .filter(item => item.content.length > 0);
}

function contentToText(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[image]').join('\n');
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
