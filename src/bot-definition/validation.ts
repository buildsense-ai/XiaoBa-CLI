import {
  BOT_DEFINITION_SCHEMA,
  type BotDefinition,
  type BotPromptDefinition,
  type BotSkillReference,
  type CustomBotModelDefinition,
} from './types';

export function isValidBotDefinition(
  definition: unknown,
  expectedBotId: string,
): definition is BotDefinition {
  const value = definition as BotDefinition | undefined;
  if (
    !value
    || typeof value !== 'object'
    || value.schema !== BOT_DEFINITION_SCHEMA
    || typeof value.botId !== 'string'
    || value.botId !== expectedBotId
    || !value.model
    || !isValidBotPromptDefinition(value.prompt)
    || !isValidBotSkillReferences(value.skills)
  ) {
    return false;
  }
  if (value.model.kind === 'catalog') {
    return (
      typeof value.model.modelId === 'string'
      && validBoundedText(value.model.modelId, 160)
      && optionalReasoningEffortIsValid(value.model.reasoningEffort)
    );
  }
  return value.model.kind === 'custom' && isValidCustomModel(value.model);
}

export function isValidBotPromptDefinition(
  prompt: unknown,
): prompt is BotPromptDefinition | undefined {
  if (prompt === undefined) return true;
  if (!prompt || typeof prompt !== 'object') return false;
  const value = prompt as BotPromptDefinition;
  if (value.selected !== 'default' && value.selected !== 'custom') return false;
  return value.customSystemPrompt === undefined
    || (
      typeof value.customSystemPrompt === 'string'
      && validPromptText(value.customSystemPrompt, 1_000_000)
    );
}

export function assertValidBotDefinition(
  definition: unknown,
  expectedBotId: string,
): asserts definition is BotDefinition {
  if (!isValidBotDefinition(definition, expectedBotId)) {
    throw new Error('BotDefinition is invalid.');
  }
}

export function isValidBotSkillReferences(
  skills: unknown,
): skills is BotSkillReference[] | undefined {
  if (skills === undefined) return true;
  if (!Array.isArray(skills) || skills.length > 256) return false;
  const seenSkillIds = new Set<string>();
  for (const raw of skills) {
    if (!raw || typeof raw !== 'object') return false;
    const keys = Object.keys(raw);
    if (keys.some(key => key !== 'skillId' && key !== 'version')) return false;
    if (typeof raw.skillId !== 'string' || typeof raw.version !== 'string') return false;
    const skillId = raw.skillId.trim();
    const version = raw.version.trim();
    if (
      !skillId
      || !version
      || skillId.length > 240
      || version.length > 120
      || hasControlCharacters(skillId)
      || hasControlCharacters(version)
      || seenSkillIds.has(skillId)
    ) {
      return false;
    }
    seenSkillIds.add(skillId);
  }
  return true;
}

function isValidCustomModel(model: unknown): model is CustomBotModelDefinition {
  const value = model as CustomBotModelDefinition | undefined;
  if (!value || typeof value !== 'object') return false;
  const contextWindowTokens = Number(value.contextWindowTokens);
  const maxTokens = value.maxTokens === undefined ? undefined : Number(value.maxTokens);
  const temperature = value.temperature === undefined ? undefined : Number(value.temperature);
  return (
    value?.kind === 'custom'
    && typeof value.protocol === 'string'
    && ['anthropic', 'openai-chat-completions', 'openai-responses'].includes(value.protocol)
    && typeof value.apiBase === 'string'
    && validHttpUrl(value.apiBase)
    && typeof value.model === 'string'
    && validBoundedText(value.model, 240)
    && typeof value.apiKey === 'string'
    && value.apiKey.length > 0
    && value.apiKey.length <= 8192
    && Number.isInteger(contextWindowTokens)
    && contextWindowTokens >= 1024
    && contextWindowTokens <= 4_000_000
    && (maxTokens === undefined || (Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 1_000_000))
    && (temperature === undefined || (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2))
    && optionalReasoningEffortIsValid(value.reasoningEffort)
  );
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validBoundedText(value: string, maxLength: number): boolean {
  const text = value.trim();
  return Boolean(text) && text.length <= maxLength && !hasControlCharacters(text);
}

function validPromptText(value: string, maxLength: number): boolean {
  const text = value.trim();
  return Boolean(text)
    && text.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function validHttpUrl(value: string): boolean {
  if (value.length > 2048 || hasControlCharacters(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function optionalReasoningEffortIsValid(value: unknown): boolean {
  return value === undefined
    || (
      typeof value === 'string'
      && ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'disabled'].includes(value)
    );
}
