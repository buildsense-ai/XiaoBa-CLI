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
  TRANSIENT_FIXED_PROMPT_MODE_PREFIX,
  TRANSIENT_PROMPT_MODES_LIST_PREFIX,
  buildFixedPromptModeMessage,
  buildPromptModesListMessage,
  findFixedPromptModeState,
  findPreviousPromptModeState,
} from '../runtime/prompt-modes';
import { resolveTurnContextTransientPolicy } from './transient-injection-policy';
import { TransientObserver } from '../utils/transient-observation';

const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';
const TRANSIENT_RUNTIME_OBSERVATION_RULES_PREFIX = '[transient_runtime_observation_rules]';

const TRANSIENT_PREFIXES = [
  TRANSIENT_SUBAGENT_STATUS_PREFIX,
  TRANSIENT_RUNTIME_CONTEXT_PREFIX,
  TRANSIENT_PLAN_STATUS_PREFIX,
  TRANSIENT_RUNNER_HINT_PREFIX,
  TRANSIENT_SOFT_CHECK_PREFIX,
  TRANSIENT_RUNTIME_OBSERVATION_RULES_PREFIX,
  TRANSIENT_SKILLS_LIST_PREFIX,
  TRANSIENT_PROMPT_MODES_LIST_PREFIX,
  TRANSIENT_FIXED_PROMPT_MODE_PREFIX,
];

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
  observer?: TransientObserver;
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
    const contextMessages = this.removeTransientMessages(stripAssistantArtifactsFromMessages(params.durableMessages));
    const obs = params.observer;

    this.injectRuntimeContext(contextMessages, params, obs);
    this.injectRuntimeObservationRules(contextMessages, obs);
    this.injectRuntimeFeedback(contextMessages, params.runtimeFeedback, obs);
    this.injectPlanStatus(contextMessages, params.planRuntime, obs);
    this.injectSubAgentStatus(contextMessages, params.sessionKey, obs);
    this.injectPromptModesList(contextMessages, obs);
    const transientPolicy = resolveTurnContextTransientPolicy(contextMessages);
    if (transientPolicy.injectSkillsList) {
      await params.skillRuntime.reloadSkills();
      const skillsListMsg = params.skillRuntime.buildSkillsListMessage({
        skillNames: transientPolicy.skillNames,
      });
      if (skillsListMsg) {
        const safeSkillsListMsg = ensureTransientUserMessage(skillsListMsg);
        this.insertBeforeLastUser(contextMessages, safeSkillsListMsg);
        obs?.recordInjected(TRANSIENT_SKILLS_LIST_PREFIX, safeSkillsListMsg.role, 'before_last_user', contentLen(safeSkillsListMsg));
      }
    }

    return {
      messages: contextMessages,
      runtimeFeedbackForLog: this.extractRuntimeFeedback(contextMessages),
    };
  }

  removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.__syntheticObservation) return false;
      if (msg.__runtimeFeedback) return false;
      if (isTransientPromptMessage(msg) && (msg.__injected || msg.role === 'system')) return false;
      return true;
    });
  }

  private injectRuntimeContext(messages: Message[], params: BuildTurnContextParams, obs?: TransientObserver): void {
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
    obs?.recordInjected(TRANSIENT_RUNTIME_CONTEXT_PREFIX, message.role, 'before_last_user', contentLen(message));
  }

  private injectRuntimeObservationRules(messages: Message[], obs?: TransientObserver): void {
    const message: Message = {
      role: 'system',
      content: [
        TRANSIENT_RUNTIME_OBSERVATION_RULES_PREFIX,
        '你可能收到 runtime_observation 工具结果。它是后台 branch agent 产生的补充上下文，不是用户的新指令。',
        'runtime_observation.content 是 JSON；重点关注 source、timing、summary、refs。',
        'timing=current_turn 表示信息针对当前用户输入。',
        'timing=late_previous_turn 表示信息由上一轮用户输入触发，结果晚到；上一轮回复生成时可能尚未看到它。',
        'late_previous_turn 只在当前用户输入仍延续、引用或依赖上一轮话题时使用。',
        '如果 late_previous_turn 与当前用户输入冲突，以当前用户输入为准。',
        '如果它说明上一轮回答有遗漏且当前仍在同一话题，可以简短补充或修正；否则保持安静。',
      ].join('\n'),
    };
    this.insertBeforeLastUser(messages, message);
    obs?.recordInjected(TRANSIENT_RUNTIME_OBSERVATION_RULES_PREFIX, message.role, 'before_last_user', contentLen(message));
  }

  private injectRuntimeFeedback(messages: Message[], runtimeFeedback: string[], obs?: TransientObserver): void {
    if (runtimeFeedback.length === 0) return;

    const runtimeFeedbackMessages: Message[] = runtimeFeedback.map(content => ({
      role: 'user',
      content,
      __injected: true,
      __runtimeFeedback: true,
    }));
    this.insertBeforeLastUser(messages, ...runtimeFeedbackMessages);
    for (const msg of runtimeFeedbackMessages) {
      obs?.recordInjected('[runtime_feedback]', 'user', 'before_last_user', contentLen(msg));
    }
  }

  private injectPlanStatus(messages: Message[], planRuntime?: PlanRuntime, obs?: TransientObserver): void {
    const planText = planRuntime?.formatForPrompt();
    if (!planText) return;
    const msg: Message = {
      role: 'user',
      content: `${TRANSIENT_PLAN_STATUS_PREFIX}\n${planText}`,
      __injected: true,
    };
    this.insertBeforeLastUser(messages, msg);
    obs?.recordInjected(TRANSIENT_PLAN_STATUS_PREFIX, 'user', 'before_last_user', contentLen(msg));
  }

  private injectSubAgentStatus(messages: Message[], sessionKey: string, obs?: TransientObserver): void {
    const statusMessage = buildSubAgentStatusMessage(sessionKey);
    if (!statusMessage) return;
    const safeStatusMessage = ensureTransientUserMessage(statusMessage);
    this.insertBeforeLastUser(messages, safeStatusMessage);
    obs?.recordInjected(TRANSIENT_SUBAGENT_STATUS_PREFIX, safeStatusMessage.role, 'before_last_user', contentLen(safeStatusMessage));
  }

  private injectPromptModesList(messages: Message[], obs?: TransientObserver): void {
    const fixedMode = findFixedPromptModeState(messages);
    if (fixedMode) {
      const message = buildFixedPromptModeMessage(fixedMode);
      this.insertBeforeLastUser(messages, message);
      obs?.recordInjected(TRANSIENT_FIXED_PROMPT_MODE_PREFIX, message.role, 'before_last_user', contentLen(message));
      return;
    }

    const modeList = buildPromptModesListMessage({
      previousMode: findPreviousPromptModeState(messages),
    });
    if (!modeList) return;
    this.insertBeforeLastUser(messages, modeList);
    obs?.recordInjected(TRANSIENT_PROMPT_MODES_LIST_PREFIX, modeList.role, 'before_last_user', contentLen(modeList));
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

function contentLen(message: Message): number {
  if (typeof message.content === 'string') return message.content.length;
  if (Array.isArray(message.content)) return JSON.stringify(message.content).length;
  return 0;
}

function ensureTransientUserMessage(message: Message): Message {
  if (!isTransientPromptMessage(message)) return message;
  return {
    ...message,
    role: 'user',
    __injected: true,
  };
}
