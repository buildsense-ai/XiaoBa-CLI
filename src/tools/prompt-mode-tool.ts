import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import {
  findFixedPromptModeState,
  getPromptModeDefinition,
  listPromptModeDefinitions,
  loadPromptModePrompt,
} from '../runtime/prompt-modes';
import { getPromptBaseDir } from '../utils/prompt-template';

export class PromptModeTool implements Tool {
  definition: ToolDefinition = {
    name: 'prompt_mode',
    description: [
      'Load the full instruction content for a registered prompt mode.',
      'Use this only when a runtime mode hint or the user request makes a mode clearly useful.',
      'Use mode "clear" only when the user explicitly asks to leave or disable the current async prompt mode.',
      'If the candidate mode is only weakly related, ignore the hint and do not call this tool.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Prompt mode id, for example coding-agent, office, classroom, or team-assistant. Use "clear" to clear the current async active mode.',
        },
      },
      required: ['mode'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const mode = typeof args?.mode === 'string' ? args.mode.trim() : '';
    if (!mode) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'mode is required',
      };
    }

    const promptsDir = getPromptBaseDir();
    const fixedMode = findFixedPromptModeState(context.conversationHistory || [], promptsDir);
    if (isPromptModeClearRequest(mode)) {
      if (fixedMode) {
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: `Cannot clear fixed prompt mode "${fixedMode.mode}" through prompt_mode. Change the runtime profile/fixed prompt mode instead.`,
        };
      }

      const activeMode = readActiveModeId(context.promptModeRuntime?.getActiveMode?.());
      context.promptModeRuntime?.clear('prompt_mode_tool_clear');
      return {
        ok: true,
        content: activeMode
          ? `Cleared active prompt mode "${activeMode}".`
          : 'No async active prompt mode was set.',
      };
    }

    const definition = getPromptModeDefinition(mode, promptsDir);
    if (!definition) {
      const available = listPromptModeDefinitions(promptsDir)
        .map(item => `${item.id} (${item.title})`)
        .join(', ');
      return {
        ok: false,
        errorCode: 'TOOL_NOT_FOUND',
        message: `Prompt mode "${mode}" not found. Available modes: ${available || 'none'}`,
      };
    }

    if (fixedMode && fixedMode.mode === definition.id) {
      return {
        ok: true,
        content: [
          `Fixed prompt mode "${fixedMode.mode}" is already active in the system prompt.`,
          'Do not reload it through prompt_mode; continue using the fixed system prompt instructions where they fit.',
        ].join('\n'),
      };
    }
    if (fixedMode) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: [
          `Cannot load prompt mode "${definition.id}" because fixed prompt mode "${fixedMode.mode}" is already active in the system prompt.`,
          'Change the runtime profile/fixed prompt mode instead of mixing prompt modes in one turn.',
        ].join('\n'),
      };
    }

    const content = loadPromptModePrompt(promptsDir, definition.id);
    if (!content) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Prompt mode "${definition.id}" is empty or unreadable`,
      };
    }

    return {
      ok: true,
      content: [
        `Prompt mode "${definition.id}" loaded. Apply it only where it fits the current real user request.`,
        'This mode may be shown as the previously active prompt mode in future turns; continue using it only if the task still matches.',
        content,
      ].join('\n\n'),
    };
  }
}

function isPromptModeClearRequest(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return normalized === 'clear' || normalized === 'none' || normalized === 'off';
}

function readActiveModeId(activeMode: unknown): string | undefined {
  if (!activeMode || typeof activeMode !== 'object') return undefined;
  const mode = (activeMode as { mode?: unknown }).mode;
  return typeof mode === 'string' && mode.trim() ? mode.trim() : undefined;
}
