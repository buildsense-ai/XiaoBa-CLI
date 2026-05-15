import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';

function normalizeText(value: unknown, maxLength = 700): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => normalizeText(item, 180))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Runtime-only decision log.
 *
 * This is intentionally not a user-facing message and uses transcriptMode=suppress
 * so the note does not bloat durable conversation context.
 */
export class RecordDecisionTool implements Tool {
  definition: ToolDefinition = {
    name: 'record_decision',
    description: [
      '把当前简短行动决策写入日志，不发送给用户，成功结果不进入后续 transcript。',
      '只在复杂任务关键转折点使用；简单任务不要用。写工程摘要，不写隐藏推理链。',
    ].join('\n'),
    transcriptMode: 'suppress',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '一句话概括当前决策，例如“这轮先用 plan 展示路线，并把设置页和子 agent 链路拆出去并行检查”。',
        },
        reason: {
          type: 'string',
          description: '简短说明为什么这样做；不需要展开完整推理。',
        },
        plan_decision: {
          type: 'string',
          enum: ['use_plan', 'skip_plan', 'update_later', 'not_applicable'],
          description: '本轮对 update_plan 的判断。',
        },
        subagent_decision: {
          type: 'string',
          enum: ['spawn_now', 'skip_subagent', 'maybe_later', 'not_applicable'],
          description: '本轮对子 agent 的判断。',
        },
        task_split: {
          type: 'array',
          items: { type: 'string' },
          description: '如果有任务拆分，列出主线和子任务分工；没有拆分时可省略。',
        },
        next_action: {
          type: 'string',
          description: '下一步准备做什么。',
        },
      },
      required: ['summary'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const summary = normalizeText(args?.summary);
    if (!summary) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'summary 不能为空',
      };
    }

    const parts = [`summary=${summary}`];
    const reason = normalizeText(args?.reason);
    if (reason) parts.push(`reason=${reason}`);

    const planDecision = normalizeText(args?.plan_decision, 80);
    if (planDecision) parts.push(`plan=${planDecision}`);

    const subagentDecision = normalizeText(args?.subagent_decision, 80);
    if (subagentDecision) parts.push(`subagent=${subagentDecision}`);

    const taskSplit = normalizeList(args?.task_split);
    if (taskSplit.length > 0) {
      parts.push(`split=${taskSplit.map((item, index) => `${index + 1}. ${item}`).join(' | ')}`);
    }

    const nextAction = normalizeText(args?.next_action);
    if (nextAction) parts.push(`next=${nextAction}`);

    Logger.info(`[decision] ${parts.join(' ; ')}`);
    return { ok: true, content: '决策说明已记录到日志' };
  }
}
