#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const CANARY_SCHEMA = 'xiaoba.deepseek-reasoning-canary.v2';
const CANONICAL_ORIGIN = 'https://api.deepseek.com';

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
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

function buildUsageEvidence(usage) {
  const result = {};
  const inputTokens = reportedNumber(usage, 'promptTokens');
  const cacheReadTokens = reportedNumber(usage, 'cachedReadTokens');
  const outputTokens = reportedNumber(usage, 'completionTokens');
  if (inputTokens !== undefined) result.input_tokens = inputTokens;
  if (cacheReadTokens !== undefined) result.cache_read_tokens = cacheReadTokens;
  if (outputTokens !== undefined) result.output_tokens = outputTokens;
  return result;
}

export function buildCanaryEvidence({ apiBase, model, first, second, recordedAt = new Date() }) {
  const parsed = new URL(apiBase);
  const canonical = parsed.origin === CANONICAL_ORIGIN;
  const providerTypes = Array.isArray(first?.providerContent)
    ? first.providerContent.map(item => String(item?.type || '')).filter(Boolean)
    : [];
  return {
    schema: CANARY_SCHEMA,
    recorded_at: recordedAt.toISOString(),
    api_kind: canonical ? 'canonical-deepseek' : 'openai-compatible',
    api_origin: canonical ? CANONICAL_ORIGIN : null,
    api_base_sha256: sha256(parsed.href.replace(/\/+$/, '')),
    model,
    verdict: first?.toolCalls?.length && second ? 'passed' : 'inconclusive_no_tool_call',
    first: {
      stop_reason: first?.stopReason || null,
      tool_calls: Number(first?.toolCalls?.length || 0),
      provider_content_types: providerTypes,
      has_reasoning: providerTypes.includes('openai_reasoning'),
    },
    second: second ? {
      stop_reason: second.stopReason || null,
      text_present: Boolean(second.content),
      tool_calls: Number(second.toolCalls?.length || 0),
      usage: buildUsageEvidence(second.usage),
    } : null,
  };
}

export async function runCanary({ apiKey, apiBase, model, requestTimeoutMs = 120_000 }) {
  const { OpenAIProvider } = require('../dist/providers/openai-provider.js');
  const provider = new OpenAIProvider({
    apiKey,
    apiUrl: apiBase,
    model,
    maxTokens: 256,
    openaiApiMode: 'chat_completions',
    reasoningEffort: 'high',
  });
  const tool = {
    name: 'canary_echo',
    description: 'Return the supplied value unchanged.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  };
  const seed = [
    { role: 'system', content: 'You are a tool replay protocol canary.' },
    {
      role: 'user',
      content: 'You must call canary_echo exactly once with value ping. Do not answer directly.',
    },
  ];
  const call = async messages => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await provider.chat(messages, [tool], { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const first = await call(seed);
  const toolCall = first.toolCalls?.[0];
  if (!toolCall) return buildCanaryEvidence({ apiBase, model, first });
  const second = await call([
    ...seed,
    {
      role: 'assistant',
      content: first.content,
      tool_calls: first.toolCalls,
      providerContent: first.providerContent,
      providerState: first.providerState,
    },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: 'ping',
    },
  ]);
  return buildCanaryEvidence({ apiBase, model, first, second });
}

function parseOutputPath(args) {
  const inline = args.find(arg => arg.startsWith('--output='));
  if (inline) return inline.slice('--output='.length);
  const index = args.indexOf('--output');
  return index >= 0 ? args[index + 1] : undefined;
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
    console.error([
      'Usage:',
      '  XIAOBA_CANARY_API_KEY=... XIAOBA_CANARY_API_BASE=https://api.deepseek.com \\',
      '  XIAOBA_CANARY_MODEL=... npm run canary:deepseek-reasoning -- --run',
      '',
      'Compatible endpoints also require XIAOBA_CANARY_ALLOW_COMPATIBLE=true.',
      'The command makes two billable requests and records no prompt, response, or credential values.',
    ].join('\n'));
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.XIAOBA_CANARY_API_KEY;
  const apiBase = process.env.XIAOBA_CANARY_API_BASE;
  const model = process.env.XIAOBA_CANARY_MODEL;
  if (!apiKey || !apiBase || !model) {
    console.error('XIAOBA_CANARY_API_KEY, XIAOBA_CANARY_API_BASE, and XIAOBA_CANARY_MODEL are required.');
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
    parsed.origin !== CANONICAL_ORIGIN
    && !/^(1|true|yes)$/i.test(process.env.XIAOBA_CANARY_ALLOW_COMPATIBLE || '')
  ) {
    console.error('Compatible endpoints require XIAOBA_CANARY_ALLOW_COMPATIBLE=true.');
    process.exitCode = 2;
    return;
  }

  try {
    const evidence = await runCanary({ apiKey, apiBase, model });
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
