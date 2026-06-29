import { Tool, ToolDefinition, ToolExecutionResult } from '../types/tool';

export type PromptModeRouterAction = 'activate' | 'clear' | 'ignore';

export interface PromptModeRouterFinishPayload {
  action: PromptModeRouterAction;
  mode?: string;
  confidence: number;
  reason: string;
  sourceTiming?: 'current_turn' | 'late_previous_turn';
  originTurn?: number;
}

export type PromptModeRouterFinishHandler = (payload: PromptModeRouterFinishPayload) => void;

const ROUTER_ACTIONS = new Set<PromptModeRouterAction>(['activate', 'clear', 'ignore']);

export class FinishPromptModeRoutingTool implements Tool {
  definition: ToolDefinition = {
    name: 'finish_prompt_mode_routing',
    description: [
      'Finish prompt mode routing for the parent agent.',
      'This branch does not answer the user. It only decides whether the parent runtime should activate, clear, or ignore a prompt mode.',
      'Call this exactly once with the best available decision.',
    ].join(' '),
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'clear', 'ignore'],
          description: 'activate a mode, clear the current mode, or ignore without changing mode state.',
        },
        mode: {
          type: 'string',
          description: 'Prompt mode id when action is activate. Leave empty for clear or ignore.',
        },
        confidence: {
          type: 'number',
          description: 'Confidence from 0 to 1.',
        },
        reason: {
          type: 'string',
          description: 'Short reason for logs and diagnostics.',
        },
      },
      required: ['action', 'confidence', 'reason'],
    },
  };

  constructor(private readonly onFinish: PromptModeRouterFinishHandler) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validatePromptModeRouterFinishArgs(args);
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: validation.error,
        retryable: false,
      };
    }

    this.onFinish(validation.payload);
    return {
      ok: true,
      content: JSON.stringify({ ok: true }),
    };
  }
}

export function validatePromptModeRouterFinishArgs(args: any):
  | { ok: true; payload: PromptModeRouterFinishPayload }
  | { ok: false; error: string } {
  const rawAction = String(args?.action || '').trim();
  if (!ROUTER_ACTIONS.has(rawAction as PromptModeRouterAction)) {
    return { ok: false, error: 'action must be activate, clear, or ignore' };
  }
  const action = rawAction as PromptModeRouterAction;

  const confidence = Number(args?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: 'confidence must be a number from 0 to 1' };
  }

  const reason = String(args?.reason || '').replace(/\s+/g, ' ').trim();
  if (!reason) {
    return { ok: false, error: 'reason must be a non-empty string' };
  }

  const mode = String(args?.mode || '').trim();
  if (action === 'activate' && !mode) {
    return { ok: false, error: 'mode is required when action is activate' };
  }

  return {
    ok: true,
    payload: {
      action,
      ...(mode ? { mode } : {}),
      confidence,
      reason,
    },
  };
}
