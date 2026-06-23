import { Message } from '../types';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';
import { SubAgentManager } from './sub-agent-manager';

export const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';

export function buildSubAgentStatusMessage(
  sessionKey: string,
  manager = SubAgentManager.getInstance(),
): Message | null {
  const subAgents = manager
    .listByParent(sessionKey)
    .filter(subAgent => isActiveStatus(subAgent.status));
  if (subAgents.length === 0) return null;

  const sections: string[] = [];
  const statusLines = subAgents.map(s => {
    const latest = compactInline(s.progressLog[s.progressLog.length - 1] ?? '', 120);
    const summary = s.status === 'completed' && s.resultSummary
      ? `\n  结果摘要: ${compactInline(s.resultSummary, 220)}`
      : '';
    const pending = s.status === 'waiting_for_input' && s.pendingQuestion
      ? `\n  待回复: ${compactInline(s.pendingQuestion, 180)}`
      : '';
    return `- [${s.id}] ${s.taskDescription} (${statusLabel(s.status)}, ${s.agentType}/${s.toolScope}) ${latest}${pending}${summary}`;
  }).join('\n');

  if (statusLines) {
    sections.push(`当前后台子任务：\n${statusLines}`);
  }

  return {
    role: 'user',
    content: [
      TRANSIENT_SUBAGENT_STATUS_PREFIX,
      renderRequiredDefaultPromptFile('transient/subagent-status.md', {
        sections: sections.join('\n\n'),
      }),
    ].join('\n\n'),
    __injected: true,
  };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'waiting_for_input':
      return '等待主 agent 回复';
    case 'stopped':
      return '已停止';
    default:
      return status;
  }
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'waiting_for_input';
}

function compactInline(text: string, maxChars: number): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}
