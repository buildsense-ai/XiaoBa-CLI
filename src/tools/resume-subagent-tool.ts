import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { Logger } from '../utils/logger';

/**
 * resume_subagent - 恢复挂起的子智能体
 *
 * 当子智能体状态为 waiting_for_input 时，主 agent 用此工具提供答案，让子智能体继续执行。
 */
export class ResumeSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'resume_subagent',
    description: '恢复当前会话下等待输入的子智能体。先确认 pendingQuestion，再把主 agent 或用户的答案传给它继续执行。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '要恢复的子智能体 ID 或展示名（如 sub-... 或 子agent1）',
        },
        answer: {
          type: 'string',
          description: '给子智能体的回答/指令',
        },
      },
      required: ['subagent_id', 'answer'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { subagent_id, answer } = args;
    const sessionKey = context.sessionId || 'unknown';

    if (!subagent_id || !answer) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：请提供 subagent_id 和 answer' };
    }

    const manager = SubAgentManager.getInstance();
    const result = manager.resumeForParent(sessionKey, subagent_id, answer);

    switch (result) {
      case 'resumed':
        {
          const info = manager.getInfoForParent(sessionKey, subagent_id);
          const label = info?.displayName ? `${info.displayName} (${info.id})` : subagent_id;
          Logger.info(`[ResumeSubagent] 已恢复 ${label}`);
          return { ok: true, content: `${label} 已恢复执行。` };
        }
      case 'not_waiting':
        {
          const info = manager.getInfoForParent(sessionKey, subagent_id);
          const label = info?.displayName ? `${info.displayName} (${info.id})` : subagent_id;
          return { ok: true, content: `${label} 当前未处于等待状态，无需恢复。` };
        }
      case 'forbidden':
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: `无权恢复子智能体 ${subagent_id}。它不属于当前会话。` };
      case 'not_found':
        return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `未找到子智能体 ${subagent_id}。` };
    }
  }
}
