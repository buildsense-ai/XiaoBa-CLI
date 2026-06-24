import { Tool, ToolDefinition, ToolExecutionResult } from '../types/tool';

export type VisibleProgressAction = 'emit' | 'skip';

export interface VisibleProgressFinishPayload {
  action: VisibleProgressAction;
  text?: string;
  reason: string;
}

export type VisibleProgressFinishHandler = (payload: VisibleProgressFinishPayload) => void;

const VISIBLE_PROGRESS_ACTIONS = new Set<VisibleProgressAction>(['emit', 'skip']);

export class FinishVisibleProgressTool implements Tool {
  definition: ToolDefinition = {
    name: 'finish_visible_progress',
    description: [
      'Finish visible progress routing for the parent agent.',
      'This branch does not answer the user. It only decides whether a short user-visible progress update should be emitted.',
      'Call this exactly once with action emit or skip.',
    ].join(' '),
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['emit', 'skip'],
          description: 'emit a short progress update, or skip without showing anything.',
        },
        text: {
          type: 'string',
          description: 'Short user-visible progress text when action is emit. Leave empty for skip.',
        },
        reason: {
          type: 'string',
          description: 'Short reason for logs and diagnostics.',
        },
      },
      required: ['action', 'reason'],
    },
  };

  constructor(private readonly onFinish: VisibleProgressFinishHandler) {}

  async execute(args: any): Promise<ToolExecutionResult> {
    const validation = validateVisibleProgressFinishArgs(args);
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

export function validateVisibleProgressFinishArgs(args: any):
  | { ok: true; payload: VisibleProgressFinishPayload }
  | { ok: false; error: string } {
  const rawAction = String(args?.action || '').trim();
  if (!VISIBLE_PROGRESS_ACTIONS.has(rawAction as VisibleProgressAction)) {
    return { ok: false, error: 'action must be emit or skip' };
  }
  const action = rawAction as VisibleProgressAction;

  const reason = normalizeText(args?.reason);
  if (!reason) {
    return { ok: false, error: 'reason must be a non-empty string' };
  }

  const text = normalizeText(args?.text);
  if (action === 'emit' && !text) {
    return { ok: false, error: 'text is required when action is emit' };
  }

  return {
    ok: true,
    payload: {
      action,
      ...(text ? { text } : {}),
      reason,
    },
  };
}

function normalizeText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
