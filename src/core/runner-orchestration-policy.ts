import { ContentBlock, Message } from '../types';
import { ToolDefinition } from '../types/tool';

export const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
export const SUBAGENT_TOOL_NAME = 'spawn_subagent';
export const PLAN_TOOL_NAME = 'update_plan';
export const RECORD_DECISION_TOOL_NAME = 'record_decision';

export const SUBAGENT_SOFT_NUDGE_MIN_TURNS = 6;
export const SUBAGENT_SOFT_NUDGE_MIN_TOOL_CALLS = 8;
export const SUBAGENT_SOFT_NUDGE_TOOL_INTERVAL = 10;
export const PLAN_SOFT_NUDGE_MIN_TURNS = 3;
export const PLAN_SOFT_NUDGE_MIN_TOOL_CALLS = 4;
export const PLAN_SOFT_NUDGE_TOOL_INTERVAL = 8;
export const RUNTIME_ORCHESTRATION_CHECKPOINT_MIN_TURNS = 5;
export const RUNTIME_ORCHESTRATION_CHECKPOINT_MIN_TOOL_CALLS = 12;

const SUBAGENT_COMPLEX_REQUEST_MIN_CHARS = 90;
const SEMANTIC_WORK_REQUEST_MIN_CHARS = 20;
const EXPLORATORY_TOOL_NAMES = new Set(['read_file', 'grep', 'glob', 'execute_shell']);

export interface OrchestrationState {
  hasUpdatedPlan: boolean;
  hasSpawnedSubagent: boolean;
  hasRecordedDecision: boolean;
}

export interface ToolExecutionLike {
  toolName: string;
}

export function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

export function buildDuplicateOutboundHint(content: string): Message {
  return makeRunnerHint([
    `刚刚连续发送了与上一条相同的内容：“${content}”。`,
    '若不是用户明确需要重复确认，请避免重复外发，必要时调用 pause_turn 收束。',
  ]);
}

export function shouldAddInitialOrchestrationRetryHint(
  tools: ToolDefinition[],
  hadInitialOrchestrationNudge: boolean,
  alreadyShown: boolean,
  turns: number,
  executionRecords: ToolExecutionLike[],
  state: OrchestrationState,
): boolean {
  if (!hadInitialOrchestrationNudge || alreadyShown || turns !== 1) return false;
  if (hasCompletedOrchestrationCheckpoint(state)) return false;
  if (!hasOrchestrationCheckpointTools(tools)) return false;

  const exploratoryCount = executionRecords.filter(record => EXPLORATORY_TOOL_NAMES.has(record.toolName)).length;
  return exploratoryCount >= 2;
}

export function buildInitialOrchestrationRetryHint(
  tools: ToolDefinition[],
  state: OrchestrationState,
): Message {
  const missing = getMissingCheckpointTools(tools, state);
  return makeRunnerHint([
    `刚刚开始了多个探索类工具调用；编排 checkpoint 还没完成 ${missing.join(' / ')} 判断。`,
    '下一轮先做拆分/跳过决策，再继续大量读文件或搜索。',
    '可直接用 update_plan / spawn_subagent / record_decision 完成这次 checkpoint。',
  ]);
}

export function buildUnavailableToolCallHint(
  unavailableToolNames: string[],
  availableToolNames: string[],
  isCheckpointTurn: boolean,
): Message {
  const lines = [
    `当前轮次未开放的工具：${unavailableToolNames.join(', ')}。这些调用没有执行。`,
    `当前可用工具：${availableToolNames.join(', ') || '(none)'}.`,
  ];
  if (isCheckpointTurn) {
    lines.push(
      '编排 checkpoint：先用 update_plan / spawn_subagent / record_decision 做拆分或跳过决策。'
    );
  } else {
    lines.push('请改用当前可用工具，或直接回复。');
  }
  return makeRunnerHint(lines);
}

export function findCheckpointBlockedExploratoryTools(
  toolNames: string[],
  state: OrchestrationState,
): string[] {
  if (hasCompletedOrchestrationCheckpoint(state)) return [];
  if (toolNames.some(name =>
    name === PLAN_TOOL_NAME
    || name === SUBAGENT_TOOL_NAME
    || name === RECORD_DECISION_TOOL_NAME
  )) {
    return [];
  }

  return Array.from(new Set(toolNames.filter(name => EXPLORATORY_TOOL_NAMES.has(name))));
}

export function buildCheckpointDecisionRequiredHint(
  blockedToolNames: string[],
  tools: ToolDefinition[],
  state: OrchestrationState,
): Message {
  const missing = getMissingCheckpointTools(tools, state);
  return makeRunnerHint([
    `编排 checkpoint 仍未完成 ${missing.join(' / ')} 判断。`,
    `刚才请求的探索工具 ${blockedToolNames.join(', ')} 没有执行；先做一次编排决策，再继续读文件或搜索。`,
    `如果需要路线图，调用 ${PLAN_TOOL_NAME}；如果有独立支线，调用 ${SUBAGENT_TOOL_NAME}；如果决定主线自己做，调用 ${RECORD_DECISION_TOOL_NAME} 简记原因。`,
    '这不是限制子 agent 数量，也不是强制拆分；只是避免长任务在没有编排判断的情况下继续单线程遍历。',
  ]);
}

export function hasCompletedOrchestrationCheckpoint(state: OrchestrationState): boolean {
  return state.hasUpdatedPlan || state.hasSpawnedSubagent || state.hasRecordedDecision;
}

export function hasOrchestrationCheckpointTools(tools: ToolDefinition[]): boolean {
  return tools.some(tool =>
    tool.name === PLAN_TOOL_NAME
    || tool.name === SUBAGENT_TOOL_NAME
    || tool.name === RECORD_DECISION_TOOL_NAME
  );
}

export function filterOrchestrationCheckpointTools(tools: ToolDefinition[]): ToolDefinition[] {
  const checkpointNames = new Set([
    PLAN_TOOL_NAME,
    SUBAGENT_TOOL_NAME,
    RECORD_DECISION_TOOL_NAME,
  ]);
  return tools.filter(tool => checkpointNames.has(tool.name));
}

export function shouldRetryInitialOrchestrationBeforeFinalAnswer(
  tools: ToolDefinition[],
  hadInitialOrchestrationNudge: boolean,
  alreadyShown: boolean,
  turns: number,
  state: OrchestrationState,
): boolean {
  if (!hadInitialOrchestrationNudge || alreadyShown || turns !== 1) return false;
  if (hasCompletedOrchestrationCheckpoint(state)) return false;
  return hasOrchestrationCheckpointTools(tools);
}

export function buildInitialOrchestrationFinalAnswerRetryHint(
  tools: ToolDefinition[],
  state: OrchestrationState,
): Message {
  const missing = getMissingCheckpointTools(tools, state);
  return makeRunnerHint([
    `编排 checkpoint：复杂任务准备直接最终回复，但还没完成 ${missing.join(' / ')}。`,
    `若已足够收束，用 ${RECORD_DECISION_TOOL_NAME} 简记原因；否则先 update_plan 或 spawn_subagent。`,
  ]);
}

export function buildCheckpointFinalAnswerRetryHint(): Message {
  return makeRunnerHint([
    '当前是编排 checkpoint 轮；请先调用 update_plan / spawn_subagent / record_decision 之一。',
    `如果决定不拆分或不需要计划，用 ${RECORD_DECISION_TOOL_NAME} 简记原因，然后再继续回复用户。`,
  ]);
}

export function shouldAddRuntimeOrchestrationCheckpoint(
  tools: ToolDefinition[],
  turns: number,
  executedToolCalls: number,
  alreadyShown: boolean,
  state: OrchestrationState,
): boolean {
  if (alreadyShown) return false;
  if (hasCompletedOrchestrationCheckpoint(state)) return false;
  if (!hasOrchestrationCheckpointTools(tools)) return false;
  if (!tools.some(tool => tool.name === RECORD_DECISION_TOOL_NAME)) return false;
  return turns >= RUNTIME_ORCHESTRATION_CHECKPOINT_MIN_TURNS
    && executedToolCalls >= RUNTIME_ORCHESTRATION_CHECKPOINT_MIN_TOOL_CALLS;
}

export function buildRuntimeOrchestrationCheckpointHint(
  turns: number,
  executedToolCalls: number,
  tools: ToolDefinition[],
  state: OrchestrationState,
): Message {
  const missing = getMissingCheckpointTools(tools, state);
  return makeRunnerHint([
    `运行中 checkpoint：当前任务已进行 ${turns} 轮、${executedToolCalls} 次工具执行，但还没完成 ${missing.join(' / ')} 判断。`,
    '下一轮先做一次编排判断，再继续大量读文件或搜索。',
    '如果已经在脑中形成多步路线，调用 update_plan 同步给用户；不要只写成普通文本清单。',
    `若主线单独推进更合适，用 ${RECORD_DECISION_TOOL_NAME} 简记原因；否则 update_plan 或 spawn_subagent。`,
  ]);
}

export function buildInitialDecisionCheckpointIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  if (!tools.some(tool => tool.name === RECORD_DECISION_TOOL_NAME)) return null;

  const userText = getLastUserText(messages);
  if (looksLikeOrchestrationMetaQuestion(userText)) return null;
  if (!looksLikeWorkRequest(userText)) return null;

  if (!looksLikeComplexDelegationCandidate(userText)) {
    return makeRunnerHint([
      '语义编排 checkpoint：先判断这轮是简单单点、主线可直接推进，还是多阶段/可并行任务。',
      '简单任务直接做，不要为了形式调用 plan/subagent。',
      '如果要列出真实执行步骤，请调用 update_plan；普通文本清单不会更新计划卡片。',
      `若任务会拉长、跨文件/跨模块或有独立支线，先 update_plan 或 spawn_subagent；若决定单线，用 ${RECORD_DECISION_TOOL_NAME} 简记原因。`,
    ]);
  }

  return makeRunnerHint([
    '编排 checkpoint：这看起来是复杂/多维/可能等待较久的任务。',
    '先判断是否需要 update_plan、spawn_subagent，以及主线/支线如何拆分。',
    '如果准备列出多步计划，请直接调用 update_plan；不要只在普通回复里写计划清单。',
    `若决定单线推进，用 ${RECORD_DECISION_TOOL_NAME} 简记原因和下一步。`,
  ]);
}

export function shouldAddPlanSoftNudge(
  tools: ToolDefinition[],
  turns: number,
  executedToolCalls: number,
  hasUpdatedPlan: boolean,
  nextToolCount: number,
): boolean {
  if (hasUpdatedPlan) return false;
  if (!tools.some(tool => tool.name === PLAN_TOOL_NAME)) return false;
  return turns >= PLAN_SOFT_NUDGE_MIN_TURNS
    && executedToolCalls >= nextToolCount;
}

export function buildInitialPlanNudgeIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  if (!tools.some(tool => tool.name === PLAN_TOOL_NAME)) return null;

  const userText = getLastUserText(messages);
  if (looksLikeOrchestrationMetaQuestion(userText)) return null;
  if (!looksLikeComplexDelegationCandidate(userText)) return null;

  return makeRunnerHint([
    '复杂任务可先用 update_plan 给用户一个临时路线图。',
    '普通文本里的步骤列表不会触发计划卡片；需要展示计划时必须调用 update_plan。',
    `若判断很快能完成或计划会增加噪音，用 ${RECORD_DECISION_TOOL_NAME} 简记原因即可。`,
    '计划不是硬性 workflow，按真实节奏维护。',
  ]);
}

export function shouldAddSubagentSoftNudge(
  tools: ToolDefinition[],
  turns: number,
  executedToolCalls: number,
  hasSpawnedSubagent: boolean,
  nextToolCount: number,
): boolean {
  if (hasSpawnedSubagent) return false;
  if (!tools.some(tool => tool.name === SUBAGENT_TOOL_NAME)) return false;
  return turns >= SUBAGENT_SOFT_NUDGE_MIN_TURNS
    && executedToolCalls >= nextToolCount;
}

export function buildInitialSubagentNudgeIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  if (!tools.some(tool => tool.name === SUBAGENT_TOOL_NAME)) return null;

  const userText = getLastUserText(messages);
  if (looksLikeOrchestrationMetaQuestion(userText)) return null;
  if (!looksLikeComplexDelegationCandidate(userText)) return null;

  return makeRunnerHint([
    '第一轮先判断是否有独立、耗时、可并行支线；有的话可派 spawn_subagent 分担。',
    '子 agent 是侧路加速，不替代主线；派出后主 agent 仍应继续推进不依赖结果的工作。',
    `若判断无需拆分，用 ${RECORD_DECISION_TOOL_NAME} 简记原因。`,
  ]);
}

export function buildPlanSoftNudge(turns: number, executedToolCalls: number, nudgeCount: number): Message {
  return makeRunnerHint([
    `已进行 ${turns} 轮、${executedToolCalls} 次工具执行，还没有维护运行时计划。`,
    nudgeCount === 0
      ? '如果任务仍较大或用户会等较久，考虑调用 update_plan 更新临时计划。'
      : '如果任务仍多阶段或多方向，重新评估是否需要调用 update_plan。',
    '不要用普通文本里的“计划：1/2/3”代替 update_plan；那只会成为聊天内容，不会更新 UI。',
    `这不是强制要求；若跳过 plan 更合适，用 ${RECORD_DECISION_TOOL_NAME} 简记原因。`,
  ]);
}

export function buildSubagentSoftNudge(turns: number, executedToolCalls: number, nudgeCount: number): Message {
  return makeRunnerHint([
    `已进行 ${turns} 轮、${executedToolCalls} 次工具执行，还没有真正派出子 agent。`,
    nudgeCount === 0
      ? '如果剩余工作有独立可并行支线，考虑派出一个或多个子 agent。'
      : '如果仍在单线程处理多个独立维度，重新评估是否拆出子 agent。',
    `这不是强制要求；若主线更快，用 ${RECORD_DECISION_TOOL_NAME} 简记原因，并继续推进主线。`,
  ]);
}

export function shouldAddMaxTurnFinalizationHint(
  maxTurns: number | undefined,
  turns: number,
  alreadyShown: boolean,
): boolean {
  if (alreadyShown || maxTurns === undefined) return false;
  const remainingTurns = maxTurns - turns + 1;
  return remainingTurns <= 4 && remainingTurns > 0;
}

export function buildMaxTurnFinalizationHint(maxTurns: number | undefined, turns: number): Message {
  const remainingTurns = maxTurns === undefined ? 0 : Math.max(maxTurns - turns + 1, 1);
  return makeRunnerHint([
    `工具轮次预算即将耗尽，约还剩 ${remainingTurns} 轮。`,
    '若信息已足够，请收束为结论、证据、风险和下一步；只为关键证据继续调用工具。',
  ]);
}

function makeRunnerHint(lines: string[]): Message {
  return {
    role: 'system',
    content: [TRANSIENT_RUNNER_HINT_PREFIX, ...lines].join('\n'),
  };
}

function getLastUserText(messages: Message[]): string {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
  return contentToString(lastUserMessage?.content ?? '').trim();
}

function getMissingCheckpointTools(tools: ToolDefinition[], state: OrchestrationState): string[] {
  const missing: string[] = [];
  if (!state.hasUpdatedPlan && tools.some(tool => tool.name === PLAN_TOOL_NAME)) missing.push(PLAN_TOOL_NAME);
  if (!state.hasSpawnedSubagent && tools.some(tool => tool.name === SUBAGENT_TOOL_NAME)) missing.push(SUBAGENT_TOOL_NAME);
  if (!state.hasRecordedDecision && tools.some(tool => tool.name === RECORD_DECISION_TOOL_NAME)) missing.push(RECORD_DECISION_TOOL_NAME);
  return missing.length > 0 ? missing : ['checkpoint'];
}

function looksLikeComplexDelegationCandidate(text: string): boolean {
  if (looksLikeOrchestrationMetaQuestion(text)) return false;
  if (text.length < SUBAGENT_COMPLEX_REQUEST_MIN_CHARS) return false;

  const signals = [
    /全面|完整|整体|发布前|正式|可用性|质量|审查|检查|评估|梳理|排查|优化|风险|清单/,
    /多个|多维|重点|链路|模块|体验|测试|日志|上下文|性能|设置|停止|中断|状态/,
    /最后|结论|证据|建议|必须|优先级|不要改代码|先不要改|必要时跑/,
  ];
  const score = signals.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);
  const lineBreaks = (text.match(/\n/g) || []).length;
  return score >= 2 || (score >= 1 && lineBreaks >= 2);
}

function looksLikeWorkRequest(text: string): boolean {
  if (!text.trim()) return false;
  if (looksLikeOrchestrationMetaQuestion(text)) return false;
  if (looksLikeComplexDelegationCandidate(text)) return true;
  if (text.length >= SEMANTIC_WORK_REQUEST_MIN_CHARS) return true;

  return /继续|再看看|看看|看下|查|检查|排查|分析|梳理|修|改|优化|测试|跑|启动|上线|提交|合并|发版|发布|读|找/.test(text);
}

export function buildExplicitPlanRequestNudgeIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  if (!tools.some(tool => tool.name === PLAN_TOOL_NAME)) return null;

  const userText = getLastUserText(messages);
  if (!looksLikeExplicitPlanRequest(userText)) return null;

  return makeRunnerHint([
    '用户明确要求列计划/plan。请先调用 update_plan 更新临时计划卡片，再继续执行。',
    '不要只在普通回复或 markdown 清单里写计划；那不会更新 Plan UI。',
    `如果你判断这不是执行计划而是在问 plan 机制，用 ${RECORD_DECISION_TOOL_NAME} 简记原因后再解释。`,
  ]);
}

export function buildExplicitPlanFinalAnswerRetryHint(): Message {
  return makeRunnerHint([
    '刚才直接用普通文本回复了计划，但用户明确要求的是运行时 Plan。',
    '请调用 update_plan 生成/更新计划卡片；随后再继续执行或解释。',
  ]);
}

function looksLikeOrchestrationMetaQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const mentionsOrchestration = /plan|update_plan|子\s*agent|sub[-_ ]?agent|spawn_subagent|record_decision|checkpoint|编排|任务拆分|复杂任务|并行|主\s*agent/i.test(trimmed);
  if (!mentionsOrchestration) return false;

  const asksAboutBehavior = /为什么|为啥|怎么|如何|是什么|啥意思|什么意思|区别|链路|触发|判断|是不是|会不会|能不能|有没有|我想知道|解释|讲讲|回顾|复盘/.test(trimmed);
  if (!asksAboutBehavior) return false;

  const asksToDoWork = /帮我(做|看|看下|检查|排查|分析|梳理|整理|改|修|实现|加|优化|测试|跑|启动|提交|合并|上线)|先只读|不要改代码|要把|最后按|开始做|直接改|修一下|改一下|优化下|测试下|跑一下|启动起来/.test(trimmed);
  return !asksToDoWork;
}

function looksLikeExplicitPlanRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const explicitPlanAction = /列(个|一下)?\s*(计划|plan)|做(个|一下)?\s*(计划|plan)|先\s*(计划|规划|plan)|规划一下|计划一下|plan\s*一下|给我.*(计划|路线图)|执行计划|工作计划|路线图/i.test(trimmed);
  if (!explicitPlanAction) return false;

  const metaQuestion = /为什么|为啥|怎么|如何|是什么|啥意思|什么意思|区别|链路|触发|判断|是不是|会不会|能不能|有没有|我想知道|解释|讲讲|回顾|复盘/.test(trimmed);
  const directWorkRequest = /帮我|给我|列|做|先|开始|直接|看看|看下|检查|排查|分析|梳理|整理|改|修|优化|测试|跑/.test(trimmed);
  return !metaQuestion || directWorkRequest;
}
