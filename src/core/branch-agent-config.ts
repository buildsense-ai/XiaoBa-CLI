import * as fs from 'fs';
import * as path from 'path';
import type { ChatConfig, OpenAIApiMode, ReasoningEffort } from '../types';
import { PathResolver } from '../utils/path-resolver';
import { isBranchAgentsEnabled } from './branch-agent-settings';

export const BRANCH_AGENT_CONFIG_SCHEMA = 'xiaoba.branch-agents.v1';
export const BRANCH_AGENT_CONFIG_FILE = 'branch-agents.json';

export type BranchModelSource = 'inherit' | 'catalog' | 'custom';

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
  model: { kind: 'inherit' } | BranchModelRuntime;
  customDraft?: BranchModelRuntime;
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
  env?: NodeJS.ProcessEnv;
}

export function getBranchAgentConfigPath(runtimeRoot = PathResolver.getRuntimeDataRoot()): string {
  return path.join(runtimeRoot, BRANCH_AGENT_CONFIG_FILE);
}

export function loadBranchAgentConfig(options: BranchAgentConfigOptions = {}): BranchAgentConfig {
  const runtimeRoot = options.runtimeRoot ?? PathResolver.getRuntimeDataRoot();
  const fallback = defaultBranchAgentConfig(options.env ?? process.env);
  const configPath = getBranchAgentConfigPath(runtimeRoot);
  if (!fs.existsSync(configPath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
  const normalized = normalizeBranchAgentConfig(config, defaultBranchAgentConfig(options.env ?? process.env));
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

function defaultBranchAgentConfig(env: NodeJS.ProcessEnv): BranchAgentConfig {
  return {
    schema: BRANCH_AGENT_CONFIG_SCHEMA,
    branches: {
      memorySearch: {
        enabled: isBranchAgentsEnabled(env),
        model: { kind: 'inherit' },
      },
    },
  };
}

function normalizeBranchAgentConfig(input: any, fallback: BranchAgentConfig): BranchAgentConfig {
  const memory = input?.schema === BRANCH_AGENT_CONFIG_SCHEMA
    ? input?.branches?.memorySearch
    : undefined;
  const model = normalizeModel(memory?.model) ?? fallback.branches.memorySearch.model;
  const customDraft = normalizeModel(memory?.customDraft);
  return {
    schema: BRANCH_AGENT_CONFIG_SCHEMA,
    branches: {
      memorySearch: {
        enabled: typeof memory?.enabled === 'boolean' ? memory.enabled : fallback.branches.memorySearch.enabled,
        model,
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
