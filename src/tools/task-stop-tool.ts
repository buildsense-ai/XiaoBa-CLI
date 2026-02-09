import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { AgentManager } from '../agents/agent-manager';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';

/**
 * TaskStop Tool - 停止后台任务
 */
export class TaskStopTool implements Tool {
  private agentManager: AgentManager;

  constructor() {
    this.agentManager = AgentManager.getInstance();
  }

  definition: ToolDefinition = {
    name: 'task_stop',
    description: '停止正在运行的后台任务',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '要停止的任务ID（Agent ID），例如 agent-1'
        }
      },
      required: ['task_id']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { task_id } = args;

    try {
      const agent = this.agentManager.getAgent(task_id);

      if (!agent) {
        return `错误: 未找到任务 ${task_id}`;
      }

      if (agent.status !== 'running') {
        return `任务 ${task_id} 当前状态为 ${agent.status}，无需停止`;
      }

      await this.agentManager.stopAgent(task_id);

      console.log('\n' + styles.warning(`⏹️  已停止任务: ${task_id}\n`));

      return `任务 ${task_id} 已停止`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`TaskStop Tool 执行失败: ${errorMessage}`);
      return `错误: ${errorMessage}`;
    }
  }
}
