import type { CatsCoAuthSnapshot } from './local-config';
import {
  findRelayModelProfile,
  relayModelProviderBaseUrl,
  type RelayModelProvider,
} from '../utils/relay-model-profiles';
import type { BotCatalogModelRuntime } from '../bot-definition/types';

const REQUEST_TIMEOUT_MS = 10_000;

export interface CatsRelayBootstrapOptions {
  botId: string;
  modelId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

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
  return {
    schema: 'xiaoba.bot-catalog-model-runtime.v1',
    botId,
    modelId: profile.id,
    provider: profile.preferredProvider,
    apiBase: relayEndpointForProvider(relayConfig, profile.preferredProvider),
    apiKey,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    reasoningEffort: 'high',
    openaiApiMode: 'chat_completions',
    capabilities: {
      vision: profile.capabilities.vision,
      toolCalling: profile.capabilities.toolCalling,
      streaming: profile.capabilities.streaming,
    },
  };
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
