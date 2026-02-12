import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';

/**
 * check_subagent - 查看子智能体状态
 *
 * 主 agent 用这个工具查看后台子任务的进度，
 * 然后用自然语言告诉用户。
 */
export class CheckSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'check_subagent',
    description: `查看当前会话下后台子智能体的运行状态和进度。

可以查看特定子智能体，也可以列出所有子智能体。
当用户询问"论文读得怎么样了"、"任务进度"等问题时使用。`,
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '子智能体 ID（如 sub-1）。不填则列出当前会话所有子智能体',
        },
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';
    const { subagent_id } = args || {};

    // 查询特定子智能体
    if (subagent_id) {
      const info = manager.getInfoForParent(sessionKey, subagent_id);
      if (!info) {
        return `未找到子智能体 ${subagent_id}`;
      }
      return this.formatInfo(info);
    }

    // 列出当前会话所有子智能体
    const all = manager.listByParent(sessionKey);
    if (all.length === 0) {
      return '当前没有后台运行的子任务。';
    }

    const lines = all.map(info => this.formatInfo(info));
    return `当前会话共有 ${all.length} 个子任务：\n\n${lines.join('\n\n---\n\n')}`;
  }

  private formatInfo(info: any): string {
    const statusMap: Record<string, string> = {
      running: '🔄 运行中',
      completed: '✅ 已完成',
      failed: '❌ 失败',
      stopped: '⏹️ 已停止',
    };

    const elapsed = info.completedAt
      ? Math.round((info.completedAt - info.createdAt) / 1000)
      : Math.round((Date.now() - info.createdAt) / 1000);

    const lines = [
      `[${info.id}] ${info.taskDescription}`,
      `状态: ${statusMap[info.status] || info.status}`,
      `Skill: ${info.skillName}`,
      `耗时: ${elapsed}s`,
    ];

    if (info.progressLog.length > 0) {
      const recent = info.progressLog.slice(-3);
      lines.push(`最近进度: ${recent.join(' → ')}`);
    }

    if (info.resultSummary) {
      lines.push(`结果摘要: ${info.resultSummary.slice(0, 500)}`);
    }

    return lines.join('\n');
  }
}
