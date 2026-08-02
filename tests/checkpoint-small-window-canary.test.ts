import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCheckpointCanaryAttemptLifecycle,
  checkpointCanaryContextWindowTokens,
  checkpointCanaryCompletedToolWitnessChainIsComplete,
  checkpointCanaryEstimatedRequestWithinBudget,
  checkpointCanaryProviderUsageWithinContextWindow,
  checkpointResumePrimaryOrdinals,
  didPersistEveryCheckpointBeforeResume,
  requestContainsTruncationMarker,
  runCheckpointCanaryWithoutConsoleOutput,
  sanitizeCheckpointCanaryError,
} from '../src/cache-benchmark/checkpoint-small-window-canary';

function attempt(attemptId: string, outcome: string): any {
  return { attempt_id: attemptId, outcome };
}

test('checkpoint canary rejects started attempts without exactly one terminal event', () => {
  assert.equal(analyzeCheckpointCanaryAttemptLifecycle([
    attempt('complete', 'started'),
    attempt('complete', 'succeeded'),
  ]).complete, true);
  assert.equal(analyzeCheckpointCanaryAttemptLifecycle([
    attempt('dangling', 'started'),
  ]).complete, false);
  assert.equal(analyzeCheckpointCanaryAttemptLifecycle([
    attempt('duplicate', 'started'),
    attempt('duplicate', 'retrying'),
    attempt('duplicate', 'failed'),
  ]).complete, false);
});

test('checkpoint canary suppresses console payloads while the real run executes', async () => {
  const observed: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { observed.push(values.join(' ')); };
  try {
    const result = await runCheckpointCanaryWithoutConsoleOutput(async () => {
      console.log('SECRET_ALPHA_5A77');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(observed, []);
  } finally {
    console.log = original;
  }
});

test('checkpoint canary requires every durable JSON restore before the matching same-episode resume', () => {
  const chronology = [
    'primary:started',
    'checkpoint:generated:1',
    'checkpoint:persisted:1',
    'checkpoint:restored:1',
    'primary:started',
    'checkpoint:generated:2',
    'checkpoint:persisted:2',
    'checkpoint:restored:2',
    'primary:started',
  ];
  assert.equal(didPersistEveryCheckpointBeforeResume(chronology, 2), true);
  assert.deepEqual(checkpointResumePrimaryOrdinals([
    ...chronology,
    'primary:started',
  ], 2), [1, 2], 'a token-limit continuation after the final resume is not another checkpoint');
  assert.deepEqual(checkpointResumePrimaryOrdinals([
    'primary:started',
    'checkpoint:generated:1',
    'checkpoint:persisted:1',
    'checkpoint:restored:1',
    'primary:started',
    'primary:started',
    'checkpoint:generated:2',
    'checkpoint:persisted:2',
    'checkpoint:restored:2',
    'primary:started',
  ], 2), [1, 3], 'an intervening model continuation must not be mistaken for checkpoint 2 resume');
  assert.equal(didPersistEveryCheckpointBeforeResume([
    ...chronology.slice(0, 7),
    'primary:started',
    'checkpoint:restored:2',
  ], 2), false);
  assert.equal(didPersistEveryCheckpointBeforeResume([
    'primary:started',
    'checkpoint:generated:1',
    'checkpoint:persisted:1',
    'checkpoint:restored:1',
    'checkpoint:generated:2',
    'checkpoint:persisted:2',
    'checkpoint:restored:2',
    'primary:started',
  ], 2), false, 'two checkpoints must not share one later primary resume');
  assert.equal(didPersistEveryCheckpointBeforeResume([
    'primary:started',
    'checkpoint:generated:1',
    'primary:started',
    'checkpoint:persisted:1',
    'checkpoint:restored:1',
    'primary:started',
    'checkpoint:generated:2',
    'primary:started',
    'checkpoint:persisted:2',
    'checkpoint:restored:2',
    'primary:started',
  ], 2), false, 'no provider request may start before its checkpoint is persisted and restored');
  assert.equal(didPersistEveryCheckpointBeforeResume(chronology, 3), false);
});

test('checkpoint canary configures a genuinely small total context window', () => {
  assert.equal(checkpointCanaryContextWindowTokens(8_000), 10_048);
  assert.equal(checkpointCanaryEstimatedRequestWithinBudget(8_000, 8_000), true);
  assert.equal(checkpointCanaryEstimatedRequestWithinBudget(8_001, 8_000), false);
  assert.equal(checkpointCanaryProviderUsageWithinContextWindow(8_000, 2_048, 10_048), true);
  assert.equal(checkpointCanaryProviderUsageWithinContextWindow(8_001, 2_048, 10_048), false);
  assert.equal(checkpointCanaryProviderUsageWithinContextWindow(8_000, undefined, 10_048), false);
});

test('checkpoint canary rejects every known truncation and omission representation', () => {
  for (const marker of [
    '[checkpoint_user_input_evidence]',
    '[tool_result_pruned]',
    '[truncated]',
    '[provider truncated output]',
    'omission: older tool output',
    'PROMPT_BUDGET_TRIM',
    '历史输出已省略',
    '[早期 3 条消息已截断，共 10 条消息]',
    'abc\n...[共 1000 字符]',
    'abc...(已截断)',
    '[历史工具结果已省略；read_file 已完成。]',
  ]) {
    assert.equal(requestContainsTruncationMarker([{ role: 'assistant', content: marker }]), true);
  }
  assert.equal(requestContainsTruncationMarker([{
    role: 'assistant',
    content: '[checkpoint_completed_tool_boundary]\ncompleted: success',
  }]), false);
});

test('checkpoint canary requires the completed-tool witness chain to grow 1 then 2', () => {
  const first = {
    completed_tool_boundary_witness_count: 1,
    completed_tool_boundary_success_witness_count: 1,
    completed_tool_boundary_fingerprints: ['step-1'],
  };
  const completeSecond = {
    completed_tool_boundary_witness_count: 2,
    completed_tool_boundary_success_witness_count: 2,
    completed_tool_boundary_fingerprints: ['step-1', 'step-2'],
  };
  assert.equal(checkpointCanaryCompletedToolWitnessChainIsComplete([
    first,
    completeSecond,
  ], 2), true);
  assert.equal(checkpointCanaryCompletedToolWitnessChainIsComplete([
    first,
    { ...first },
  ], 2), false, 'the second checkpoint must not pass with only the first witness');
  assert.equal(checkpointCanaryCompletedToolWitnessChainIsComplete([
    first,
    {
      ...completeSecond,
      completed_tool_boundary_success_witness_count: 1,
    },
  ], 2), false, 'failed or retryable results must not satisfy this success canary');
});

test('checkpoint canary error projection allowlists names, codes, and HTTP status', () => {
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'SECRET_ALPHA_5A77',
    code: 'SECRET_BRAVO_7E42',
    status: 'credential-like-status',
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v4',
    error: { name: 'Error', code: null, status: null, phase: null, reason: null },
  });
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
    response: { status: 504 },
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v4',
    error: { name: 'TimeoutError', code: 'ETIMEDOUT', status: 504, phase: null, reason: null },
  });
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'Error',
    code: 'CHECKPOINT_CANARY_TOOL_SEQUENCE_INVALID',
    checkpointCanaryPhase: 'react_loop',
    checkpointCanaryDiagnostic: {
      expected_step: 2,
      actual_step: 1,
      completed_step_count: 1,
      tool_name_matched: true,
      secret: 'must-not-escape',
    },
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v4',
    error: {
      name: 'Error',
      code: 'CHECKPOINT_CANARY_TOOL_SEQUENCE_INVALID',
      status: null,
      phase: 'react_loop',
      reason: null,
      diagnostic: {
        expected_step: 2,
        actual_step: 1,
        completed_step_count: 1,
        generated_checkpoint_count: null,
        persisted_checkpoint_count: null,
        restored_checkpoint_count: null,
        tool_name_matched: true,
      },
    },
  });
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'Error',
    code: 'CONTEXT_CHECKPOINT_FAILED',
    checkpointCanaryPhase: 'react_loop',
    message: 'request preflight checkpoint candidate remains over budget after compression',
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v4',
    error: {
      name: 'Error',
      code: 'CONTEXT_CHECKPOINT_FAILED',
      status: null,
      phase: 'react_loop',
      reason: 'post_checkpoint_request_over_budget',
    },
  });
});
