import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TRUNCATED_EXECUTE_SHELL_PREFIX,
  foldHistoricalExecuteShellMessages,
  resolveExecuteShellMessageFoldingOptions,
} from '../src/core/execute-shell-message-folder';
import { ConversationRunner } from '../src/core/conversation-runner';
import { Message } from '../src/types';
import { ToolExecutor } from '../src/types/tool';

function makeShellOutput(command: string, lineCount = 100, failed = false): string {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const lineNumber = index + 1;
    if (lineNumber === 50) {
      return 'ERROR failed at src/broken.ts:123 with assertion failure';
    }
    return `plain shell output line ${lineNumber}`;
  });
  return [
    failed ? 'Command failed:' : 'Command succeeded:',
    `$ ${command}`,
    '',
    'Elapsed: 123ms',
    `Output lines: ${lineCount}`,
    '',
    failed ? 'Error:' : '',
    lines.join('\n'),
  ].filter(line => line !== '').join('\n');
}

function makeStructuredShellOutput(command: string, lineCount = 100): string {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const lineNumber = index + 1;
    if (lineNumber === 50) {
      return 'ERROR failed at src/structured.ts:45 with assertion failure';
    }
    return `structured shell output line ${lineNumber}`;
  });
  return [
    'Command completed',
    'status: failed',
    `command: ${command}`,
    'exit_code: 1',
    'signal:',
    'timed_out: false',
    'duration_ms: 321',
    'cwd_before: C:\\work\\repo',
    'cwd_after: C:\\work\\repo',
    `stdout_lines: ${lineCount}`,
    'stderr_lines: 1',
    'stdout_bytes: 1000',
    'stderr_bytes: 25',
    'truncated: false',
    'error_message: Command failed with exit code 1',
    '',
    'stdout:',
    lines.join('\n'),
    '',
    'stderr:',
    'warning before failure',
  ].join('\n');
}

function makeToolCallMessage(id: string, command: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name: 'execute_shell',
        arguments: JSON.stringify({ command, timeout: 10000 }),
      },
    }],
  };
}

test('folds large historical execute_shell results while preserving tool exchange ids and key lines', () => {
  const raw = makeShellOutput('npm test', 100, true);
  const messages: Message[] = [
    { role: 'user', content: 'run tests' },
    makeToolCallMessage('call_old_shell', 'npm test'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_old_shell', content: raw },
    { role: 'assistant', content: 'tests failed' },
    { role: 'user', content: 'summarize failure' },
  ];

  const result = foldHistoricalExecuteShellMessages(messages, {
    thresholdTokens: 20,
    maxHeadLines: 2,
    maxTailLines: 2,
    maxKeyLines: 4,
  });
  const folded = result.messages[2];

  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.candidate_count, 1);
  assert.equal(folded.tool_call_id, 'call_old_shell');
  assert.equal(folded.name, 'execute_shell');
  assert.equal(typeof folded.content, 'string');
  assert.ok(String(folded.content).startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
  assert.match(String(folded.content), /artifact_id: sh_[a-f0-9]{16}/);
  assert.match(String(folded.content), /command: npm test/);
  assert.match(String(folded.content), /status: failed/);
  assert.match(String(folded.content), /ERROR failed at src\/broken\.ts:123/);
  assert.equal(String(folded.content).includes('plain shell output line 45'), false);
  assert.ok(result.stats.saved_tokens_est > 0);
});

test('writes truncated execute_shell full output to a linkable artifact', () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shell-artifacts-'));
  const raw = makeShellOutput('npm test -- linked', 100, true);
  const messages: Message[] = [
    { role: 'user', content: 'run linked tests' },
    makeToolCallMessage('call_linked_shell', 'npm test -- linked'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_linked_shell', content: raw },
    { role: 'assistant', content: 'tests failed' },
    { role: 'user', content: 'continue' },
  ];

  try {
    const result = foldHistoricalExecuteShellMessages(messages, {
      thresholdTokens: 20,
      artifactStore: {
        enabled: true,
        rootDirectory: artifactRoot,
        sessionId: 'test session',
        turn: 9,
      },
    });
    const content = String(result.messages[2].content);
    const fullOutputPath = content.match(/^full_output_path: (.+)$/m)?.[1];

    assert.ok(content.startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
    assert.match(content, /full_output_ref: tool-result:\/\/test_session\/turn-0009\/sh_[a-f0-9]{16}/);
    assert.match(content, /full_output_link: file:\/\//);
    assert.ok(fullOutputPath);
    assert.equal(fs.readFileSync(fullOutputPath, 'utf8').includes(raw), true);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('folds structured execute_shell output and reads contract metadata', () => {
  const raw = makeStructuredShellOutput('npm test -- structured', 100);
  const messages: Message[] = [
    { role: 'user', content: 'run tests' },
    makeToolCallMessage('call_structured_shell', 'npm test -- structured'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_structured_shell', content: raw },
    { role: 'assistant', content: 'tests failed' },
    { role: 'user', content: 'summarize failure' },
  ];

  const result = foldHistoricalExecuteShellMessages(messages, {
    thresholdTokens: 20,
    maxHeadLines: 2,
    maxTailLines: 2,
    maxKeyLines: 4,
  });
  const folded = result.messages[2];

  assert.ok(String(folded.content).startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
  assert.match(String(folded.content), /command: npm test -- structured/);
  assert.match(String(folded.content), /cwd: C:\\work\\repo/);
  assert.match(String(folded.content), /status: failed/);
  assert.match(String(folded.content), /elapsed: 321ms/);
  assert.match(String(folded.content), /output_lines: 101/);
  assert.match(String(folded.content), /ERROR failed at src\/structured\.ts:45/);
});

test('does not fold execute_shell result from the current tool loop', () => {
  const raw = makeShellOutput('npm run build', 100);
  const messages: Message[] = [
    { role: 'user', content: 'build now' },
    makeToolCallMessage('call_current_shell', 'npm run build'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_current_shell', content: raw },
  ];

  const result = foldHistoricalExecuteShellMessages(messages, {
    thresholdTokens: 20,
  });

  assert.equal(result.stats.folded_count, 0);
  assert.equal(result.stats.skipped_current_turn_count, 1);
  assert.equal(result.messages[2].content, raw);
});

test('can delayed-fold older current-run execute_shell results while protecting recent results', () => {
  const firstRaw = makeShellOutput('npm test -- current-old', 100);
  const secondRaw = makeShellOutput('npm test -- current-recent', 100);
  const messages: Message[] = [
    { role: 'user', content: 'run several commands in one request' },
    makeToolCallMessage('call_current_old', 'npm test -- current-old'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_current_old', content: firstRaw },
    { role: 'assistant', content: 'old shell complete' },
    makeToolCallMessage('call_current_recent', 'npm test -- current-recent'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_current_recent', content: secondRaw },
  ];

  const result = foldHistoricalExecuteShellMessages(messages, {
    thresholdTokens: 20,
    foldCurrentRun: true,
    protectedCurrentRunToolResultIndexes: new Set([5]),
  });

  assert.equal(result.stats.candidate_count, 1);
  assert.equal(result.stats.current_turn_candidate_count, 1);
  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.folded_current_turn_count, 1);
  assert.equal(result.stats.protected_current_turn_count, 1);
  assert.ok(String(result.messages[2].content).startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
  assert.equal(result.messages[5].content, secondRaw);
});

test('can keep the most recent historical execute_shell result raw', () => {
  const firstRaw = makeShellOutput('npm test -- old', 100);
  const secondRaw = makeShellOutput('npm test -- recent', 100);
  const messages: Message[] = [
    { role: 'user', content: 'run old shell' },
    makeToolCallMessage('call_old', 'npm test -- old'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_old', content: firstRaw },
    { role: 'assistant', content: 'old done' },
    { role: 'user', content: 'run recent shell' },
    makeToolCallMessage('call_recent', 'npm test -- recent'),
    { role: 'tool', name: 'Bash', tool_call_id: 'call_recent', content: secondRaw },
    { role: 'assistant', content: 'recent done' },
    { role: 'user', content: 'continue' },
  ];

  const result = foldHistoricalExecuteShellMessages(messages, {
    thresholdTokens: 20,
    keepRecentHistoricalShells: 1,
  });

  assert.equal(result.stats.candidate_count, 2);
  assert.equal(result.stats.folded_count, 1);
  assert.equal(result.stats.skipped_recent_count, 1);
  assert.ok(String(result.messages[2].content).startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
  assert.equal(result.messages[6].content, secondRaw);
});

test('environment options are deterministic and can disable folding', () => {
  const env = {
    XIAOBA_EXECUTE_SHELL_MESSAGE_FOLDING: '0',
    XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS: '321',
    XIAOBA_EXECUTE_SHELL_FOLD_HEAD_LINES: '3',
    XIAOBA_EXECUTE_SHELL_FOLD_TAIL_LINES: '7',
    XIAOBA_EXECUTE_SHELL_FOLD_KEY_LINES: '9',
    XIAOBA_EXECUTE_SHELL_FOLD_KEEP_RECENT: '2',
  } as NodeJS.ProcessEnv;

  const options = resolveExecuteShellMessageFoldingOptions(env);

  assert.equal(options.enabled, false);
  assert.equal(options.thresholdTokens, 321);
  assert.equal(options.maxHeadLines, 3);
  assert.equal(options.maxTailLines, 7);
  assert.equal(options.maxKeyLines, 9);
  assert.equal(options.keepRecentHistoricalShells, 2);
});

test('runner folds execute_shell only in provider input and leaves durable session messages raw', async () => {
  const previousThreshold = process.env.XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS;
  process.env.XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS = '20';

  const raw = makeShellOutput('npm test -- provider-only', 100);
  const messages: Message[] = [
    { role: 'user', content: 'run provider shell' },
    makeToolCallMessage('call_provider_shell', 'npm test -- provider-only'),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_provider_shell', content: raw },
    { role: 'assistant', content: 'shell done' },
    { role: 'user', content: 'continue' },
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
    if (previousThreshold === undefined) delete process.env.XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS;
    else process.env.XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS = previousThreshold;
  }

  const providerToolResult = captured[0].find(message => message.role === 'tool');
  assert.ok(String(providerToolResult?.content).startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX));
  assert.equal(messages[2].content, raw);
});
