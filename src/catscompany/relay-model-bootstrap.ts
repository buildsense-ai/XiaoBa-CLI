import type { CatsCoAuthSnapshot } from './local-config';
import {
  findRelayModelProfile,
  relayModelProviderBaseUrl,
  type RelayModelProvider,
} from '../utils/relay-model-profiles';
import type { BotCatalogModelRuntime } from '../bot-definition/types';
import type { ReasoningEffort } from '../types';
import { fetchModelsDevVision } from '../utils/models-dev-capabilities';

const REQUEST_TIMEOUT_MS = 10_000;
const CAPABILITY_REQUEST_TIMEOUT_MS = 3_000;

export interface CatsRelayBootstrapOptions {
  botId: string;
  modelId: string;
  auth: CatsCoAuthSnapshot;
  reasoningEffort?: ReasoningEffort;
  fetchImpl?: typeof fetch;
}

type RuntimeCapabilities = NonNullable<BotCatalogModelRuntime['capabilities']>;

/**
 * Obtains the device-local material needed to run a catalog model. The caller
 * owns the Definition write, so a failed request never creates a half-ready
 * bot Definition.
 */
export async function provisionCatsRelayCatalogRuntime(
  options: CatsRelayBootstrapOptions,
): Promise<BotCatalogModelRuntime> {
  const botId = String(options.botId || '').trim();
  const modelId = String(options.modelId || '').trim();
  const token = String(options.auth.token || '').trim();
  const httpBaseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
  const profile = findRelayModelProfile(modelId);
  if (!botId) throw new Error('Cannot initialize a catalog model without botId.');
  if (!profile) throw new Error(`Unknown CatsCo relay model: ${modelId}`);
  if (!token || !httpBaseUrl) {
    throw new Error('CatsCo account login is required before the default model can be initialized.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const relayConfig = await catsRequest(fetchImpl, httpBaseUrl, token, 'GET', '/api/relay/config');
  if (relayConfig?.self_service_enabled === false) {
    throw new Error('CatsCo relay self-service is unavailable, so the default model cannot be initialized.');
  }
  ensureRequestedModelIsAvailable(relayConfig, profile.id, profile.model);

  const apiKey = await ensurePlainRelayKey(fetchImpl, httpBaseUrl, token, options.auth);
  const modelsDevVisionRequest = fetchModelsDevVision({
    provider: profile.modelsDevProvider,
    model: profile.modelsDevModel,
  }, fetchImpl);
  const relayCapabilities = await fetchRelayModelCapabilities(
    fetchImpl,
    relayEndpointForProvider(relayConfig, 'openai'),
    apiKey,
    profile.model,
  );
  const modelsDevVision = typeof relayCapabilities?.vision === 'boolean'
    ? undefined
    : await modelsDevVisionRequest;
  const modelsDevCapabilities = typeof modelsDevVision === 'boolean' ? { vision: modelsDevVision } : undefined;
  const capabilities = mergeCapabilities(profile.capabilities, modelsDevCapabilities, relayCapabilities);
  const capabilitiesSource = relayCapabilities
    ? 'relay-models'
    : modelsDevCapabilities ? 'models-dev' : 'static';
  return {
    schema: 'xiaoba.bot-catalog-model-runtime.v1',
    botId,
    modelId: profile.id,
    provider: profile.preferredProvider,
    apiBase: relayEndpointForProvider(relayConfig, profile.preferredProvider),
    apiKey,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    reasoningEffort: options.reasoningEffort ?? 'high',
    openaiApiMode: profile.openaiApiMode ?? 'chat_completions',
    capabilities,
    capabilitiesSource,
    ...(capabilitiesSource !== 'static' ? { capabilitiesCheckedAt: new Date().toISOString() } : {}),
  };
}

export async function refreshCatsRelayCatalogRuntimeCapabilities(
  runtime: BotCatalogModelRuntime,
  fetchImpl: typeof fetch = fetch,
): Promise<BotCatalogModelRuntime> {
  const profile = findRelayModelProfile(runtime.modelId) ?? findRelayModelProfile(runtime.model);
  const modelsDevVisionRequest = fetchModelsDevVision({
    provider: profile?.modelsDevProvider,
    model: profile?.modelsDevModel || runtime.model,
  }, fetchImpl);
  const relayCapabilities = await fetchRelayModelCapabilities(
    fetchImpl,
    runtime.apiBase,
    runtime.apiKey,
    runtime.model,
  );
  const modelsDevVision = typeof relayCapabilities?.vision === 'boolean'
    ? undefined
    : await modelsDevVisionRequest;
  const modelsDevCapabilities = typeof modelsDevVision === 'boolean' ? { vision: modelsDevVision } : undefined;
  if (!relayCapabilities && !modelsDevCapabilities) {
    if (runtime.capabilitiesSource === 'relay-models' || runtime.capabilitiesSource === 'models-dev') return runtime;
    return {
      ...runtime,
      capabilities: mergeCapabilities(profile?.capabilities),
      capabilitiesSource: 'static',
    };
  }
  return {
    ...runtime,
    capabilities: mergeCapabilities(profile?.capabilities, modelsDevCapabilities, relayCapabilities),
    capabilitiesSource: relayCapabilities ? 'relay-models' : 'models-dev',
    capabilitiesCheckedAt: new Date().toISOString(),
  };
}

function mergeCapabilities(
  ...sources: Array<Partial<RuntimeCapabilities> | undefined>
): RuntimeCapabilities {
  const merged = Object.assign({}, ...sources.filter(Boolean));
  return {
    ...(typeof merged.vision === 'boolean' ? { vision: merged.vision } : {}),
    ...(typeof merged.toolCalling === 'boolean' ? { toolCalling: merged.toolCalling } : {}),
    ...(typeof merged.streaming === 'boolean' ? { streaming: merged.streaming } : {}),
  };
}

function relayModelsUrl(apiBase: string): string {
  const parsed = new URL(String(apiBase || '').trim());
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/anthropic$/i.test(path)) {
    parsed.pathname = path.replace(/\/anthropic$/i, '/v1/models');
  } else if (/\/v1$/i.test(path)) {
    parsed.pathname = `${path}/models`;
  } else if (/\/models$/i.test(path)) {
    parsed.pathname = path;
  } else {
    parsed.pathname = `${path}/v1/models`;
  }
  return parsed.toString();
}

async function fetchRelayModelCapabilities(
  fetchImpl: typeof fetch,
  apiBase: string,
  apiKey: string,
  modelName: string,
): Promise<RuntimeCapabilities | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPABILITY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(relayModelsUrl(apiBase), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as any;
    const requested = String(modelName || '').trim().toLowerCase();
    const item = Array.isArray(payload?.data)
      ? payload.data.find((candidate: any) => String(candidate?.id || '').trim().toLowerCase() === requested)
      : undefined;
    if (!item) return undefined;
    const capabilities = item.capabilities && typeof item.capabilities === 'object'
      ? item.capabilities
      : {};
    const rawModalities = capabilities.input_modalities ?? item.input_modalities;
    const modalities = Array.isArray(rawModalities)
      ? rawModalities.map((value: unknown) => String(value).trim().toLowerCase())
      : undefined;
    return {
      ...(typeof capabilities.vision === 'boolean'
        ? { vision: capabilities.vision }
        : modalities ? { vision: modalities.includes('image') } : {}),
      ...(typeof capabilities.tool_calling === 'boolean'
        ? { toolCalling: capabilities.tool_calling }
        : typeof capabilities.toolCalling === 'boolean' ? { toolCalling: capabilities.toolCalling } : {}),
      ...(typeof capabilities.streaming === 'boolean' ? { streaming: capabilities.streaming } : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensurePlainRelayKey(
  fetchImpl: typeof fetch,
  httpBaseUrl: string,
  token: string,
  auth: CatsCoAuthSnapshot,
): Promise<string> {
  const current = await catsRequest(fetchImpl, httpBaseUrl, token, 'GET', '/api/relay/key');
  const key = current?.key;
  const active = key && String(key.state || 'active') === 'active';
  const plain = String(key?.key || '').trim();
  if (active && plain) return plain;

  if (active) {
    const revealed = await catsRequest(fetchImpl, httpBaseUrl, token, 'POST', '/api/relay/key/reveal', {});
    const revealedPlain = String(revealed?.key?.key || '').trim();
    if (revealedPlain) return revealedPlain;
    throw new Error('CatsCo relay key exists but its plaintext could not be retrieved on this device.');
  }

  const created = await catsRequest(fetchImpl, httpBaseUrl, token, 'POST', '/api/relay/key', {
    name: auth.displayName || auth.username || (auth.uid ? `CatsCo user ${auth.uid}` : 'CatsCo desktop'),
  });
  const createdPlain = String(created?.key?.key || '').trim();
  if (!createdPlain) {
    throw new Error('CatsCo relay key was created without a plaintext value.');
  }
  return createdPlain;
}

function ensureRequestedModelIsAvailable(config: any, modelId: string, model: string): void {
  if (!Array.isArray(config?.models)) return;
  const requested = modelId.toLowerCase();
  const requestedModel = model.toLowerCase();
  const available = config.models.some((item: any) => (
    item?.enabled !== false
    && [String(item?.id || '').toLowerCase(), String(item?.model || '').toLowerCase()]
      .some(value => value === requested || value === requestedModel)
  ));
  if (!available) {
    throw new Error(`CatsCo relay does not currently provide the default model ${modelId}.`);
  }
}

function relayEndpointForProvider(config: any, provider: RelayModelProvider): string {
  const endpoints = Array.isArray(config?.endpoints) ? config.endpoints : [];
  const endpoint = endpoints.find((item: any) => {
    const protocol = String(item?.protocol || '').toLowerCase();
    return provider === 'openai' ? protocol.includes('openai') : protocol.includes('anthropic');
  });
  const baseUrl = String(config?.base_url || 'https://relay.catsco.cc').trim().replace(/\/+$/, '');
  const fallback = baseUrl === 'https://relay.catsco.cc'
    ? relayModelProviderBaseUrl(provider)
    : provider === 'openai' ? `${baseUrl}/v1` : `${baseUrl}/anthropic`;
  return String(endpoint?.base_url || fallback).trim().replace(/\/+$/, '');
}

async function catsRequest(
  fetchImpl: typeof fetch,
  httpBaseUrl: string,
  token: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${httpBaseUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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
    if (!response.ok) {
      throw new Error(String(data?.error || data?.message || `CatsCo relay request failed: ${response.status}`));
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
