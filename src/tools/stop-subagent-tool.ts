import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { Logger } from '../utils/logger';

/**
 * stop_subagent - 停止后台子智能体
 *
 * 当用户说"停止精读"、"取消那个任务"时使用。
 */
export class StopSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'stop_subagent',
    description: '停止当前会话下正在运行的后台子智能体。用户要求取消后台任务时使用；不确定 ID 时先用 check_subagent。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '要停止的子智能体 ID 或展示名（如 sub-... 或 子agent1）',
        },
      },
      required: ['subagent_id'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { subagent_id } = args;
    const sessionKey = context.sessionId || 'unknown';

    if (!subagent_id) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：请提供要停止的子智能体 ID' };
    }

    const manager = SubAgentManager.getInstance();
    const result = manager.stopForParent(sessionKey, subagent_id);

    if (result === 'stopped') {
      const info = manager.getInfoForParent(sessionKey, subagent_id);
      const label = info?.displayName ? `${info.displayName} (${info.id})` : subagent_id;
      Logger.info(`[StopSubagent] 已停止 ${label}`);
      return { ok: true, content: `${label} 已停止。` };
    }
    if (result === 'not_running') {
      const info = manager.getInfoForParent(sessionKey, subagent_id);
      const label = info?.displayName ? `${info.displayName} (${info.id})` : subagent_id;
      return { ok: true, content: `${label} 当前状态为 ${info?.status || 'unknown'}，无法停止。` };
    }
    if (result === 'forbidden') {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `无权停止子智能体 ${subagent_id}。它不属于当前会话。` };
    }

    return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `未找到子智能体 ${subagent_id}。` };
  }
}
