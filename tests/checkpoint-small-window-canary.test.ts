import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCheckpointCanaryAttemptLifecycle,
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

test('checkpoint canary error projection allowlists names, codes, and HTTP status', () => {
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'SECRET_ALPHA_5A77',
    code: 'SECRET_BRAVO_7E42',
    status: 'credential-like-status',
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v2',
    error: { name: 'Error', code: null, status: null },
  });
  assert.deepEqual(sanitizeCheckpointCanaryError({
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
    response: { status: 504 },
  }), {
    schema: 'xiaoba.checkpoint-small-window-canary.v2',
    error: { name: 'TimeoutError', code: 'ETIMEDOUT', status: 504 },
  });
});
