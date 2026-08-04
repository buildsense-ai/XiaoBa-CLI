import axios from 'axios';
import { ChatConfig } from '../types';
import { IMAGE_ANALYSIS_GUARDRAIL, normalizeImageAnalysisTask } from './image-analysis-prompt';
import { prepareImageForModel } from './image-utils';
import { sanitizeProviderErrorMessageForLog } from './provider-error-log-sanitizer';

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1_000_000;

export interface VisionFallbackProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface VisionFallbackResult {
  ok: boolean;
  analysis?: string;
  error?: string;
  status?: number;
  configured: boolean;
  providerModel?: string;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

interface VisionFallbackProviderResolution {
  enabled: boolean;
  provider?: VisionFallbackProviderConfig;
  error?: string;
}

function resolveVisionFallbackProvider(config: ChatConfig): VisionFallbackProviderResolution {
  const configured = config.visionFallback;
  const enabled = envBoolean(process.env.CATSCOMPANY_VISION_FALLBACK_ENABLED) ?? configured?.enabled ?? false;
  if (!enabled) return { enabled: false };

  const reusePrimary = envBoolean(process.env.CATSCOMPANY_VISION_FALLBACK_USE_PRIMARY)
    ?? configured?.usePrimaryModel
    ?? false;
  if (reusePrimary && (config.provider === 'anthropic' || config.openaiApiMode === 'responses')) {
    return {
      enabled: true,
      error: 'Vision fallback usePrimaryModel requires an OpenAI Chat Completions compatible primary connection',
    };
  }

  const hasEnvironmentConnection = [
    process.env.CATSCOMPANY_VISION_FALLBACK_BASE_URL,
    process.env.CATSCOMPANY_VISION_FALLBACK_API_KEY,
    process.env.CATSCOMPANY_VISION_FALLBACK_MODEL,
  ].some(value => value !== undefined);
  const baseUrl = String((
    reusePrimary
      ? config.apiUrl
      : hasEnvironmentConnection
        ? process.env.CATSCOMPANY_VISION_FALLBACK_BASE_URL
        : configured?.baseUrl
  ) ?? '').trim();
  const apiKey = String((
    reusePrimary
      ? config.apiKey
      : hasEnvironmentConnection
        ? process.env.CATSCOMPANY_VISION_FALLBACK_API_KEY
        : configured?.apiKey
  ) ?? '').trim();
  const model = String((
    reusePrimary
      ? config.model
      : hasEnvironmentConnection
        ? process.env.CATSCOMPANY_VISION_FALLBACK_MODEL
        : configured?.model
  ) ?? '').trim();

  const missing = [
    !baseUrl ? 'baseUrl' : '',
    !apiKey ? 'apiKey' : '',
    !model ? 'model' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      enabled: true,
      error: `Vision fallback provider configuration is missing ${missing.join(', ')}`,
    };
  }

  return {
    enabled: true,
    provider: {
      baseUrl,
      apiKey,
      model,
      timeoutMs: parsePositiveInteger(
        process.env.CATSCOMPANY_VISION_FALLBACK_TIMEOUT_MS || configured?.timeoutMs,
        DEFAULT_TIMEOUT_MS,
      ),
      maxTokens: parsePositiveInteger(
        process.env.CATSCOMPANY_VISION_FALLBACK_MAX_TOKENS || configured?.maxTokens,
        DEFAULT_MAX_TOKENS,
      ),
    },
  };
}

export function resolveVisionFallbackProviderConfig(config: ChatConfig): VisionFallbackProviderConfig | undefined {
  return resolveVisionFallbackProvider(config).provider;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function extractAnalysis(data: any): string | undefined {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((block: any) => typeof block === 'string' ? block : block?.text)
      .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function sanitizeProviderError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error || 'unknown error');
  const withoutConfiguredKey = apiKey ? raw.split(apiKey).join('[redacted-token]') : raw;
  return sanitizeProviderErrorMessageForLog(withoutConfiguredKey);
}

export async function analyzeImageWithVisionFallback(options: {
  filePath: string;
  prompt: string;
  config: ChatConfig;
  signal?: AbortSignal;
}): Promise<VisionFallbackResult> {
  const resolution = resolveVisionFallbackProvider(options.config);
  if (!resolution.provider) {
    return {
      ok: false,
      configured: resolution.enabled,
      error: resolution.error || 'Vision fallback provider is disabled',
    };
  }
  const provider = resolution.provider;
  if (options.signal?.aborted) {
    return {
      ok: false,
      configured: true,
      error: 'Vision fallback request aborted',
      providerModel: provider.model,
    };
  }

  const requestController = new AbortController();
  let deadlineExpired = false;
  const abortFromCaller = () => requestController.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    requestController.abort();
  }, provider.timeoutMs);

  try {
    const preparedImage = await prepareImageForModel(options.filePath, provider.maxTokens);
    const imageData = preparedImage.buffer.toString('base64');
    const requestBody = {
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: IMAGE_ANALYSIS_GUARDRAIL,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: normalizeImageAnalysisTask(options.prompt) },
            {
              type: 'image_url',
              image_url: { url: `data:${preparedImage.mediaType};base64,${imageData}` },
            },
          ],
        },
      ],
      max_tokens: provider.maxTokens,
      stream: false,
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody), 'utf8');
    if (requestBytes > MAX_REQUEST_BYTES) {
      return {
        ok: false,
        configured: true,
        error: `Vision fallback request exceeds the ${MAX_REQUEST_BYTES} byte size limit`,
        providerModel: provider.model,
      };
    }

    const response = await axios.post(
      resolveChatCompletionsUrl(provider.baseUrl),
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: provider.timeoutMs,
        signal: requestController.signal,
        maxBodyLength: MAX_REQUEST_BYTES,
        maxContentLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
      },
    );

    const analysis = extractAnalysis(response.data);
    if (response.status >= 200 && response.status < 300 && analysis) {
      return {
        ok: true,
        configured: true,
        analysis,
        status: response.status,
        providerModel: provider.model,
      };
    }
    const providerError = analysis || response.data?.error?.message || `HTTP ${response.status}`;
    return {
      ok: false,
      configured: true,
      status: response.status,
      error: sanitizeProviderError(providerError, provider.apiKey),
      providerModel: provider.model,
    };
  } catch (error: any) {
    const abortError = options.signal?.aborted
      ? 'Vision fallback request aborted'
      : deadlineExpired
        ? `Vision fallback request timed out after ${provider.timeoutMs}ms`
        : undefined;
    return {
      ok: false,
      configured: true,
      status: error?.response?.status,
      error: abortError || sanitizeProviderError(error?.message || error, provider.apiKey),
      providerModel: provider.model,
    };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
