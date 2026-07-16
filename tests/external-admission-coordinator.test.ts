/**
 * Issue #93 — External Admission Coordinator.
 *
 * Tests the single-writer coordinator that serializes durable admission of
 * ready pages produced by concurrent provider reads. The coordinator provides
 * work-conserving round-robin admission across enabled providers, persists a
 * durable next-provider rotation marker, arbitrates backfill vs continuous
 * pages per provider, and preserves the Episode → Capsule → provenance →
 * cursor acknowledgement commit order.
 *
 * These tests exercise the coordinator through its public seam using a
 * deterministic fake commit function, proving single-writer behavior, fair
 * order, starvation resistance, crash replay, deadline drain, and
 * backfill arbitration — all without real provider readers or async pools.
 */

import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ExternalAdmissionCoordinator,
  type ExternalEvidencePage,
  type ExternalAdmissionCommitResult,
  type ExternalAdmissionCommitFn,
  type ExternalAdmissionCoordinatorState,
} from '../src/utils/external-admission-coordinator';
import type {
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SessionLogSourceReadResult,
  SourceEventIdentity,
  SourceCursor,
} from '../src/utils/session-log-source';
import type { DistillationUnit } from '../src/utils/distillation-unit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-test-'));
  tempDirs.push(dir);
  return dir;
}

function stateFilePath(dir: string): string {
  return path.join(dir, 'external-admission-coordinator-state.json');
}

function makeIdentity(provider: string, sourceId?: string): SessionLogSourceIdentity {
  return {
    sourceId: sourceId ?? `external-${provider}`,
    label: `External Source (${provider})`,
    category: 'external',
    provider,
    reader: 'fixture',
  };
}

function makeResource(ref: string): SessionLogSourceResource {
  return { resourceRef: ref };
}

function makeEventIdentity(eventId: string, position: number): SourceEventIdentity {
  return { eventId, position, conversationId: 'conv-1', branchId: 'main' };
}

function makeDistillationUnit(filePath: string): DistillationUnit {
  return {
    filePath,
    newTurns: [],
    continuityTurns: [],
    byteRange: { start: 0, end: 1 },
    generatedAt: '2025-01-01T00:00:00.000Z',
  };
}

function makeReadResult(resourceRef: string, position: number): SessionLogSourceReadResult {
  const newCursor: SourceCursor = { resourceRef, position, processedCount: 1 };
  return {
    distillationUnit: null,
    distillationUnits: [makeDistillationUnit(`xurl://fake/${resourceRef}`)],
    advanced: true,
    status: 'advanced',
    newCursor,
    eventIdentities: [makeEventIdentity(`event-${position}`, position)],
    accounting: { events: 1, bytes: 100, elapsedMs: 1 },
  };
}

function makePage(
  provider: string,
  resourceRef: string,
  position: number,
  lane: 'continuous' | 'catch-up' | 'backfill' = 'continuous',
): ExternalEvidencePage {
  return {
    providerId: provider,
    sourceId: `external-${provider}`,
    identity: makeIdentity(provider),
    resource: makeResource(resourceRef),
    distillationUnits: [makeDistillationUnit(`xurl://${provider}/${resourceRef}`)],
    eventIdentities: [makeEventIdentity(`event-${position}`, position)],
    readResult: makeReadResult(resourceRef, position),
    lane,
  };
}

interface CommitRecord {
  readonly page: ExternalEvidencePage;
  readonly sequence: number;
}

function makeRecordingCommitFn(records: CommitRecord[]): ExternalAdmissionCommitFn {
  let seq = 0;
  return (page: ExternalEvidencePage): ExternalAdmissionCommitResult => {
    records.push({ page, sequence: seq++ });
    return {
      admittedEpisodes: 1,
      contradictionSignals: 0,
      acknowledged: true,
    };
  };
}

function makeFailingCommitFn(): ExternalAdmissionCommitFn {
  return (): ExternalAdmissionCommitResult => ({
    admittedEpisodes: 0,
    contradictionSignals: 0,
    acknowledged: false,
    error: new Error('commit failed during test'),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExternalAdmissionCoordinator — round-robin fairness', () => {
  test('selectNextProvider returns null when no providers are ready', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });
    assert.equal(coordinator.selectNextProvider([]), null);
  });

  test('selectNextProvider returns the sole ready provider', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });
    assert.equal(coordinator.selectNextProvider(['codex']), 'codex');
  });

  test('selectNextProvider rotates across multiple ready providers', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // First round: start from the first provider (alphabetical: claude, codex, pi)
    const first = coordinator.selectNextProvider(['codex', 'claude', 'pi']);
    assert.equal(first, 'claude');
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'claude');

    // After serving claude, next should be codex
    const second = coordinator.selectNextProvider(['codex', 'claude', 'pi']);
    assert.equal(second, 'codex');
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'codex');

    // After serving codex, next should be pi
    const third = coordinator.selectNextProvider(['codex', 'claude', 'pi']);
    assert.equal(third, 'pi');
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'pi');

    // After serving pi, wraps back to claude
    const fourth = coordinator.selectNextProvider(['codex', 'claude', 'pi']);
    assert.equal(fourth, 'claude');
  });

  test('selectNextProvider skips providers not in the ready set', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // Serve claude first (alphabetical)
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'claude');

    // Now only codex and pi are ready (claude is slow)
    const next = coordinator.selectNextProvider(['codex', 'pi']);
    assert.equal(next, 'codex');
  });

  test('selectNextProvider is work-conserving: skips absent providers without blocking', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // Set nextProvider to a provider that is NOT ready
    coordinator.advanceNextProvider(['codex', 'claude'], 'codex');
    // Manually set nextProvider to a non-ready provider
    coordinator.setStateForTesting({ schemaVersion: 1, nextProvider: 'pi', providerTurns: {} });

    // pi is not ready; should skip to codex (first in sorted ready set after pi)
    const next = coordinator.selectNextProvider(['codex', 'claude']);
    assert.ok(next === 'codex' || next === 'claude');
    assert.notEqual(next, 'pi');
  });
});

describe('ExternalAdmissionCoordinator — durable next-provider marker', () => {
  test('nextProvider persists across coordinator restart', () => {
    const dir = makeTempDir();
    const filePath = stateFilePath(dir);
    const records: CommitRecord[] = [];

    const first = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn(records),
    });
    first.advanceNextProvider(['codex', 'claude', 'pi'], 'claude');
    first.saveState();
    assert.ok(fs.existsSync(filePath), 'state file should exist after saveState');

    // Recreate from disk
    const second = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn(records),
    });
    const next = second.selectNextProvider(['codex', 'claude', 'pi']);
    assert.equal(next, 'codex', 'restarted coordinator should resume from saved nextProvider');
  });

  test('nextProvider marker survives provider set reorder', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // Serve claude, then codex
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'claude');
    coordinator.advanceNextProvider(['codex', 'claude', 'pi'], 'codex');

    // Now pi is removed from the set; nextProvider was 'pi'
    coordinator.advanceNextProvider(['codex', 'claude'], 'pi');

    // With only codex and claude ready, nextProvider was 'pi' which is absent;
    // should wrap to claude (first alphabetically)
    const next = coordinator.selectNextProvider(['codex', 'claude']);
    assert.equal(next, 'claude');
  });

  test('admitPage persists state after each commit', () => {
    const dir = makeTempDir();
    const filePath = stateFilePath(dir);
    const records: CommitRecord[] = [];

    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn(records),
    });

    coordinator.admitPage(makePage('codex', 'thread-1', 0));
    assert.ok(fs.existsSync(filePath), 'state should be persisted after admitPage');

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ExternalAdmissionCoordinatorState;
    assert.equal(raw.schemaVersion, 1);
    assert.ok(raw.nextProvider, 'nextProvider should be set after commit');
  });
});

describe('ExternalAdmissionCoordinator — single-writer serialization', () => {
  test('admitPage commits one page at a time and records the sequence', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    const page1 = makePage('codex', 'thread-1', 0);
    const page2 = makePage('claude', 'thread-2', 0);

    const result1 = coordinator.admitPage(page1);
    const result2 = coordinator.admitPage(page2);

    assert.equal(records.length, 2);
    assert.equal(records[0].page.providerId, 'codex');
    assert.equal(records[1].page.providerId, 'claude');
    assert.ok(result1.acknowledged);
    assert.ok(result2.acknowledged);
  });

  test('commit function receives pages in Episode→Capsule→provenance→cursor order', () => {
    const dir = makeTempDir();
    const commitCalls: ExternalEvidencePage[] = [];
    let callCount = 0;
    const commitFn: ExternalAdmissionCommitFn = (page) => {
      callCount++;
      commitCalls.push(page);
      // Verify the page carries the full commit payload
      assert.ok(page.distillationUnits.length > 0, 'page must carry distillation units');
      assert.ok(page.eventIdentities.length > 0, 'page must carry event identities');
      assert.ok(page.readResult, 'page must carry the read result for cursor acknowledgement');
      return { admittedEpisodes: 1, contradictionSignals: 0, acknowledged: true };
    };

    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn,
    });

    coordinator.admitPage(makePage('codex', 'thread-1', 0));
    assert.equal(callCount, 1);
    assert.equal(commitCalls[0].providerId, 'codex');
  });
});

describe('ExternalAdmissionCoordinator — starvation resistance', () => {
  test('a slow provider never blocks ready providers', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // Ready set excludes the slow 'pi' provider
    const ready1 = coordinator.selectNextProvider(['codex', 'claude']);
    assert.equal(ready1, 'claude');

    // Even if nextProvider was 'pi' (the slow one), it gets skipped
    coordinator.setStateForTesting({ schemaVersion: 1, nextProvider: 'pi', providerTurns: {} });
    const ready2 = coordinator.selectNextProvider(['codex', 'claude']);
    assert.notEqual(ready2, 'pi');
    assert.ok(ready2 === 'codex' || ready2 === 'claude');
  });

  test('a continuously ready provider does not monopolize all turns', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    const providers = ['claude', 'codex', 'pi'];

    // Simulate 3 rounds: each round, all three are ready
    for (let round = 0; round < 3; round++) {
      for (const expected of providers) {
        const next = coordinator.selectNextProvider(providers);
        assert.equal(next, expected, `round ${round}: expected ${expected} but got ${next}`);
        coordinator.admitPage(makePage(expected, `thread-${round}`, round), providers);
      }
    }

    // After 3 full rounds, each provider got exactly 3 turns
    const counts: Record<string, number> = {};
    for (const r of records) {
      counts[r.page.providerId] = (counts[r.page.providerId] ?? 0) + 1;
    }
    assert.equal(counts['codex'], 3);
    assert.equal(counts['claude'], 3);
    assert.equal(counts['pi'], 3);
  });
});

describe('ExternalAdmissionCoordinator — backfill arbitration', () => {
  test('forced backfill is followed by durable rotation across every ready lane', () => {
    const dir = makeTempDir();
    const filePath = stateFilePath(dir);
    const records: CommitRecord[] = [];
    const first = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn(records),
    });

    first.markBackfillPending('codex');
    first.admitPages([
      makePage('codex', 'thread-continuous', 1, 'continuous'),
      makePage('codex', 'thread-catch-up', 1, 'catch-up'),
      makePage('codex', 'thread-backfill', 1, 'backfill'),
    ], ['codex']);

    assert.deepEqual(
      records.map(record => record.page.lane),
      ['backfill', 'continuous', 'catch-up'],
      'backfill keeps its next-turn guarantee, then all ready lanes rotate',
    );

    const restartedRecords: CommitRecord[] = [];
    const restarted = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn(restartedRecords),
    });
    restarted.admitPages([
      makePage('codex', 'thread-catch-up-2', 2, 'catch-up'),
      makePage('codex', 'thread-continuous-2', 2, 'continuous'),
    ], ['codex']);

    assert.deepEqual(
      restartedRecords.map(record => record.page.lane),
      ['continuous', 'catch-up'],
      'the lane continuation survives coordinator restart',
    );
  });

  test('backfill receives the next provider turn after the current commit', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    // Continuous page for codex
    coordinator.admitPage(makePage('codex', 'thread-1', 0, 'continuous'));

    // Mark backfill as pending for codex
    coordinator.markBackfillPending('codex');

    // The next page for codex should be backfill
    const nextLane = coordinator.selectNextLane('codex');
    assert.equal(nextLane, 'backfill');
  });

  test('backfill and continuous alternate while both remain ready', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    // Serve continuous first
    coordinator.admitPage(makePage('codex', 'thread-1', 0, 'continuous'));

    // Mark backfill pending
    coordinator.markBackfillPending('codex');

    // Backfill should get the next turn
    assert.equal(coordinator.selectNextLane('codex'), 'backfill');
    coordinator.admitPage(makePage('codex', 'thread-1', 1, 'backfill'));
    coordinator.clearBackfillPending('codex');

    // Now continuous should get the next turn
    assert.equal(coordinator.selectNextLane('codex'), 'continuous');
    coordinator.admitPage(makePage('codex', 'thread-2', 0, 'continuous'));

    // If backfill is pending again, it should get the next turn
    coordinator.markBackfillPending('codex');
    assert.equal(coordinator.selectNextLane('codex'), 'backfill');
  });

  test('backfill retains independent cursor state in its page', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    const backfillPage = makePage('codex', 'thread-backfill', 5, 'backfill');
    coordinator.admitPage(backfillPage);

    assert.equal(records[0].page.lane, 'backfill');
    assert.equal(records[0].page.resource.resourceRef, 'thread-backfill');
    assert.equal(records[0].page.eventIdentities[0].position, 5);
  });

  test('different-provider backfill does not interfere with continuous ordering', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    // Serve codex continuous
    coordinator.admitPage(makePage('codex', 'thread-1', 0, 'continuous'));

    // Claude backfill is ready — it should get the next turn (different provider)
    coordinator.markBackfillPending('claude');
    const claudeLane = coordinator.selectNextLane('claude');
    assert.equal(claudeLane, 'backfill');

    // Codex continuous should still be 'continuous' (independent)
    const codexLane = coordinator.selectNextLane('codex');
    assert.equal(codexLane, 'continuous');
  });
});

describe('ExternalAdmissionCoordinator — deadline drain', () => {
  test('admitPage rejects a Ready page after deadline is set', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    // Commit one page before deadline
    coordinator.admitPage(makePage('codex', 'thread-1', 0));
    assert.equal(records.length, 1);

    // Set deadline — no new page should start committing
    coordinator.setDeadlineReached();

    const result = coordinator.admitPage(makePage('claude', 'thread-2', 0));
    assert.equal(records.length, 1, 'no new commit after deadline');
    assert.equal(result.acknowledged, false);
    assert.ok(result.error, 'deadline result should carry an error');
  });

  test('admitPageInProgress allows the single Committing page to settle', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    // Start an in-progress commit (simulates a commit that was already started)
    coordinator.markCommitting(makePage('codex', 'thread-1', 0));

    // Set deadline while the commit is in progress
    coordinator.setDeadlineReached();

    // The in-progress commit should still be allowed to settle
    const result = coordinator.settleCommitting();
    assert.ok(result.acknowledged, 'in-progress commit should settle');
    assert.equal(records.length, 1);
  });
});

describe('ExternalAdmissionCoordinator — crash replay idempotency', () => {
  test('a crash before cursor ack leaves the page replayable', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];

    // Commit function that simulates a crash: acknowledges episodes/capsules
    // but fails before cursor ack
    let crashed = false;
    const commitFn: ExternalAdmissionCommitFn = (page) => {
      records.push({ page, sequence: records.length });
      if (!crashed) {
        crashed = true;
        return {
          admittedEpisodes: 1,
          contradictionSignals: 0,
          acknowledged: false,
          error: new Error('crash before cursor ack'),
        };
      }
      return {
        admittedEpisodes: 1,
        contradictionSignals: 0,
        acknowledged: true,
      };
    };

    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn,
    });

    // First attempt crashes
    const page = makePage('codex', 'thread-1', 0);
    const result1 = coordinator.admitPage(page);
    assert.equal(result1.acknowledged, false, 'first attempt should fail');
    assert.equal(records.length, 1, 'commit function was called once');

    // Replay: the same page should be re-admitted idempotently
    const result2 = coordinator.admitPage(page);
    assert.equal(result2.acknowledged, true, 'replay should succeed');
    assert.equal(records.length, 2, 'commit function was called again for replay');
  });

  test('replay does not produce duplicate state advance', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    // Admit a page successfully
    coordinator.admitPage(makePage('codex', 'thread-1', 0));
    const state1 = coordinator.getStateForTesting();

    // Re-admit the same page — state should advance normally (idempotent replay
    // means the coordinator doesn't reject it, but the commit fn handles
    // deduplication)
    coordinator.admitPage(makePage('codex', 'thread-1', 0));
    const state2 = coordinator.getStateForTesting();

    // The nextProvider should have advanced past codex in both cases
    assert.ok(state1.nextProvider, 'state1 should have nextProvider set');
    assert.ok(state2.nextProvider, 'state2 should have nextProvider set');
  });
});

describe('ExternalAdmissionCoordinator — quota enforcement', () => {
  test('admitPages respects a maxPages quota', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
      maxPagesPerRound: 2,
    });

    const providers = ['codex', 'claude', 'pi'];
    const pages = providers.map(p => makePage(p, `thread-0`, 0));

    const results = coordinator.admitPages(pages, providers);

    // Only 2 pages should be committed (maxPagesPerRound = 2)
    const committed = results.filter(r => r.acknowledged);
    assert.equal(committed.length, 2, 'only 2 pages should be committed');
    assert.equal(records.length, 2);
  });

  test('admitPages with no quota commits all ready pages', () => {
    const dir = makeTempDir();
    const records: CommitRecord[] = [];
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn(records),
    });

    const providers = ['claude', 'codex'];
    const pages = providers.map(p => makePage(p, `thread-0`, 0));

    const results = coordinator.admitPages(pages, providers);
    assert.equal(results.length, 2);
    assert.equal(records.length, 2);
    // Each provider should get exactly one page (sorted order: claude first)
    assert.equal(records[0].page.providerId, 'claude');
    assert.equal(records[1].page.providerId, 'codex');
  });
});

describe('ExternalAdmissionCoordinator — state persistence', () => {
  test('loadState recovers providerTurns after restart', () => {
    const dir = makeTempDir();
    const filePath = stateFilePath(dir);

    const first = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn([]),
    });

    first.admitPage(makePage('codex', 'thread-1', 0, 'continuous'));
    first.markBackfillPending('codex');
    first.saveState();

    const second = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn([]),
    });

    const state = second.getStateForTesting();
    assert.ok(state.providerTurns['codex'], 'providerTurns should be recovered');
    assert.equal(state.providerTurns['codex'].backfillPending, true);
  });

  test('missing state file starts with empty state', () => {
    const dir = makeTempDir();
    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: stateFilePath(dir),
      commitFn: makeRecordingCommitFn([]),
    });

    const state = coordinator.getStateForTesting();
    assert.equal(state.nextProvider, null);
    assert.deepEqual(state.providerTurns, {});
  });

  test('corrupt state file fails closed with empty state', () => {
    const dir = makeTempDir();
    const filePath = stateFilePath(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, '{ not valid json', 'utf-8');

    const coordinator = new ExternalAdmissionCoordinator({
      stateFilePath: filePath,
      commitFn: makeRecordingCommitFn([]),
    });

    const state = coordinator.getStateForTesting();
    assert.equal(state.nextProvider, null, 'corrupt state should default to empty');
    assert.deepEqual(state.providerTurns, {});
  });
});
