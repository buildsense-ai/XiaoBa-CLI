import { Message } from '../types';
import {
  SessionSkillRuntime,
  TRANSIENT_SKILLS_LIST_PREFIX,
} from '../skills/session-skill-runtime';
import { isRuntimeFeedbackContent } from './runtime-feedback';
import { SubAgentManager } from './sub-agent-manager';
import { PlanRuntime } from './plan-runtime';

const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';
const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';

export interface BuildTurnContextParams {
  sessionKey: string;
  durableMessages: Message[];
  runtimeFeedback: string[];
  skillRuntime: SessionSkillRuntime;
  planRuntime?: PlanRuntime;
}

export interface BuildTurnContextResult {
  messages: Message[];
  runtimeFeedbackForLog: string[];
}

/**
 * Builds the initial context for a single turn.
 *
 * This is provider input preparation, not durable transcript mutation.
 */
export class TurnContextBuilder {
  async build(params: BuildTurnContextParams): Promise<BuildTurnContextResult> {
    const contextMessages = [...params.durableMessages];
    this.injectRuntimeFeedback(contextMessages, params.runtimeFeedback);
    this.injectPlanStatus(contextMessages, params.planRuntime);
    this.injectSubAgentStatus(contextMessages, params.sessionKey);

    await params.skillRuntime.reloadSkills();
    const skillsListMsg = params.skillRuntime.buildSkillsListMessage();
    if (skillsListMsg) {
      this.insertBeforeLastUser(contextMessages, skillsListMsg);
    }

    return {
      messages: contextMessages,
      runtimeFeedbackForLog: this.extractRuntimeFeedback(contextMessages),
    };
  }

  removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.__runtimeFeedback) return false;
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_PLAN_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SKILLS_LIST_PREFIX)) return false;
      return true;
    });
  }

  private injectRuntimeFeedback(messages: Message[], runtimeFeedback: string[]): void {
    if (runtimeFeedback.length === 0) return;

    const runtimeFeedbackMessages: Message[] = runtimeFeedback.map(content => ({
      role: 'user',
      content,
      __injected: true,
      __runtimeFeedback: true,
    }));
    this.insertBeforeLastUser(messages, ...runtimeFeedbackMessages);
  }

  private injectPlanStatus(messages: Message[], planRuntime?: PlanRuntime): void {
    const planText = planRuntime?.formatForPrompt();
    if (!planText) return;
    this.insertBeforeLastUser(messages, {
      role: 'system',
      content: `${TRANSIENT_PLAN_STATUS_PREFIX}\n${planText}`,
    });
  }

  private injectSubAgentStatus(messages: Message[], sessionKey: string): void {
    const subAgentManager = SubAgentManager.getInstance();
    const runningSubAgents = subAgentManager.listByParent(sessionKey);
    if (runningSubAgents.length === 0) return;

    const statusLines = runningSubAgents.map(s => {
      const statusLabel = s.status === 'running'
        ? '运行中'
        : s.status === 'completed'
          ? '已完成'
          : s.status === 'failed'
            ? '失败'
            : '已停止';
      const latest = s.progressLog[s.progressLog.length - 1] ?? '';
      const summary = s.status === 'completed' && s.resultSummary
        ? `\n  结果: ${s.resultSummary.slice(0, 200)}`
        : '';
      return `- [${s.id}] ${s.taskDescription} (${statusLabel}) ${latest}${summary}`;
    }).join('\n');

    this.insertBeforeLastUser(messages, {
      role: 'system',
      content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\n当前有 ${runningSubAgents.length} 个后台子任务：\n${statusLines}\n\n用户如果询问任务进度，请基于以上信息回答。如果用户要求停止任务，使用 stop_subagent 工具。`,
    });
  }

  private extractRuntimeFeedback(messages: Message[]): string[] {
    return messages
      .filter(message => message.__runtimeFeedback && isRuntimeFeedbackContent(message.content))
      .map(message => message.content as string);
  }

  private insertBeforeLastUser(messages: Message[], ...inserted: Message[]): void {
    const lastUserIdx = findLastIndex(messages, message => message.role === 'user');
    if (lastUserIdx < 0) {
      messages.push(...inserted);
      return;
    }
    messages.splice(lastUserIdx, 0, ...inserted);
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (predicate(items[idx])) return idx;
  }
  return -1;
}
