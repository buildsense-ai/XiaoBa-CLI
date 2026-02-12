import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
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
    description: `停止一个正在后台运行的子智能体。

当用户要求取消或停止某个后台任务时使用。
如果不确定 ID，先用 check_subagent 查看列表。`,
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '要停止的子智能体 ID（如 sub-1）',
        },
      },
      required: ['subagent_id'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { subagent_id } = args;
    const sessionKey = context.sessionId || 'unknown';

    if (!subagent_id) {
      return '错误：请提供要停止的子智能体 ID';
    }

    const manager = SubAgentManager.getInstance();
    const result = manager.stopForParent(sessionKey, subagent_id);

    if (result === 'stopped') {
      Logger.info(`[StopSubagent] 已停止 ${subagent_id}`);
      return `子智能体 ${subagent_id} 已停止。`;
    }
    if (result === 'not_running') {
      const info = manager.getInfoForParent(sessionKey, subagent_id);
      return `子智能体 ${subagent_id} 当前状态为 ${info?.status || 'unknown'}，无法停止。`;
    }
    if (result === 'forbidden') {
      return `未找到子智能体 ${subagent_id}。`;
    }

    return `未找到子智能体 ${subagent_id}。`;
  }
}
