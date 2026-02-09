import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { AgentManager } from '../agents/agent-manager';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';

/**
 * TaskOutput Tool - 查看后台任务输出
 */
export class TaskOutputTool implements Tool {
  private agentManager: AgentManager;

  constructor() {
    this.agentManager = AgentManager.getInstance();
  }

  definition: ToolDefinition = {
    name: 'task_output',
    description: '获取后台运行的任务的输出结果',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务ID（Agent ID），例如 agent-1'
        },
        block: {
          type: 'boolean',
          description: '是否等待任务完成。true=等待完成，false=立即返回当前状态',
          default: true
        },
        timeout: {
          type: 'number',
          description: '最大等待时间（毫秒），默认30000ms',
          default: 30000
        }
      },
      required: ['task_id']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { task_id, block = true, timeout = 30000 } = args;

    try {
      const agent = this.agentManager.getAgent(task_id);

      if (!agent) {
        return `错误: 未找到任务 ${task_id}`;
      }

      if (block) {
        // 等待任务完成
        const startTime = Date.now();
        while (agent.status === 'running' && Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (agent.status === 'running') {
          return `任务 ${task_id} 仍在运行中（超时）\n当前输出:\n${agent.getOutput()}`;
        }
      }

      // 返回任务状态和输出
      const output = agent.getOutput();
      const status = agent.status;

      console.log('\n' + styles.title(`📊 任务输出: ${task_id}`));
      console.log(styles.text(`   状态: ${status}`));
      console.log(styles.text(`   输出长度: ${output.length} 字符\n`));

      return `任务 ${task_id} 状态: ${status}\n\n输出:\n${output}`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`TaskOutput Tool 执行失败: ${errorMessage}`);
      return `错误: ${errorMessage}`;
    }
  }
}
