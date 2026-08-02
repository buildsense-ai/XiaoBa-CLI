#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const CANARY_SCHEMA = 'xiaoba.provider-cache-canary.v2';
const CANARY_MIN_STABLE_CHARS = 24_000;
const OFFICIAL_ORIGINS = new Set(['https://api.openai.com', 'https://api.deepseek.com']);

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function buildCapabilityProbeText(sourceText, minimumChars = CANARY_MIN_STABLE_CHARS) {
  const source = String(sourceText || '').trim();
  if (!source) throw new Error('Canary stable source text must not be empty.');
  const segments = [];
  let chars = 0;
  while (chars < minimumChars) {
    segments.push(source);
    chars += source.length + 2;
  }
  return segments.join('\n\n');
}

function reportedNumber(value, key) {
  if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
    return undefined;
  }
  const raw = value[key];
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasReportedNumber(value, key) {
  return reportedNumber(value, key) !== undefined;
}

export function buildAttemptUsage(usage) {
  const attemptUsage = {};
  const inputTokens = reportedNumber(usage, 'promptTokens');
  const cacheReadTokens = reportedNumber(usage, 'cachedReadTokens');
  const cacheWriteTokens = reportedNumber(usage, 'cachedWriteTokens');
  const outputTokens = reportedNumber(usage, 'completionTokens');
  if (inputTokens !== undefined) attemptUsage.input_tokens = inputTokens;
  if (cacheReadTokens !== undefined) attemptUsage.cache_read_tokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) attemptUsage.cache_write_tokens = cacheWriteTokens;
  if (outputTokens !== undefined) attemptUsage.output_tokens = outputTokens;
  return attemptUsage;
}

export function evaluateCanaryAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 'unsupported_usage';
  if (attempts.some(attempt => {
    const inputTokens = reportedNumber(attempt?.usage, 'input_tokens');
    const cacheReadTokens = reportedNumber(attempt?.usage, 'cache_read_tokens');
    const cacheWriteTokens = reportedNumber(attempt?.usage, 'cache_write_tokens');
    return inputTokens === undefined
      || inputTokens <= 0
      || cacheReadTokens === undefined
      || cacheReadTokens > inputTokens
      || (cacheWriteTokens !== undefined && cacheWriteTokens > inputTokens);
  })) {
    return 'unobservable_usage';
  }
  const laterAttempts = (attempts || []).slice(1);
  if (laterAttempts.some(attempt => reportedNumber(attempt?.usage, 'cache_read_tokens') > 0)) {
    return 'passed';
  }
  if ((attempts || []).some(attempt => reportedNumber(attempt?.usage, 'input_tokens') > 0)) {
    return 'failed_no_reuse';
  }
  return 'unsupported_usage';
}

export function buildCanaryEvidence({
  apiBase,
  model,
  apiMode,
  sourceText,
  stableText,
  attempts,
  recordedAt = new Date(),
}) {
  const parsed = new URL(apiBase);
  const origin = parsed.origin;
  const apiKind = origin === 'https://api.openai.com'
    ? 'canonical-openai'
    : origin === 'https://api.deepseek.com'
      ? 'canonical-deepseek'
      : 'openai-compatible';
  return {
    schema: CANARY_SCHEMA,
    recorded_at: recordedAt.toISOString(),
    api_kind: apiKind,
    api_origin: OFFICIAL_ORIGINS.has(origin) ? origin : null,
    api_base_sha256: sha256(parsed.href.replace(/\/+$/, '')),
    api_mode: apiMode,
    model,
    source_system_sha256: sha256(sourceText),
    stable_system_sha256: sha256(stableText),
    stable_system_chars: stableText.length,
    verdict: evaluateCanaryAttempts(attempts),
    attempts,
  };
}

export async function runCanary({
  apiKey,
  apiBase,
  model,
  apiMode = 'chat_completions',
  stableText: sourceText,
  maxTokens = 16,
  requestTimeoutMs = 120_000,
}) {
  const { OpenAIProvider } = require('../dist/providers/openai-provider.js');
  const stableText = buildCapabilityProbeText(sourceText);
  const provider = new OpenAIProvider({
    apiKey,
    apiUrl: apiBase,
    model,
    maxTokens,
    openaiApiMode: apiMode,
  });
  const dynamicVariants = [
    'Cache canary suffix A. Reply with OK.',
    'Cache canary suffix B. Reply with OK.',
    'Cache canary suffix C. Reply with OK.',
  ];
  const attempts = [];

  for (const dynamicText of dynamicVariants) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await provider.chat([
        { role: 'system', content: stableText },
        { role: 'user', content: dynamicText },
      ], undefined, {
        signal: controller.signal,
        cachePartitionKey: `canary-${sha256(`${apiBase}\0${model}`).slice(0, 16)}`,
      });
      const usage = response?.usage;
      attempts.push({
        dynamic_suffix_sha256: sha256(dynamicText),
        stop_reason: response?.stopReason || null,
        usage: buildAttemptUsage(usage),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return buildCanaryEvidence({ apiBase, model, apiMode, sourceText, stableText, attempts });
}

function parseOutputPath(args) {
  const inline = args.find(arg => arg.startsWith('--output='));
  if (inline) return inline.slice('--output='.length);
  const index = args.indexOf('--output');
  return index >= 0 ? args[index + 1] : undefined;
}

function printUsage() {
  console.error([
    'Usage:',
    '  XIAOBA_CANARY_API_KEY=... XIAOBA_CANARY_API_BASE=https://... \\',
    '  XIAOBA_CANARY_MODEL=... npm run canary:provider-cache -- --run',
    '',
    'Optional:',
    '  XIAOBA_CANARY_API_MODE=chat_completions|responses',
    '  XIAOBA_CANARY_ALLOW_COMPATIBLE=true',
    '  XIAOBA_CANARY_MAX_TOKENS=16',
    '',
    'The command makes three billable requests with a deterministic >=24k-character stable prefix.',
    'It never records prompt bodies, credentials, response text, or compatible endpoint origins.',
  ].join('\n'));
}

function sanitizeError(error) {
  const source = error && typeof error === 'object' ? error : {};
  return {
    name: typeof source.name === 'string' ? source.name : 'Error',
    status: Number.isFinite(Number(source.status ?? source.response?.status))
      ? Number(source.status ?? source.response?.status)
      : null,
    code: typeof source.code === 'string' ? source.code : null,
    request_id: typeof source.request_id === 'string' ? source.request_id : null,
    provider_type: typeof source.error?.type === 'string' ? source.error.type : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.XIAOBA_CANARY_API_KEY;
  const apiBase = process.env.XIAOBA_CANARY_API_BASE;
  const model = process.env.XIAOBA_CANARY_MODEL;
  const apiMode = process.env.XIAOBA_CANARY_API_MODE || 'chat_completions';
  if (!apiKey || !apiBase || !model) {
    console.error('XIAOBA_CANARY_API_KEY, XIAOBA_CANARY_API_BASE, and XIAOBA_CANARY_MODEL are required.');
    process.exitCode = 2;
    return;
  }
  if (!['chat_completions', 'responses'].includes(apiMode)) {
    console.error('XIAOBA_CANARY_API_MODE must be chat_completions or responses.');
    process.exitCode = 2;
    return;
  }
  let parsed;
  try {
    parsed = new URL(apiBase);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Unsafe API URL');
    }
  } catch {
    console.error('XIAOBA_CANARY_API_BASE must be a credential-free HTTPS URL.');
    process.exitCode = 2;
    return;
  }
  if (
    !OFFICIAL_ORIGINS.has(parsed.origin)
    && !/^(1|true|yes)$/i.test(process.env.XIAOBA_CANARY_ALLOW_COMPATIBLE || '')
  ) {
    console.error('Compatible endpoints require XIAOBA_CANARY_ALLOW_COMPATIBLE=true.');
    process.exitCode = 2;
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const stableText = fs.readFileSync(path.join(scriptDir, '..', 'prompts', 'system-prompt.md'), 'utf8');
  const maxTokens = Math.max(1, Math.min(128, Number(process.env.XIAOBA_CANARY_MAX_TOKENS || 16)));
  try {
    const evidence = await runCanary({ apiKey, apiBase, model, apiMode, stableText, maxTokens });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    const outputPath = parseOutputPath(args);
    if (outputPath) {
      const resolved = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, serialized, { mode: 0o600 });
      console.log(`Redacted canary evidence written to ${resolved}`);
      return;
    }
    process.stdout.write(serialized);
  } catch (error) {
    console.error(JSON.stringify({ schema: CANARY_SCHEMA, error: sanitizeError(error) }));
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch(error => {
    console.error(JSON.stringify({ schema: CANARY_SCHEMA, error: sanitizeError(error) }));
    process.exitCode = 1;
  });
}
