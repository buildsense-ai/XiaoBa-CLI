import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldToolResultsTowardPromptBudget,
  resolveAdaptiveToolResultFoldingOptions,
} from '../src/core/adaptive-tool-result-folder';
import { Message } from '../src/types';

function makeToolCall(id: string, name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    }],
  };
}

function makeReadFileOutput(path: string, chars: number): string {
  return [
    `File: ${path}`,
    `Path: ${path}`,
    '',
    'read output '.repeat(Math.ceil(chars / 12)).slice(0, chars),
  ].join('\n');
}

function makeShellOutput(command: string, chars: number): string {
  return [
    'Command succeeded:',
    `$ ${command}`,
    '',
    'Elapsed: 100ms',
    'Output lines: 1',
    '',
    'shell output '.repeat(Math.ceil(chars / 13)).slice(0, chars),
  ].join('\n');
}

test('adaptively lowers thresholds to fold additional tool results toward a prompt budget', () => {
  const readRaw = makeReadFileOutput('E:/repo/a.ts', 6000);
  const shellRaw = makeShellOutput('npm test', 6000);
  const messages: Message[] = [
    { role: 'user', content: 'old request' },
    makeToolCall('call_read', 'read_file', { file_path: 'E:/repo/a.ts' }),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_read', content: readRaw },
    makeToolCall('call_shell', 'execute_shell', { command: 'npm test' }),
    { role: 'tool', name: 'execute_shell', tool_call_id: 'call_shell', content: shellRaw },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'continue' },
  ];

  const result = foldToolResultsTowardPromptBudget(
    messages,
    [],
    {
      enabled: true,
      thresholdTokens: 2000,
      maxPreviewLines: 2,
      maxSymbolLines: 2,
      keepRecentHistoricalReads: 0,
      foldCurrentRun: false,
    },
    {
      enabled: true,
      thresholdTokens: 2000,
      maxHeadLines: 2,
      maxTailLines: 2,
      maxKeyLines: 2,
      keepRecentHistoricalShells: 0,
      foldCurrentRun: false,
    },
    {
      enabled: true,
      targetPromptTokens: 1000,
      minThresholdTokens: 500,
      thresholdScale: 0.5,
      maxPasses: 2,
    },
  );

  assert.ok(result.stats.started_prompt_tokens_est > result.stats.finished_prompt_tokens_est);
  assert.equal(result.stats.folded_count, 2);
  assert.equal(result.stats.read_file_folded_count, 1);
  assert.equal(result.stats.execute_shell_folded_count, 1);
  assert.equal(result.stats.passes, 2);
  assert.deepEqual(result.stats.thresholds_tried, [1000, 500]);
  assert.match(String(result.messages[2].content), /^\[truncated_read_file\]/);
  assert.match(String(result.messages[4].content), /^\[truncated_execute_shell\]/);
});

test('does not adaptively fold when disabled or already under target', () => {
  const messages: Message[] = [
    { role: 'user', content: 'old request' },
    makeToolCall('call_read', 'read_file', { file_path: 'E:/repo/a.ts' }),
    { role: 'tool', name: 'read_file', tool_call_id: 'call_read', content: makeReadFileOutput('E:/repo/a.ts', 6000) },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'continue' },
  ];

  const disabled = foldToolResultsTowardPromptBudget(
    messages,
    [],
    {
      enabled: true,
      thresholdTokens: 2000,
      maxPreviewLines: 2,
      maxSymbolLines: 2,
      keepRecentHistoricalReads: 0,
      foldCurrentRun: false,
    },
    {
      enabled: true,
      thresholdTokens: 2000,
      maxHeadLines: 2,
      maxTailLines: 2,
      maxKeyLines: 2,
      keepRecentHistoricalShells: 0,
      foldCurrentRun: false,
    },
    {
      enabled: false,
      targetPromptTokens: 1,
      minThresholdTokens: 500,
      thresholdScale: 0.5,
      maxPasses: 2,
    },
  );

  assert.equal(disabled.stats.folded_count, 0);
  assert.equal(disabled.messages[2].content, messages[2].content);

  const underTarget = foldToolResultsTowardPromptBudget(
    messages,
    [],
    {
      enabled: true,
      thresholdTokens: 2000,
      maxPreviewLines: 2,
      maxSymbolLines: 2,
      keepRecentHistoricalReads: 0,
      foldCurrentRun: false,
    },
    {
      enabled: true,
      thresholdTokens: 2000,
      maxHeadLines: 2,
      maxTailLines: 2,
      maxKeyLines: 2,
      keepRecentHistoricalShells: 0,
      foldCurrentRun: false,
    },
    {
      enabled: true,
      targetPromptTokens: 100000,
      minThresholdTokens: 500,
      thresholdScale: 0.5,
      maxPasses: 2,
    },
  );

  assert.equal(underTarget.stats.folded_count, 0);
  assert.equal(underTarget.messages[2].content, messages[2].content);
});

test('environment options control adaptive folding', () => {
  const env = {
    XIAOBA_ADAPTIVE_TOOL_RESULT_FOLDING: '0',
    XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_TARGET_PROMPT_TOKENS: '90000',
    XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_MIN_THRESHOLD_TOKENS: '250',
    XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_THRESHOLD_SCALE: '0.25',
    XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_MAX_PASSES: '6',
  } as NodeJS.ProcessEnv;

  const options = resolveAdaptiveToolResultFoldingOptions(env);

  assert.equal(options.enabled, false);
  assert.equal(options.targetPromptTokens, 90000);
  assert.equal(options.minThresholdTokens, 250);
  assert.equal(options.thresholdScale, 0.25);
  assert.equal(options.maxPasses, 6);
});
