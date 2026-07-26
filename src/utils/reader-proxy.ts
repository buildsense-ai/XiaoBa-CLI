import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatConfig } from '../types';

const DEFAULT_HTTP_BASE_URL = 'https://app.catsco.cc';
const DEFAULT_READER_API_PATH = '/api/reader';
const DEFAULT_TIMEOUT_MS = 300000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1500, 3000, 5000];

const STRICT_GUARDRAIL_PROMPT = [
  'Read this image conservatively and do not guess.',
  'Only report text or structure that is directly visible.',
  'If any text is blurry, cropped, tiny, or uncertain, write [unclear] instead of inferring.',
  'Preserve the original visible language.',
  'Do not infer document type, app name, business meaning, or context unless exact words are visible.',
  'Output useful observations for the current user request.',
].join(' ');

export interface ReaderProxyOptions {
  filePath: string;
  prompt?: string;
  config?: ChatConfig;
}

export interface ReaderProxyResult {
  ok: boolean;
  analysis?: string;
  error?: string;
  status?: number;
  attempts?: number;
}

function normalizePrompt(prompt?: string): string {
  const cleaned = (prompt || '').trim();
  if (!cleaned) {
    return `${STRICT_GUARDRAIL_PROMPT} Primary task: extract all visible text from this image in reading order.`;
  }
  return `${STRICT_GUARDRAIL_PROMPT} Current user task: ${cleaned}`;
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function resolveReaderBaseUrl(config?: ChatConfig): string {
  const explicit = (process.env.CATSCOMPANY_READER_API_URL || process.env.READER_PROXY_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const httpBaseUrl = (
    process.env.CATSCOMPANY_HTTP_BASE_URL
    || config?.catscompany?.httpBaseUrl
    || DEFAULT_HTTP_BASE_URL
  ).trim().replace(/\/+$/, '');

  return `${httpBaseUrl}${DEFAULT_READER_API_PATH}`;
}

function buildAuthHeaderCandidates(config?: ChatConfig): Array<Record<string, string>> {
  const candidates = [
    ...[
      process.env.READER_PROXY_API_KEY,
      process.env.CATSCO_API_KEY,
      process.env.CATSCOMPANY_API_KEY,
      config?.catscompany?.apiKey,
    ].map(value => ({ scheme: 'ApiKey', value })),
    ...[
      process.env.READER_PROXY_BEARER_TOKEN,
      process.env.CATSCO_BEARER_TOKEN,
      process.env.CATSCOMPANY_BEARER_TOKEN,
      process.env.CATSCO_USER_TOKEN,
      process.env.CATSCOMPANY_USER_TOKEN,
    ].map(value => ({ scheme: 'Bearer', value })),
  ];
  const seen = new Set<string>();
  const headers: Array<Record<string, string>> = [];
  for (const candidate of candidates) {
    const value = String(candidate.value || '').trim();
    if (!value) continue;
    const authorization = `${candidate.scheme} ${value}`;
    if (seen.has(authorization)) continue;
    seen.add(authorization);
    headers.push({ Authorization: authorization });
  }
  if (headers.length === 0) {
    throw new Error('Cats reader proxy could not find the current CatsCo account or bot authentication.');
  }
  return headers;
}

function appendField(chunks: Buffer[], boundary: string, name: string, value: string): void {
  chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`, 'utf8'));
  chunks.push(Buffer.from(value, 'utf8'));
  chunks.push(Buffer.from('\r\n', 'utf8'));
}

function appendFile(chunks: Buffer[], boundary: string, filePath: string): void {
  const filename = path.basename(filePath).replace(/"/g, '\\"');
  chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`, 'utf8'));
  chunks.push(Buffer.from(`Content-Type: ${guessContentType(filePath)}\r\n\r\n`, 'utf8'));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from('\r\n', 'utf8'));
}

function buildMultipartBody(filePath: string, fields: Record<string, string>): { body: Buffer; boundary: string } {
  const boundary = `catsco-reader-${crypto.randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    appendField(chunks, boundary, name, value);
  }

  appendFile(chunks, boundary, filePath);
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { body: Buffer.concat(chunks), boundary };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function analyzeImageWithReaderProxy(options: ReaderProxyOptions): Promise<ReaderProxyResult> {
  const baseUrl = resolveReaderBaseUrl(options.config);
  const analyzeUrl = `${baseUrl}/analyze`;
  const prompt = normalizePrompt(options.prompt);
  const { body, boundary } = buildMultipartBody(options.filePath, { prompt });
  let authCandidates: Array<Record<string, string>>;
  try {
    authCandidates = buildAuthHeaderCandidates(options.config);
  } catch (error: any) {
    return { ok: false, attempts: 0, error: String(error?.message || error || 'Unknown reader proxy auth error') };
  }
  let totalAttempts = 0;

  for (let authIndex = 0; authIndex < authCandidates.length; authIndex++) {
    const authHeaders = authCandidates[authIndex];
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      totalAttempts += 1;
      try {
        const response = await axios.post(analyzeUrl, body, {
          timeout: DEFAULT_TIMEOUT_MS,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          validateStatus: () => true,
          headers: {
            ...authHeaders,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
        });

        if (response.status !== 200) {
          const errorText = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data);

          if ((response.status === 401 || response.status === 403) && authIndex + 1 < authCandidates.length) {
            break;
          }
          if (attempt < maxAttempts && RETRYABLE_STATUS_CODES.has(response.status)) {
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }

          return {
            ok: false,
            status: response.status,
            attempts: totalAttempts,
            error: `Cats reader proxy returned ${response.status} after ${totalAttempts} attempt(s): ${errorText}`,
          };
        }

        const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (typeof payload?.analysis === 'string' && payload.analysis.trim()) {
          return { ok: true, attempts: totalAttempts, analysis: payload.analysis.trim() };
        }

        return { ok: true, attempts: totalAttempts, analysis: JSON.stringify(payload, null, 2) };
      } catch (error: any) {
        const message = String(error?.message || error || 'Unknown reader proxy error');
        if (attempt < maxAttempts && /timeout|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENOTFOUND/i.test(message)) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }

        return {
          ok: false,
          attempts: totalAttempts,
          error: message,
        };
      }
    }
  }

  return {
    ok: false,
    attempts: totalAttempts,
    error: 'Unknown reader proxy retry state',
  };
}
