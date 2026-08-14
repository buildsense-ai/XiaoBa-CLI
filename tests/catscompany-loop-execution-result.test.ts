import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LOOP_ACTION_PACKET_SCHEMA, type LoopActionPacket } from '../src/catscompany/loop-evidence';
import {
  buildLoopExecutionResult,
  validateLoopExecutionResult,
} from '../src/catscompany/loop-execution-result';
import { LoopRuntimeBridge } from '../src/catscompany/loop-runtime-bridge';

const topic = 'grp_101';
const workerSessionId = 'session:v2:catscompany:group:grp_101:agent:559';

function packet(): LoopActionPacket {
  return {
    schema: LOOP_ACTION_PACKET_SCHEMA,
    kind: 'execute_attempt',
    actionId: 'execute-1',
    actionKey: 'execute_attempt:attempt-1:1',
    action: { state: 'ready', workItemRevision: 7, targetPrincipal: 'catsco-user:559', targetTopicId: topic },
    workItemId: 'work-1',
    workItemRevision: 7,
    targetPrincipal: 'catsco-user:559',
    targetTopicId: topic,
    workerTopicId: topic,
    evidenceTopicId: 'grp_102',
    attemptId: 'attempt-1',
    ownerUid: '602',
    generation: 1,
    runtimePrincipal: 'catsco-user:559',
    workerSessionId,
    workBundle: { contractDigest: 'a'.repeat(64), instructions: 'do work', deliverables: ['github-pr'] },
  };
}

describe('CatsCo Loop execution result', () => {
  test('builds a structured terminal record from the action bindings', () => {
    assert.deepEqual(buildLoopExecutionResult(packet(), 'completed'), {
      schema: 'loopctl-execution-result-v1',
      attemptId: 'attempt-1',
      workerSessionId,
      generation: 1,
      workItemRevision: 7,
      outcome: 'completed',
    });
  });

  test('rejects execution records substituted from another action', () => {
    const action = packet();
    const result = buildLoopExecutionResult(action, 'completed');
    for (const invalid of [
      { ...result, attemptId: 'attempt-2' },
      { ...result, workerSessionId: 'session:v2:catscompany:group:grp_101:agent:560' },
      { ...result, generation: 2 },
      { ...result, workItemRevision: 8 },
      { ...result, outcome: 'unknown' as any },
    ]) {
      assert.throws(() => validateLoopExecutionResult(action, invalid));
    }
  });

  test('rejects non-string execution-result binding values without coercion', () => {
    const action = packet();
    const result = buildLoopExecutionResult(action, 'completed');
    for (const invalid of [
      { ...result, attemptId: 1 },
      { ...result, attemptId: { value: 'attempt-1' } },
      { ...result, workerSessionId: 1 },
      { ...result, workerSessionId: { value: workerSessionId } },
    ]) {
      assert.throws(() => validateLoopExecutionResult(action, invalid as any), /is required/);
    }
  });

  test('does not expose a completed execution result until the bridge validates its bindings', async () => {
    const action = packet();
    let observed = false;
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: { runtimeStarted: async () => undefined } as any,
      prepareSession: () => undefined,
      execute: async () => ({ ...buildLoopExecutionResult(action, 'completed'), attemptId: 'wrong-attempt' }),
      onExecutionResult: () => { observed = true; },
    });

    await assert.rejects(() => bridge.handle(JSON.stringify(action), topic, '602'), /attemptId/);
    assert.equal(observed, false);
  });
});
