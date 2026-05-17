import { ContentBlock, Message } from '../types';
import { ToolDefinition } from '../types/tool';

export const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
export const SUBAGENT_TOOL_NAME = 'spawn_subagent';
export const PLAN_TOOL_NAME = 'update_plan';
export const RECORD_DECISION_TOOL_NAME = 'record_decision';

const SUBAGENT_COMPLEX_REQUEST_MIN_CHARS = 90;
const SEMANTIC_WORK_REQUEST_MIN_CHARS = 20;
const PLAN_SOFT_NUDGE_MIN_TURNS = 3;
const PLAN_SOFT_NUDGE_MIN_TOOL_CALLS = 4;
const PLAN_SOFT_NUDGE_TOOL_INTERVAL = 8;
const SUBAGENT_SOFT_NUDGE_MIN_TURNS = 6;
const SUBAGENT_SOFT_NUDGE_MIN_TOOL_CALLS = 8;
const SUBAGENT_SOFT_NUDGE_TOOL_INTERVAL = 10;

export interface OrchestrationState {
  hasUpdatedPlan: boolean;
  hasSpawnedSubagent: boolean;
  hasRecordedDecision: boolean;
}

export function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

export function buildInitialDecisionHintIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  const userText = getLastUserText(messages);
  if (looksLikeOrchestrationMetaQuestion(userText)) return null;
  if (!looksLikeWorkRequest(userText)) return null;

  const available = getAvailableOrchestrationTools(tools);
  if (available.length === 0) return null;

  const lines = looksLikeComplexDelegationCandidate(userText)
    ? [
      '语义编排提示：这看起来是多阶段、多维度或可能等待较久的任务。',
      '先判断是否需要运行时计划、后台子任务，以及主线/支线如何拆分。',
      '子 agent 是侧路加速，不替代主线；派出后主线仍应继续推进不依赖结果的工作。',
    ]
    : [
      '语义编排提示：先判断这轮是简单单点、主线可直接推进，还是多阶段/可并行任务。',
      '简单任务直接做，不要为了形式调用 plan/subagent。',
    ];

  return makeRunnerHint([
    ...lines,
    buildAvailableToolHint(available),
  ]);
}

export function buildExplicitPlanRequestHintIfUseful(messages: Message[], tools: ToolDefinition[]): Message | null {
  if (!hasTool(tools, PLAN_TOOL_NAME)) return null;

  const userText = getLastUserText(messages);
  if (!looksLikeExplicitPlanRequest(userText)) return null;

  return makeRunnerHint([
    '用户明确要求列计划/plan。若这是执行路线图，请优先调用 update_plan 更新计划卡片。',
    '不要只在普通回复或 markdown 清单里写计划；那不会更新 Plan UI。',
    '如果用户是在问 plan 机制而不是让你执行计划，可以直接解释。',
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
  if (!hasTool(tools, PLAN_TOOL_NAME)) return false;
  return turns >= PLAN_SOFT_NUDGE_MIN_TURNS
    && executedToolCalls >= nextToolCount;
}

export function buildPlanSoftNudge(turns: number, executedToolCalls: number, nudgeCount: number): Message {
  return makeRunnerHint([
    `已进行 ${turns} 轮、${executedToolCalls} 次工具执行，还没有维护运行时计划。`,
    nudgeCount === 0
      ? '如果任务仍较大或用户会等较久，考虑调用 update_plan 更新临时计划。'
      : '如果任务仍多阶段或多方向，重新评估是否需要调用 update_plan。',
    '这不是硬性要求；如果单线推进更快，可以继续执行。',
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
  if (!hasTool(tools, SUBAGENT_TOOL_NAME)) return false;
  return turns >= SUBAGENT_SOFT_NUDGE_MIN_TURNS
    && executedToolCalls >= nextToolCount;
}

export function buildSubagentSoftNudge(turns: number, executedToolCalls: number, nudgeCount: number): Message {
  return makeRunnerHint([
    `已进行 ${turns} 轮、${executedToolCalls} 次工具执行，还没有派出子 agent。`,
    nudgeCount === 0
      ? '如果剩余工作有独立、耗时、可并行支线，考虑派出一个或多个子 agent。'
      : '如果仍在单线程处理多个独立维度，重新评估是否拆出子 agent。',
    '这不是硬性要求；如果主线自己做更快，可以继续主线工作。',
  ]);
}

export function nextPlanNudgeToolCount(current: number): number {
  return Math.max(current + PLAN_SOFT_NUDGE_TOOL_INTERVAL, PLAN_SOFT_NUDGE_MIN_TOOL_CALLS);
}

export function nextSubagentNudgeToolCount(current: number): number {
  return Math.max(current + SUBAGENT_SOFT_NUDGE_TOOL_INTERVAL, SUBAGENT_SOFT_NUDGE_MIN_TOOL_CALLS);
}

export function makeRunnerHint(lines: string[]): Message {
  return {
    role: 'system',
    content: [TRANSIENT_RUNNER_HINT_PREFIX, ...lines].join('\n'),
  };
}

function getAvailableOrchestrationTools(tools: ToolDefinition[]): string[] {
  return [PLAN_TOOL_NAME, SUBAGENT_TOOL_NAME, RECORD_DECISION_TOOL_NAME]
    .filter(name => hasTool(tools, name));
}

function buildAvailableToolHint(available: string[]): string {
  const parts: string[] = [];
  if (available.includes(PLAN_TOOL_NAME)) {
    parts.push('需要展示真实执行路线时调用 update_plan');
  }
  if (available.includes(SUBAGENT_TOOL_NAME)) {
    parts.push('有独立支线时调用 spawn_subagent');
  }
  if (available.includes(RECORD_DECISION_TOOL_NAME)) {
    parts.push('决定不拆分时可用 record_decision 简记理由');
  }
  return `可用编排动作：${parts.join('；')}。`;
}

function hasTool(tools: ToolDefinition[], name: string): boolean {
  return tools.some(tool => tool.name === name);
}

function getLastUserText(messages: Message[]): string {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
  return contentToString(lastUserMessage?.content ?? '').trim();
}

function looksLikeWorkRequest(text: string): boolean {
  if (!text.trim()) return false;
  if (looksLikeOrchestrationMetaQuestion(text)) return false;
  if (looksLikeComplexDelegationCandidate(text)) return true;
  if (text.length >= SEMANTIC_WORK_REQUEST_MIN_CHARS) return true;

  return /继续|再看看|看看|看下|查|检查|排查|分析|梳理|修|改|优化|测试|跑|启动|上线|提交|合并|发版|发布|读|找/.test(text);
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

function looksLikeExplicitPlanRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const explicitPlanAction = /列(个|一下)?\s*(计划|plan)|做(个|一下)?\s*(计划|plan)|先\s*(计划|规划|plan)|规划一下|计划一下|plan\s*一下|给我.*(计划|路线图)|执行计划|工作计划|路线图/i.test(trimmed);
  if (!explicitPlanAction) return false;

  const metaQuestion = /为什么|为啥|怎么|如何|是什么|啥意思|什么意思|区别|链路|触发|判断|是不是|会不会|能不能|有没有|我想知道|解释|讲讲|回顾|复盘/.test(trimmed);
  const directWorkRequest = /帮我|给我|列|做|先|开始|直接|看看|看下|检查|排查|分析|梳理|整理|改|修|优化|测试|跑/.test(trimmed);
  return !metaQuestion || directWorkRequest;
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
