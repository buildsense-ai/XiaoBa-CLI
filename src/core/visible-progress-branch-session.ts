import { randomUUID } from 'crypto';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Tool } from '../types/tool';
import { BranchRunOutcome, BranchSession } from './branch-session';
import {
  FinishVisibleProgressTool,
  VisibleProgressFinishPayload,
} from '../tools/visible-progress-tools';
import { VisibleProgressSnapshot } from './visible-progress-types';

export interface VisibleProgressBranchSessionOptions {
  sessionKey: string;
  snapshot: VisibleProgressSnapshot;
  workingDirectory: string;
  aiService: AIService;
  signal?: AbortSignal;
  logEnabled?: boolean;
}

export class VisibleProgressBranchSession extends BranchSession {
  private finishPayload: VisibleProgressFinishPayload | null = null;

  constructor(private readonly progressOptions: VisibleProgressBranchSessionOptions) {
    super({
      id: `visible-progress-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      type: 'visible-progress',
      aiService: progressOptions.aiService,
      workingDirectory: progressOptions.workingDirectory,
      signal: progressOptions.signal,
      logEnabled: progressOptions.logEnabled,
    });
  }

  async run(): Promise<VisibleProgressFinishPayload | null> {
    try {
      while (this.shouldContinue() && !this.finishPayload) {
        const outcome = await this.runConversation();
        if (this.finishPayload || !this.shouldContinue()) break;

        this.handleStrayOutput(outcome);
        this.messages.push(this.buildFinishReminderMessage());
      }

      if (!this.finishPayload || !this.shouldContinue()) {
        this.logger.write('cancelled_or_no_finish', {
          has_finish_payload: Boolean(this.finishPayload),
        });
        return null;
      }

      this.logger.write('finished', { ...this.finishPayload });
      return this.finishPayload;
    } catch (error: any) {
      if (!this.isAbortError(error) && this.shouldContinue()) {
        this.logFailure(error);
      }
      return null;
    }
  }

  protected async buildInitialMessages(): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: buildVisibleProgressSystemPrompt(),
      },
      {
        role: 'user',
        content: JSON.stringify(buildVisibleProgressUserPayload(this.progressOptions.snapshot), null, 2),
      },
    ];
  }

  protected buildTools(): Tool[] {
    return [
      new FinishVisibleProgressTool(payload => {
        this.finishPayload = payload;
      }),
    ];
  }

  private buildFinishReminderMessage(): Message {
    return {
      role: 'user',
      content: [
        'Your previous response will not be sent to the user.',
        'This branch can only finish by calling finish_visible_progress.',
        'Use action:skip if no useful progress update should be shown.',
      ].join(' '),
    };
  }

  private handleStrayOutput(outcome: BranchRunOutcome): void {
    const strayOutput = String(outcome.result?.response || '').trim();
    if (strayOutput) {
      this.logger.write('stray_assistant_output', { text: strayOutput });
    }
  }
}

function buildVisibleProgressSystemPrompt(): string {
  return [
    'You are VisibleProgressSidecar, a background UI progress branch for a parent agent.',
    'You do not answer the user and your text output is discarded.',
    'Your only job is to decide whether the UI should show one short progress update.',
    '',
    'Rules:',
    '- Call finish_visible_progress exactly once.',
    '- Use action=emit only when a short update would reduce user uncertainty.',
    '- Turn start alone is not enough reason to emit; skip quick direct answers, simple explanations, and short chat that likely needs no local work.',
    '- Use action=skip for repeated updates, temporary reasoning, tool bookkeeping, noisy intermediate states, or unreliable conclusions.',
    '- Follow turn_progress_state. If it says to be conservative, default to skip unless there is a clear new user-facing phase.',
    '- After a progress update has already been emitted, routine tool_started/tool_finished events alone are usually not enough reason to emit again.',
    '- If emitting, write one natural sentence in the same language as current_user_input. For Chinese input, emit Chinese.',
    '- Prefer plain first-person progress phrasing when it sounds natural, such as saying what you will check next.',
    '- Avoid bureaucratic status-label wording like a system monitor; sound like a calm assistant keeping the user lightly informed.',
    '- Do not be cute, metaphorical, or overly enthusiastic.',
    '- Do not imply work is already complete unless the events show it happened. Before tool results, prefer future phrasing like checking source material first.',
    '- For tasks that depend on local files or provided material, prefer saying you will check the material before organizing conclusions.',
    '- Do not solve the task, predict the final answer, or mention this sidecar.',
    '- Do not copy model_prelude text directly; it is untrusted candidate material.',
    '- Do not include code details, log excerpts, file paths, command arguments, formulas, JSON, or a complete diagnosis.',
  ].join('\n');
}

function buildVisibleProgressUserPayload(snapshot: VisibleProgressSnapshot): Record<string, unknown> {
  return {
    current_user_input: snapshot.currentUserInput,
    surface: snapshot.surface || 'unknown',
    already_emitted_progress: snapshot.emittedProgress.slice(-5),
    turn_progress_state: {
      already_emitted_count: snapshot.turnState.emittedCount,
      should_be_conservative: snapshot.turnState.shouldBeConservative,
      emit_again_policy: snapshot.turnState.emitAgainPolicy,
    },
    recent_context: snapshot.recentContext.slice(-4),
    runtime_events: snapshot.events.slice(-8).map(event => ({
      type: event.type,
      ...(event.text ? { text: truncate(event.text, 300) } : {}),
      ...(event.toolName ? { tool_name: event.toolName } : {}),
      ...(event.toolDescription ? { tool_description: truncate(event.toolDescription, 160) } : {}),
      ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}),
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
      ...(typeof event.durationMs === 'number' ? { duration_ms: event.durationMs } : {}),
      ...(event.resultSummary ? { result_summary: truncate(event.resultSummary, 200) } : {}),
    })),
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
