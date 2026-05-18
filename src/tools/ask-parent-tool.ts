import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';

/**
 * ask_parent - 子智能体专用协作工具
 *
 * 子智能体信息不足、需要主 agent 或用户做判断时使用。普通主会话不会注册该工具。
 */
export class AskParentTool implements Tool {
  definition: ToolDefinition = {
    name: 'ask_parent',
    description: '子智能体专用：向主 agent 提问并挂起等待 resume_subagent。先自行调查，只有确实需要补充信息或决策时使用。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '需要主 agent 或用户补充的信息/决策问题，说明你为什么需要它。',
        },
      },
      required: ['question'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const question = String(args?.question || '').trim();
    if (!question) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：question 不能为空' };
    }
    if (!context.requestParentInput) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'ask_parent 只能在子智能体 runtime 中使用。',
      };
    }

    const answer = await context.requestParentInput(question);
    return { ok: true, content: `主 agent 回复：\n${answer}` };
  }
}
