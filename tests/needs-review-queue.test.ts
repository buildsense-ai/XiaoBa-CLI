import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPromotionPacket,
  PromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
} from '../src/utils/promotion-reviewer';
import {
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';
import {
  emptyCapabilityRegistryState,
  makeEvidenceRef,
  newCapability,
  NewCapabilityInput,
  CapabilityRegistryState,
} from '../src/utils/capability-registry';
import {
  addNeedsReviewEntry,
  AddNeedsReviewEntryInput,
  computeEvidenceFingerprint,
  computeRegistryStateFingerprint,
  emptyNeedsReviewQueueState,
  findPendingEntryForCandidate,
  getQueueEntry,
  loadNeedsReviewQueue,
  markDropped,
  markResolved,
  markRetryEligible,
  NeedsReviewQueueEntry,
  NeedsReviewQueueState,
  reevaluateAllRetryEligibility,
  reevaluateRetryEligibility,
  saveNeedsReviewQueue,
} from '../src/utils/needs-review-queue';

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

function setup(): {
  root: string;
  queueFile: string;
  teardown: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-needs-review-queue-'));
  const queueFile = path.join(root, 'data', 'needs-review-queue-state.json');
  return {
    root,
    queueFile,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeSolvedLoop(): SolvedLoopEvidence {
  return {
    problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
    action: 'Used tools [read_file] and said: You can use readline and process line by line.',
    verification: 'Thanks, that works perfectly!',
    noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
  };
}

function makeProvenance(): DistilledKnowledgeCandidate['provenance'] {
  return [
    {
      filePath: '/logs/sessions/chat/chat_cli.jsonl',
      turn: 1,
      role: 'problem-action',
      unitByteRange: { start: 0, end: 1000 },
    },
    {
      filePath: '/logs/sessions/chat/chat_cli.jsonl',
      turn: 2,
      role: 'verification',
      unitByteRange: { start: 0, end: 1000 },
    },
  ];
}

function makeCandidate(
  overrides: Partial<DistilledKnowledgeCandidate> = {},
): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'cap-abc123def456',
    title: 'Capability: parse JSONL in Node',
    applicability: 'Applies when the user raises a similar problem to: parse a JSONL file',
    actionPattern: 'Use tool(s) [read_file] then respond with: You can use readline and process line by line.',
    boundaries: [
      'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
      'Do not apply when the user is still correcting or iterating on the request.',
    ],
    risks: [
      'Distilled from a single solved loop; the pattern may not generalize.',
      'Apply the Promotion Reviewer before installing as an active skill.',
    ],
    solvedLoop: overrides.solvedLoop ?? makeSolvedLoop(),
    provenance: overrides.provenance ?? makeProvenance(),
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: '/logs/sessions/chat/chat_cli.jsonl',
      byteRange: { start: 0, end: 1000 },
      generatedAt: '2026-07-10T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makePacket(
  overrides: Partial<DistilledKnowledgeCandidate> = {},
): PromotionPacket {
  return buildPromotionPacket(makeCandidate(overrides));
}

function makeNeedsReviewResult(
  overrides: Partial<PromotionReviewResult> = {},
): PromotionReviewResult {
  return {
    schemaVersion: 1,
    capabilityId: 'cap-abc123def456',
    decision: 'needs_review',
    rationale: 'Held for review because the action pattern references tools not grounded in evidence.',
    reviewRisks: [
      {
        label: 'unsupported-tool-claim',
        detail: 'Action pattern references tool "edit_file" which does not appear in the solved-loop evidence action.',
      },
    ],
    rewrite: null,
    questions: [
      'Which claims in the candidate are not grounded in the solved-loop evidence?',
      'Can additional evidence be provided to support the unsupported claims?',
    ],
    reviewedAt: '2026-07-10T01:00:00.000Z',
    ...overrides,
  };
}

function makeRegistryWithCapabilities(): CapabilityRegistryState {
  const registry = emptyCapabilityRegistryState();
  newCapability(registry, {
    capabilityId: 'cap-existing-jsonl',
    activeSnapshotId: 'snap-existing-aaaa',
    routingDescription:
      'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
    evidenceRefs: [
      makeEvidenceRef('/logs/sessions/chat/chat_cli.jsonl', 1, { start: 0, end: 1000 }, '2026-07-09T00:00:00.000Z'),
    ],
    relatedSnapshotIds: ['snap-existing-aaaa'],
    createdAt: '2026-07-09T01:00:00.000Z',
  });
  return registry;
}

function makeAddInput(
  state: NeedsReviewQueueState,
  overrides: Partial<AddNeedsReviewEntryInput> = {},
): AddNeedsReviewEntryInput {
  return {
    packet: makePacket(),
    review: makeNeedsReviewResult(),
    matchedCapabilityIds: ['cap-existing-jsonl'],
    registry: makeRegistryWithCapabilities(),
    reviewerVersion: 'reviewer-v1.0.0',
    createdAt: '2026-07-10T01:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Needs Review Queue (issue #19)', () => {
  // -------------------------------------------------------------------------
  // Create and load an independent state file
  // -------------------------------------------------------------------------

  describe('create and load an independent state file', () => {
    test('loading a non-existent queue file returns an empty queue', () => {
      const env = setup();
      try {
        const state = loadNeedsReviewQueue(env.queueFile);
        assert.deepEqual(state.entries, {});
        assert.equal(state.schemaVersion, 1);
        assert.equal(state.stateCorrupt, undefined);
      } finally {
        env.teardown();
      }
    });

    test('a runtime data root can create and reload a queue state file', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        addNeedsReviewEntry(state, makeAddInput(state));
        saveNeedsReviewQueue(env.queueFile, state);

        assert.ok(fs.existsSync(env.queueFile));

        const reloaded = loadNeedsReviewQueue(env.queueFile);
        assert.equal(Object.keys(reloaded.entries).length, 1);
        const entry = Object.values(reloaded.entries)[0];
        assert.equal(entry.capabilityId, 'cap-abc123def456');
        assert.equal(entry.status, 'pending');
      } finally {
        env.teardown();
      }
    });
  });

  describe('match queue entries for matching-evidence retry', () => {
    test('does not match unchanged candidates with exact capabilityId', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        addNeedsReviewEntry(state, input);

        const unchanged = { ...input.packet.candidate };
        const noMatch = findPendingEntryForCandidate(state, unchanged);

        assert.equal(noMatch, undefined, 'exact capabilityId with no provenance changes does not match');
      } finally {
        env.teardown();
      }
    });

    test('matches exact capabilityId only when candidate brings new provenance', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const withNewProvenance: DistilledKnowledgeCandidate = {
          ...input.packet.candidate,
          provenance: [
            ...input.packet.candidate.provenance,
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 3,
              role: 'problem-action',
              unitByteRange: { start: 1000, end: 2000 },
            },
          ],
        };

        const renewedMatch = findPendingEntryForCandidate(state, withNewProvenance);
        assert.equal(renewedMatch?.entryId, entry.entryId, 'same capabilityId with new provenance refreshes');
      } finally {
        env.teardown();
      }
    });

    test('requires stronger matching than only title + problem before refreshing', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const identicalYetDistinctCandidate: DistilledKnowledgeCandidate = {
          ...input.packet.candidate,
          capabilityId: 'cap-distinct',
        };

        const fallbackMatch = findPendingEntryForCandidate(state, identicalYetDistinctCandidate);
        assert.equal(
          fallbackMatch,
          undefined,
          'same title/problem/action/verification with no new provenance does not match',
        );

        const withNewProvenance: DistilledKnowledgeCandidate = {
          ...input.packet.candidate,
          capabilityId: 'cap-distinct-2',
          provenance: [
            ...input.packet.candidate.provenance,
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 3,
              role: 'problem-action',
              unitByteRange: { start: 1000, end: 2000 },
            },
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 4,
              role: 'verification',
              unitByteRange: { start: 1000, end: 2000 },
            },
          ],
        };

        const renewedMatch = findPendingEntryForCandidate(state, withNewProvenance);
        assert.equal(renewedMatch?.entryId, entry.entryId, 'additional provenance enables matching-evidence retry');
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Atomic writes
  // -------------------------------------------------------------------------

  describe('atomic writes do not leave partial JSON state', () => {
    test('a saved queue file is valid JSON after a normal write', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        addNeedsReviewEntry(state, makeAddInput(state));
        saveNeedsReviewQueue(env.queueFile, state);

        const raw = fs.readFileSync(env.queueFile, 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(Object.keys(parsed.entries).length, 1);
      } finally {
        env.teardown();
      }
    });

    test('no stale temp files remain after a successful write', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        addNeedsReviewEntry(state, makeAddInput(state));
        saveNeedsReviewQueue(env.queueFile, state);

        const dir = path.dirname(env.queueFile);
        const entries = fs.readdirSync(dir);
        const tmpFiles = entries.filter(f => f.endsWith('.tmp'));
        assert.equal(tmpFiles.length, 0);
      } finally {
        env.teardown();
      }
    });

    test('repeated saves replace the queue file atomically without corruption', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        addNeedsReviewEntry(state, makeAddInput(state));
        saveNeedsReviewQueue(env.queueFile, state);

        const entry = Object.values(state.entries)[0];
        markRetryEligible(state, entry.entryId, 'Explicit retry command.', '2026-07-10T02:00:00.000Z');
        saveNeedsReviewQueue(env.queueFile, state);

        const reloaded = loadNeedsReviewQueue(env.queueFile);
        assert.equal(Object.keys(reloaded.entries).length, 1);
        assert.equal(Object.values(reloaded.entries)[0].status, 'retry_eligible');
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Corrupt state quarantine
  // -------------------------------------------------------------------------

  describe('corrupt state is quarantined without destroying snapshots or audit logs', () => {
    test('a corrupt queue file is quarantined and an empty queue is returned', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.queueFile), { recursive: true });
        fs.writeFileSync(env.queueFile, '{ this is not valid json ', 'utf-8');

        const state = loadNeedsReviewQueue(env.queueFile);
        assert.equal(state.stateCorrupt, true);
        assert.deepEqual(state.entries, {});

        const dir = path.dirname(env.queueFile);
        const quarantined = fs
          .readdirSync(dir)
          .filter(f => f.startsWith('needs-review-queue-state.json.corrupt.'));
        assert.equal(quarantined.length, 1);
        assert.equal(fs.existsSync(env.queueFile), false);
      } finally {
        env.teardown();
      }
    });

    test('a structurally invalid queue file is quarantined', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.queueFile), { recursive: true });
        fs.writeFileSync(
          env.queueFile,
          JSON.stringify({ schemaVersion: 1, entries: [] }),
          'utf-8',
        );

        const state = loadNeedsReviewQueue(env.queueFile);
        assert.equal(state.stateCorrupt, true);
        assert.deepEqual(state.entries, {});
        assert.equal(fs.existsSync(env.queueFile), false);
      } finally {
        env.teardown();
      }
    });

    test('quarantine does not destroy installed snapshots or audit logs', () => {
      const env = setup();
      try {
        const snapshotsDir = path.join(env.root, 'skills', 'generated-distilled');
        const snapshotFile = path.join(
          snapshotsDir,
          'cap-existing-jsonl',
          'snap-existing-aaaa',
          'SKILL.md',
        );
        fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
        fs.writeFileSync(snapshotFile, '# immutable snapshot', 'utf-8');

        const auditLog = path.join(env.root, 'data', 'distillation-review-outcomes.json');
        fs.mkdirSync(path.dirname(auditLog), { recursive: true });
        fs.writeFileSync(auditLog, '{"schemaVersion":1,"outcomes":[]}');

        fs.writeFileSync(env.queueFile, '{ corrupt ', 'utf-8');
        loadNeedsReviewQueue(env.queueFile);

        assert.ok(fs.existsSync(snapshotFile));
        assert.equal(fs.readFileSync(snapshotFile, 'utf-8'), '# immutable snapshot');
        assert.ok(fs.existsSync(auditLog));
        assert.equal(fs.readFileSync(auditLog, 'utf-8'), '{"schemaVersion":1,"outcomes":[]}');
      } finally {
        env.teardown();
      }
    });

    test('loading after quarantine returns a clean empty queue that can be written to', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.queueFile), { recursive: true });
        fs.writeFileSync(env.queueFile, '{ corrupt ', 'utf-8');

        const state = loadNeedsReviewQueue(env.queueFile);
        assert.equal(state.stateCorrupt, true);

        addNeedsReviewEntry(state, makeAddInput(state));
        saveNeedsReviewQueue(env.queueFile, state);

        const reloaded = loadNeedsReviewQueue(env.queueFile);
        assert.equal(reloaded.stateCorrupt, undefined);
        assert.equal(Object.keys(reloaded.entries).length, 1);
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // needs_review creates a durable queue entry
  // -------------------------------------------------------------------------

  describe('needs_review creates a durable queue entry without mutating the registry', () => {
    test('creates an entry with all required fields', () => {
      const env = setup();
      try {
        const registry = makeRegistryWithCapabilities();
        const beforeRegistrySnapshot = JSON.stringify(registry);

        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        assert.ok(entry.entryId.startsWith('cap-abc123def456:'));
        assert.equal(entry.capabilityId, 'cap-abc123def456');
        assert.equal(entry.candidatePayload.capabilityId, 'cap-abc123def456');
        assert.deepEqual(entry.matchedCapabilityIds, ['cap-existing-jsonl']);
        assert.ok(entry.rationale);
        assert.ok(Array.isArray(entry.questions));
        assert.ok(entry.questions.length > 0);
        assert.deepEqual(entry.sourceRefs, [
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 1,
            role: 'problem-action',
            unitByteRange: { start: 0, end: 1000 },
          },
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 2,
            role: 'verification',
            unitByteRange: { start: 0, end: 1000 },
          },
        ]);
        assert.equal(entry.reviewerVersion, 'reviewer-v1.0.0');
        assert.ok(entry.evidenceFingerprint);
        assert.ok(entry.registryStateFingerprint);
        assert.equal(entry.status, 'pending');
        assert.equal(entry.retryEligibility.eligible, false);
        assert.equal(entry.createdAt, '2026-07-10T01:00:00.000Z');
        assert.equal(entry.updatedAt, '2026-07-10T01:00:00.000Z');

        // Registry was not mutated.
        assert.equal(JSON.stringify(registry), beforeRegistrySnapshot);

        // Entry is durable after save + reload.
        saveNeedsReviewQueue(env.queueFile, state);
        const reloaded = loadNeedsReviewQueue(env.queueFile);
        const stored = Object.values(reloaded.entries)[0];
        assert.ok(stored);
        assert.equal(stored.capabilityId, 'cap-abc123def456');
        assert.equal(stored.status, 'pending');
      } finally {
        env.teardown();
      }
    });

    test('questions fall back to reviewer result questions when not provided separately', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state, { questions: undefined });
        const entry = addNeedsReviewEntry(state, input);

        assert.deepEqual(entry.questions, input.review.questions);
      } finally {
        env.teardown();
      }
    });

    test('does not overwrite distinct evidence reviewed at the same timestamp', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const firstInput = makeAddInput(state);
        const secondInput = makeAddInput(state, {
          packet: makePacket({
            solvedLoop: {
              ...makeSolvedLoop(),
              action:
                'Used tools [read_file] and said: Stream JSONL with readline, validate each parsed row, and skip blank lines.',
            },
            sourceUnit: {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              byteRange: { start: 1001, end: 2000 },
              generatedAt: '2026-07-10T00:30:00.000Z',
            },
          }),
          review: makeNeedsReviewResult({
            reviewedAt: firstInput.review.reviewedAt,
          }),
          createdAt: firstInput.createdAt,
        });

        const first = addNeedsReviewEntry(state, firstInput);
        const second = addNeedsReviewEntry(state, secondInput);

        assert.notEqual(first.entryId, second.entryId);
        assert.equal(Object.keys(state.entries).length, 2);
        assert.notEqual(first.evidenceFingerprint, second.evidenceFingerprint);
      } finally {
        env.teardown();
      }
    });

    test('questions can be overridden separately from the review result', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const customQuestions = ['Custom question one?', 'Custom question two?'];
        const input = makeAddInput(state, { questions: customQuestions });
        const entry = addNeedsReviewEntry(state, input);

        assert.deepEqual(entry.questions, customQuestions);
      } finally {
        env.teardown();
      }
    });

    test('throws when the review decision is not needs_review', () => {
      const state = emptyNeedsReviewQueueState();
      assert.throws(
        () =>
          addNeedsReviewEntry(
            state,
            makeAddInput(state, {
              review: makeNeedsReviewResult({ decision: 'promote' }),
            }),
          ),
        /only "needs_review" decisions are allowed/,
      );
    });

    test('throws when capabilityId is empty', () => {
      const state = emptyNeedsReviewQueueState();
      assert.throws(
        () =>
          addNeedsReviewEntry(
            state,
            makeAddInput(state, {
              review: makeNeedsReviewResult({ capabilityId: '' }),
            }),
          ),
        /capabilityId must be a non-empty string/,
      );
    });

    test('throws when reviewerVersion is empty', () => {
      const state = emptyNeedsReviewQueueState();
      assert.throws(
        () =>
          addNeedsReviewEntry(
            state,
            makeAddInput(state, { reviewerVersion: '' }),
          ),
        /reviewerVersion must be a non-empty string/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Fingerprint stability
  // -------------------------------------------------------------------------

  describe('evidence and registry-state fingerprints are stable and comparable', () => {
    test('computeEvidenceFingerprint is deterministic for the same packet', () => {
      const packet = makePacket();
      const a = computeEvidenceFingerprint(packet);
      const b = computeEvidenceFingerprint(packet);
      assert.equal(a, b);
    });

    test('computeEvidenceFingerprint changes when solved-loop evidence changes', () => {
      const packetA = makePacket();
      const packetB = makePacket({
        solvedLoop: {
          problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
          action: 'Used tools [read_file].',
          verification: 'Thanks, that works perfectly!',
          noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
        },
      });

      assert.notEqual(computeEvidenceFingerprint(packetA), computeEvidenceFingerprint(packetB));
    });

    test('computeEvidenceFingerprint changes when provenance changes', () => {
      const packetA = makePacket();
      const packetB = makePacket({
        provenance: [
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 3,
            role: 'problem-action',
            unitByteRange: { start: 1000, end: 2000 },
          },
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 4,
            role: 'verification',
            unitByteRange: { start: 1000, end: 2000 },
          },
        ],
      });

      assert.notEqual(computeEvidenceFingerprint(packetA), computeEvidenceFingerprint(packetB));
    });

    test('computeRegistryStateFingerprint is deterministic for the same registry and ids', () => {
      const registry = makeRegistryWithCapabilities();
      const a = computeRegistryStateFingerprint(registry, ['cap-existing-jsonl']);
      const b = computeRegistryStateFingerprint(registry, ['cap-existing-jsonl']);
      assert.equal(a, b);
    });

    test('computeRegistryStateFingerprint is independent of id order', () => {
      const registry = makeRegistryWithCapabilities();
      newCapability(registry, {
        capabilityId: 'cap-second',
        activeSnapshotId: 'snap-second',
        routingDescription: 'Second capability.',
        evidenceRefs: [],
        relatedSnapshotIds: ['snap-second'],
        createdAt: '2026-07-09T02:00:00.000Z',
      });

      const a = computeRegistryStateFingerprint(registry, ['cap-existing-jsonl', 'cap-second']);
      const b = computeRegistryStateFingerprint(registry, ['cap-second', 'cap-existing-jsonl']);
      assert.equal(a, b);
    });

    test('computeRegistryStateFingerprint changes when a matched capability changes', () => {
      const registryA = makeRegistryWithCapabilities();
      const registryB = makeRegistryWithCapabilities();
      registryB.capabilities['cap-existing-jsonl'].activeSnapshotId = 'snap-changed';

      assert.notEqual(
        computeRegistryStateFingerprint(registryA, ['cap-existing-jsonl']),
        computeRegistryStateFingerprint(registryB, ['cap-existing-jsonl']),
      );
    });

    test('computeRegistryStateFingerprint changes when a matched capability appears in the registry', () => {
      const registryWith = makeRegistryWithCapabilities();
      const registryWithout = emptyCapabilityRegistryState();

      assert.notEqual(
        computeRegistryStateFingerprint(registryWith, ['cap-existing-jsonl']),
        computeRegistryStateFingerprint(registryWithout, ['cap-existing-jsonl']),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Retry eligibility rules
  // -------------------------------------------------------------------------

  describe('retry eligibility is gated by evidence, reviewer version, and registry state', () => {
    test('entry is not eligible when all fingerprints are unchanged', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: entry.evidenceFingerprint,
          registryStateFingerprint: entry.registryStateFingerprint,
          reviewerVersion: entry.reviewerVersion,
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(reevaluated.retryEligibility.eligible, false);
        assert.equal(reevaluated.status, 'pending');
        assert.match(
          reevaluated.retryEligibility.reason,
          /unchanged/,
        );
      } finally {
        env.teardown();
      }
    });

    test('entry becomes eligible when evidence fingerprint changes', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const changedPacket = makePacket({
          solvedLoop: {
            problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
            action: 'Used tools [read_file, grep] and said: You can use readline and filter with grep.',
            verification: 'Thanks, that works perfectly!',
            noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
          },
        });

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: computeEvidenceFingerprint(changedPacket),
          registryStateFingerprint: entry.registryStateFingerprint,
          reviewerVersion: entry.reviewerVersion,
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(reevaluated.retryEligibility.eligible, true);
        assert.equal(reevaluated.status, 'retry_eligible');
        assert.match(reevaluated.retryEligibility.reason, /evidence fingerprint/);
      } finally {
        env.teardown();
      }
    });

    test('entry becomes eligible when reviewer version changes', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: entry.evidenceFingerprint,
          registryStateFingerprint: entry.registryStateFingerprint,
          reviewerVersion: 'reviewer-v2.0.0',
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(reevaluated.retryEligibility.eligible, true);
        assert.equal(reevaluated.status, 'retry_eligible');
        assert.match(reevaluated.retryEligibility.reason, /reviewer version/);
      } finally {
        env.teardown();
      }
    });

    test('entry becomes eligible when registry-state fingerprint changes', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const changedRegistry = makeRegistryWithCapabilities();
        changedRegistry.capabilities['cap-existing-jsonl'].routingDescription =
          'Updated routing description after new evidence.';

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: entry.evidenceFingerprint,
          registryStateFingerprint: computeRegistryStateFingerprint(changedRegistry, [
            'cap-existing-jsonl',
          ]),
          reviewerVersion: entry.reviewerVersion,
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(reevaluated.retryEligibility.eligible, true);
        assert.equal(reevaluated.status, 'retry_eligible');
        assert.match(reevaluated.retryEligibility.reason, /registry-state fingerprint/);
      } finally {
        env.teardown();
      }
    });

    test('entry becomes eligible when multiple fingerprints change simultaneously', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const changedPacket = makePacket({
          provenance: [
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 5,
              role: 'problem-action',
              unitByteRange: { start: 0, end: 1000 },
            },
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 6,
              role: 'verification',
              unitByteRange: { start: 0, end: 1000 },
            },
          ],
        });
        const changedRegistry = makeRegistryWithCapabilities();
        changedRegistry.capabilities['cap-existing-jsonl'].evidenceRefs.push(
          makeEvidenceRef('/logs/sessions/chat/chat_cli.jsonl', 10, { start: 0, end: 500 }, '2026-07-11T00:00:00.000Z'),
        );

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: computeEvidenceFingerprint(changedPacket),
          registryStateFingerprint: computeRegistryStateFingerprint(changedRegistry, [
            'cap-existing-jsonl',
          ]),
          reviewerVersion: 'reviewer-v2.0.0',
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(reevaluated.retryEligibility.eligible, true);
        assert.equal(reevaluated.status, 'retry_eligible');
        assert.match(reevaluated.retryEligibility.reason, /changed/);
      } finally {
        env.teardown();
      }
    });

    test('resolved entries are never made eligible again', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);
        markResolved(state, entry.entryId, '2026-07-10T02:00:00.000Z');

        const changedPacket = makePacket({
          solvedLoop: {
            problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
            action: 'Used tools [read_file, grep] and said: You can use readline and filter with grep.',
            verification: 'Thanks, that works perfectly!',
            noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
          },
        });

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: computeEvidenceFingerprint(changedPacket),
          registryStateFingerprint: entry.registryStateFingerprint,
          reviewerVersion: 'reviewer-v2.0.0',
          checkedAt: '2026-07-10T03:00:00.000Z',
        });

        assert.equal(reevaluated.status, 'resolved');
        assert.equal(reevaluated.retryEligibility.eligible, false);
      } finally {
        env.teardown();
      }
    });

    test('dropped entries are never made eligible again', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);
        markDropped(state, entry.entryId, '2026-07-10T02:00:00.000Z');

        const reevaluated = reevaluateRetryEligibility(state, entry.entryId, {
          evidenceFingerprint: 'changed-fingerprint',
          registryStateFingerprint: entry.registryStateFingerprint,
          reviewerVersion: 'reviewer-v2.0.0',
          checkedAt: '2026-07-10T03:00:00.000Z',
        });

        assert.equal(reevaluated.status, 'dropped');
        assert.equal(reevaluated.retryEligibility.eligible, false);
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Explicit status transitions
  // -------------------------------------------------------------------------

  describe('explicit status transitions update retry eligibility', () => {
    test('markRetryEligible makes a pending entry eligible without changing fingerprints', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const updated = markRetryEligible(
          state,
          entry.entryId,
          'Explicit retry requested by runtime command.',
          '2026-07-10T02:00:00.000Z',
        );

        assert.equal(updated.status, 'retry_eligible');
        assert.equal(updated.retryEligibility.eligible, true);
        assert.equal(updated.retryEligibility.reason, 'Explicit retry requested by runtime command.');
        assert.equal(updated.updatedAt, '2026-07-10T02:00:00.000Z');
      } finally {
        env.teardown();
      }
    });

    test('markResolved removes an entry from the retry pool', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);
        markRetryEligible(state, entry.entryId, 'Eligible now.', '2026-07-10T02:00:00.000Z');

        const updated = markResolved(state, entry.entryId, '2026-07-10T03:00:00.000Z');
        assert.equal(updated.status, 'resolved');
        assert.equal(updated.retryEligibility.eligible, false);
      } finally {
        env.teardown();
      }
    });

    test('markDropped removes an entry from the retry pool', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);

        const updated = markDropped(
          state,
          entry.entryId,
          '2026-07-10T03:00:00.000Z',
          'Dropped by policy after repeated failed retries.',
        );
        assert.equal(updated.status, 'dropped');
        assert.equal(updated.retryEligibility.eligible, false);
        assert.match(updated.retryEligibility.reason, /Dropped/);
      } finally {
        env.teardown();
      }
    });

    test('cannot mark a resolved entry as retry eligible', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const input = makeAddInput(state);
        const entry = addNeedsReviewEntry(state, input);
        markResolved(state, entry.entryId, '2026-07-10T02:00:00.000Z');

        assert.throws(
          () =>
            markRetryEligible(
              state,
              entry.entryId,
              'Should fail.',
              '2026-07-10T03:00:00.000Z',
            ),
          /status is "resolved"/,
        );
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Bulk re-evaluation
  // -------------------------------------------------------------------------

  describe('reevaluateAllRetryEligibility updates every entry', () => {
    test('bulk re-evaluation marks only changed entries eligible', () => {
      const env = setup();
      try {
        const state = emptyNeedsReviewQueueState();
        const inputA = makeAddInput(state, {
          packet: makePacket({ capabilityId: 'cap-a' }),
          review: makeNeedsReviewResult({ capabilityId: 'cap-a' }),
        });
        const entryA = addNeedsReviewEntry(state, inputA);
        const inputB = makeAddInput(state, {
          packet: makePacket({ capabilityId: 'cap-b' }),
          review: makeNeedsReviewResult({ capabilityId: 'cap-b' }),
        });
        const entryB = addNeedsReviewEntry(state, inputB);

        const changedRegistry = makeRegistryWithCapabilities();
        changedRegistry.capabilities['cap-existing-jsonl'].activeSnapshotId = 'snap-changed';

        reevaluateAllRetryEligibility(state, {
          evidenceFingerprint: entryA.evidenceFingerprint,
          registryStateFingerprint: computeRegistryStateFingerprint(changedRegistry, [
            'cap-existing-jsonl',
          ]),
          reviewerVersion: entryA.reviewerVersion,
          checkedAt: '2026-07-10T02:00:00.000Z',
        });

        assert.equal(getQueueEntry(state, entryA.entryId)!.status, 'retry_eligible');
        assert.equal(getQueueEntry(state, entryB.entryId)!.status, 'retry_eligible');
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end with deterministic reviewer
  // -------------------------------------------------------------------------

  describe('integration with deterministic reviewer', () => {
    test('a real needs_review result creates a queue entry via addNeedsReviewEntry', () => {
      const env = setup();
      try {
        const candidate = makeCandidate({
          actionPattern: 'Use tool(s) [read_file, edit_file] then respond.',
        });
        const packet = buildPromotionPacket(candidate);
        const review = reviewPromotionPacket(packet);

        assert.equal(review.decision, 'needs_review');
        assert.ok(review.questions);
        assert.ok(review.questions!.length > 0);

        const registry = makeRegistryWithCapabilities();
        const state = emptyNeedsReviewQueueState();
        const entry = addNeedsReviewEntry(state, {
          packet,
          review,
          matchedCapabilityIds: ['cap-existing-jsonl'],
          registry,
          reviewerVersion: 'reviewer-v1.0.0',
          createdAt: review.reviewedAt,
        });

        assert.equal(entry.capabilityId, candidate.capabilityId);
        assert.deepEqual(entry.questions, review.questions);
        assert.equal(entry.status, 'pending');

        saveNeedsReviewQueue(env.queueFile, state);
        const reloaded = loadNeedsReviewQueue(env.queueFile);
        assert.equal(Object.keys(reloaded.entries).length, 1);
        assert.equal(Object.values(reloaded.entries)[0].status, 'pending');
      } finally {
        env.teardown();
      }
    });
  });
});
