import { AIService } from '../src/utils/ai-service';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const sessionKey = process.env.XIAOBA_CACHE_CANARY_SESSION
  || `responses-cache-large-tool-${Date.now()}`;
const largeChars = readPositiveInteger(process.env.XIAOBA_CACHE_CANARY_LARGE_CHARS, 64_000);

const service = new AIService({
  provider: 'openai',
  openaiApiMode: 'responses',
  ...(process.env.XIAOBA_CACHE_CANARY_API_KEY
    ? { apiKey: process.env.XIAOBA_CACHE_CANARY_API_KEY }
    : {}),
  ...(process.env.XIAOBA_CACHE_CANARY_API_URL
    ? { apiUrl: process.env.XIAOBA_CACHE_CANARY_API_URL }
    : {}),
  ...(process.env.XIAOBA_CACHE_CANARY_MODEL
    ? { model: process.env.XIAOBA_CACHE_CANARY_MODEL }
    : {}),
  maxTokens: 64,
  temperature: 0,
});

const tools: ToolDefinition[] = [{
  name: 'read_file',
  description: 'Read a file and return its contents.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
    },
    required: ['file_path'],
  },
}];

const stableInstructions = Array.from({ length: 280 }, (_, index) => (
  `Stable cache canary instruction ${index + 1}: preserve the exact prior transcript and inspect tool evidence.`
)).join('\n');
const smallOutput = Array.from({ length: 40 }, (_, index) => (
  `${index + 1}: small read result line used to establish a normal cached prefix.`
)).join('\n');
const largeOutput = Array.from({ length: Math.max(1, Math.ceil(largeChars / 96)) }, (_, index) => (
  `${index + 1}: large read result evidence ${String(index).padStart(6, '0')} `
  + 'abcdefghijklmnopqrstuvwxyz 0123456789 cache-prefix-continuity'
)).join('\n').slice(0, largeChars);

const smallMessages: Message[] = [
  { role: 'system', content: stableInstructions },
  { role: 'user', content: 'Run the cache canary and acknowledge the read_file evidence.' },
  toolCall('canary-small-call', 'canary-small.txt'),
  {
    role: 'tool',
    name: 'read_file',
    tool_call_id: 'canary-small-call',
    content: smallOutput,
  },
];
const largeMessages: Message[] = [
  ...smallMessages,
  toolCall('canary-large-call', 'canary-large.txt'),
  {
    role: 'tool',
    name: 'read_file',
    tool_call_id: 'canary-large-call',
    content: largeOutput,
  },
];

const options = {
  promptCacheContext: {
    sessionKey,
    phase: 'normal' as const,
    explicitCaching: false,
  },
};

async function main(): Promise<void> {
  const results = [];
  results.push(await run('small_cold', smallMessages));
  results.push(await run('small_repeat', smallMessages));
  results.push(await run('large_first', largeMessages));
  results.push(await run('large_repeat', largeMessages));

  process.stdout.write(`${JSON.stringify({
    session_key: sessionKey,
    large_chars: largeOutput.length,
    results,
  }, null, 2)}\n`);
}

async function run(label: string, messages: Message[]) {
  let streamedChars = 0;
  const response = await service.chatStream(
    cloneForRequest(messages),
    cloneForRequest(tools),
    { onText: text => { streamedChars += text.length; } },
    cloneForRequest(options),
  );
  return {
    label,
    input_tokens: response.usage?.promptTokens ?? null,
    cached_tokens: response.usage?.cachedReadTokens ?? null,
    cache_write_tokens: response.usage?.cachedWriteTokens ?? null,
    completion_tokens: response.usage?.completionTokens ?? null,
    streamed_chars: streamedChars,
  };
}

function cloneForRequest<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toolCall(id: string, filePath: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: filePath }),
      },
    }],
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
