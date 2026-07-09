import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DistillationUnit } from '../src/utils/distillation-unit';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';
import {
  appendEvidence,
  CapabilityRegistryState,
  emptyCapabilityRegistryState,
  loadCapabilityRegistry,
  makeEvidenceRef,
  newCapability,
  saveCapabilityRegistry,
} from '../src/utils/capability-registry';
import {
  loadNeedsReviewQueue,
  NeedsReviewQueueState,
} from '../src/utils/needs-review-queue';
import {
  buildPromotionPacket,
  PromotionDecision,
  PromotionPacket,
  PromotionReviewResult,
} from '../src/utils/promotion-reviewer';
import {
  DistillationPipeline,
  DistillerFn,
  loadReviewOutcomesSync,
  ReviewerFn,
} from '../src/utils/distillation-pipeline';
import {
  computeSnapshotId,
  resolveEffectiveFields,
} from '../src/utils/distilled-skill-installer';

// ---------------------------------------------------------------------------
// V2 distillation pipeline wiring (issue #20).
//
// Exercises the runtime-visible state transitions when the pipeline applies
// V2 consolidation decisions from injectable fixtures:
//   new_capability, append_evidence, supersede_snapshot, needs_review, reject.
//
// The default deterministic reviewer is bypassed; tests control the decisions
// so the assertions target durable state, not prompt behavior.
// ---------------------------------------------------------------------------

const EVIDENCE: SolvedLoopEvidence = {
  problem: 'How do I parse a JSONL file line by line in Node?',
  action: 'Used tools [read_file] and said: Use readline to stream the file.',
  verification: 'Thanks, that works perfectly!',
  noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
};

function fixtureCandidate(
  unit: DistillationUnit,
  capabilityId: string,
  actionPattern?: string,
): DistilledKnowledgeCandidate {
  const provenance: CapabilityProvenanceRef[] = [
    {
      filePath: unit.filePath,
      turn: unit.newTurns[0]?.turn ?? 1,
      role: 'problem-action',
      unitByteRange: unit.byteRange,
    },
    {
      filePath: unit.filePath,
      turn: unit.newTurns[1]?.turn ?? 2,
      role: 'verification',
      unitByteRange: unit.byteRange,
    },
  ];
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: `Capability: ${EVIDENCE.problem.slice(0, 60)}`,
    applicability: `Applies when the user raises a similar problem to: ${EVIDENCE.problem.slice(0, 100)}`,
    actionPattern: actionPattern ?? `Respond with: ${EVIDENCE.action.slice(0, 120)}`,
    boundaries: [
      'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
    ],
    risks: ['Distilled from a single solved loop; the pattern may not generalize.'],
    solvedLoop: EVIDENCE,
    provenance,
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: unit.filePath,
      byteRange: unit.byteRange,
      generatedAt: unit.generatedAt,
    },
  };
}

function makeUnit(): DistillationUnit {
  return {
    filePath: '/tmp/test-log.jsonl',
    newTurns: [
      { turn: 1, user: { text: 'How do I parse a JSONL file?' }, assistant: { text: 'Use readline.', tool_calls: [] } },
      { turn: 2, user: { text: 'Thanks, that works perfectly!' }, assistant: { text: 'Glad it helped.', tool_calls: [] } },
    ],
    continuityTurns: [],
    byteRange: { start: 0, end: 200 },
    generatedAt: '2026-07-10T00:00:00.000Z',
  };
}

interface TestEnv {
  root: string;
  outputDir: string;
  reviewOutcomesPath: string;
  registryPath: string;
  queuePath: string;
  pipeline: DistillationPipeline;
  teardown: () => void;
}

function setupEnv(reviewer: ReviewerFn): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pipeline-v2-'));
  const outputDir = path.join(root, 'skills', 'generated-distilled');
  const reviewOutcomesPath = path.join(root, 'data', 'review-outcomes.json');
  const registryPath = path.join(root, 'data', 'capability-registry.json');
  const queuePath = path.join(root, 'data', 'needs-review-queue.json');

  const distiller: DistillerFn = () => [
    fixtureCandidate(makeUnit(), 'cap-v1-promote'),
    fixtureCandidate(makeUnit(), 'cap-v2-new'),
    fixtureCandidate(makeUnit(), 'cap-v2-append'),
    fixtureCandidate(makeUnit(), 'cap-v2-supersede', 'Superseded action pattern for the same problem.'),
    fixtureCandidate(makeUnit(), 'cap-v2-needs-review'),
    fixtureCandidate(makeUnit(), 'cap-v2-reject'),
  ];

  const pipeline = new DistillationPipeline({
    distiller,
    reviewer,
    outputDir,
    reviewOutcomesPath,
    capabilityRegistryPath: registryPath,
    needsReviewQueuePath: queuePath,
  });

  return {
    root,
    outputDir,
    reviewOutcomesPath,
    registryPath,
    queuePath,
    pipeline,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function setupSingleCandidateEnv(
  capabilityId: string,
  decision: PromotionDecision,
  actionPattern?: string,
): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pipeline-v2-'));
  const outputDir = path.join(root, 'skills', 'generated-distilled');
  const reviewOutcomesPath = path.join(root, 'data', 'review-outcomes.json');
  const registryPath = path.join(root, 'data', 'capability-registry.json');
  const queuePath = path.join(root, 'data', 'needs-review-queue.json');

  const distiller: DistillerFn = () => [
    fixtureCandidate(makeUnit(), capabilityId, actionPattern),
  ];

  const reviewer: ReviewerFn = packet => ({
    schemaVersion: 1,
    capabilityId: packet.candidate.capabilityId,
    decision,
    rationale: `Fixture reviewer decision: ${decision}`,
    reviewRisks: [],
    rewrite: null,
    reviewedAt: '2026-07-10T01:00:00.000Z',
  });

  const pipeline = new DistillationPipeline({
    distiller,
    reviewer,
    outputDir,
    reviewOutcomesPath,
    capabilityRegistryPath: registryPath,
    needsReviewQueuePath: queuePath,
  });

  return {
    root,
    outputDir,
    reviewOutcomesPath,
    registryPath,
    queuePath,
    pipeline,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function seedRegistry(registryPath: string): void {
  const state = emptyCapabilityRegistryState();
  const reviewedAt = '2026-07-09T00:00:00.000Z';

  newCapability(state, {
    capabilityId: 'cap-v2-append',
    activeSnapshotId: 'snap-append-1',
    routingDescription: 'Existing append target',
    evidenceRefs: [makeEvidenceRef('/old.jsonl', 1, { start: 0, end: 100 }, reviewedAt)],
    relatedSnapshotIds: ['snap-append-1'],
    createdAt: reviewedAt,
  });

  newCapability(state, {
    capabilityId: 'cap-v2-supersede',
    activeSnapshotId: 'snap-supersede-1',
    routingDescription: 'Existing supersede target',
    evidenceRefs: [makeEvidenceRef('/old.jsonl', 1, { start: 0, end: 100 }, reviewedAt)],
    relatedSnapshotIds: ['snap-supersede-1'],
    createdAt: reviewedAt,
  });

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  saveCapabilityRegistry(registryPath, state);
}

function makeFixtureReviewer(): ReviewerFn {
  return (packet: PromotionPacket): PromotionReviewResult => {
    const id = packet.candidate.capabilityId;
    let decision: PromotionDecision;
    if (id === 'cap-v1-promote') decision = 'promote';
    else if (id === 'cap-v2-new') decision = 'new_capability';
    else if (id === 'cap-v2-append') decision = 'append_evidence';
    else if (id === 'cap-v2-supersede') decision = 'supersede_snapshot';
    else if (id === 'cap-v2-needs-review') decision = 'needs_review';
    else decision = 'reject';

    return {
      schemaVersion: 1,
      capabilityId: id,
      decision,
      rationale: `Fixture reviewer decision: ${decision}`,
      reviewRisks: [],
      rewrite: null,
      reviewedAt: '2026-07-10T01:00:00.000Z',
    };
  };
}

describe('DistillationPipeline V2 consolidation state wiring (issue #20)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv(makeFixtureReviewer());
    seedRegistry(env.registryPath);
  });

  afterEach(() => {
    env.teardown();
  });

  test('new_capability installs an initial snapshot and creates a registry entry', () => {
    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v2-new');
    assert.ok(outcome, 'new_capability outcome recorded');
    assert.equal(outcome!.decision, 'new_capability');
    assert.ok(outcome!.snapshotId, 'new_capability outcome has a snapshot id');
    assert.ok(outcome!.skillFilePath, 'new_capability outcome has a skill file path');
    assert.ok(fs.existsSync(outcome!.skillFilePath!), 'new_capability SKILL.md exists on disk');

    const registry = loadCapabilityRegistry(env.registryPath);
    const entry = registry.capabilities['cap-v2-new'];
    assert.ok(entry, 'registry entry created for new capability');
    assert.equal(entry.activeSnapshotId, outcome!.snapshotId, 'active snapshot matches installed snapshot');
    assert.equal(entry.status, 'active');
    assert.ok(entry.evidenceRefs.length > 0, 'registry entry has evidence refs');
    assert.ok(entry.relatedSnapshotIds.includes(entry.activeSnapshotId), 'active snapshot is in related snapshots');
  });

  test('append_evidence updates registry evidence refs without changing active snapshot or installing a skill', () => {
    const registryBefore = loadCapabilityRegistry(env.registryPath);
    const activeBefore = registryBefore.capabilities['cap-v2-append']!.activeSnapshotId;

    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v2-append');
    assert.ok(outcome, 'append_evidence outcome recorded');
    assert.equal(outcome!.decision, 'append_evidence');
    assert.equal(outcome!.snapshotId, undefined, 'append_evidence does not install a snapshot');
    assert.equal(outcome!.skillFilePath, undefined, 'append_evidence does not create a skill-list entry');

    const registryAfter = loadCapabilityRegistry(env.registryPath);
    const entry = registryAfter.capabilities['cap-v2-append'];
    assert.ok(entry, 'registry entry still exists');
    assert.equal(entry.activeSnapshotId, activeBefore, 'active snapshot unchanged');
    assert.equal(entry.evidenceRefs.length, 3, 'two new evidence refs appended to the existing one');
  });

  test('supersede_snapshot installs a new active snapshot and preserves the prior one', () => {
    const registryBefore = loadCapabilityRegistry(env.registryPath);
    const activeBefore = registryBefore.capabilities['cap-v2-supersede']!.activeSnapshotId;

    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v2-supersede');
    assert.ok(outcome, 'supersede_snapshot outcome recorded');
    assert.equal(outcome!.decision, 'supersede_snapshot');
    assert.ok(outcome!.snapshotId, 'supersede_snapshot outcome has a snapshot id');
    assert.notEqual(outcome!.snapshotId, activeBefore, 'new snapshot differs from prior active snapshot');
    assert.ok(outcome!.skillFilePath, 'supersede_snapshot installed a new SKILL.md');

    const registryAfter = loadCapabilityRegistry(env.registryPath);
    const entry = registryAfter.capabilities['cap-v2-supersede'];
    assert.ok(entry, 'registry entry still exists');
    assert.equal(entry.activeSnapshotId, outcome!.snapshotId, 'active snapshot updated to new snapshot');
    assert.ok(entry.relatedSnapshotIds.includes(activeBefore), 'prior active snapshot preserved in related snapshots');
    assert.ok(entry.relatedSnapshotIds.includes(outcome!.snapshotId!), 'new active snapshot preserved in related snapshots');
  });

  test('needs_review creates a durable queue entry without mutating registry state', () => {
    const registryBefore = loadCapabilityRegistry(env.registryPath);

    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v2-needs-review');
    assert.ok(outcome, 'needs_review outcome recorded');
    assert.equal(outcome!.decision, 'needs_review');
    assert.equal(outcome!.snapshotId, undefined, 'needs_review does not install a snapshot');

    const queue = loadNeedsReviewQueue(env.queuePath);
    const entry = Object.values(queue.entries).find(e => e.capabilityId === 'cap-v2-needs-review');
    assert.ok(entry, 'needs_review queue entry created');
    assert.equal(entry.status, 'pending');
    assert.ok(entry.evidenceFingerprint, 'entry has evidence fingerprint');
    assert.ok(entry.registryStateFingerprint, 'entry has registry state fingerprint');

    const registryAfter = loadCapabilityRegistry(env.registryPath);
    assert.deepEqual(
      Object.keys(registryAfter.capabilities).filter(id => id !== 'cap-v2-new').sort(),
      Object.keys(registryBefore.capabilities).sort(),
      'registry state unchanged by needs_review apart from other decisions',
    );
  });

  test('reject writes a review outcome without mutating registry state or installing a skill', () => {
    const registryBefore = loadCapabilityRegistry(env.registryPath);

    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v2-reject');
    assert.ok(outcome, 'reject outcome recorded');
    assert.equal(outcome!.decision, 'reject');
    assert.equal(outcome!.snapshotId, undefined, 'reject does not install a snapshot');

    const registryAfter = loadCapabilityRegistry(env.registryPath);
    assert.deepEqual(
      Object.keys(registryAfter.capabilities).filter(id => id !== 'cap-v2-new').sort(),
      Object.keys(registryBefore.capabilities).sort(),
      'registry state unchanged by reject apart from other decisions',
    );
  });

  test('V1 promote remains auditable and does not touch the Capability Registry', () => {
    const registryBefore = loadCapabilityRegistry(env.registryPath);

    const result = env.pipeline.processUnit(makeUnit());

    const outcome = result.outcomes.find(o => o.capabilityId === 'cap-v1-promote');
    assert.ok(outcome, 'promote outcome recorded');
    assert.equal(outcome!.decision, 'promote');
    assert.ok(outcome!.snapshotId, 'promote outcome has a snapshot id');
    assert.ok(outcome!.skillFilePath, 'promote installed a SKILL.md');

    const registryAfter = loadCapabilityRegistry(env.registryPath);
    assert.deepEqual(
      Object.keys(registryAfter.capabilities).filter(id => id !== 'cap-v2-new').sort(),
      Object.keys(registryBefore.capabilities).sort(),
      'V1 promote does not create a registry entry apart from other decisions',
    );

    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesPath);
    const promoted = outcomes.find(o => o.capabilityId === 'cap-v1-promote');
    assert.ok(promoted, 'V1 promote outcome is durable');
    assert.equal(promoted!.decision, 'promote');
  });

  test('all V2 decisions and V1 promote are recorded in the durable review-outcomes log', () => {
    env.pipeline.processUnit(makeUnit());

    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesPath);
    const decisions = new Map(outcomes.map(o => [o.capabilityId, o.decision]));

    assert.equal(decisions.get('cap-v1-promote'), 'promote');
    assert.equal(decisions.get('cap-v2-new'), 'new_capability');
    assert.equal(decisions.get('cap-v2-append'), 'append_evidence');
    assert.equal(decisions.get('cap-v2-supersede'), 'supersede_snapshot');
    assert.equal(decisions.get('cap-v2-needs-review'), 'needs_review');
    assert.equal(decisions.get('cap-v2-reject'), 'reject');
  });

  test('new_capability validates duplicate registry entries before installing a snapshot', () => {
    env.teardown();
    env = setupSingleCandidateEnv('cap-v2-new', 'new_capability');

    const state = emptyCapabilityRegistryState();
    newCapability(state, {
      capabilityId: 'cap-v2-new',
      activeSnapshotId: 'snap-existing',
      routingDescription: 'Existing capability',
      evidenceRefs: [],
      relatedSnapshotIds: ['snap-existing'],
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    saveCapabilityRegistry(env.registryPath, state);

    assert.throws(
      () => env.pipeline.processUnit(makeUnit()),
      /a registry entry with this capabilityId already exists/,
    );
    assert.equal(
      fs.existsSync(path.join(env.outputDir, 'cap-v2-new')),
      false,
      'duplicate new_capability must not leave an orphan snapshot directory',
    );
    assert.deepEqual(loadReviewOutcomesSync(env.reviewOutcomesPath), []);
  });

  test('supersede_snapshot validates the target capability before installing a snapshot', () => {
    env.teardown();
    env = setupSingleCandidateEnv('cap-v2-missing', 'supersede_snapshot');

    assert.throws(
      () => env.pipeline.processUnit(makeUnit()),
      /no such registry entry/,
    );
    assert.equal(
      fs.existsSync(path.join(env.outputDir, 'cap-v2-missing')),
      false,
      'missing supersede target must not leave an orphan snapshot directory',
    );
    assert.deepEqual(loadReviewOutcomesSync(env.reviewOutcomesPath), []);
  });

  test('supersede_snapshot validates no-op active snapshots before installing a snapshot', () => {
    env.teardown();
    const actionPattern = 'Supersede candidate that renders to the existing active snapshot.';
    env = setupSingleCandidateEnv('cap-v2-same', 'supersede_snapshot', actionPattern);

    const candidate = fixtureCandidate(makeUnit(), 'cap-v2-same', actionPattern);
    const review: PromotionReviewResult = {
      schemaVersion: 1,
      capabilityId: 'cap-v2-same',
      decision: 'supersede_snapshot',
      rationale: 'Fixture reviewer decision: supersede_snapshot',
      reviewRisks: [],
      rewrite: null,
      reviewedAt: '2026-07-10T01:00:00.000Z',
    };
    const activeSnapshotId = computeSnapshotId(
      candidate,
      resolveEffectiveFields(candidate, review.rewrite),
      review,
    );
    const state = emptyCapabilityRegistryState();
    newCapability(state, {
      capabilityId: 'cap-v2-same',
      activeSnapshotId,
      routingDescription: 'Existing same-snapshot capability',
      evidenceRefs: [],
      relatedSnapshotIds: [activeSnapshotId],
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    saveCapabilityRegistry(env.registryPath, state);

    assert.throws(
      () => env.pipeline.processUnit(makeUnit()),
      /newActiveSnapshotId is already the active snapshot/,
    );
    assert.equal(
      fs.existsSync(path.join(env.outputDir, 'cap-v2-same')),
      false,
      'no-op supersede must not leave an orphan snapshot directory',
    );
    assert.deepEqual(loadReviewOutcomesSync(env.reviewOutcomesPath), []);
  });
});
