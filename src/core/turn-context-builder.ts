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
import {
  GauzMemClient,
  formatGauzMemPrompt,
} from '../utils/gauzmem-client';

const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';
const LEGACY_GAUZMEM_TRANSIENT_PREFIX = '[transient_gauzmem_recall]';

export interface BuildTurnContextParams {
  sessionKey: string;
  sessionType?: string;
  durableMessages: Message[];
  runtimeFeedback: string[];
  skillRuntime: SessionSkillRuntime;
  planRuntime?: PlanRuntime;
}

export interface BuildTurnContextResult {
  messages: Message[];
  runtimeFeedbackForLog: string[];
  gauzMemRunIds: string[];
  gauzMemPassiveRuns: Array<Record<string, unknown>>;
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
    const gauzMemPassiveRuns = await this.injectGauzMemRecall(contextMessages, params.sessionKey, params.sessionType);
    const gauzMemRunIds = gauzMemPassiveRuns
      .map(run => typeof run.runId === 'string' ? run.runId : '')
      .filter(Boolean);

    await params.skillRuntime.reloadSkills();
    const skillsListMsg = params.skillRuntime.buildSkillsListMessage();
    if (skillsListMsg) {
      this.insertBeforeLastUser(contextMessages, skillsListMsg);
    }

    return {
      messages: contextMessages,
      runtimeFeedbackForLog: this.extractRuntimeFeedback(contextMessages),
      gauzMemRunIds,
      gauzMemPassiveRuns,
    };
  }

  removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.__transient) return false;
      if (msg.__runtimeFeedback) return false;
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_PLAN_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(LEGACY_GAUZMEM_TRANSIENT_PREFIX)) return false;
      if (msg.content.startsWith('[gauzmem_recall]')) return false;
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
    const statusMessage = buildSubAgentStatusMessage(sessionKey);
    if (!statusMessage) return;
    this.insertBeforeLastUser(messages, statusMessage);
  }

  private async injectGauzMemRecall(messages: Message[], sessionKey: string, sessionType?: string): Promise<Array<Record<string, unknown>>> {
    const query = this.lastUserText(messages);
    if (!query) return [];

    const client = new GauzMemClient();
    if (!client.enabled) return [];

    try {
      const result = await client.retrieve({
        query,
        sessionId: sessionKey,
        sessionType,
      });
      if (!result) return [];
      const prompt = formatGauzMemPrompt(result);
      if (!prompt) return [];
      this.insertBeforeLastUser(messages, {
        role: 'system',
        content: prompt,
        __injected: true,
        __transient: true,
      });
      return result.runId ? [{
        runId: result.runId,
        query,
        evidenceIds: result.memoryBundle?.evidenceIds || [],
        edgeIds: result.memoryBundle?.edgeIds || [],
        stats: result.stats || {},
      }] : [];
    } catch {
      // GauzMem is optional; retrieval failure must not block the turn.
      return [];
    }
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

  private lastUserText(messages: Message[]): string {
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
      const message = messages[idx];
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');
      }
      return '';
    }
    return '';
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (predicate(items[idx])) return idx;
  }
  return -1;
}
