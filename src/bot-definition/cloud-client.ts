import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import { createHash } from 'crypto';
import { normalizeReasoningEffort } from '../utils/reasoning-effort';
import type { ReasoningEffort } from '../types';
import { canonicalizeBotSkillRefs } from '../bot-skills/canonical';
import {
  BOT_DEFINITION_SCHEMA,
  type CloudBotDefinition,
  type BotModelDefinition,
  type BotPromptDefinition,
  type BotSkillRef,
  type CustomBotModelDefinition,
} from './types';

const CLOUD_MODEL_REQUEST_TIMEOUT_MS = 10_000;

export interface CloudBotModelSelection {
  /** Missing means catalog for compatibility with selections created by older callers. */
  kind?: 'catalog' | 'custom' | 'local';
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  /**
   * Cloud-authoritative context window for catalog selections. Optional so
   * older servers (or custom models) continue to work; when present the
   * device-local profile must not override it.
   */
  contextWindowTokens?: number;
  revision: number;
  customModel?: CustomBotModelDefinition;
  definition?: CloudBotDefinition;
}

export interface CloudBotDefinitionSnapshot {
  configured: boolean;
  revision: number;
  definition?: CloudBotDefinition;
  runtime?: Record<string, unknown>;
}

export interface CloudBotModelClientOptions {
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

export interface DefaultPromptSnapshotInput {
  content: string;
  xiaobaVersion?: string;
  runtimeVersion?: string;
}

export async function pullCloudBotModelSelection(
  options: CloudBotModelClientOptions,
): Promise<CloudBotModelSelection | undefined> {
  const definitionSnapshot = await pullCloudBotDefinition(options);
  if (definitionSnapshot) {
    if (!definitionSnapshot.configured || !definitionSnapshot.definition) return undefined;
    const model = definitionSnapshot.definition.model;
    return model.kind === 'local'
      ? {
        kind: 'local',
        modelId: 'local',
        revision: definitionSnapshot.revision,
        definition: definitionSnapshot.definition,
      }
      : model.kind === 'custom'
      ? {
        kind: 'custom',
        modelId: model.model,
        revision: definitionSnapshot.revision,
        customModel: model,
        definition: definitionSnapshot.definition,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      }
      : {
        kind: 'catalog',
        modelId: model.modelId,
        revision: definitionSnapshot.revision,
        definition: definitionSnapshot.definition,
        ...(model.kind === 'catalog' && model.contextWindowTokens
          ? { contextWindowTokens: model.contextWindowTokens }
          : {}),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      };
  }
  return pullLegacyCloudBotModelSelection(options);
}

export async function pullLegacyCloudBotModelSelection(
  options: CloudBotModelClientOptions,
): Promise<CloudBotModelSelection | undefined> {
  const response = await cloudModelRequest(options, 'GET', '/api/bot/model-config');
  if (response === undefined) return undefined;
  const responseBotId = String(response?.uid ?? '').trim();
  const modelId = String(response?.desired?.model_id || '').trim();
  const revision = Number(response?.desired?.revision);
  if (responseBotId !== String(options.botId).trim() || !modelId || !Number.isInteger(revision) || revision < 0) {
    throw new Error('CatsCo cloud returned an invalid bot model configuration.');
  }
  if (response?.configured !== true) {
    return revision > 0 && modelId === 'local'
      ? { kind: 'local', modelId: 'local', revision }
      : undefined;
  }
  const kind = normalizeCloudModelKind(response?.desired?.kind);
  const rawReasoning = String(response?.desired?.reasoning_effort || '').trim();
  const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
  if (rawReasoning && !reasoningEffort) {
    throw new Error(`CatsCo cloud returned an unsupported reasoning effort: ${rawReasoning}`);
  }
  if (kind === 'custom') {
    const customModel = parseCloudCustomModel(response?.desired?.custom);
    if (customModel.model !== modelId) {
      throw new Error('CatsCo cloud custom model does not match its selected model id.');
    }
    if ((customModel.reasoningEffort || '') !== (reasoningEffort || '')) {
      throw new Error('CatsCo cloud custom model reasoning does not match its selected reasoning effort.');
    }
    return {
      kind,
      modelId,
      revision,
      customModel,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  return {
    kind: 'catalog',
    modelId,
    revision,
    ...(parseCloudContextWindowTokens(response?.desired?.context_window_tokens) !== undefined
      ? { contextWindowTokens: parseCloudContextWindowTokens(response?.desired?.context_window_tokens) }
      : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export async function pullCloudBotDefinition(
  options: CloudBotModelClientOptions,
): Promise<CloudBotDefinitionSnapshot | undefined> {
  const response = await cloudDefinitionRequest(options, 'bot', 'GET', '/api/bot/definition');
  if (response === undefined) return undefined;
  if (!isBotDefinitionResponse(response)) return undefined;
  return parseCloudBotDefinitionSnapshot(response, options.botId);
}

export async function patchCloudBotDefinitionModel(
  options: CloudBotModelClientOptions,
  model: BotModelDefinition,
  revision?: number,
): Promise<number | undefined> {
  const response = await cloudDefinitionRequest(
    options,
    'owner',
    'PATCH',
    `/api/bots/definition/model?uid=${encodeURIComponent(options.botId)}`,
    {
      ...(revision !== undefined ? { revision } : {}),
      model,
    },
  );
  if (response === undefined) return undefined;
  return parseRevision(response);
}

export async function patchCloudBotDefinitionPrompt(
  options: CloudBotModelClientOptions,
  prompt: BotPromptDefinition,
  revision?: number,
): Promise<number | undefined> {
  const response = await cloudDefinitionRequest(
    options,
    'owner',
    'PATCH',
    `/api/bots/definition/prompt?uid=${encodeURIComponent(options.botId)}`,
    {
      ...(revision !== undefined ? { revision } : {}),
      prompt,
    },
  );
  if (response === undefined) return undefined;
  return parseRevision(response);
}

export async function patchCloudBotDefinitionSkills(
  options: CloudBotModelClientOptions,
  skills: readonly BotSkillRef[],
  revision: number,
): Promise<number | undefined> {
  const response = await cloudDefinitionRequest(
    options,
    'bot',
    'PATCH',
    '/api/bot/definition/skills',
    {
      revision,
      skills: canonicalizeBotSkillRefs(skills),
    },
  );
  if (response === undefined) return undefined;
  return parseRevision(response);
}

export async function acknowledgeCloudBotDefinition(
  options: CloudBotModelClientOptions,
  revision: number,
  applyError = '',
): Promise<void> {
  await cloudDefinitionRequest(options, 'bot', 'POST', '/api/bot/definition/ack', {
    revision,
    ...(applyError ? { error: applyError } : {}),
  });
}

export async function reportCloudDefaultPromptSnapshot(
  options: CloudBotModelClientOptions,
  snapshot: DefaultPromptSnapshotInput,
): Promise<boolean> {
  const content = String(snapshot.content || '');
  if (!content.trim()) throw new Error('Default system prompt snapshot cannot be empty.');
  const response = await cloudDefinitionRequest(
    options,
    'bot',
    'PUT',
    '/api/bot/definition/default-prompt',
    {
      content,
      contentHash: createHash('sha256').update(content, 'utf-8').digest('hex'),
      ...(snapshot.xiaobaVersion ? { xiaobaVersion: snapshot.xiaobaVersion } : {}),
      ...(snapshot.runtimeVersion ? { runtimeVersion: snapshot.runtimeVersion } : {}),
    },
  );
  return response !== undefined;
}

export async function acknowledgeCloudBotModelSelection(
  options: CloudBotModelClientOptions,
  selection: CloudBotModelSelection,
  applyError = '',
): Promise<void> {
  if (selection.definition) {
    await acknowledgeCloudBotDefinition(options, selection.revision, applyError);
    return;
  }
  await cloudModelRequest(options, 'POST', '/api/bot/model-config/ack', {
    revision: selection.revision,
    ...(selection.kind === 'custom' || selection.kind === 'local' ? { kind: selection.kind } : {}),
    model_id: selection.modelId,
    reasoning_effort: selection.reasoningEffort || '',
    ...(applyError ? { error: applyError } : {}),
  });
}

export function redactCloudBotModelError(
  error: unknown,
  selection?: CloudBotModelSelection,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const secret = selection?.customModel?.apiKey;
  if (secret) message = message.split(secret).join('[REDACTED]');
  return message;
}

function normalizeCloudModelKind(value: unknown): 'catalog' | 'custom' {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind || kind === 'catalog') return 'catalog';
  if (kind === 'custom') return 'custom';
  throw new Error(`CatsCo cloud returned an unsupported model kind: ${kind}`);
}

function parseCloudCustomModel(value: unknown): CustomBotModelDefinition {
  const input = value as Record<string, unknown> | undefined;
  const protocol = String(input?.protocol || '').trim().toLowerCase();
  const apiBase = String(input?.apiBase || input?.api_base || '').trim().replace(/\/+$/, '');
  const model = String(input?.model || '').trim();
  const apiKey = String(input?.apiKey || input?.api_key || '').trim();
  const contextWindowTokens = Number(input?.contextWindowTokens ?? input?.context_window_tokens);
  const maxTokens = Number(input?.maxTokens ?? input?.max_tokens);
  const temperature = input?.temperature === undefined || input?.temperature === null
    ? undefined
    : Number(input.temperature);
  const rawReasoning = String(input?.reasoningEffort || input?.reasoning_effort || '').trim();
  const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
  if (!['anthropic', 'openai-chat-completions', 'openai-responses'].includes(protocol)) {
    throw new Error('CatsCo cloud returned an unsupported custom model protocol.');
  }
  if (!apiBase || !/^https?:\/\//i.test(apiBase) || !model || !apiKey) {
    throw new Error('CatsCo cloud returned an incomplete custom model configuration.');
  }
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 1024 || contextWindowTokens > 4_000_000) {
    throw new Error('CatsCo cloud returned an invalid custom model context window.');
  }
  if (Number.isFinite(maxTokens) && (maxTokens < 0 || maxTokens > 1_000_000)) {
    throw new Error('CatsCo cloud returned invalid custom model max tokens.');
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error('CatsCo cloud returned an invalid custom model temperature.');
  }
  if (rawReasoning && !reasoningEffort) {
    throw new Error(`CatsCo cloud returned an unsupported reasoning effort: ${rawReasoning}`);
  }
  return {
    kind: 'custom',
    protocol: protocol as CustomBotModelDefinition['protocol'],
    apiBase,
    model,
    apiKey,
    contextWindowTokens,
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function parseCloudBotDefinitionSnapshot(
  response: any,
  expectedBotId: string,
): CloudBotDefinitionSnapshot {
  const revision = parseRevision(response);
  if (response?.configured !== true) {
    return { configured: false, revision };
  }
  const raw = response?.definition as Record<string, unknown> | undefined;
  const botId = String(raw?.botId || '').trim();
  if (!raw || raw.schema !== BOT_DEFINITION_SCHEMA || botId !== String(expectedBotId).trim()) {
    throw new Error('CatsCo cloud returned an invalid BotDefinition identity.');
  }
  const rawModel = raw.model as Record<string, unknown> | undefined;
  const kind = String(rawModel?.kind || '').trim().toLowerCase();
  let model: CloudBotDefinition['model'];
  if (kind === 'custom') {
    model = parseCloudCustomModel(rawModel);
  } else if (kind === 'local') {
    const modelId = String(rawModel?.modelId || '').trim().toLowerCase();
    if (modelId && modelId !== 'local') {
      throw new Error('CatsCo cloud returned an invalid local BotDefinition.');
    }
    model = { kind: 'local', modelId: 'local' };
  } else if (!kind || kind === 'catalog') {
    const modelId = String(rawModel?.modelId || '').trim();
    const rawReasoning = String(rawModel?.reasoningEffort || '').trim();
    const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
    const contextWindowTokens = parseCloudContextWindowTokens(rawModel?.contextWindowTokens);
    if (!modelId || (rawReasoning && !reasoningEffort)) {
      throw new Error('CatsCo cloud returned an invalid catalog BotDefinition.');
    }
    model = {
      kind: 'catalog',
      modelId,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  } else {
    throw new Error(`CatsCo cloud returned an unsupported BotDefinition model kind: ${kind}`);
  }
  const prompt = parseCloudPromptDefinition(raw.prompt);
  const hasSkills = Object.prototype.hasOwnProperty.call(raw, 'skills');
  if (hasSkills && raw.skills !== null && !Array.isArray(raw.skills)) {
    throw new Error('CatsCo cloud returned an invalid BotDefinition Skills field.');
  }
  const skills = hasSkills
    ? canonicalizeBotSkillRefs((raw.skills ?? []) as BotSkillRef[])
    : undefined;
  return {
    configured: true,
    revision,
    definition: {
      schema: BOT_DEFINITION_SCHEMA,
      botId,
      model,
      ...(prompt ? { prompt } : {}),
      ...(skills !== undefined ? { skills } : {}),
    },
    ...(response?.runtime && typeof response.runtime === 'object'
      ? { runtime: response.runtime as Record<string, unknown> }
      : {}),
  };
}

function parseCloudContextWindowTokens(value: unknown): number | undefined {
  const tokens = Number(value);
  return Number.isInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function parseCloudPromptDefinition(value: unknown): BotPromptDefinition | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const selected = String(raw.selected || '').trim().toLowerCase();
  const customSystemPrompt = String(raw.customSystemPrompt || '');
  if (selected !== 'default' && selected !== 'custom') {
    throw new Error('CatsCo cloud returned an invalid prompt selection.');
  }
  if (selected === 'custom' && !customSystemPrompt.trim()) {
    throw new Error('CatsCo cloud returned an empty custom system prompt.');
  }
  return {
    selected,
    ...(customSystemPrompt ? { customSystemPrompt } : {}),
  };
}

function isBotDefinitionResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const value = response as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(value, 'revision')
    && Object.prototype.hasOwnProperty.call(value, 'configured');
}

function parseRevision(response: any): number {
  const revision = Number(response?.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error('CatsCo cloud returned an invalid BotDefinition revision.');
  }
  return revision;
}

async function cloudDefinitionRequest(
  options: CloudBotModelClientOptions,
  authMode: 'owner' | 'bot',
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<any | undefined> {
  const credential = String(authMode === 'owner' ? options.auth.token : options.auth.apiKey || '').trim();
  const httpBaseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!credential || !httpBaseUrl) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_MODEL_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${httpBaseUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authMode === 'owner' ? `Bearer ${credential}` : `ApiKey ${credential}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if ([404, 405, 501].includes(response.status)) return undefined;
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(String(data?.error || data?.message || `CatsCo BotDefinition request failed: ${response.status}`));
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function cloudModelRequest(
  options: CloudBotModelClientOptions,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<any | undefined> {
  const apiKey = String(options.auth.apiKey || '').trim();
  const httpBaseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!apiKey || !httpBaseUrl) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_MODEL_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${httpBaseUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if ([404, 405, 501].includes(response.status)) return undefined;
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      throw new Error(String(data?.error || data?.message || `CatsCo cloud model request failed: ${response.status}`));
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
