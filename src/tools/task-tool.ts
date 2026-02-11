import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { AgentManager } from '../agents/agent-manager';
import { AgentConfig, AgentType } from '../types/agent';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';
import { ToolManager } from './tool-manager';

/**
 * Task Tool - 智能体生成和管理工具
 * 允许主 Agent 创建和管理子 Agent
 */
export class TaskTool implements Tool {
  private agentManager: AgentManager;

  /** 当前嵌套深度（静态，所有 TaskTool 实例共享） */
  private static currentDepth = 0;
  /** 最大允许嵌套深度 */
  private static readonly MAX_DEPTH = 3;

  constructor() {
    this.agentManager = AgentManager.getInstance();
  }

  definition: ToolDefinition = {
    name: 'task',
    description: `启动专门的子智能体来处理复杂的多步骤任务。

可用的智能体类型：
- explore: 快速代码库探索智能体，用于搜索文件、理解代码结构
- plan: 规划制定智能体，用于设计实现方案
- bash: 命令执行专家智能体，用于执行 git、npm、docker 等命令
- general-purpose: 通用智能体，用于复杂的多步骤任务
- code-reviewer: 代码审查智能体，用于审查代码质量

使用场景：
- 当需要深入探索代码库时，使用 explore 智能体
- 当需要制定实现计划时，使用 plan 智能体
- 当需要执行复杂命令序列时，使用 bash 智能体
- 当需要审查代码时，使用 code-reviewer 智能体`,
    parameters: {
      type: 'object',
      properties: {
        subagent_type: {
          type: 'string',
          enum: ['explore', 'plan', 'bash', 'general-purpose', 'code-reviewer'],
          description: '子智能体类型'
        },
        description: {
          type: 'string',
          description: '任务的简短描述（3-5个词）'
        },
        prompt: {
          type: 'string',
          description: '详细的任务提示，描述子智能体需要完成的具体工作'
        },
        model: {
          type: 'string',
          enum: ['sonnet', 'opus', 'haiku'],
          description: '可选的模型选择。haiku 适合快速简单的任务，sonnet 适合复杂任务'
        },
        max_turns: {
          type: 'number',
          description: '最大执行轮数，用于控制执行时间'
        },
        run_in_background: {
          type: 'boolean',
          description: '是否在后台运行。后台运行的任务不会阻塞主流程'
        }
      },
      required: ['subagent_type', 'description', 'prompt']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const {
      subagent_type,
      description,
      prompt,
      model = 'sonnet',
      max_turns,
      run_in_background = false
    } = args;

    // 递归深度检查
    if (TaskTool.currentDepth >= TaskTool.MAX_DEPTH) {
      Logger.warning(`子智能体嵌套深度已达上限 (${TaskTool.MAX_DEPTH})，拒绝创建新的子智能体`);
      return `错误：子智能体嵌套深度已达上限 (${TaskTool.MAX_DEPTH})。请直接完成任务，不要再创建子智能体。`;
    }

    try {
      TaskTool.currentDepth++;

      // 创建 Agent 配置
      const config: AgentConfig = {
        type: subagent_type as AgentType,
        description,
        prompt,
        model,
        maxTurns: max_turns,
        runInBackground: run_in_background
      };

      // 创建 Agent
      const agentId = await this.agentManager.createAgent(config);

      console.log('\n' + styles.highlight(`🤖 启动子智能体: ${description}`));
      console.log(styles.text(`   类型: ${subagent_type}`));
      console.log(styles.text(`   模型: ${model}`));
      console.log(styles.text(`   ID: ${agentId}\n`));

      if (run_in_background) {
        // 后台执行
        this.executeInBackground(agentId, context);
        return `子智能体 ${agentId} 已在后台启动。使用 task_output 工具查看输出。`;
      } else {
        // 前台执行
        // 创建 ToolManager 并获取所有工具
        const toolManager = new ToolManager(context.workingDirectory, {
          sessionId: context.sessionId ? `${context.sessionId}:${agentId}` : agentId,
          surface: 'agent',
          permissionProfile: 'strict',
          runId: context.runId,
        });
        const tools = toolManager.getAllTools();

        const result = await this.agentManager.executeAgent(agentId, {
          workingDirectory: context.workingDirectory,
          conversationHistory: context.conversationHistory,
          tools: tools  // ✅ 传递真实的工具列表
        });

        console.log(styles.success(`✅ 子智能体完成: ${description}\n`));

        return result.output;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`Task Tool 执行失败: ${errorMessage}`);
      return `错误: ${errorMessage}`;
    } finally {
      TaskTool.currentDepth--;
    }
  }

  /**
   * 在后台执行 Agent
   */
  private async executeInBackground(agentId: string, context: ToolExecutionContext): Promise<void> {
    try {
      // 创建 ToolManager 并获取所有工具
      const toolManager = new ToolManager(context.workingDirectory, {
        sessionId: context.sessionId ? `${context.sessionId}:${agentId}` : agentId,
        surface: 'agent',
        permissionProfile: 'strict',
        runId: context.runId,
      });
      const tools = toolManager.getAllTools();

      const result = await this.agentManager.executeAgent(agentId, {
        workingDirectory: context.workingDirectory,
        conversationHistory: context.conversationHistory,
        tools: tools  // ✅ 传递真实的工具列表
      });

      console.log(styles.success(`\n✅ 后台任务完成: ${agentId}\n`));
    } catch (error) {
      Logger.error(`后台任务 ${agentId} 执行失败: ${error}`);
    }
  }
}
