import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { ChatConfig } from '../types';
import { normalizeOpenAIApiMode } from './openai-api-mode';
import { normalizeReasoningEffort } from './reasoning-effort';

export type DistillationHeartbeatModelMode = 'inherit' | 'custom';

export interface DistillationHeartbeatModelConfig {
  mode: DistillationHeartbeatModelMode;
  override?: Partial<ChatConfig>;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function getDistillationHeartbeatModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtimeRoot?: string,
): DistillationHeartbeatModelConfig {
  const fileEnv = runtimeRoot
    ? readRuntimeEnvFile(path.join(runtimeRoot, '.env'))
    : {};
  const value = (key: string): string | undefined => fileEnv[key] ?? env[key];
  const mode = value('DISTILLATION_HEARTBEAT_LLM_MODE')?.trim().toLowerCase() === 'custom'
    ? 'custom'
    : 'inherit';
  if (mode === 'inherit') return { mode };

  const provider = value('DISTILLATION_HEARTBEAT_LLM_PROVIDER')?.trim().toLowerCase();
  const apiUrl = value('DISTILLATION_HEARTBEAT_LLM_API_BASE')?.trim();
  const apiKey = value('DISTILLATION_HEARTBEAT_LLM_API_KEY')?.trim();
  const model = value('DISTILLATION_HEARTBEAT_LLM_MODEL')?.trim();
  if ((provider !== 'anthropic' && provider !== 'openai') || !apiUrl || !apiKey || !model) {
    throw new Error(
      'Distillation Heartbeat custom model requires provider, API base, API key, and model.',
    );
  }

  const override: Partial<ChatConfig> = {
    provider,
    apiUrl,
    apiKey,
    model,
  };
  const contextWindowTokens = positiveInteger(value('DISTILLATION_HEARTBEAT_LLM_CONTEXT_WINDOW_TOKENS'));
  const reasoningEffort = normalizeReasoningEffort(value('DISTILLATION_HEARTBEAT_LLM_REASONING_EFFORT'));
  const openaiApiMode = normalizeOpenAIApiMode(value('DISTILLATION_HEARTBEAT_LLM_OPENAI_API_MODE'));
  if (contextWindowTokens !== undefined) override.contextWindowTokens = contextWindowTokens;
  if (reasoningEffort !== undefined) override.reasoningEffort = reasoningEffort;
  if (openaiApiMode !== undefined) override.openaiApiMode = openaiApiMode;
  return {
    mode,
    override,
  };
}

function readRuntimeEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}
