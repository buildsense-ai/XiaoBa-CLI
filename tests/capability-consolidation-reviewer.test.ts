import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildPromotionPacket,
  buildRegistryPromotionContext,
  reviewPromotionPacket,
} from '../src/utils/promotion-reviewer';
import {
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';
import {
  emptyCapabilityRegistryState,
  loadCapabilityRegistry,
  makeEvidenceRef,
  newCapability,
  saveCapabilityRegistry,
} from '../src/utils/capability-registry';
import { installPromotedCandidate } from '../src/utils/distilled-skill-installer';

// ---------------------------------------------------------------------------
// Registry-aware consolidation reviewer (issue #28).
//
// Exposes a matched capability's Active Snapshot and traceable evidence refs
// to the reviewer, distinguishes material action-pattern/boundary changes from
// equivalent/evidence-only guidance, and produces new_capability,
// append_evidence, or supersede_snapshot decisions.
// ---------------------------------------------------------------------------

const EVIDENCE: SolvedLoopEvidence = {
  problem: 'How do I parse a JSONL file line by line in Node?',
  action: 'Used tools [read_file] and said: Use readline to stream the file.',
  verification: 'Thanks, that works perfectly!',
  noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
};

const BASE_CANDIDATE: DistilledKnowledgeCandidate = {
  schemaVersion: 1,
  kind: 'capability',
  capabilityId: 'cap-jsonl-readline',
  title: 'Capability: parse JSONL in Node',
  applicability: 'Applies when the user raises a similar problem to: parse a JSONL file',
  actionPattern: 'Use tools [read_file] then apply this pattern: process line by line with readline',
  boundaries: [
    'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
    'Do not apply when the user is still correcting or iterating on the request.',
  ],
  risks: ['Distilled from a single solved loop; the pattern may not generalize.'],
  solvedLoop: EVIDENCE,
  provenance: [
    { filePath: '/logs/sessions/chat/cli.jsonl', turn: 1, role: 'problem-action', unitByteRange: { start: 0, end: 200 } },
    { filePath: '/logs/sessions/chat/cli.jsonl', turn: 2, role: 'verification', unitByteRange: { start: 0, end: 200 } },
  ],
  generatedAt: '2026-07-10T00:00:00.000Z',
  sourceUnit: {
    filePath: '/logs/sessions/chat/cli.jsonl',
    byteRange: { start: 0, end: 200 },
    generatedAt: '2026-07-10T00:00:00.000Z',
  },
};

function makeCandidate(
  overrides: Partial<DistilledKnowledgeCandidate> = {},
): DistilledKnowledgeCandidate {
  return { ...BASE_CANDIDATE, ...overrides };
}

function makeReview(capabilityId = BASE_CANDIDATE.capabilityId) {
  return {
    schemaVersion: 1 as const,
    capabilityId,
    decision: 'new_capability' as const,
    rationale: 'Fixture review.',
    reviewRisks: [],
    rewrite: null,
    reviewedAt: '2026-07-10T01:00:00.000Z',
  };
}

function setupRegistryAndSnapshot(
  overrides: {
    capabilityId?: string;
    routingDescription?: string;
    actionPattern?: string;
    boundaries?: string[];
  } = {},
): {
  root: string;
  registryPath: string;
  outputDir: string;
  capabilityId: string;
  activeSnapshotId: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-consolidation-reviewer-'));
  const registryPath = path.join(root, 'data', 'capability-registry.json');
  const outputDir = path.join(root, 'skills', 'generated-distilled');

  const capabilityId = overrides.capabilityId ?? 'cap-jsonl-readline';

  // Install the immutable snapshot first so its computed snapshotId is the one
  // selected in the registry as the Active Snapshot. The snapshot is rendered
  // from the "existing" guidance fields so consolidation comparisons see it.
  const existingCandidate = makeCandidate({
    capabilityId,
    actionPattern: overrides.actionPattern ?? BASE_CANDIDATE.actionPattern,
    boundaries: overrides.boundaries ?? BASE_CANDIDATE.boundaries,
  });
  const review = makeReview(capabilityId);
  const snapshot = installPromotedCandidate(existingCandidate, review, outputDir);
  assert.equal(snapshot.newlyCreated, true, 'existing snapshot was installed');
  const activeSnapshotId = snapshot.snapshotId;

  const state = emptyCapabilityRegistryState();
  newCapability(state, {
    capabilityId,
    activeSnapshotId,
    routingDescription: overrides.routingDescription ?? 'Existing JSONL readline capability',
    evidenceRefs: [makeEvidenceRef('/old.jsonl', 1, { start: 0, end: 100 }, '2026-07-09T00:00:00.000Z')],
    relatedSnapshotIds: [activeSnapshotId],
    createdAt: '2026-07-09T00:00:00.000Z',
  });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  saveCapabilityRegistry(registryPath, state);

  return { root, registryPath, outputDir, capabilityId, activeSnapshotId };
}

function teardown(env: { root: string }): void {
  fs.rmSync(env.root, { recursive: true, force: true });
}

describe('Registry-aware consolidation reviewer (issue #28)', () => {
  test('empty registry context produces new_capability', () => {
    const packet = buildPromotionPacket(makeCandidate(), {
      registryContext: {
        matches: [],
        activeSnapshotContents: {},
        evidenceRefsByCapability: {},
      },
    });

    const result = reviewPromotionPacket(packet);

    assert.equal(result.decision, 'new_capability');
    assert.equal(result.capabilityId, BASE_CANDIDATE.capabilityId);
    assert.equal(result.targetCapabilityId, undefined);
  });

  test('no registry context keeps V1 promote behavior', () => {
    const packet = buildPromotionPacket(makeCandidate());

    const result = reviewPromotionPacket(packet);

    assert.equal(result.decision, 'promote');
    assert.equal(result.targetCapabilityId, undefined);
  });

  test('matched capability with equivalent guidance produces append_evidence', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      const candidate = makeCandidate({ capabilityId: 'cap-jsonl-readline-new-occurrence' });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);

      assert.ok(context.matches.length > 0, 'prefilter found the related capability');
      assert.ok(
        context.matches.some(m => m.capabilityId === env.capabilityId),
        'context exposes the matched capability id',
      );
      assert.ok(
        context.activeSnapshotContents[env.capabilityId],
        'context exposes the active snapshot content',
      );
      assert.ok(
        context.evidenceRefsByCapability[env.capabilityId].length > 0,
        'context exposes traceable evidence refs',
      );

      const packet = buildPromotionPacket(candidate, { registryContext: context });
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'append_evidence');
      assert.equal(result.targetCapabilityId, env.capabilityId);
      assert.match(
        result.rationale,
        /append traceable evidence/,
        'rationale explains evidence-only append',
      );
    } finally {
      teardown(env);
    }
  });

  test('cosmetic action-pattern changes append evidence instead of churning snapshots', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      const candidate = makeCandidate({
        capabilityId: 'cap-jsonl-readline-new-occurrence',
        actionPattern: 'USE tools [read_file], then apply this pattern: process lines by line with readline.',
      });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);

      const result = reviewPromotionPacket(buildPromotionPacket(candidate, { registryContext: context }));

      assert.equal(result.decision, 'append_evidence');
      assert.equal(result.targetCapabilityId, env.capabilityId);
    } finally {
      teardown(env);
    }
  });

  test('a weak prefilter recall hit creates a new capability instead of mutating it', () => {
    const env = setupRegistryAndSnapshot({ routingDescription: 'Existing Node capability' });
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      const candidate = makeCandidate({
        capabilityId: 'cap-node-deployment',
        title: 'Capability: deploy a Node application',
        applicability: 'Applies when a Node application needs deployment.',
        actionPattern: 'Use tools [read_file] then apply this pattern: inspect the deployment configuration.',
        boundaries: ['Only applies to deployment configuration; do not change application code.'],
        solvedLoop: {
          ...EVIDENCE,
          problem: 'How do I deploy this Node application?',
          action: 'Used tools [read_file] and said: inspect the deployment configuration.',
        },
      });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);
      assert.ok(context.matches.length > 0, 'the prefilter recalls the weak Node match');

      const result = reviewPromotionPacket(buildPromotionPacket(candidate, { registryContext: context }));

      assert.equal(result.decision, 'new_capability');
      assert.equal(result.targetCapabilityId, undefined);
    } finally {
      teardown(env);
    }
  });

  test('material action-pattern change produces supersede_snapshot', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      // Vary the action pattern materially AND keep the evidence action
      // consistent with the claimed tools so basic review passes.
      const candidate = makeCandidate({
        capabilityId: 'cap-jsonl-readline-new-occurrence',
        actionPattern: 'Use tools [read_file] then apply this pattern: stream the file with fs.createReadStream and split2 instead of readline',
        solvedLoop: {
          ...EVIDENCE,
          action: 'Used tools [read_file] and said: stream the file with fs.createReadStream and split2 instead of readline',
        },
      });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);
      const packet = buildPromotionPacket(candidate, { registryContext: context });

      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'supersede_snapshot');
      assert.equal(result.targetCapabilityId, env.capabilityId);
      assert.match(
        result.rationale,
        /material action-pattern or boundary change/,
        'rationale explains material change',
      );
    } finally {
      teardown(env);
    }
  });

  test('material boundary change produces supersede_snapshot', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      const candidate = makeCandidate({
        capabilityId: 'cap-jsonl-readline-new-occurrence',
        boundaries: [
          'Only applies when the input is a local JSONL file under 1 GiB.',
          'Do not apply when the user is still correcting or iterating on the request.',
        ],
      });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);
      const packet = buildPromotionPacket(candidate, { registryContext: context });

      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'supersede_snapshot');
      assert.equal(result.targetCapabilityId, env.capabilityId);
    } finally {
      teardown(env);
    }
  });

  test('unreadable active snapshot falls back to needs_review', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      // Remove the installed snapshot so the context cannot read it.
      const snapshotPath = path.join(env.outputDir, env.capabilityId, env.activeSnapshotId, 'SKILL.md');
      fs.rmSync(path.dirname(snapshotPath), { recursive: true, force: true });

      const candidate = makeCandidate({ capabilityId: 'cap-jsonl-readline-new-occurrence' });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);

      assert.equal(context.activeSnapshotContents[env.capabilityId], undefined);

      const packet = buildPromotionPacket(candidate, { registryContext: context });
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      assert.ok(
        result.reviewRisks.some(r => r.label === 'unreadable-active-snapshot'),
        'risk labels unreadable active snapshot',
      );
    } finally {
      teardown(env);
    }
  });

  test('malformed active snapshot falls back to needs_review instead of superseding', () => {
    const env = setupRegistryAndSnapshot();
    try {
      const registry = loadCapabilityRegistry(env.registryPath);
      const snapshotPath = path.join(env.outputDir, env.capabilityId, env.activeSnapshotId, 'SKILL.md');
      const malformed = fs.readFileSync(snapshotPath, 'utf-8').replace('**Action Pattern**', '**Action**');
      fs.writeFileSync(snapshotPath, malformed, 'utf-8');

      const candidate = makeCandidate({ capabilityId: env.capabilityId });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);
      const result = reviewPromotionPacket(buildPromotionPacket(candidate, { registryContext: context }));

      assert.equal(result.decision, 'needs_review');
      assert.ok(result.reviewRisks.some(r => r.label === 'malformed-active-snapshot'));
    } finally {
      teardown(env);
    }
  });

  test('exact capabilityId match takes priority over text-similarity match', () => {
    const env = setupRegistryAndSnapshot({ capabilityId: 'cap-jsonl-readline' });
    const env2 = setupRegistryAndSnapshot({
      capabilityId: 'cap-jsonl-readline-alt',
      actionPattern: 'Use tools [read_file] then apply this pattern: process line by line with readline',
    });
    try {
      // Build a combined registry so both capabilities exist.
      const registry = emptyCapabilityRegistryState();
      const state1 = loadCapabilityRegistry(env.registryPath);
      const state2 = loadCapabilityRegistry(env2.registryPath);
      for (const entry of Object.values(state1.capabilities)) {
        registry.capabilities[entry.capabilityId] = entry;
      }
      for (const entry of Object.values(state2.capabilities)) {
        registry.capabilities[entry.capabilityId] = entry;
      }

      // Candidate uses the exact same capabilityId as env1.
      const candidate = makeCandidate({ capabilityId: env.capabilityId });
      const context = buildRegistryPromotionContext(candidate, registry, env.outputDir);
      const packet = buildPromotionPacket(candidate, { registryContext: context });
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'append_evidence');
      assert.equal(result.targetCapabilityId, env.capabilityId);
    } finally {
      teardown(env);
      teardown(env2);
    }
  });
});
