import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ChatConfig } from '../types';

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_TOKENS = 4096;

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

export function resolveVisionFallbackProviderConfig(config: ChatConfig): VisionFallbackProviderConfig | undefined {
  const configured = config.visionFallback;
  const enabled = envBoolean(process.env.CATSCOMPANY_VISION_FALLBACK_ENABLED) ?? configured?.enabled ?? false;
  if (!enabled) return undefined;

  const reusePrimary = envBoolean(process.env.CATSCOMPANY_VISION_FALLBACK_USE_PRIMARY)
    ?? configured?.usePrimaryModel
    ?? false;
  const baseUrl = (process.env.CATSCOMPANY_VISION_FALLBACK_BASE_URL
    || configured?.baseUrl
    || (reusePrimary ? config.apiUrl : '')
    || '').trim();
  const apiKey = (process.env.CATSCOMPANY_VISION_FALLBACK_API_KEY
    || configured?.apiKey
    || (reusePrimary ? config.apiKey : '')
    || '').trim();
  const model = (process.env.CATSCOMPANY_VISION_FALLBACK_MODEL
    || configured?.model
    || (reusePrimary ? config.model : '')
    || '').trim();

  if (!baseUrl || !apiKey || !model) return undefined;
  return {
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
  };
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function guessContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/jpeg';
  }
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

export async function analyzeImageWithVisionFallback(options: {
  filePath: string;
  prompt: string;
  config: ChatConfig;
}): Promise<VisionFallbackResult> {
  const provider = resolveVisionFallbackProviderConfig(options.config);
  if (!provider) {
    return { ok: false, configured: false, error: 'Vision fallback provider is not configured or is incomplete' };
  }

  try {
    const imageData = fs.readFileSync(options.filePath).toString('base64');
    const response = await axios.post(
      resolveChatCompletionsUrl(provider.baseUrl),
      {
        model: provider.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: options.prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${guessContentType(options.filePath)};base64,${imageData}` },
            },
          ],
        }],
        max_tokens: provider.maxTokens,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: provider.timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      },
    );

    const analysis = extractAnalysis(response.data);
    if (response.status >= 200 && response.status < 300 && analysis) {
      return { ok: true, configured: true, analysis, status: response.status };
    }
    return {
      ok: false,
      configured: true,
      status: response.status,
      error: analysis || response.data?.error?.message || `HTTP ${response.status}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      configured: true,
      status: error?.response?.status,
      error: error?.message || String(error),
    };
  }
}
