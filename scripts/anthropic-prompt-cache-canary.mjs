#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const CANONICAL_API_ORIGIN = 'https://api.anthropic.com';
const CANARY_SCHEMA = 'xiaoba.anthropic-prompt-cache-canary.v3';
const CANARY_MIN_STABLE_CHARS = 24_000;
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'];

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildCanarySystem(stableText, dynamicText) {
  return [
    {
      type: 'text',
      text: stableText,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: dynamicText,
    },
  ];
}

export function buildCapabilityProbeText(sourceText, minimumChars = CANARY_MIN_STABLE_CHARS) {
  const source = String(sourceText || '').trim();
  if (!source) throw new Error('Canary stable source text must not be empty.');
  const segments = [];
  while (segments.join('\n\n').length < minimumChars) {
    segments.push(source);
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

export function buildAttemptEvidence({ response, message, dynamicText }) {
  const responseUrl = new URL(response.url);
  const usage = message?.usage || {};
  const requestId = REQUEST_ID_HEADERS
    .map(header => response.headers.get(header))
    .find(Boolean);

  const attemptUsage = {};
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ]) {
    const value = reportedNumber(usage, key);
    if (value !== undefined) attemptUsage[key] = value;
  }

  return {
    request_id: requestId || null,
    message_id: typeof message?.id === 'string' ? message.id : null,
    api_path: responseUrl.pathname,
    dynamic_system_sha256: sha256(dynamicText),
    usage: attemptUsage,
  };
}

export function evaluateCanaryAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 'unobservable_usage';
  if (attempts.some(attempt => {
    const inputTokens = reportedNumber(attempt?.usage, 'input_tokens');
    const cacheReadTokens = reportedNumber(attempt?.usage, 'cache_read_input_tokens');
    const cacheCreationTokens = reportedNumber(attempt?.usage, 'cache_creation_input_tokens');
    if (inputTokens === undefined || cacheReadTokens === undefined || cacheCreationTokens === undefined) {
      return true;
    }
    const normalizedInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    return normalizedInputTokens <= 0 || cacheReadTokens > normalizedInputTokens;
  })) {
    return 'unobservable_usage';
  }
  const secondRead = reportedNumber(attempts?.[1]?.usage, 'cache_read_input_tokens');
  const anyRead = (attempts || []).some(attempt => (
    reportedNumber(attempt?.usage, 'cache_read_input_tokens') > 0
  ));
  const anyWrite = (attempts || []).some(attempt => (
    reportedNumber(attempt?.usage, 'cache_creation_input_tokens') > 0
  ));
  if (secondRead > 0) return 'passed';
  if (anyRead) return 'inconclusive_prior_entry';
  if (anyWrite) return 'failed_no_reuse';
  return 'unsupported_or_below_threshold';
}

export function buildCanaryEvidence({
  model,
  apiBase = CANONICAL_API_ORIGIN,
  sourceText,
  stableText,
  attempts,
  recordedAt = new Date(),
}) {
  const parsedBase = new URL(apiBase);
  const origin = parsedBase.origin;
  const normalizedBase = parsedBase.href.replace(/\/+$/, '');
  const canonical = origin === CANONICAL_API_ORIGIN;
  return {
    schema: CANARY_SCHEMA,
    recorded_at: recordedAt.toISOString(),
    api_kind: canonical ? 'canonical-anthropic' : 'anthropic-compatible',
    api_origin: canonical ? CANONICAL_API_ORIGIN : null,
    api_base_sha256: sha256(normalizedBase),
    model,
    source_system_sha256: sha256(sourceText ?? stableText),
    stable_system_sha256: sha256(stableText),
    stable_system_chars: stableText.length,
    verdict: evaluateCanaryAttempts(attempts),
    attempts,
  };
}

export async function runCanary({
  apiKey,
  model,
  stableText: sourceText,
  apiBase = CANONICAL_API_ORIGIN,
}) {
  const stableText = buildCapabilityProbeText(sourceText);
  const client = new Anthropic({
    apiKey,
    baseURL: apiBase,
    timeout: 10 * 60 * 1000,
  });
  const dynamicVariants = [
    '[transient_plan_status]\nPrompt-cache canary state A.',
    '[transient_plan_status]\nPrompt-cache canary state B.',
  ];
  const attempts = [];

  for (const dynamicText of dynamicVariants) {
    const pending = client.beta.promptCaching.messages.create({
      model,
      max_tokens: 1,
      system: buildCanarySystem(stableText, dynamicText),
      messages: [{
        role: 'user',
        content: 'Reply with one character.',
      }],
    });
    const { data: message, response } = await pending.withResponse();
    attempts.push(buildAttemptEvidence({ response, message, dynamicText }));
  }

  return buildCanaryEvidence({ model, apiBase, sourceText, stableText, attempts });
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
    '  ANTHROPIC_CANARY_API_KEY=... ANTHROPIC_CANARY_MODEL=... \\',
    '    npm run canary:anthropic-prompt-cache -- --run [--output evidence.json]',
    '',
    'Optional compatible endpoint:',
    '  ANTHROPIC_CANARY_API_BASE=https://... ANTHROPIC_CANARY_ALLOW_COMPATIBLE=true',
    '',
    'The command makes two API requests with a deterministic >=24k-character stable prefix.',
    'It never records prompt bodies, credentials, or a compatible endpoint in plaintext.',
  ].join('\n'));
}

function sanitizeError(error) {
  const source = error && typeof error === 'object' ? error : {};
  return {
    name: typeof source.name === 'string' ? source.name : 'Error',
    status: typeof source.status === 'number' ? source.status : null,
    request_id: typeof source.request_id === 'string' ? source.request_id : null,
    type: typeof source.error?.type === 'string' ? source.error.type : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const apiKey = process.env.ANTHROPIC_CANARY_API_KEY;
  const model = process.env.ANTHROPIC_CANARY_MODEL;
  if (!apiKey || !model) {
    console.error('ANTHROPIC_CANARY_API_KEY and ANTHROPIC_CANARY_MODEL are required.');
    process.exitCode = 2;
    return;
  }
  const apiBase = process.env.ANTHROPIC_CANARY_API_BASE || CANONICAL_API_ORIGIN;
  let origin;
  try {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:') throw new Error('HTTPS is required');
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('Credentials, query parameters, and fragments are not allowed');
    }
    origin = url.origin;
  } catch {
    console.error('ANTHROPIC_CANARY_API_BASE must be a valid HTTPS URL.');
    process.exitCode = 2;
    return;
  }
  if (
    origin !== CANONICAL_API_ORIGIN
    && !/^(1|true|yes)$/i.test(process.env.ANTHROPIC_CANARY_ALLOW_COMPATIBLE || '')
  ) {
    console.error('Compatible endpoints require ANTHROPIC_CANARY_ALLOW_COMPATIBLE=true.');
    process.exitCode = 2;
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const stableText = fs.readFileSync(path.join(scriptDir, '..', 'prompts', 'system-prompt.md'), 'utf8');

  try {
    const evidence = await runCanary({ apiKey, model, stableText, apiBase });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    const outputPath = parseOutputPath(args);
    if (outputPath) {
      const resolvedOutput = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, serialized, { mode: 0o600 });
      console.log(`Redacted canary evidence written to ${resolvedOutput}`);
      return;
    }
    process.stdout.write(serialized);
  } catch (error) {
    console.error(JSON.stringify({
      schema: CANARY_SCHEMA,
      error: sanitizeError(error),
    }));
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schema: CANARY_SCHEMA,
      error: sanitizeError(error),
    }));
    process.exitCode = 1;
  });
}
