import { Message } from '../types';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
  SessionRoute,
} from '../types/session-identity';
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
  TRANSIENT_RUNTIME_CONTEXT_PREFIX,
  buildRuntimeContextMessage,
} from './runtime-context-builder';
import { stripAssistantArtifactsFromMessages } from '../utils/transcript-artifacts';
import {
  RUNTIME_OBSERVATIONS_PREFIX,
  renderRuntimeObservations,
} from './runtime-observation-store';
import type { RuntimeObservationStore } from './runtime-observation-store';

const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';

export interface BuildTurnContextParams {
  sessionKey: string;
  sessionType?: string;
  sessionRoute?: SessionRoute;
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  localFileGrants?: ScopedLocalFileGrant[];
  durableMessages: Message[];
  runtimeFeedback: string[];
  skillRuntime: SessionSkillRuntime;
  planRuntime?: PlanRuntime;
  runtimeObservationStore?: RuntimeObservationStore;
  runtimeObservationPromptBudget?: number;
  runtimeObservationMaxItems?: number;
}

export interface BuildTurnContextResult {
  messages: Message[];
  runtimeFeedbackForLog: string[];
  runtimeObservationIdsForPrompt: string[];
}

/**
 * Builds the initial context for a single turn.
 *
 * This is provider input preparation, not durable transcript mutation.
 */
export class TurnContextBuilder {
  async build(params: BuildTurnContextParams): Promise<BuildTurnContextResult> {
    const contextMessages = stripAssistantArtifactsFromMessages(params.durableMessages);
    this.injectRuntimeContext(contextMessages, params);
    this.injectRuntimeFeedback(contextMessages, params.runtimeFeedback);
    this.injectPlanStatus(contextMessages, params.planRuntime);
    this.injectSubAgentStatus(contextMessages, params.sessionKey);

    await params.skillRuntime.reloadSkills();
    const skillsListMsg = params.skillRuntime.buildSkillsListMessage();
    if (skillsListMsg) {
      this.insertBeforeLastUser(contextMessages, skillsListMsg);
    }
    const runtimeObservationIdsForPrompt = this.injectRuntimeObservations(contextMessages, params);

    return {
      messages: contextMessages,
      runtimeFeedbackForLog: this.extractRuntimeFeedback(contextMessages),
      runtimeObservationIdsForPrompt,
    };
  }

  removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.__runtimeFeedback) return false;
      if (msg.__injected && msg.__runtimeObservation) return false;
      if (
        msg.__injected
        && typeof msg.content === 'string'
        && msg.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX)
      ) return false;
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_PLAN_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SKILLS_LIST_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX)) return false;
      return true;
    });
  }

  private injectRuntimeContext(messages: Message[], params: BuildTurnContextParams): void {
    const message = buildRuntimeContextMessage({
      sessionKey: params.sessionKey,
      sessionType: params.sessionType,
      sessionRoute: params.sessionRoute,
      executionScope: params.executionScope,
      localDeviceGrant: params.localDeviceGrant,
      deviceGrants: params.deviceGrants,
      deviceSelection: params.deviceSelection,
      localFileGrants: params.localFileGrants,
    });
    if (!message) return;
    this.insertBeforeLastUser(messages, message);
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

  private injectRuntimeObservations(
    messages: Message[],
    params: BuildTurnContextParams,
  ): string[] {
    if (!params.runtimeObservationStore) return [];

    const observations = params.runtimeObservationStore.pickForPrompt({
      sessionId: params.sessionKey,
      tokenBudget: params.runtimeObservationPromptBudget,
      maxItems: params.runtimeObservationMaxItems,
    });
    const observationMessage = renderRuntimeObservations(observations);
    if (!observationMessage) return [];

    this.insertBeforeLastUser(messages, observationMessage);
    return observations.map(observation => observation.id);
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
