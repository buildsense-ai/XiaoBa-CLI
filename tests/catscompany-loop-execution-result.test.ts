import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LOOP_ACTION_PACKET_SCHEMA, type LoopActionPacket } from '../src/catscompany/loop-evidence';
import {
  buildLoopExecutionResult,
  parseLoopCandidateCompletion,
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
    githubRepo: 'owner/repo',
    proofMode: 'catsco-message',
    contracts: { taskContractHash: 'a'.repeat(64), referenceSnapshotHash: 'b'.repeat(64), writeScopeHash: 'c'.repeat(64), acceptanceContractHash: 'd'.repeat(64) },
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

  test('only parses one complete strict candidate envelope and rejects prose, malformed, and multiple envelopes', () => {
    const valid = '{"schema":"loop_candidate_v1","candidateId":"candidate-1","deliverable":{"kind":"github_pr","repository":"owner/repo","prNumber":12,"headSha":"head","baseSha":"base"}}';
    assert.deepEqual(parseLoopCandidateCompletion(valid)?.candidate, {
      schema: 'loop_candidate_v1', candidateId: 'candidate-1',
      deliverable: { kind: 'github_pr', repository: 'owner/repo', prNumber: 12, headSha: 'head', baseSha: 'base' },
    });
    for (const invalid of [
      'Created https://github.com/owner/repo/pull/12',
      '{"schema":"loop_candidate_v1","candidateId":"candidate-1"}',
      `${valid}\n${valid}`,
      '{"schema":"loop_candidate_v1","candidateId":"candidate-1","extra":true,"deliverable":{"kind":"github_pr","repository":"owner/repo","prNumber":12,"headSha":"head","baseSha":"base"}}',
    ]) assert.equal(parseLoopCandidateCompletion(invalid), undefined);
  });

  test('rejects candidate presence for failed results', () => {
    const action = packet();
    const completion = parseLoopCandidateCompletion('{"schema":"loop_candidate_v1","candidateId":"candidate-1","deliverable":{"kind":"github_pr","repository":"owner/repo","prNumber":12,"headSha":"head","baseSha":"base"}}')!;
    const completed = buildLoopExecutionResult(action, 'completed', completion);
    assert.throws(() => validateLoopExecutionResult(action, { ...completed, outcome: 'failed' }), /only permits a candidate/);
  });

  test('rejects candidate presence for cancelled results', () => {
    const action = packet();
    const completion = parseLoopCandidateCompletion('{"schema":"loop_candidate_v1","candidateId":"candidate-1","deliverable":{"kind":"github_pr","repository":"owner/repo","prNumber":12,"headSha":"head","baseSha":"base"}}')!;
    const completed = buildLoopExecutionResult(action, 'completed', completion);
    assert.throws(() => validateLoopExecutionResult(action, { ...completed, outcome: 'cancelled' }), /only permits a candidate/);
  });

  test('rejects candidates not produced by the strict terminal parser', () => {
    const action = packet();
    const injected = {
      schema: 'loop_candidate_v1', candidateId: 'candidate-1',
      deliverable: { kind: 'github_pr', repository: 'owner/repo', prNumber: 12, headSha: 'head', baseSha: 'base' },
    };
    assert.throws(
      () => validateLoopExecutionResult(action, { ...buildLoopExecutionResult(action, 'completed'), candidate: injected as any }),
      /terminal completion parser/,
    );
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
