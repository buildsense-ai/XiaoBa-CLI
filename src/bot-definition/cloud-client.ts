import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import { normalizeReasoningEffort } from '../utils/reasoning-effort';
import type { ReasoningEffort } from '../types';
import type { CustomBotModelDefinition } from './types';

const CLOUD_MODEL_REQUEST_TIMEOUT_MS = 10_000;

export interface CloudBotModelSelection {
  /** Missing means catalog for compatibility with selections created by older callers. */
  kind?: 'catalog' | 'custom';
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  revision: number;
  customModel?: CustomBotModelDefinition;
}

export interface CloudBotModelClientOptions {
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

export async function pullCloudBotModelSelection(
  options: CloudBotModelClientOptions,
): Promise<CloudBotModelSelection | undefined> {
  const response = await cloudModelRequest(options, 'GET', '/api/bot/model-config');
  if (response === undefined) return undefined;
  if (response?.configured !== true) return undefined;
  const responseBotId = String(response?.uid ?? '').trim();
  const kind = normalizeCloudModelKind(response?.desired?.kind);
  const modelId = String(response?.desired?.model_id || '').trim();
  const revision = Number(response?.desired?.revision);
  const rawReasoning = String(response?.desired?.reasoning_effort || '').trim();
  const reasoningEffort = rawReasoning ? normalizeReasoningEffort(rawReasoning) : undefined;
  if (responseBotId !== String(options.botId).trim() || !modelId || !Number.isInteger(revision) || revision < 0) {
    throw new Error('CatsCo cloud returned an invalid bot model configuration.');
  }
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
  return { kind: 'catalog', modelId, revision, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function acknowledgeCloudBotModelSelection(
  options: CloudBotModelClientOptions,
  selection: CloudBotModelSelection,
  applyError = '',
): Promise<void> {
  await cloudModelRequest(options, 'POST', '/api/bot/model-config/ack', {
    revision: selection.revision,
    ...(selection.kind === 'custom' ? { kind: 'custom' } : {}),
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
  const apiBase = String(input?.api_base || '').trim().replace(/\/+$/, '');
  const model = String(input?.model || '').trim();
  const apiKey = String(input?.api_key || '').trim();
  const contextWindowTokens = Number(input?.context_window_tokens);
  const maxTokens = Number(input?.max_tokens);
  const temperature = input?.temperature === undefined || input?.temperature === null
    ? undefined
    : Number(input.temperature);
  const rawReasoning = String(input?.reasoning_effort || '').trim();
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
