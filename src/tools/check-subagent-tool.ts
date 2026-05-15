import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { formatSubAgentEventLine } from '../core/sub-agent-events';

/**
 * check_subagent - 查看子智能体状态
 *
 * 主 agent 用这个工具查看后台子任务的进度，
 * 然后用自然语言告诉用户。
 */
export class CheckSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'check_subagent',
    description: '查看当前会话下后台子智能体的状态、最近事件、结果摘要和产出文件。用户问进度或回流摘要不够时使用。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '子智能体 ID 或展示名（如 sub-... 或 子agent1）。不填则列出当前会话所有子智能体',
        },
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';
    const { subagent_id } = args || {};

    // 查询特定子智能体
    if (subagent_id) {
      const info = manager.getInfoForParent(sessionKey, subagent_id);
      if (!info) {
        return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `未找到子智能体 ${subagent_id}` };
      }
      return { ok: true, content: this.formatInfo(info) };
    }

    // 列出当前会话所有子智能体
    const all = manager.listByParent(sessionKey);
    if (all.length === 0) {
      return { ok: true, content: '当前没有后台运行的子任务。' };
    }

    const lines = all.map(info => this.formatInfo(info));
    return { ok: true, content: `当前会话共有 ${all.length} 个子任务：\n\n${lines.join('\n\n---\n\n')}` };
  }

  private formatInfo(info: any): string {
    const statusMap: Record<string, string> = {
      running: '🔄 运行中',
      completed: '✅ 已完成',
      failed: '❌ 失败',
      stopped: '⏹️ 已停止',
      waiting_for_input: '⏸️ 等待主 agent 回复',
    };

    const elapsed = info.completedAt
      ? Math.round((info.completedAt - info.createdAt) / 1000)
      : Math.round((Date.now() - info.createdAt) / 1000);

    const lines = [
      `[${info.displayName || info.id}] ${info.taskDescription}`,
      info.displayName ? `ID: ${info.id}` : '',
      `状态: ${statusMap[info.status] || info.status}`,
      `类型: ${info.agentType || 'skill'}`,
      `工具范围: ${info.toolScope || 'unknown'}`,
      `工具: ${info.allowedTools?.length ? info.allowedTools.join(', ') : '无'}`,
      `Skill: ${info.skillName}`,
      `耗时: ${elapsed}s`,
    ].filter(Boolean);

    if (info.progressLog.length > 0) {
      const recent = info.progressLog.slice(-3);
      lines.push(`最近进度: ${recent.join(' → ')}`);
    }

    if (info.pendingQuestion) {
      const waitingFor = info.pendingQuestionSince
        ? `（已等待 ${Math.round((Date.now() - info.pendingQuestionSince) / 1000)}s）`
        : '';
      lines.push(`待回复问题${waitingFor}: ${info.pendingQuestion}`);
    }

    if (info.resultSummary) {
      lines.push(`结果摘要: ${info.resultSummary.slice(0, 500)}`);
    }

    if (info.outputFiles && info.outputFiles.length > 0) {
      lines.push(`产出文件:\n${info.outputFiles.map((f: string) => `  - ${f}`).join('\n')}`);
    }

    if (info.recentEvents && info.recentEvents.length > 0) {
      lines.push(`最近事件:\n${info.recentEvents.slice(-5).map(formatSubAgentEventLine).join('\n')}`);
    }

    return lines.join('\n');
  }
}
