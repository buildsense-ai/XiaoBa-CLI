import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TRUNCATED_READ_FILE_PREFIX,
  foldHistoricalReadFileMessages,
  resolveReadFileMessageFoldingOptions,
} from '../src/core/read-file-message-folder';
import { ConversationRunner } from '../src/core/conversation-runner';
import { Message } from '../src/types';
import { ToolExecutor } from '../src/types/tool';

function makeReadFileOutput(path: string, lineCount = 80): string {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const lineNumber = index + 1;
    return `${String(lineNumber).padStart(5, ' ')}→ plain historical content line ${lineNumber}`;
  });
  return [
    `文件: ${path}`,
    `Path: ${path}`,
    `总行数: ${lineCount}`,
    `显示: 1-${lineCount}`,
    '',
    lines.join('\n'),
  ].join('\n');
}

function makeToolCallMessage(id: string, filePath: string): Message {
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

test('folds large historical read_file tool results while preserving tool exchange ids', () => {
  const raw = makeReadFileOutput('E:/repo/large.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: '先看一下 large.ts' },
    makeToolCallMessage('call_old_read', 'E:/repo/large.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_old_read', content: raw },
    { role: 'assistant', content: '看完了。' },
    { role: 'user', content: '继续说结论' },
  ];

  const result = foldHistoricalReadFileMessages(messages, {
    thresholdTokens: 20,
    maxPreviewLines: 2,
    maxSymbolLines: 2,
  });
  const folded = result.messages[2];

  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.candidate_count, 1);
  assert.equal(folded.tool_call_id, 'call_old_read');
  assert.equal(folded.name, 'read_file');
  assert.equal(typeof folded.content, 'string');
  assert.ok(String(folded.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.match(String(folded.content), /artifact_id: rf_[a-f0-9]{16}/);
  assert.match(String(folded.content), /path: E:\/repo\/large\.ts/);
  assert.equal(String(folded.content).includes('plain historical content line 45'), false);
  assert.ok(result.stats.saved_tokens_est > 0);
});

test('writes truncated read_file full output to a linkable artifact', () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-read-artifacts-'));
  const raw = makeReadFileOutput('E:/repo/linked-large.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read linked-large.ts' },
    makeToolCallMessage('call_linked_read', 'E:/repo/linked-large.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_linked_read', content: raw },
    { role: 'assistant', content: 'read complete' },
    { role: 'user', content: 'continue' },
  ];

  try {
    const result = foldHistoricalReadFileMessages(messages, {
      thresholdTokens: 20,
      artifactStore: {
        enabled: true,
        rootDirectory: artifactRoot,
        sessionId: 'test session',
        turn: 7,
      },
    });
    const content = String(result.messages[2].content);
    const fullOutputPath = content.match(/^full_output_path: (.+)$/m)?.[1];

    assert.ok(content.startsWith(TRUNCATED_READ_FILE_PREFIX));
    assert.match(content, /full_output_ref: tool-result:\/\/test_session\/rf_[a-f0-9]{16}/);
    assert.match(content, /full_output_link: file:\/\//);
    assert.ok(fullOutputPath);
    assert.equal(fs.readFileSync(fullOutputPath, 'utf8').includes(raw), true);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('keeps folded historical artifact references byte-identical across inference turns', () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-stable-read-artifacts-'));
  const raw = makeReadFileOutput('E:/repo/stable-large.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read stable-large.ts' },
    makeToolCallMessage('call_stable_read', 'E:/repo/stable-large.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_stable_read', content: raw },
    { role: 'assistant', content: 'read complete' },
    { role: 'user', content: 'continue' },
  ];

  try {
    const foldAtTurn = (turn: number) => foldHistoricalReadFileMessages(messages, {
      thresholdTokens: 20,
      artifactStore: {
        enabled: true,
        rootDirectory: artifactRoot,
        sessionId: 'stable session',
        turn,
      },
    }).messages[2];

    const first = foldAtTurn(1);
    const second = foldAtTurn(2);

    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.match(String(first.content), /full_output_ref: tool-result:\/\/stable_session\/rf_[a-f0-9]{16}/);
    assert.equal(String(first.content).includes('/turn-'), false);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('runner keeps the same historical provider tool result byte-identical across tool-loop turns', async () => {
  const previousThreshold = process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
  process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = '20';
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runner-stable-prefix-'));
  const raw = makeReadFileOutput('E:/repo/runner-stable.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read runner-stable.ts' },
    makeToolCallMessage('call_historical_read', 'E:/repo/runner-stable.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_historical_read', content: raw },
    { role: 'assistant', content: 'historical read complete' },
    { role: 'user', content: 'continue with one more read' },
  ];
  const captured: Message[][] = [];
  const aiService = {
    async chat(requestMessages: Message[]) {
      captured.push(JSON.parse(JSON.stringify(requestMessages)));
      if (captured.length === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'call_current_read',
            type: 'function' as const,
            function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'E:/repo/current.ts' }) },
          }],
        };
      }
      return { content: 'done', toolCalls: [] };
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [{
      name: 'read_file',
      description: 'read a file',
      parameters: { type: 'object', properties: {} },
    }],
    executeTool: async toolCall => ({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: 'read_file',
      content: 'current read output',
    }),
  };

  try {
    const runner = new ConversationRunner(aiService as any, executor, {
      stream: false,
      enableCompression: false,
      toolExecutionContext: {
        workspaceRoot,
        sessionId: 'stable-runner-session',
      },
    });
    await runner.run(messages);

    assert.equal(captured.length, 2);
    const historicalAtTurn1 = captured[0].find(message => message.tool_call_id === 'call_historical_read');
    const historicalAtTurn2 = captured[1].find(message => message.tool_call_id === 'call_historical_read');
    assert.equal(JSON.stringify(historicalAtTurn2), JSON.stringify(historicalAtTurn1));
    assert.match(String(historicalAtTurn1?.content), /full_output_ref: tool-result:\/\/stable-runner-session\/rf_[a-f0-9]{16}/);
  } finally {
    if (previousThreshold === undefined) delete process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
    else process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = previousThreshold;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('does not fold read_file result from the current tool loop', () => {
  const raw = makeReadFileOutput('E:/repo/current.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: '现在读取 current.ts 并修改' },
    makeToolCallMessage('call_current_read', 'E:/repo/current.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_current_read', content: raw },
  ];

  const result = foldHistoricalReadFileMessages(messages, {
    thresholdTokens: 20,
  });

  assert.equal(result.stats.folded_count, 0);
  assert.equal(result.stats.skipped_current_turn_count, 1);
  assert.equal(result.messages[2].content, raw);
});

test('can delayed-fold older current-run read_file results while protecting recent results', () => {
  const firstRaw = makeReadFileOutput('E:/repo/current-old.ts', 90);
  const secondRaw = makeReadFileOutput('E:/repo/current-recent.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read several files in one request' },
    makeToolCallMessage('call_current_old', 'E:/repo/current-old.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_current_old', content: firstRaw },
    { role: 'assistant', content: 'old read complete' },
    makeToolCallMessage('call_current_recent', 'E:/repo/current-recent.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_current_recent', content: secondRaw },
  ];

  const result = foldHistoricalReadFileMessages(messages, {
    thresholdTokens: 20,
    foldCurrentRun: true,
    protectedCurrentRunToolResultIndexes: new Set([5]),
  });

  assert.equal(result.stats.candidate_count, 1);
  assert.equal(result.stats.current_turn_candidate_count, 1);
  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.folded_current_turn_count, 1);
  assert.equal(result.stats.protected_current_turn_count, 1);
  assert.ok(String(result.messages[2].content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(result.messages[5].content, secondRaw);
});

test('can keep the most recent historical read_file result raw', () => {
  const firstRaw = makeReadFileOutput('E:/repo/old.ts', 90);
  const secondRaw = makeReadFileOutput('E:/repo/recent.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: '读 old' },
    makeToolCallMessage('call_old', 'E:/repo/old.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_old', content: firstRaw },
    { role: 'assistant', content: 'old 看完了' },
    { role: 'user', content: '读 recent' },
    makeToolCallMessage('call_recent', 'E:/repo/recent.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_recent', content: secondRaw },
    { role: 'assistant', content: 'recent 看完了' },
    { role: 'user', content: '继续' },
  ];

  const result = foldHistoricalReadFileMessages(messages, {
    thresholdTokens: 20,
    keepRecentHistoricalReads: 1,
  });

  assert.equal(result.stats.candidate_count, 2);
  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.skipped_recent_count, 1);
  assert.ok(String(result.messages[2].content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(result.messages[6].content, secondRaw);
});

test('environment options are deterministic and can disable folding', () => {
  const env = {
    XIAOBA_READ_FILE_MESSAGE_FOLDING: '0',
    XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS: '123',
    XIAOBA_READ_FILE_FOLD_PREVIEW_LINES: '4',
    XIAOBA_READ_FILE_FOLD_SYMBOL_LINES: '5',
    XIAOBA_READ_FILE_FOLD_KEEP_RECENT: '2',
  } as NodeJS.ProcessEnv;

  const options = resolveReadFileMessageFoldingOptions(env);

  assert.equal(options.enabled, false);
  assert.equal(options.thresholdTokens, 123);
  assert.equal(options.maxPreviewLines, 4);
  assert.equal(options.maxSymbolLines, 5);
  assert.equal(options.keepRecentHistoricalReads, 2);
});

test('runner folds provider input and persists the same stable historical read_file result', async () => {
  const previousThreshold = process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
  process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = '20';

  const raw = makeReadFileOutput('E:/repo/provider-only.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: '读 provider-only' },
    makeToolCallMessage('call_provider_only', 'E:/repo/provider-only.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_provider_only', content: raw },
    { role: 'assistant', content: '读完了' },
    { role: 'user', content: '继续' },
  ];
  const captured: Message[][] = [];
  const aiService = {
    async chat(requestMessages: Message[]) {
      captured.push(JSON.parse(JSON.stringify(requestMessages)));
      return { content: 'done' };
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [],
    executeTool: async () => ({ tool_call_id: 'unused', role: 'tool', name: 'unused', content: 'unused' }),
  };

  try {
    const runner = new ConversationRunner(aiService as any, executor, {
      stream: false,
      enableCompression: false,
    });
    await runner.run(messages);
  } finally {
    if (previousThreshold === undefined) delete process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
    else process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = previousThreshold;
  }

  const providerToolResult = captured[0].find(message => message.role === 'tool');
  assert.ok(String(providerToolResult?.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(messages[2].content, providerToolResult?.content);
  assert.equal(messages[2].__toolResultStable, true);
});

test('runner keeps folded historical read_file output stable across model turns', async () => {
  const previousThreshold = process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-prefix-'));
  process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = '20';

  const raw = makeReadFileOutput('E:/repo/cache-prefix.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read cache-prefix.ts' },
    makeToolCallMessage('call_cache_prefix', 'E:/repo/cache-prefix.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_cache_prefix', content: raw },
    { role: 'assistant', content: 'read complete' },
    { role: 'user', content: 'continue with one tool call' },
  ];
  const captured: Message[][] = [];
  let callCount = 0;
  const aiService = {
    async chat(requestMessages: Message[]) {
      captured.push(JSON.parse(JSON.stringify(requestMessages)));
      callCount++;
      if (callCount === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'call_noop',
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          }],
        };
      }
      return { content: 'done', toolCalls: [] };
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [{
      name: 'noop',
      description: 'No-op tool used to force a second model turn',
      parameters: { type: 'object', properties: {} },
    }],
    executeTool: async () => ({
      ok: true,
      tool_call_id: 'call_noop',
      role: 'tool',
      name: 'noop',
      content: 'ok',
    }),
  };

  try {
    const runner = new ConversationRunner(aiService as any, executor, {
      stream: false,
      enableCompression: false,
      toolExecutionContext: {
        workingDirectory: workspaceRoot,
        workspaceRoot,
        sessionId: 'stable-session',
      },
    });
    await runner.run(messages);
  } finally {
    if (previousThreshold === undefined) delete process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
    else process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = previousThreshold;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }

  assert.equal(captured.length, 2);
  const firstFolded = captured[0].find(message => message.tool_call_id === 'call_cache_prefix');
  const secondFolded = captured[1].find(message => message.tool_call_id === 'call_cache_prefix');
  assert.ok(String(firstFolded?.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(JSON.stringify(secondFolded), JSON.stringify(firstFolded));
});

test('runner delayed-folds older current-run tool results and keeps recent ones raw', async () => {
  const previousThreshold = process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
  const previousCurrentRunFolding = process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING;
  const previousKeepRecent = process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT;
  process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = '20';
  process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING = '1';
  process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT = '1';

  const firstRaw = makeReadFileOutput('E:/repo/current-provider-old.ts', 90);
  const secondRaw = makeReadFileOutput('E:/repo/current-provider-recent.ts', 90);
  const messages: Message[] = [
    { role: 'user', content: 'read multiple files before answering' },
    makeToolCallMessage('call_current_provider_old', 'E:/repo/current-provider-old.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_current_provider_old', content: firstRaw },
    { role: 'assistant', content: 'old read complete' },
    makeToolCallMessage('call_current_provider_recent', 'E:/repo/current-provider-recent.ts'),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_current_provider_recent', content: secondRaw },
  ];
  const captured: Message[][] = [];
  const aiService = {
    async chat(requestMessages: Message[]) {
      captured.push(JSON.parse(JSON.stringify(requestMessages)));
      return { content: 'done' };
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [],
    executeTool: async () => ({ tool_call_id: 'unused', role: 'tool', name: 'unused', content: 'unused' }),
  };

  try {
    const runner = new ConversationRunner(aiService as any, executor, {
      stream: false,
      enableCompression: false,
    });
    await runner.run(messages);
  } finally {
    if (previousThreshold === undefined) delete process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS;
    else process.env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS = previousThreshold;
    if (previousCurrentRunFolding === undefined) delete process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING;
    else process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING = previousCurrentRunFolding;
    if (previousKeepRecent === undefined) delete process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT;
    else process.env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT = previousKeepRecent;
  }

  const providerOld = captured[0].find(message => message.tool_call_id === 'call_current_provider_old');
  const providerRecent = captured[0].find(message => message.tool_call_id === 'call_current_provider_recent');
  assert.ok(String(providerOld?.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(providerRecent?.content, secondRaw);
  assert.ok(String(messages[2].content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.ok(String(messages[5].content).startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(messages[2].__toolResultStable, true);
  assert.equal(messages[5].__toolResultStable, true);
});
