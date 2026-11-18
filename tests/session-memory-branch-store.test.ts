import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_SESSION_MEMORY_OBSERVATIONS,
  SessionMemoryBranchStore,
  memoryBranchClaimKey,
  memoryBranchScopeCovers,
} from '../src/core/session-memory-branch';

const scope = { sessionKey: 'session:one', topicId: 'grp_1', actorUserId: 'usr1' };
const otherSender = { ...scope, actorUserId: 'usr2' };

function publishFinding(store: SessionMemoryBranchStore, overrides: Partial<Parameters<SessionMemoryBranchStore['publish']>[0]> = {}) {
  return store.publish({
    subject: 'Meridian deliverable',
    claim: 'The picture edit was approved; narration was still open.',
    sourceRefs: ['catscompany/2026-11-16/meridian.jsonl#7'],
    scope,
    originTurn: 1,
    originTurnId: 'episode:1',
    verifiedThroughInput: store.currentInputSequence,
    branchId: 'branch-1',
    ...overrides,
  });
}

describe('SessionMemoryBranchStore', () => {
  test('advances the sequence only for real user input', () => {
    const store = new SessionMemoryBranchStore();
    assert.equal(store.currentInputSequence, 0);
    const first = store.noteUserInput({ text: 'hello', scope, turn: 1, turnId: 'input:1' });
    assert.equal(first, 1);
    const runtime = store.noteUserInput({ text: 'runtime observation', scope, turn: 1, turnId: 'runtime', runtimeObservation: true });
    assert.equal(runtime, 1, 'a runtime observation turn never advances eligibility');
    assert.equal(store.noteUserInput({ text: 'second', scope, turn: 2, turnId: 'input:2' }), 2);
    assert.deepEqual(store.takeEvents().map(event => [event.kind, event.sequence]), [
      ['user_input', 1],
      ['user_input', 2],
    ]);
  });

  test('holds a claim verified for an older input and delivers it after reconfirmation', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'first', scope, turn: 1, turnId: 'input:1' });
    const published = publishFinding(store);
    assert.equal(published.ok, true);

    store.noteUserInput({ text: 'second', scope, turn: 2, turnId: 'input:2' });
    assert.deepEqual(store.drainEligible({ sequence: 2, scope, turn: 2 }), []);
    assert.equal(store.snapshot().entries[0].status, 'held');
    assert.equal(store.snapshot().entries[0].holdReasons['2'], 'stale_verified_through_input');

    assert.equal(store.reconfirm({ observationId: published.observationId, sequence: 2, scope }).ok, true);
    const delivered = store.drainEligible({ sequence: 2, scope, turn: 2 });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].timing, 'late_previous_turn');
    assert.deepEqual(store.drainEligible({ sequence: 2, scope, turn: 2 }), [], 'a claim is delivered exactly once');
  });

  test('a withheld claim is never delivered to another sender in the same group session', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'sender one', scope, turn: 1, turnId: 'input:1' });
    const published = publishFinding(store);
    assert.equal(store.reconfirm({ observationId: published.observationId, sequence: 1, scope: otherSender }).reason, 'scope_mismatch');
    assert.deepEqual(store.drainEligible({ sequence: 1, scope: otherSender, turn: 1 }), []);
    assert.equal(store.snapshot().entries[0].holdReasons['1'], 'scope_mismatch');
    assert.equal(memoryBranchScopeCovers(scope, otherSender), false);
  });

  test('deduplicates an identical claim and lets a correction supersede the earlier observation', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'first', scope, turn: 1, turnId: 'input:1' });
    const first = publishFinding(store);
    const duplicate = publishFinding(store);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(duplicate.existingObservationId, first.observationId);
    assert.equal(store.size(), 1);

    const correction = store.publish({
      subject: 'Meridian deliverable',
      claim: 'The export contains audible narration, contrary to the earlier repair report.',
      sourceRefs: ['catscompany/2026-11-18/inspection.jsonl#2'],
      qualification: 'Resolved by inspecting the delivered 60-second export.',
      supersedes: [first.observationId!],
      scope,
      originTurn: 2,
      originTurnId: 'episode:2',
      verifiedThroughInput: 1,
      branchId: 'branch-1',
    });
    assert.equal(correction.ok, true);
    const entries = store.snapshot().entries;
    const superseded = entries.find(entry => entry.id === first.observationId);
    assert.equal(superseded?.status, 'superseded');
    assert.equal(superseded?.supersededBy, correction.observationId);
    assert.equal(memoryBranchClaimKey({ subject: 'a', claim: 'b', sourceRefs: ['x', 'y'] }),
      memoryBranchClaimKey({ subject: 'a', claim: 'b', sourceRefs: ['y', 'x'] }));
  });

  test('withdraws a held observation and records the reason', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'project A', scope, turn: 1, turnId: 'input:1' });
    const published = publishFinding(store);
    store.noteUserInput({ text: 'project B', scope, turn: 2, turnId: 'input:2' });
    store.drainEligible({ sequence: 2, scope, turn: 2 });
    const withdrawn = store.withdraw({ observationId: published.observationId, reason: 'topic_switch', scope });
    assert.equal(withdrawn.ok, true);
    assert.equal(store.snapshot().entries[0].status, 'withdrawn');
    assert.equal(store.snapshot().entries[0].withdrawnReason, 'topic_switch');
    assert.deepEqual(store.drainEligible({ sequence: 2, scope, turn: 2 }), []);
  });

  test('expires queued claims on session closure and refunds nothing', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'first', scope, turn: 1, turnId: 'input:1' });
    publishFinding(store);
    assert.equal(store.expire('session_closed'), 1);
    assert.equal(store.snapshot().entries[0].status, 'expired');
    assert.equal(store.publish({ ...publish(), scope }).ok, false);
  });

  test('keeps the queue bounded', () => {
    const store = new SessionMemoryBranchStore();
    store.noteUserInput({ text: 'first', scope, turn: 1, turnId: 'input:1' });
    for (let index = 0; index < MAX_SESSION_MEMORY_OBSERVATIONS + 8; index += 1) {
      publishFinding(store, {
        subject: `subject-${index}`,
        claim: `claim-${index}`,
        sourceRefs: [`chat/2026-11-18/fixture.jsonl#${index}`],
      });
    }
    const snapshot = store.snapshot();
    assert.ok(snapshot.entries.length <= MAX_SESSION_MEMORY_OBSERVATIONS);
    assert.equal(snapshot.entries.length, MAX_SESSION_MEMORY_OBSERVATIONS);
    assert.equal(store.publish({
      ...publish(),
      subject: 'overflow',
      claim: 'overflow',
      sourceRefs: ['chat/2026-11-18/fixture.jsonl#999'],
    }).reason, 'queue_full', 'a full queue rejects instead of dropping a live claim');
  });
});

function publish() {
  return {
    subject: 'subject',
    claim: 'claim',
    sourceRefs: ['chat/2026-11-18/fixture.jsonl#1'],
    scope,
    originTurn: 1,
    originTurnId: 'episode:1',
    verifiedThroughInput: 1,
    branchId: 'branch-1',
  };
}
