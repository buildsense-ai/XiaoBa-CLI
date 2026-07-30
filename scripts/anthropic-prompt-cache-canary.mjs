#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const CANONICAL_API_ORIGIN = 'https://api.anthropic.com';
const CANARY_SCHEMA = 'xiaoba.anthropic-prompt-cache-canary.v1';
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

export function buildAttemptEvidence({ response, message, dynamicText }) {
  const responseUrl = new URL(response.url);
  const usage = message?.usage || {};
  const requestId = REQUEST_ID_HEADERS
    .map(header => response.headers.get(header))
    .find(Boolean);

  return {
    request_id: requestId || null,
    message_id: typeof message?.id === 'string' ? message.id : null,
    api_path: `${responseUrl.pathname}${responseUrl.search}`,
    dynamic_system_sha256: sha256(dynamicText),
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0),
      cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
    },
  };
}

export function buildCanaryEvidence({ model, stableText, attempts, recordedAt = new Date() }) {
  return {
    schema: CANARY_SCHEMA,
    recorded_at: recordedAt.toISOString(),
    api_origin: CANONICAL_API_ORIGIN,
    model,
    stable_system_sha256: sha256(stableText),
    attempts,
  };
}

export async function runCanary({ apiKey, model, stableText }) {
  const client = new Anthropic({
    apiKey,
    baseURL: CANONICAL_API_ORIGIN,
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

  return buildCanaryEvidence({ model, stableText, attempts });
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
    'The command makes two canonical Anthropic API requests and never records prompt bodies or credentials.',
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

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const stableText = fs.readFileSync(path.join(scriptDir, '..', 'prompts', 'system-prompt.md'), 'utf8');

  try {
    const evidence = await runCanary({ apiKey, model, stableText });
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
