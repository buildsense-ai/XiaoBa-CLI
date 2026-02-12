import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';

/**
 * spawn_subagent - 派遣子智能体后台执行 skill
 *
 * 主 agent 像"甩活给小弟"一样使用这个工具：
 * 调用后立即返回，子智能体在后台独立运行，
 * 主会话不阻塞，可以继续和用户对话。
 */
export class SpawnSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'spawn_subagent',
    description: `派遣一个子智能体在后台独立执行某个 skill 任务。

调用后立即返回，不会阻塞当前对话。子智能体会独立运行，完成后通过飞书主动通知用户。

使用场景：
- 用户要求执行耗时较长的 skill（如论文精读、文献综述等）
- 你判断任务需要大量工具调用轮次（>10轮），不适合在当前对话中同步执行
- 用户可能还有其他事情要聊，你不想让他等

注意：
- 每个会话最多同时运行 3 个子任务
- 子智能体会自动使用对应 skill 的工具策略
- 你可以用 check_subagent 查看进度，用 stop_subagent 停止任务`,
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '要执行的 skill 名称（如 paper-analysis, literature-review 等）',
        },
        task_description: {
          type: 'string',
          description: '任务的简短描述，用于进度通知（如"精读 attention is all you need"）',
        },
        user_message: {
          type: 'string',
          description: '传递给子智能体的完整用户指令（包含文件路径等必要信息）',
        },
      },
      required: ['skill_name', 'task_description', 'user_message'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { skill_name, task_description, user_message } = args;

    if (!skill_name || !task_description || !user_message) {
      return '错误：skill_name、task_description、user_message 均为必填参数';
    }

    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';

    // 需要 AIService 和 SkillManager 实例
    // AIService 使用默认配置创建，SkillManager 动态加载
    const aiService = new AIService();
    const skillManager = new SkillManager();
    await skillManager.loadSkills();

    const result = manager.spawn(
      sessionKey,
      skill_name,
      task_description,
      user_message,
      context.workingDirectory,
      aiService,
      skillManager,
    );

    if ('error' in result) {
      return `派遣失败：${result.error}`;
    }

    console.log('\n' + styles.highlight(`🚀 派遣子智能体: ${task_description}`));
    console.log(styles.text(`   ID: ${result.id}`));
    console.log(styles.text(`   Skill: ${skill_name}\n`));

    return [
      `子智能体 ${result.id} 已派遣，正在后台执行「${task_description}」。`,
      `Skill: ${skill_name}`,
      `状态: running`,
      ``,
      `子智能体会独立运行并通过飞书通知用户进度和结果。`,
      `你可以用 check_subagent 查看进度，用 stop_subagent 停止任务。`,
    ].join('\n');
  }
}
