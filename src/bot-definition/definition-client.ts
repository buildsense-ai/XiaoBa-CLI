import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import { normalizeReasoningEffort } from '../utils/reasoning-effort';
import {
  BOT_DEFINITION_SCHEMA,
  type BotDefinition,
  type BotDefinitionFieldPatch,
  type BotModelDefinition,
  type BotPromptDefinition,
  type CloudBotDefinitionSnapshot,
  type CustomBotModelDefinition,
} from './types';

const DEFINITION_REQUEST_TIMEOUT_MS = 10_000;

export type CloudBotDefinitionPullResult =
  | { kind: 'found'; snapshot: CloudBotDefinitionSnapshot }
  | { kind: 'migration_required'; legacyModel?: BotModelDefinition }
  | { kind: 'unsupported' };

export class BotDefinitionRevisionConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super('CatsCo BotDefinition revision conflict.');
    this.name = 'BotDefinitionRevisionConflictError';
  }
}

export interface CloudBotDefinitionClientOptions {
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

export async function pullCloudBotDefinition(
  options: CloudBotDefinitionClientOptions,
): Promise<CloudBotDefinitionPullResult> {
  const response = await request(options, 'runtime', 'GET', '/api/bot/definition');
  if (response.kind === 'unsupported') return response;
  if (response.kind === 'migration_required') {
    return {
      kind: 'migration_required',
      ...(response.data?.legacy_model
        ? { legacyModel: parseModel(response.data.legacy_model, true) }
        : {}),
    };
  }
  if (response.kind !== 'ok') {
    throw new BotDefinitionRevisionConflictError(response.currentRevision);
  }
  return { kind: 'found', snapshot: parseSnapshot(response.data, options.botId, true) };
}

export async function patchCloudBotDefinition(
  options: CloudBotDefinitionClientOptions,
  expectedRevision: number,
  changes: BotDefinitionFieldPatch,
): Promise<CloudBotDefinitionSnapshot> {
  const response = await request(
    options,
    'owner',
    'PATCH',
    `/api/bots/definition?uid=${encodeURIComponent(options.botId)}`,
    {
      expected_revision: expectedRevision,
      ...(changes.model ? { model: changes.model } : {}),
      ...(changes.savedCustomModel ? { savedCustomModel: changes.savedCustomModel } : {}),
      ...(changes.prompt ? { prompt: changes.prompt } : {}),
    },
  );
  if (response.kind === 'conflict') {
    throw new BotDefinitionRevisionConflictError(response.currentRevision);
  }
  if (response.kind !== 'ok') {
    throw new Error('CatsCo BotDefinition PATCH is unavailable.');
  }
  const committedRevision = Number(response.data?.revision);
  const runtime = await pullCloudBotDefinition(options);
  if (
    runtime.kind !== 'found'
    || !Number.isInteger(committedRevision)
    || runtime.snapshot.revision !== committedRevision
  ) {
    throw new Error('CatsCo committed BotDefinition but the runtime snapshot is not yet readable.');
  }
  return runtime.snapshot;
}

export async function acknowledgeCloudBotDefinition(
  options: CloudBotDefinitionClientOptions,
  revision: number,
  applyError = '',
): Promise<void> {
  const response = await request(options, 'runtime', 'POST', '/api/bot/definition/ack', {
    revision,
    ...(applyError ? { error: applyError } : {}),
  });
  if (response.kind === 'conflict') {
    throw new BotDefinitionRevisionConflictError(response.currentRevision);
  }
  if (response.kind !== 'ok') {
    throw new Error('CatsCo BotDefinition ACK is unavailable.');
  }
}

export function redactBotDefinitionError(error: unknown, definition?: BotDefinition): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [
    definition?.model.kind === 'custom' ? definition.model.apiKey : '',
    definition?.savedCustomModel?.apiKey || '',
  ].filter(Boolean);
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  return message;
}

function parseSnapshot(value: any, expectedBotId: string, runtime: boolean): CloudBotDefinitionSnapshot {
  const revision = Number(value?.revision);
  const definition = parseDefinition(value?.definition, expectedBotId, runtime);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error('CatsCo returned an invalid BotDefinition revision.');
  }
  return {
    definition,
    revision,
    ...(String(value?.updatedAt || '').trim() ? { updatedAt: String(value.updatedAt).trim() } : {}),
  };
}

function parseDefinition(value: any, expectedBotId: string, runtime: boolean): BotDefinition {
  const schema = String(value?.schema || '').trim();
  const botId = String(value?.botId || '').trim();
  if (schema !== BOT_DEFINITION_SCHEMA || botId !== expectedBotId) {
    throw new Error('CatsCo returned a BotDefinition for a different bot or schema.');
  }
  const prompt = parsePrompt(value?.prompt);
  const model = parseModel(value?.model, runtime);
  const savedCustomModel = value?.savedCustomModel
    ? parseCustomModel(value.savedCustomModel, runtime)
    : undefined;
  return {
    schema: BOT_DEFINITION_SCHEMA,
    botId,
    model,
    ...(savedCustomModel ? { savedCustomModel } : {}),
    prompt,
  };
}

function parsePrompt(value: any): BotPromptDefinition {
  const selected = String(value?.selected || '').trim();
  const customSystemPrompt = value?.customSystemPrompt === undefined
    ? undefined
    : String(value.customSystemPrompt).trim();
  if (selected !== 'default' && selected !== 'custom') {
    throw new Error('CatsCo returned an invalid BotDefinition prompt selection.');
  }
  if (selected === 'custom' && !customSystemPrompt) {
    throw new Error('CatsCo returned an empty custom system prompt.');
  }
  return {
    selected,
    ...(customSystemPrompt ? { customSystemPrompt } : {}),
  };
}

function parseModel(value: any, runtime: boolean): BotModelDefinition {
  const kind = String(value?.kind || '').trim().toLowerCase();
  if (kind === 'catalog') {
    const modelId = String(value?.modelId || '').trim();
    const rawReasoning = String(value?.reasoningEffort || '').trim();
    const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
    if (!modelId || (rawReasoning && !reasoningEffort)) {
      throw new Error('CatsCo returned an invalid catalog model definition.');
    }
    return { kind: 'catalog', modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  if (kind !== 'custom') {
    throw new Error('CatsCo returned an unsupported BotDefinition model kind.');
  }
  return parseCustomModel(value, runtime);
}

function parseCustomModel(value: any, runtime: boolean): CustomBotModelDefinition {
  const protocol = String(value?.protocol || '').trim().toLowerCase();
  const apiBase = String(value?.apiBase || '').trim().replace(/\/+$/, '');
  const model = String(value?.model || '').trim();
  const apiKey = String(value?.apiKey || '').trim();
  const contextWindowTokens = Number(value?.contextWindowTokens);
  const maxTokens = value?.maxTokens === undefined ? undefined : Number(value.maxTokens);
  const temperature = value?.temperature === undefined ? undefined : Number(value.temperature);
  const rawReasoning = String(value?.reasoningEffort || '').trim();
  const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
  if (!['anthropic', 'openai-chat-completions', 'openai-responses'].includes(protocol)) {
    throw new Error('CatsCo returned an unsupported custom model protocol.');
  }
  if (!apiBase || !/^https?:\/\//i.test(apiBase) || !model || (runtime && !apiKey)) {
    throw new Error('CatsCo returned an incomplete custom model definition.');
  }
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 1024 || contextWindowTokens > 4_000_000) {
    throw new Error('CatsCo returned an invalid custom model context window.');
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 1_000_000)) {
    throw new Error('CatsCo returned invalid custom model max tokens.');
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error('CatsCo returned invalid custom model temperature.');
  }
  if (rawReasoning && !reasoningEffort) {
    throw new Error('CatsCo returned an unsupported custom model reasoning effort.');
  }
  return {
    kind: 'custom',
    protocol: protocol as CustomBotModelDefinition['protocol'],
    apiBase,
    model,
    apiKey,
    contextWindowTokens,
    ...(maxTokens ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

type RequestResult =
  | { kind: 'ok'; data: any }
  | { kind: 'migration_required'; data: any }
  | { kind: 'conflict'; currentRevision?: number }
  | { kind: 'unsupported' };

async function request(
  options: CloudBotDefinitionClientOptions,
  authKind: 'owner' | 'runtime',
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<RequestResult> {
  const httpBaseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
  const credential = authKind === 'owner'
    ? String(options.auth.token || '').trim()
    : String(options.auth.apiKey || '').trim();
  if (!httpBaseUrl || !credential) return { kind: 'unsupported' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFINITION_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${httpBaseUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authKind === 'owner' ? `Bearer ${credential}` : `ApiKey ${credential}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if ([404, 405, 501].includes(response.status)) return { kind: 'unsupported' };
    if (response.status === 409 && data?.error === 'migration_required') {
      return { kind: 'migration_required', data };
    }
    if (response.status === 409 && data?.error === 'revision_conflict') {
      const currentRevision = Number(data?.current_revision);
      return {
        kind: 'conflict',
        ...(Number.isInteger(currentRevision) && currentRevision >= 0 ? { currentRevision } : {}),
      };
    }
    if (!response.ok) {
      throw new Error(String(data?.error || data?.message || `CatsCo BotDefinition request failed: ${response.status}`));
    }
    return { kind: 'ok', data };
  } finally {
    clearTimeout(timeout);
  }
}
