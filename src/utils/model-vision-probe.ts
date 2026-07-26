import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatConfig } from '../types';
import { normalizeOpenAIChatCompletionsUrl, normalizeOpenAIResponsesUrl } from '../providers/openai-url';
import { PathResolver } from './path-resolver';

export type VisionCapabilityState = 'supported' | 'unsupported' | 'unknown';

interface CachedVisionCapability {
  state: VisionCapabilityState;
  checkedAt: string;
}

interface VisionCapabilityCache {
  schema: 'xiaoba.model-capability-cache.v1';
  entries: Record<string, CachedVisionCapability>;
}

type ProbeConfig = Pick<ChatConfig, 'apiUrl' | 'apiKey' | 'model' | 'provider' | 'openaiApiMode'>;

export interface VisionProbeOptions {
  fetchImpl?: typeof fetch;
  cachePath?: string;
  now?: () => Date;
  timeoutMs?: number;
  probeImageBase64?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const KNOWN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const PROBE_CODE = '731';
const PROBE_PROMPT = 'Return only the three digits visibly printed in this image. Do not guess.';
const inFlightProbes = new Map<string, Promise<VisionCapabilityState>>();

export async function probeVisionCapability(
  config: ProbeConfig,
  options: VisionProbeOptions = {},
): Promise<VisionCapabilityState> {
  const apiUrl = String(config.apiUrl || '').trim();
  const apiKey = String(config.apiKey || '').trim();
  const model = String(config.model || '').trim();
  if (!apiUrl || !apiKey || !model || !config.provider) return 'unknown';

  const now = options.now?.() ?? new Date();
  const cachePath = options.cachePath ?? PathResolver.getDataPath('model-capability-cache.json');
  const cacheKey = buildCacheKey(config);
  const inFlightKey = `${cachePath}\n${cacheKey}`;
  const cache = readCache(cachePath);
  const cached = cache.entries[cacheKey];
  if (cached && cacheEntryIsFresh(cached, now)) return cached.state;

  const existing = inFlightProbes.get(inFlightKey);
  if (existing) return existing;

  const pending = runProbe(config, options)
    .then(state => {
      const latestCache = readCache(cachePath);
      latestCache.entries[cacheKey] = { state, checkedAt: now.toISOString() };
      pruneCache(latestCache, now);
      writeCache(cachePath, latestCache);
      return state;
    })
    .finally(() => inFlightProbes.delete(inFlightKey));
  inFlightProbes.set(inFlightKey, pending);
  return pending;
}

async function runProbe(config: ProbeConfig, options: VisionProbeOptions): Promise<VisionCapabilityState> {
  const probeImageBase64 = options.probeImageBase64 ?? createProbeImageBase64();
  if (!probeImageBase64) return 'unknown';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const request = buildProbeRequest(config, probeImageBase64);
    const response = await (options.fetchImpl ?? fetch)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = parseJsonResponse(text);
    if (response.ok) {
      return extractResponseText(config, payload).includes(PROBE_CODE) ? 'supported' : 'unknown';
    }
    return isExplicitVisionRejection(response.status, text, payload) ? 'unsupported' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

function createProbeImageBase64(): string | undefined {
  try {
    // This dependency is already shipped for PDF rendering. Generating the
    // probe at runtime keeps source and packaged assets small.
    const canvasModule = require('@napi-rs/canvas') as {
      createCanvas: (width: number, height: number) => {
        getContext: (kind: '2d') => {
          fillStyle: string;
          font: string;
          textAlign: string;
          textBaseline: string;
          fillRect: (x: number, y: number, width: number, height: number) => void;
          fillText: (text: string, x: number, y: number) => void;
        };
        toBuffer: (mimeType: 'image/png') => Buffer;
      };
    };
    const canvas = canvasModule.createCanvas(220, 80);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 220, 80);
    context.fillStyle = '#000000';
    context.font = 'bold 48px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(PROBE_CODE, 110, 40);
    return canvas.toBuffer('image/png').toString('base64');
  } catch {
    return undefined;
  }
}

function buildProbeRequest(
  config: ProbeConfig,
  probeImageBase64: string,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const dataUrl = `data:image/png;base64,${probeImageBase64}`;
  if (config.provider === 'anthropic') {
    const base = String(config.apiUrl || '')
      .replace(/\/v1\/messages\/?$/i, '')
      .replace(/\/v1\/?$/i, '')
      .replace(/\/+$/, '');
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': String(config.apiKey),
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        max_tokens: 32,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROBE_PROMPT },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: probeImageBase64 } },
          ],
        }],
      },
    };
  }

  if (config.openaiApiMode === 'responses') {
    return {
      url: normalizeOpenAIResponsesUrl(String(config.apiUrl)),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: {
        model: config.model,
        max_output_tokens: 32,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: PROBE_PROMPT },
            { type: 'input_image', image_url: dataUrl },
          ],
        }],
      },
    };
  }

  return {
    url: normalizeOpenAIChatCompletionsUrl(String(config.apiUrl)),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: {
      model: config.model,
      max_tokens: 32,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROBE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    },
  };
}

function extractResponseText(config: Pick<ChatConfig, 'provider' | 'openaiApiMode'>, payload: any): string {
  if (config.provider === 'anthropic') {
    return Array.isArray(payload?.content)
      ? payload.content.map((item: any) => String(item?.text || '')).join('\n')
      : '';
  }
  if (config.openaiApiMode === 'responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text;
    return Array.isArray(payload?.output)
      ? payload.output
        .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .map((item: any) => String(item?.text || item?.output_text || ''))
        .join('\n')
      : '';
  }
  return String(payload?.choices?.[0]?.message?.content || '');
}

function isExplicitVisionRejection(status: number, rawText: string, payload: any): boolean {
  if (![400, 415, 422].includes(status)) return false;
  const message = `${rawText} ${payload?.error?.message || payload?.message || ''}`;
  return /image|vision|multimodal|modality|图片|视觉/i.test(message)
    && /unsupported|not support|does not support|invalid.*image|text.only|不支持|仅.*文本/i.test(message);
}

function parseJsonResponse(text: string): any {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function buildCacheKey(config: ProbeConfig): string {
  return createHash('sha256')
    .update([
      config.provider,
      config.openaiApiMode || '',
      String(config.apiUrl || '').trim(),
      String(config.model || '').trim(),
      String(config.apiKey || '').trim(),
    ].join('\n'))
    .digest('hex');
}

function cacheEntryIsFresh(entry: CachedVisionCapability, now: Date): boolean {
  const age = now.getTime() - Date.parse(entry.checkedAt);
  const ttl = entry.state === 'unknown' ? UNKNOWN_TTL_MS : KNOWN_TTL_MS;
  return Number.isFinite(age) && age >= 0 && age < ttl;
}

function readCache(cachePath: string): VisionCapabilityCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as VisionCapabilityCache;
    if (parsed?.schema === 'xiaoba.model-capability-cache.v1' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // Missing and damaged caches are both safe to rebuild.
  }
  return { schema: 'xiaoba.model-capability-cache.v1', entries: {} };
}

function pruneCache(cache: VisionCapabilityCache, now: Date): void {
  const entries = Object.entries(cache.entries)
    .filter(([, entry]) => {
      const age = now.getTime() - Date.parse(entry.checkedAt);
      return Number.isFinite(age) && age >= 0 && age < KNOWN_TTL_MS;
    })
    .sort((left, right) => Date.parse(right[1].checkedAt) - Date.parse(left[1].checkedAt))
    .slice(0, MAX_CACHE_ENTRIES);
  cache.entries = Object.fromEntries(entries);
}

function writeCache(cachePath: string, cache: VisionCapabilityCache): void {
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempPath, cachePath);
    } catch {
      // Windows may refuse replacing an existing file with rename.
      fs.copyFileSync(tempPath, cachePath);
      fs.rmSync(tempPath, { force: true });
    }
  } catch {
    // Capability probing must still work in read-only runtimes.
    try { fs.rmSync(tempPath, { force: true }); } catch { /* Best effort cleanup. */ }
  }
}
