import { ChatConfig } from '../types';
import { resolveMaxTokens } from '../providers/output-limits';
import { RELAY_MODEL_PROFILES } from './relay-model-profiles';

export interface ModelContextWindowSpec {
  id: string;
  label: string;
  modelPatterns: RegExp[];
  contextWindowTokens: number;
}

export interface ModelContextWindowResolution {
  source: 'relay' | 'custom' | 'explicit' | 'fallback';
  model?: string;
  label: string;
  contextWindowTokens: number;
  promptBudgetTokens: number;
  safetyReserveTokens: number;
  maxOutputTokens: number;
  summaryBudgetTokens: number;
}

export const CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const ESTIMATION_MARGIN_RATIO = 0.06;
const PROTOCOL_RESERVE_TOKENS = 4_096;
const MIN_SAFETY_RESERVE_TOKENS = 8_192;
const MIN_SUMMARY_BUDGET_TOKENS = 50_000;
const MAX_SUMMARY_BUDGET_TOKENS = 300_000;
const SUMMARY_BUDGET_RATIO = 0.35;
const SUMMARY_WRAPPER_RESERVE_TOKENS = 8_192;

const RELAY_MODEL_ALIASES: Record<string, RegExp[]> = {
  'minimax-m2.7': [/^minimax-m2\.7(?:-highspeed)?$/i],
};

export const RELAY_MODEL_CONTEXT_WINDOW_SPECS: ModelContextWindowSpec[] = RELAY_MODEL_PROFILES.map(profile => ({
  id: profile.id,
  label: profile.label,
  modelPatterns: [
    new RegExp(`^${profile.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    ...(RELAY_MODEL_ALIASES[profile.id] || []),
  ],
  contextWindowTokens: profile.contextWindowTokens,
}));

export function parsePositiveInteger(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function findKnownModelContextWindowSpec(model: unknown): ModelContextWindowSpec | undefined {
  const modelName = String(model || '').trim();
  if (!modelName) return undefined;
  return RELAY_MODEL_CONTEXT_WINDOW_SPECS.find(spec => (
    spec.modelPatterns.some(pattern => pattern.test(modelName))
  ));
}

export function resolveKnownModelContextWindowTokens(model: unknown): number | undefined {
  return findKnownModelContextWindowSpec(model)?.contextWindowTokens;
}

export function calculatePromptBudgetTokens(
  contextWindowTokens: number,
  maxOutputTokens: number,
): { promptBudgetTokens: number; safetyReserveTokens: number } {
  const estimationReserve = Math.ceil(contextWindowTokens * ESTIMATION_MARGIN_RATIO);
  const rawSafetyReserveTokens = Math.max(
    MIN_SAFETY_RESERVE_TOKENS,
    maxOutputTokens + PROTOCOL_RESERVE_TOKENS + estimationReserve,
  );
  const safetyReserveTokens = Math.min(
    Math.max(0, contextWindowTokens - 1),
    rawSafetyReserveTokens,
  );
  const promptBudgetTokens = Math.max(1, contextWindowTokens - safetyReserveTokens);
  return {
    promptBudgetTokens,
    safetyReserveTokens,
  };
}

export function isCatsRelayModelConfig(
  config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiUrl = String(config.apiUrl || '').trim().toLowerCase();
  if (apiUrl) {
    return apiUrl.includes('relay.catsco.cc');
  }
  const source = String(env.CATSCO_MODEL_SOURCE || '').trim().toLowerCase();
  if (source === 'relay') return true;
  if (source === 'custom') return false;
  return false;
}

export function resolveConfiguredContextWindowTokens(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return parsePositiveInteger(env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS)
    ?? parsePositiveInteger(env.GAUZ_LLM_CONTEXT_TOKENS);
}

export function resolveModelContextWindow(
  config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider' | 'maxTokens' | 'contextWindowTokens'>,
  env: NodeJS.ProcessEnv = process.env,
): ModelContextWindowResolution {
  const model = String(config.model || '').trim();
  const explicitWindow = parsePositiveInteger(config.contextWindowTokens) ?? resolveConfiguredContextWindowTokens(env);
  const knownSpec = findKnownModelContextWindowSpec(model);
  const relay = isCatsRelayModelConfig(config, env);
  const contextWindowTokens = explicitWindow
    ?? (relay ? knownSpec?.contextWindowTokens : undefined)
    ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = resolveMaxTokens({
    ...config,
    contextWindowTokens,
  } as ChatConfig);
  const budget = calculatePromptBudgetTokens(contextWindowTokens, maxOutputTokens);
  const summaryBudgetTokens = calculateSummaryBudgetTokens(budget.promptBudgetTokens);

  return {
    source: explicitWindow ? 'explicit' : relay ? 'relay' : 'custom',
    model,
    label: knownSpec?.label || model || '自定义模型',
    contextWindowTokens,
    promptBudgetTokens: budget.promptBudgetTokens,
    safetyReserveTokens: budget.safetyReserveTokens,
    maxOutputTokens,
    summaryBudgetTokens,
  };
}

export function resolveModelPromptBudgetTokens(
  config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider' | 'maxTokens' | 'contextWindowTokens'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveModelContextWindow(config, env).promptBudgetTokens;
}

export function calculateSummaryBudgetTokens(promptBudgetTokens: number): number {
  const wrapperReserveTokens = Math.min(
    SUMMARY_WRAPPER_RESERVE_TOKENS,
    Math.max(0, Math.floor(promptBudgetTokens * 0.2)),
  );
  const contentCeiling = Math.max(1, promptBudgetTokens - wrapperReserveTokens);
  const scaled = Math.floor(contentCeiling * SUMMARY_BUDGET_RATIO);
  return Math.max(
    Math.min(MIN_SUMMARY_BUDGET_TOKENS, contentCeiling),
    Math.min(MAX_SUMMARY_BUDGET_TOKENS, contentCeiling, scaled),
  );
}

export function formatContextWindowTokens(tokens: number | undefined): string {
  if (!Number.isFinite(tokens) || !tokens) return '安全默认';
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}K`;
  }
  return `${tokens}`;
}
