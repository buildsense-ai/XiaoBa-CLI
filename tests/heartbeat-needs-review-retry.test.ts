import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DistillationHeartbeatScheduler,
} from '../src/utils/distillation-heartbeat-scheduler';
import {
  DistillationPipeline,
  loadReviewOutcomesSync,
  QueueReviewResult,
} from '../src/utils/distillation-pipeline';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  loadNeedsReviewQueue,
  NeedsReviewQueueEntry,
} from '../src/utils/needs-review-queue';
import {
  loadCapabilityRegistry,
} from '../src/utils/capability-registry';
import { requestNeedsReviewRetry } from '../src/commands/runtime';
import {
  DistillationUnit,
} from '../src/utils/distillation-unit';
import {
  DistilledKnowledgeCandidate,
} from '../src/utils/capability-distiller';
import {
  PromotionReviewResult,
  PROMOTION_REVIEWER_VERSION,
} from '../src/utils/promotion-reviewer';

// ---------------------------------------------------------------------------
// Heartbeat-driven Needs Review Queue re-review (issue #29).
//
// Drives the real heartbeat path with controlled session logs, an injectable
// distiller that produces a stable capability identity across occurrences, and
// an injectable reviewer that controls the review decision. The cycle-complete
// hook is wired to `pipeline.reviewEligibleQueueEntries` so the heartbeat
// autonomously re-reviews eligible queue entries.
//
// Covers all gates/transitions:
//  - unchanged reviewer version, evidence, and registry state → pending stays unreviewed
//  - reviewer-version, registry-state, explicit-command, and matching-evidence
//    changes make an entry eligible and persist the reason
//  - eligible entries are consumed via the consolidation reviewer
//  - non-needs_review resolves the entry + durable Registry/snapshot/outcome
//  - renewed needs_review preserves updated questions/rationale and is not retried
//    until another meaningful change
// ---------------------------------------------------------------------------

function makeTurn(
  turn: number,
  session_id: string,
  userText: string,
  assistantText: string,
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: [] },
    tokens: { prompt: 10, completion: 20 },
  };
}

function writeLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');
}

const PROBLEM = 'How do I parse a JSONL file line by line in Node without loading it all into memory?';
const ACCEPTANCE = 'Thanks, that works perfectly!';
const ACTION_A = 'Use readline to stream the file line by line and parse each line as JSON.';

const STABLE_CAPABILITY_ID = 'cap-stable-jsonl-readline';

/**
 * Injectable distiller that produces a stable capability identity across
 * occurrences. The deterministic distiller derives capabilityId from the turn
 * number, so two occurrences of the same problem get different IDs. This
 * distiller keeps the ID stable so the matching-evidence refresh path can find
 * an existing queued entry for the same capability.
 */
function makeStableDistiller(): (unit: DistillationUnit) => DistilledKnowledgeCandidate[] {
  return (unit: DistillationUnit): DistilledKnowledgeCandidate[] => {
    const newTurns = unit.newTurns;
    const candidates: DistilledKnowledgeCandidate[] = [];
    for (let i = 0; i < newTurns.length - 1; i++) {
      const problemTurn = newTurns[i];
      const verificationTurn = newTurns[i + 1];
      if (!problemTurn || !verificationTurn) continue;
      candidates.push({
        schemaVersion: 1,
        kind: 'capability',
        capabilityId: STABLE_CAPABILITY_ID,
        title: 'Capability: parse JSONL in Node',
        applicability: 'Applies when the user raises a similar problem to: parse a JSONL file',
        actionPattern: 'Use readline to stream the file line by line and parse each line as JSON.',
        boundaries: [
          'Only applies when the new situation matches the original problem shape.',
          'Do not apply when the user is still correcting or iterating on the request.',
        ],
        risks: ['Distilled from a single solved loop; the pattern may not generalize.'],
        solvedLoop: {
          problem: problemTurn.user.text,
          action: problemTurn.assistant.text,
          verification: verificationTurn.user.text,
          noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
        },
        provenance: [
          { filePath: unit.filePath, turn: problemTurn.turn, role: 'problem-action', unitByteRange: unit.byteRange },
          { filePath: unit.filePath, turn: verificationTurn.turn, role: 'verification', unitByteRange: unit.byteRange },
        ],
        generatedAt: new Date().toISOString(),
        sourceUnit: { filePath: unit.filePath, byteRange: unit.byteRange, generatedAt: unit.generatedAt },
      });
    }
    return candidates;
  };
}

/** Injectable reviewer whose decision can be changed between heartbeats. */
function makeControlledReviewer(): {
  reviewer: (packet: { candidate: DistilledKnowledgeCandidate }) => PromotionReviewResult;
  setDecision: (decision: PromotionReviewResult['decision']) => void;
} {
  let callCount = 0;
  let decision: PromotionReviewResult['decision'] = 'needs_review';
  return {
    reviewer: (packet) => {
      callCount++;
      return {
        schemaVersion: 1,
        capabilityId: packet.candidate.capabilityId,
        decision,
        rationale: `${decision} #${callCount}`,
        reviewRisks: [],
        rewrite: null,
        reviewedAt: new Date(Date.now() + callCount * 1000).toISOString(),
        questions: decision === 'needs_review' ? [`Question ${callCount}: what more evidence is needed?`] : undefined,
      };
    },
    setDecision: (d) => { decision = d; },
  };
}

interface TestEnv {
  root: string;
  logFile: string;
  registryFile: string;
  recordFile: string;
  reviewOutcomesFile: string;
  needsReviewQueueFile: string;
  outputDir: string;
  pipeline: DistillationPipeline;
  scheduler: DistillationHeartbeatScheduler;
  reviewer: ReturnType<typeof makeControlledReviewer>;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-needs-review-'));
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-09', 'chat_cli.jsonl');
  const registryFile = path.join(root, 'data', 'capability-registry-state.json');
  const recordFile = path.join(root, 'data', 'distillation-heartbeat-record.json');
  const reviewOutcomesFile = path.join(root, 'data', 'distillation-review-outcomes.json');
  const needsReviewQueueFile = path.join(root, 'data', 'needs-review-queue-state.json');
  const outputDir = path.join(root, 'skills', 'generated-distilled');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE: process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE,
    DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE: process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE,
    DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE: process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = path.join(root, 'data', 'distillation-cursor-state.json');
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordFile;
  process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE = reviewOutcomesFile;
  process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE = registryFile;
  process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE = needsReviewQueueFile;
  delete process.env.XIAOBA_ROLE;

  const controlledReviewer = makeControlledReviewer();
  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: reviewOutcomesFile,
    capabilityRegistryPath: registryFile,
    needsReviewQueuePath: needsReviewQueueFile,
    distiller: makeStableDistiller(),
    reviewer: controlledReviewer.reviewer as any,
  });

  const scheduler = new DistillationHeartbeatScheduler(
    root,
    unit => pipeline.processUnit(unit),
    () => pipeline.reviewEligibleQueueEntries(),
  );

  return {
    root,
    logFile,
    registryFile,
    recordFile,
    reviewOutcomesFile,
    needsReviewQueueFile,
    outputDir,
    pipeline,
    scheduler,
    reviewer: controlledReviewer,
    restore: () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (typeof value === 'string') {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }
    },
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function loadQueue(env: TestEnv) {
  return loadNeedsReviewQueue(env.needsReviewQueueFile);
}

function loadOutcomes(env: TestEnv) {
  return loadReviewOutcomesSync(env.reviewOutcomesFile);
}

function loadRegistry(env: TestEnv) {
  return loadCapabilityRegistry(env.registryFile);
}

function getSingleEntry(env: TestEnv): NeedsReviewQueueEntry {
  const queue = loadQueue(env);
  const entries = Object.values(queue.entries);
  assert.equal(entries.length, 1, 'expected exactly one queue entry');
  return entries[0]!;
}

describe('Heartbeat-driven Needs Review Queue re-review (issue #29)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.restore();
    env.teardown();
  });

  // Helper: write the first occurrence and run a heartbeat to enqueue a
  // needs_review entry. Returns the enqueued entry.
  async function enqueueFirstOccurrence(): Promise<NeedsReviewQueueEntry> {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');
    return getSingleEntry(env);
  }

  // -------------------------------------------------------------------------
  // Criterion 1: Unchanged reviewer version, evidence, and registry state
  // leave pending entries unreviewed across heartbeats.
  // -------------------------------------------------------------------------
  test('unchanged state leaves pending entries unreviewed across heartbeats', async () => {
    const entry = await enqueueFirstOccurrence();
    assert.equal(entry.status, 'pending');
    assert.equal(entry.retryEligibility.eligible, false);

    const outcomesAfterFirst = loadOutcomes(env);
    const outcomeCountAfterFirst = outcomesAfterFirst.length;

    // Second heartbeat with no new content and no state changes.
    const r2 = await env.scheduler.runHeartbeat('scheduled');
    assert.equal(r2.ran, true);

    const entry2 = getSingleEntry(env);
    assert.equal(entry2.status, 'pending', 'entry remains pending');
    assert.equal(entry2.retryEligibility.eligible, false, 'entry is not eligible');
    assert.match(
      entry2.retryEligibility.reason,
      /unchanged/,
      'reason explains unchanged fingerprints',
    );

    // No new review outcome was produced.
    const outcomesAfterSecond = loadOutcomes(env);
    assert.equal(
      outcomesAfterSecond.length,
      outcomeCountAfterFirst,
      'no new review outcome from the unchanged heartbeat',
    );

    // Third heartbeat — still unreviewed.
    await env.scheduler.runHeartbeat('scheduled');
    const entry3 = getSingleEntry(env);
    assert.equal(entry3.status, 'pending', 'entry still pending after third heartbeat');
    assert.equal(entry3.retryEligibility.eligible, false);
  });

  // -------------------------------------------------------------------------
  // Criterion 2a: Explicit runtime command makes an entry eligible and
  // persists the reason.
  // -------------------------------------------------------------------------
  test('explicit runtime retry command makes an entry eligible with a persisted reason', async () => {
    const entry = await enqueueFirstOccurrence();
    assert.equal(entry.retryEligibility.eligible, false);

    requestNeedsReviewRetry(
      env.root,
      entry.entryId,
      'Operator requested another pass.',
      '2026-07-10T02:00:00.000Z',
    );

    const queue = loadQueue(env);
    const marked = queue.entries[entry.entryId]!;
    assert.equal(marked.status, 'retry_eligible');
    assert.equal(marked.retryEligibility.eligible, true);
    assert.equal(marked.retryEligibility.reason, 'Operator requested another pass.');
    assert.equal(marked.retryEligibility.lastEligibleAt, '2026-07-10T02:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // Criterion 2b: Reviewer-version change makes a pending entry eligible.
  // -------------------------------------------------------------------------
  test('reviewer-version change makes a pending entry eligible', async () => {
    const entry = await enqueueFirstOccurrence();

    // Reconstruct the pipeline with a different reviewer version and run a
    // heartbeat so the cycle-complete hook detects the version change.
    const savedEnv = { ...process.env };
    process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE = env.reviewOutcomesFile;
    const pipelineV2 = new DistillationPipeline({
      outputDir: env.outputDir,
      reviewOutcomesPath: env.reviewOutcomesFile,
      capabilityRegistryPath: env.registryFile,
      needsReviewQueuePath: env.needsReviewQueueFile,
      distiller: makeStableDistiller(),
      reviewer: env.reviewer.reviewer as any,
      reviewerVersion: 'promotion-reviewer-v3',
    });
    const schedulerV2 = new DistillationHeartbeatScheduler(
      env.root,
      unit => pipelineV2.processUnit(unit),
      () => pipelineV2.reviewEligibleQueueEntries(),
    );

    await schedulerV2.runHeartbeat('scheduled');

    const queue = loadQueue(env);
    const updated = queue.entries[entry.entryId]!;
    // The version-change trigger makes the entry eligible, and the same
    // heartbeat consumes it immediately through the cycle-complete hook. The
    // persisted reason must still record the reviewer-version trigger.
    assert.equal(updated.status, 'pending', 'entry was re-reviewed and renewed to pending');
    assert.equal(updated.retryEligibility.eligible, false);
    assert.match(
      updated.retryEligibility.reason,
      /reviewer version/,
      'reason persists the reviewer-version trigger after re-review',
    );
    const outcomes = loadOutcomes(env);
    assert.ok(
      outcomes.length >= 2,
      'a new review outcome was produced from the version-triggered re-review',
    );

    // Restore env so teardown doesn't break.
    Object.assign(process.env, savedEnv);
  });

  // -------------------------------------------------------------------------
  // Criterion 2c: Matching-new-evidence change makes an entry eligible and
  // persists the reason.
  // -------------------------------------------------------------------------
  test('matching newly distilled evidence refreshes the queued entry and makes it eligible', async () => {
    const entry = await enqueueFirstOccurrence();
    const originalEvidenceFp = entry.evidenceFingerprint;
    const originalProvenanceCount = entry.candidatePayload.provenance.length;
    const originalSourceRefCount = entry.sourceRefs.length;

    // Append a second occurrence with the same problem + action. The stable
    // distiller produces the same capabilityId, so the pipeline finds the
    // existing queued entry and refreshes its evidence.
    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const queue = loadQueue(env);
    const entries = Object.values(queue.entries);
    assert.equal(entries.length, 1, 'no duplicate entry was created');

    const refreshed = queue.entries[entry.entryId]!;
    // The evidence fingerprint changed because new provenance was merged.
    assert.notEqual(
      refreshed.evidenceFingerprint,
      originalEvidenceFp,
      'evidence fingerprint changed after refresh',
    );
    assert.ok(
      refreshed.candidatePayload.provenance.length > originalProvenanceCount,
      'new provenance refs were merged into the queued candidate',
    );
    assert.ok(
      refreshed.sourceRefs.length > originalSourceRefCount,
      'new provenance refs were also saved in the durable queue material',
    );

    // The entry was consumed by the cycle-complete hook in the same heartbeat
    // (reviewer still returns needs_review → renewed to pending). But the
    // refresh reason is persisted in the review-outcomes log, which now records
    // the re-review. The key assertion is that the evidence fingerprint changed
    // and no duplicate was created, proving the refresh path ran.
    const outcomes = loadOutcomes(env);
    assert.ok(outcomes.length >= 2, 'at least two review outcomes (enqueue + re-review)');
  });

  test('matching new evidence resolves the existing entry even when the current review is resolvable', async () => {
    const entry = await enqueueFirstOccurrence();
    env.reviewer.setDecision('new_capability');

    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const queue = loadQueue(env);
    const refreshedAndResolved = queue.entries[entry.entryId]!;
    assert.equal(refreshedAndResolved.status, 'resolved');
    assert.equal(Object.keys(queue.entries).length, 1, 'the matching occurrence does not create a second entry');
    assert.ok(
      loadRegistry(env).capabilities[STABLE_CAPABILITY_ID],
      'the re-review decision updates the Capability Registry for the queued entry',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3: Eligible entries are automatically consumed by the heartbeat
  // through the consolidation reviewer.
  // -------------------------------------------------------------------------
  test('eligible entries are consumed by the heartbeat through the consolidation reviewer', async () => {
    const entry = await enqueueFirstOccurrence();

    // Make the entry eligible via an explicit retry command.
    requestNeedsReviewRetry(env.root, entry.entryId, 'Operator requested retry.', '2026-07-10T02:00:00.000Z');

    // The reviewer still returns needs_review, so the entry will be renewed
    // (not resolved). But the re-review must happen — a new review outcome is
    // produced.
    const outcomesBefore = loadOutcomes(env).length;
    await env.scheduler.runHeartbeat('scheduled');
    const outcomesAfter = loadOutcomes(env);

    assert.ok(
      outcomesAfter.length > outcomesBefore,
      'a new review outcome was produced from the queue re-review',
    );

    // The last outcome is a needs_review from the re-review.
    const lastOutcome = outcomesAfter[outcomesAfter.length - 1]!;
    assert.equal(lastOutcome.decision, 'needs_review');
    assert.equal(lastOutcome.capabilityId, STABLE_CAPABILITY_ID);
  });

  // -------------------------------------------------------------------------
  // Criterion 4: A non-needs_review result resolves the entry and leaves the
  // corresponding durable Registry, snapshot, and review-outcome transition.
  // -------------------------------------------------------------------------
  test('a non-needs_review result resolves the queue entry and leaves durable Registry/snapshot/outcome', async () => {
    const entry = await enqueueFirstOccurrence();

    // Make the entry eligible.
    requestNeedsReviewRetry(env.root, entry.entryId, 'Operator requested retry.', '2026-07-10T02:00:00.000Z');

    // Switch the reviewer to resolve with new_capability.
    env.reviewer.setDecision('new_capability');

    await env.scheduler.runHeartbeat('scheduled');

    // The queue entry is resolved.
    const queue = loadQueue(env);
    const resolved = queue.entries[entry.entryId]!;
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.retryEligibility.eligible, false);

    // The durable review-outcomes log records the new_capability decision.
    const outcomes = loadOutcomes(env);
    const newCapOutcomes = outcomes.filter(o => o.decision === 'new_capability');
    assert.ok(newCapOutcomes.length >= 1, 'a new_capability outcome was recorded');
    const resolveOutcome = newCapOutcomes[newCapOutcomes.length - 1]!;
    assert.equal(resolveOutcome.capabilityId, STABLE_CAPABILITY_ID);
    assert.ok(resolveOutcome.snapshotId, 'outcome records the installed snapshot id');
    assert.ok(resolveOutcome.skillFilePath, 'outcome records the installed skill file path');

    // The Capability Registry has a durable entry with an Active Snapshot.
    const registry = loadRegistry(env);
    const regEntry = registry.capabilities[STABLE_CAPABILITY_ID];
    assert.ok(regEntry, 'registry has a durable entry for the resolved capability');
    assert.equal(regEntry!.status, 'active');
    assert.ok(regEntry!.activeSnapshotId, 'registry entry has an active snapshot');

    // The immutable snapshot is on disk.
    const snapshotPath = path.join(env.outputDir, STABLE_CAPABILITY_ID, regEntry!.activeSnapshotId, 'SKILL.md');
    assert.ok(fs.existsSync(snapshotPath), 'Active Snapshot SKILL.md exists on disk');
  });

  // -------------------------------------------------------------------------
  // Criterion 5: A renewed needs_review preserves updated questions/rationale
  // and is not retried again until another meaningful change.
  // -------------------------------------------------------------------------
  test('a renewed needs_review preserves updated questions/rationale and is not retried until meaningful change', async () => {
    const entry = await enqueueFirstOccurrence();
    const originalRationale = entry.rationale;
    const originalQuestions = entry.questions;

    // Make the entry eligible and run a heartbeat. The reviewer still returns
    // needs_review, so the entry is renewed.
    requestNeedsReviewRetry(env.root, entry.entryId, 'Operator requested retry.', '2026-07-10T02:00:00.000Z');
    await env.scheduler.runHeartbeat('scheduled');

    const queueAfterRenew = loadQueue(env);
    const renewed = queueAfterRenew.entries[entry.entryId]!;
    assert.equal(renewed.status, 'pending', 'renewed entry returns to pending');
    assert.equal(renewed.retryEligibility.eligible, false, 'renewed entry is not eligible');
    assert.match(
      renewed.retryEligibility.reason,
      /Renewed needs_review/,
      'reason explains the renewed state',
    );

    // The rationale and questions were updated from the renewed review.
    assert.notEqual(renewed.rationale, originalRationale, 'rationale was updated');
    assert.notDeepEqual(renewed.questions, originalQuestions, 'questions were updated');
    assert.ok(renewed.questions.length > 0, 'renewed questions are preserved');

    // The stored reviewer version and registry-state fingerprint are pinned to
    // the current values so an unchanged version won't re-trigger.
    assert.equal(renewed.reviewerVersion, PROMOTION_REVIEWER_VERSION);

    // A subsequent heartbeat with no meaningful change does not re-review.
    const outcomesAfterRenew = loadOutcomes(env).length;
    await env.scheduler.runHeartbeat('scheduled');
    const outcomesAfterSecond = loadOutcomes(env);
    assert.equal(
      outcomesAfterSecond.length,
      outcomesAfterRenew,
      'renewed entry was not re-reviewed without a meaningful change',
    );

    const queueAfterSecond = loadQueue(env);
    const stillPending = queueAfterSecond.entries[entry.entryId]!;
    assert.equal(stillPending.status, 'pending', 'entry still pending');
    assert.equal(stillPending.retryEligibility.eligible, false);
    // The rationale from the renew is preserved (not overwritten).
    assert.equal(stillPending.rationale, renewed.rationale, 'renewed rationale preserved');
  });

  // -------------------------------------------------------------------------
  // Criterion 5b: After renewal, another explicit retry makes the entry
  // eligible again (the renew does not permanently block retries).
  // -------------------------------------------------------------------------
  test('after renewal, another explicit retry makes the entry eligible again', async () => {
    const entry = await enqueueFirstOccurrence();
    requestNeedsReviewRetry(env.root, entry.entryId, 'First retry.', '2026-07-10T02:00:00.000Z');
    await env.scheduler.runHeartbeat('scheduled');

    const renewed = loadQueue(env).entries[entry.entryId]!;
    assert.equal(renewed.status, 'pending');
    assert.equal(renewed.retryEligibility.eligible, false);

    // Another explicit retry should make it eligible again.
    requestNeedsReviewRetry(env.root, entry.entryId, 'Second retry.', '2026-07-10T03:00:00.000Z');
    const queue = loadQueue(env);
    const reEligible = queue.entries[entry.entryId]!;
    assert.equal(reEligible.status, 'retry_eligible');
    assert.equal(reEligible.retryEligibility.eligible, true);
    assert.equal(reEligible.retryEligibility.reason, 'Second retry.');
  });

  // -------------------------------------------------------------------------
  // Criterion 2d: Registry-state change makes a pending entry eligible.
  // -------------------------------------------------------------------------
  test('relevant registry-state change makes a pending entry eligible', async () => {
    const entry = await enqueueFirstOccurrence();

    // Manually create a registry entry that the queue entry's
    // matchedCapabilityIds references, so the registry-state fingerprint
    // changes. The queue entry was enqueued with an empty registry, so adding
    // a capability changes the fingerprint for the matched IDs.
    // We simulate this by writing a registry file that includes a capability
    // the queue entry references. The queue entry's matchedCapabilityIds is
    // empty (no registry matches at enqueue time), so we need a different
    // approach: directly add a capability to the registry and update the
    // queue entry's matchedCapabilityIds to reference it.

    // Load the queue, add a matched capability ID to the entry, and save.
    const queue = loadQueue(env);
    const queued = queue.entries[entry.entryId]!;
    queued.matchedCapabilityIds = ['cap-other-jsonl'];
    fs.writeFileSync(env.needsReviewQueueFile, JSON.stringify({
      schemaVersion: 1,
      entries: { [entry.entryId]: queued },
    }, null, 2));

    // Write a registry with that capability so the fingerprint is non-null.
    const registryState = {
      schemaVersion: 1,
      capabilities: {
        'cap-other-jsonl': {
          capabilityId: 'cap-other-jsonl',
          activeSnapshotId: 'snap-1',
          status: 'active',
          routingDescription: 'Parse JSONL with readline',
          evidenceRefs: [],
          relatedSnapshotIds: ['snap-1'],
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
        },
      },
    };
    fs.mkdirSync(path.dirname(env.registryFile), { recursive: true });
    fs.writeFileSync(env.registryFile, JSON.stringify(registryState, null, 2));

    // Run a heartbeat — the cycle-complete hook should detect the registry-state
    // change (the fingerprint now includes cap-other-jsonl which was absent at
    // enqueue time) and make the entry eligible.
    await env.scheduler.runHeartbeat('scheduled');

    const queueAfter = loadQueue(env);
    const updated = queueAfter.entries[entry.entryId]!;
    // The registry-state trigger makes the entry eligible, and the same
    // heartbeat consumes it immediately. The renewed entry must still carry the
    // trigger reason durably.
    assert.equal(updated.status, 'pending', 'entry was re-reviewed and renewed to pending');
    assert.equal(updated.retryEligibility.eligible, false);
    assert.match(
      updated.retryEligibility.reason,
      /registry-state fingerprint/,
      'reason persists the registry-state trigger after re-review',
    );
    const outcomes = loadOutcomes(env);
    assert.ok(
      outcomes.length >= 2,
      'a new review outcome was produced from the registry-triggered re-review',
    );
  });
});
