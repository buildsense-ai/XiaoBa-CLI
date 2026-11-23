import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { FileBotCatalogModelRuntimeRepository, FileBotCloudCatalogModelRuntimeRepository } from '../bot-definition/repository';
import type { ChatConfig, OpenAIApiMode, ReasoningEffort } from '../types';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';
import { DEEPSEEK_FLASH_RELAY_MODEL_PROFILE } from '../providers/deepseek/catalog-profile';
import { isOfficialRelayBaseUrl } from '../utils/relay-model-profiles';
import {
  DEFAULT_MEMORY_BRANCH_BUDGET,
  normalizeMemoryBranchBudget,
  type MemoryBranchBudget,
} from './branch-budget';

export const BRANCH_AGENT_CONFIG_SCHEMA = 'xiaoba.branch-agents.v3';
export const BRANCH_AGENT_CONFIG_FILE = 'branch-agents.json';

export type BranchModelSource = 'inherit' | 'catalog' | 'custom';
export type MemoryBranchKind = 'memory' | 'wiki';

export interface BranchModelRuntime {
  kind: 'catalog' | 'custom';
  modelId?: string;
  provider: 'anthropic' | 'openai';
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindowTokens: number;
  reasoningEffort?: ReasoningEffort;
  openaiApiMode?: OpenAIApiMode;
  capabilities: {
    toolCalling: boolean;
    vision?: boolean;
    streaming?: boolean;
  };
}

export interface MemoryBranchConfig {
  enabled: boolean;
  /** Exactly one read branch can be active. `memory` preserves the legacy branch. */
  kind: MemoryBranchKind;
  /**
   * Saved legacy Memory Branch model preference. Wiki uses the XiaoBa Relay model.
   */
  model: { kind: 'inherit' } | BranchModelRuntime;
  /**
   * Dashboard-only form draft for the custom-model editor. Never resolved at
   * runtime: resolveMemoryBranchModelOverride reads `model` only, so a draft
   * without a saved runtime model never changes branch behavior.
   */
  customDraft?: BranchModelRuntime;
  budget: MemoryBranchBudget;
}

export interface BranchAgentConfig {
  schema: typeof BRANCH_AGENT_CONFIG_SCHEMA;
  branches: {
    memorySearch: MemoryBranchConfig;
  };
  updatedAt?: string;
}

export interface BranchAgentConfigOptions {
  runtimeRoot?: string;
}

export function getBranchAgentConfigPath(runtimeRoot = PathResolver.getRuntimeDataRoot()): string {
  return path.join(runtimeRoot, BRANCH_AGENT_CONFIG_FILE);
}

export function loadBranchAgentConfig(options: BranchAgentConfigOptions = {}): BranchAgentConfig {
  const fallback = defaultBranchAgentConfig();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getBranchAgentConfigPath(options.runtimeRoot), 'utf-8'));
    return normalizeBranchAgentConfig(parsed, fallback);
  } catch {
    return fallback;
  }
}

export function saveBranchAgentConfig(
  config: BranchAgentConfig,
  options: BranchAgentConfigOptions = {},
): BranchAgentConfig {
  const runtimeRoot = options.runtimeRoot ?? PathResolver.getRuntimeDataRoot();
  const normalized = normalizeBranchAgentConfig(config, defaultBranchAgentConfig());
  const persisted: BranchAgentConfig = {
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const configPath = getBranchAgentConfigPath(runtimeRoot);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tempPath, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
  return persisted;
}

/**
 * Runtime model override for the Memory Branch, read from
 * `branches.memorySearch.model` only — `customDraft` is a Dashboard form
 * draft and is never a runtime source. `inherit` → undefined: the branch
 * shares the primary agent's AIService. A catalog/custom runtime → field
 * values for the dedicated branch AIService built in RuntimeFactory; the
 * primary agent's service stays untouched. The override model must keep tool
 * calling (assess_memory_need / finish_memory_search are the branch's only
 * tool surfaces): the sidecar gate
 * (AgentTurnController.startMemorySidecarIfEnabled) fails closed — branch
 * skipped, visible warn — when the resolved model cannot call tools.
 */
export function resolveMemoryBranchModelOverride(config: BranchAgentConfig): Partial<ChatConfig> | undefined {
  const model = config.branches.memorySearch.model;
  if (model.kind === 'inherit') return undefined;
  return {
    provider: model.provider,
    apiUrl: model.apiBase,
    apiKey: model.apiKey,
    model: model.model,
    temperature: undefined,
    maxTokens: undefined,
    contextWindowTokens: model.contextWindowTokens,
    reasoningEffort: model.reasoningEffort,
    openaiApiMode: model.openaiApiMode,
    modelCapabilities: { ...model.capabilities },
  };
}

/**
 * Use the DeepSeek catalog profile with the existing first-party Relay credential.
 */
export function resolveOfficialMemoryBranchModel(options: {
  runtimeRoot: string;
  activeRelay?: Pick<ChatConfig, 'apiUrl' | 'apiKey'>;
}): Partial<ChatConfig> | undefined {
  const { runtimeRoot, activeRelay } = options;
  const active = toDeepSeekBranchModel(activeRelay);
  if (active) return active;

  const envFile = path.join(runtimeRoot, '.env');
  let env: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    try {
      env = dotenv.parse(fs.readFileSync(envFile));
    } catch {
      Logger.warning('Unable to read .env for the Wiki Branch Relay. Checking other Relay sources.');
    }
  }
  const saved = toDeepSeekBranchModel({
    apiUrl: process.env.CATSCO_RELAY_LLM_API_BASE ?? env.CATSCO_RELAY_LLM_API_BASE ?? '',
    apiKey: process.env.CATSCO_RELAY_LLM_API_KEY ?? env.CATSCO_RELAY_LLM_API_KEY ?? '',
  });
  if (saved) return saved;

  const botId = createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid;
  if (!botId) return undefined;
  for (const repo of [FileBotCloudCatalogModelRuntimeRepository, FileBotCatalogModelRuntimeRepository]) {
    const cached = new repo({ runtimeRoot }).read(String(botId));
    const model = cached && toDeepSeekBranchModel({ apiUrl: cached.apiBase, apiKey: cached.apiKey });
    if (model) return model;
  }
  return undefined;
}

function toDeepSeekBranchModel(relay?: Pick<ChatConfig, 'apiUrl' | 'apiKey'>): Partial<ChatConfig> | undefined {
  const apiKey = relay?.apiKey?.trim();
  if (!apiKey || !relay?.apiUrl) return undefined;
  let origin: string;
  try { origin = new URL(relay.apiUrl).origin; } catch { return undefined; }
  if (!isOfficialRelayBaseUrl(origin)) return undefined;
  const profile = DEEPSEEK_FLASH_RELAY_MODEL_PROFILE;
  return {
    provider: profile.preferredProvider,
    apiUrl: origin + '/v1',
    apiKey,
    catsCoRelay: true,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    reasoningEffort: 'high',
    openaiApiMode: profile.openaiApiMode,
    modelCapabilities: { ...profile.capabilities },
  };
}

function defaultBranchAgentConfig(): BranchAgentConfig {
  return {
    schema: BRANCH_AGENT_CONFIG_SCHEMA,
    branches: {
      memorySearch: {
        enabled: true,
        kind: 'wiki',
        model: { kind: 'inherit' },
        budget: { ...DEFAULT_MEMORY_BRANCH_BUDGET },
      },
    },
  };
}

function normalizeBranchAgentConfig(input: any, fallback: BranchAgentConfig): BranchAgentConfig {
  if (input?.schema !== BRANCH_AGENT_CONFIG_SCHEMA) return fallback;
  const memory = input.branches?.memorySearch;
  const model = normalizeModel(memory?.model) ?? fallback.branches.memorySearch.model;
  const customDraft = normalizeModel(memory?.customDraft);
  const budget = normalizeMemoryBranchBudget(memory?.budget, fallback.branches.memorySearch.budget);
  return {
    schema: BRANCH_AGENT_CONFIG_SCHEMA,
    branches: {
      memorySearch: {
        enabled: typeof memory?.enabled === 'boolean' ? memory.enabled : fallback.branches.memorySearch.enabled,
        kind: memory?.kind === 'memory' ? 'memory' : 'wiki',
        model,
        budget,
        ...(customDraft?.kind === 'custom' ? { customDraft } : {}),
      },
    },
    ...(typeof input?.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
  };
}

function normalizeModel(input: any): MemoryBranchConfig['model'] | undefined {
  if (input?.kind === 'inherit') return { kind: 'inherit' };
  if (input?.kind !== 'catalog' && input?.kind !== 'custom') return undefined;
  const provider = input.provider === 'anthropic' || input.provider === 'openai' ? input.provider : undefined;
  const apiBase = validModelApiBase(input.apiBase);
  const apiKey = safeSingleLine(input.apiKey);
  const model = safeSingleLine(input.model);
  const modelId = input.kind === 'catalog' ? safeSingleLine(input.modelId) : undefined;
  const contextWindowTokens = positiveInteger(input.contextWindowTokens);
  if (!provider || !apiBase || !apiKey || !model || !contextWindowTokens) return undefined;
  if (input.kind === 'catalog' && !modelId) return undefined;
  return {
    kind: input.kind,
    ...(modelId ? { modelId } : {}),
    provider,
    apiBase,
    apiKey,
    model,
    contextWindowTokens,
    ...(isReasoningEffort(input.reasoningEffort) ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(isOpenAIApiMode(input.openaiApiMode) ? { openaiApiMode: input.openaiApiMode } : {}),
    capabilities: {
      toolCalling: input.capabilities?.toolCalling !== false,
      ...(typeof input.capabilities?.vision === 'boolean' ? { vision: input.capabilities.vision } : {}),
      ...(typeof input.capabilities?.streaming === 'boolean' ? { streaming: input.capabilities.streaming } : {}),
    },
  };
}

function nonEmpty(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function safeSingleLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = nonEmpty(value);
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function validModelApiBase(value: unknown): string | undefined {
  const text = safeSingleLine(value)?.replace(/\/+$/, '');
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'default' || value === 'high' || value === 'max' || value === 'disabled';
}

function isOpenAIApiMode(value: unknown): value is OpenAIApiMode {
  return value === 'chat_completions' || value === 'responses';
}
