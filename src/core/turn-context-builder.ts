import { Message } from '../types';
import {
  SessionSkillRuntime,
  TRANSIENT_SKILLS_LIST_PREFIX,
} from '../skills/session-skill-runtime';
import { isRuntimeFeedbackContent } from './runtime-feedback';
import { PlanRuntime } from './plan-runtime';
import {
  TRANSIENT_SUBAGENT_STATUS_PREFIX,
  buildSubAgentStatusMessage,
} from './sub-agent-observation';

const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';

const TRANSIENT_PREFIXES = [
  TRANSIENT_SUBAGENT_STATUS_PREFIX,
  TRANSIENT_PLAN_STATUS_PREFIX,
  TRANSIENT_RUNNER_HINT_PREFIX,
  TRANSIENT_SOFT_CHECK_PREFIX,
  TRANSIENT_SKILLS_LIST_PREFIX,
];

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
      if (isTransientPromptMessage(msg) && (msg.__injected || msg.role === 'system')) {
        return false;
      }
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
      role: 'user',
      content: `${TRANSIENT_PLAN_STATUS_PREFIX}\n${planText}`,
      __injected: true,
    });
  }

  private injectSubAgentStatus(messages: Message[], sessionKey: string): void {
    const statusMessage = buildSubAgentStatusMessage(sessionKey);
    if (!statusMessage) return;
    this.insertBeforeLastUser(messages, statusMessage);
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

function isTransientPromptMessage(message: Message): boolean {
  const { content } = message;
  return typeof content === 'string'
    && TRANSIENT_PREFIXES.some(prefix => content.startsWith(prefix));
}
