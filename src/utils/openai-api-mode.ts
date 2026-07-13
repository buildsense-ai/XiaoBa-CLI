import type { OpenAIApiMode } from '../types';

export const OPENAI_API_MODE_OPTIONS: OpenAIApiMode[] = ['chat_completions', 'responses'];

export function normalizeOpenAIApiMode(value: unknown): OpenAIApiMode | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  return OPENAI_API_MODE_OPTIONS.includes(normalized as OpenAIApiMode)
    ? normalized as OpenAIApiMode
    : undefined;
}

export function openAIApiModeOrDefault(value: unknown): OpenAIApiMode {
  return normalizeOpenAIApiMode(value) ?? 'chat_completions';
}
