import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapLegacyDistilledSkillsOnce } from '../src/utils/distilled-skill-bootstrap';
import {
  findDeferByBundleId,
  findOperationalByBundleId,
  loadReviewQueueState,
  markDeferredEntryExplicitRetry,
  saveReviewQueueState,
} from '../src/utils/skill-evolution-review-queue';
import { EvidenceBundle, loadCurrentSkillRegistry, SkillEvolutionRuntime } from '../src/utils/skill-evolution';

type LegacyOutcome = 'adopt' | 'improve' | 'merge' | 'retire' | 'defer' | 'reject' | 'operational';

interface RuntimeArtifacts {
  root: string;
  generatedRoot: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  reviewQueuePath: string;
}

describe('Legacy distilled skill bootstrap (issue #40)', () => {
  let root: string;
  let artifacts: RuntimeArtifacts;
  let originalApiKey: string | undefined;
  let originalRuntimeEnv: string | undefined;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-legacy-bootstrap-'));
    artifacts = {
      root,
      generatedRoot: path.join(root, 'skills', 'generated-distilled'),
      registryPath: path.join(root, 'data', 'current-skill-registry.json'),
      auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
      journalPath: path.join(root, 'data', 'transition-journal.json'),
      reviewQueuePath: path.join(root, 'data', 'skill-evolution-review-queue.json'),
    };
    originalApiKey = process.env.GAUZ_LLM_API_KEY;
    originalRuntimeEnv = process.env.XIAOBA_RUNTIME_ROOT;
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    delete process.env.GAUZ_LLM_API_KEY;
    process.env.XIAOBA_RUNTIME_ROOT = root;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.GAUZ_LLM_API_KEY;
    else process.env.GAUZ_LLM_API_KEY = originalApiKey;
    if (originalRuntimeEnv === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
    else process.env.XIAOBA_RUNTIME_ROOT = originalRuntimeEnv;
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('adopts legacy generated skill and deletes artifact only after successful reassessment', async () => {
    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-accept', 'snap-accept');
    const runtime = buildRuntime(artifacts, { 'cap-accept': 'adopt' });

    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'create_current_skill');
    assert.equal(results[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);

    const registry = loadCurrentSkillRegistry(artifacts.registryPath);
    assert.equal(Object.keys(registry.capabilities).length, 1, 'bootstraped accepted legacy creates one current skill');
  });

  test('rejects legacy generated skill and deletes artifact', async () => {
    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-reject', 'snap-reject');
    const runtime = buildRuntime(artifacts, { 'cap-reject': 'reject' });

    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'reject_candidate');
    assert.equal(results[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false, 'rejected legacy artifact is removed after transition is durably logged');
    const registry = loadCurrentSkillRegistry(artifacts.registryPath);
    assert.equal(Object.keys(registry.capabilities).length, 0);
  });

  test('keeps deferred legacy generated skill until later evidence triggers re-review', async () => {
    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-defer', 'snap-defer');
    const outcomes: Record<string, LegacyOutcome> = { 'cap-defer': 'defer' };
    let authorCalls = 0;
    const runtime = buildRuntime(artifacts, outcomes, () => {
      authorCalls++;
    });

    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'defer');
    assert.equal(results[0]!.queued, 'deferred');
    assert.equal(results[0]!.deleted, false);
    assert.equal(fs.existsSync(artifactPath), true, 'deferred artifact remains for later reassessment');
    const queue = loadReviewQueueState(artifacts.reviewQueuePath);
    const queued = findDeferByBundleId(queue, results[0]!.bundleId);
    assert.ok(queued, 'deferred entry is written to review queue');

    const repeated = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });
    assert.equal(repeated[0]!.queued, 'deferred');
    assert.equal(repeated[0]!.deleted, false);
    assert.equal(authorCalls, 1, 'pending deferred work is not reassessed during bootstrap');

    markDeferredEntryExplicitRetry(queue, queued!.entryId);
    saveReviewQueueState(artifacts.reviewQueuePath, queue);
    outcomes['cap-defer'] = 'adopt';
    await runtime.reviewDueQueueEntries();

    const afterReview = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });
    assert.equal(afterReview[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(authorCalls, 2, 'eligible deferred work is reassessed by the V3 queue');
  });

  test('reads bounded provenance logs into source evidence', async () => {
    writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-source-evidence', 'snap-source-evidence');
    let authoredBundle: EvidenceBundle | undefined;
    const runtime = buildRuntime(artifacts, { 'cap-source-evidence': 'adopt' }, bundle => {
      authoredBundle = bundle;
    });

    await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.ok(authoredBundle?.sourceEvidence);
    assert.match(authoredBundle!.sourceEvidence![0]!.content, /^problem-action evidence:/u);
    assert.match(authoredBundle!.sourceEvidence![1]!.content, /verification evidence:/u);
  });

  test('improves an adopted current skill and removes the legacy artifact', async () => {
    const runtime = buildRuntime(artifacts, {
      'cap-improve-seed': 'adopt',
      'cap-improve': 'improve',
    });
    writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-improve-seed', 'snap-improve-seed');

    await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-improve', 'snap-improve');
    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'replace_current_skill');
    assert.equal(results[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    const registry = loadCurrentSkillRegistry(artifacts.registryPath);
    assert.equal(Object.keys(registry.capabilities).length, 1);
    assert.equal(Object.values(registry.capabilities)[0]!.revision, 2);
  });

  test('merges two adopted current skills and removes the legacy artifact', async () => {
    const runtime = buildRuntime(artifacts, {
      'cap-merge-a': 'adopt',
      'cap-merge-b': 'adopt',
      'cap-merge': 'merge',
    });
    writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-merge-a', 'snap-merge-a');
    writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-merge-b', 'snap-merge-b');

    await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-merge', 'snap-merge');
    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'merge_into_capability');
    assert.equal(results[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(Object.keys(loadCurrentSkillRegistry(artifacts.registryPath).capabilities).length, 1);
  });

  test('retires an adopted current skill and removes the legacy artifact', async () => {
    const runtime = buildRuntime(artifacts, {
      'cap-retire-seed': 'adopt',
      'cap-retire': 'retire',
    });
    writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-retire-seed', 'snap-retire-seed');

    await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-retire', 'snap-retire');
    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'retire_capability');
    assert.equal(results[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(Object.keys(loadCurrentSkillRegistry(artifacts.registryPath).capabilities).length, 0);
  });

  test('retries cleanup without reassessing after a committed transition', async () => {
    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-cleanup-retry', 'snap-cleanup-retry');
    let authorCalls = 0;
    const runtime = buildRuntime(artifacts, { 'cap-cleanup-retry': 'adopt' }, () => {
      authorCalls++;
    });

    const first = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
      deleteArtifact: () => {
        throw new Error('simulated cleanup failure');
      },
    });

    assert.equal(first[0]!.deleted, false);
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(authorCalls, 1);

    const second = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(second[0]!.transition, 'create_current_skill');
    assert.equal(second[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(authorCalls, 1, 'committed bundle is not reassessed during cleanup recovery');
    assert.equal(Object.keys(loadCurrentSkillRegistry(artifacts.registryPath).capabilities).length, 1);
  });

  test('keeps legacy generated skill after operational bootstrap failure', async () => {
    const artifactPath = writeLegacyDistilledArtifact(artifacts.generatedRoot, 'cap-operational', 'snap-operational');
    const outcomes: Record<string, LegacyOutcome> = { 'cap-operational': 'operational' };
    let authorCalls = 0;
    const runtime = buildRuntime(artifacts, outcomes, () => {
      authorCalls++;
    });

    const results = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.transition, 'reject_candidate');
    assert.equal(results[0]!.queued, 'operational');
    assert.equal(results[0]!.deleted, false);
    assert.equal(fs.existsSync(artifactPath), true, 'operational failure keeps artifact to preserve bootstrap guidance');

    const queue = loadReviewQueueState(artifacts.reviewQueuePath);
    const queued = findOperationalByBundleId(queue, results[0]!.bundleId);
    assert.ok(queued, 'operational entry is written to review queue');
    assert.equal(queued!.attempts, 1);

    const repeated = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });
    assert.equal(repeated[0]!.queued, 'operational');
    assert.equal(authorCalls, 1, 'operational retry waits for the V3 backoff window');

    queue.operational = queue.operational.map(entry => entry.bundleId === queued!.bundleId
      ? { ...entry, nextRetryAt: new Date(0).toISOString() }
      : entry);
    saveReviewQueueState(artifacts.reviewQueuePath, queue);
    outcomes['cap-operational'] = 'adopt';
    await runtime.reviewDueQueueEntries();

    const afterRetry = await bootstrapLegacyDistilledSkillsOnce({
      skillEvolution: runtime,
      generatedDistilledRoot: artifacts.generatedRoot,
    });
    assert.equal(afterRetry[0]!.deleted, true);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(authorCalls, 2, 'due operational work is retried by the V3 queue');
  });
});

function buildRuntime(
  artifacts: RuntimeArtifacts,
  outcomes: Record<string, LegacyOutcome>,
  onAuthor?: (bundle: EvidenceBundle) => void,
): SkillEvolutionRuntime {
  return new SkillEvolutionRuntime({
    workingDirectory: artifacts.root,
    outputDir: artifacts.generatedRoot,
    registryPath: artifacts.registryPath,
    auditPath: artifacts.auditPath,
    journalPath: artifacts.journalPath,
    reviewQueuePath: artifacts.reviewQueuePath,
    authorFixture: ({ bundle }) => {
      onAuthor?.(bundle);
      const candidate = bundle.episode as { capabilityId: string };
      const safeName = candidate.capabilityId.replace(/[^a-z0-9-]+/giu, '-');
      const outcome = outcomes[candidate.capabilityId] ?? 'adopt';
      const related = bundle.relatedCurrentSkills;

      if (outcome === 'improve') {
        const target = related[0]!;
        return {
          body: `Improved legacy reassessment for ${candidate.capabilityId}`,
          envelope: {
            decision: 'replace_current_skill',
            routingName: target.routingName,
            description: target.description,
            targetCapabilityHandle: target.handle,
          },
        };
      }
      if (outcome === 'merge') {
        const [target, source] = related;
        return {
          body: `Merge legacy reassessment for ${candidate.capabilityId}`,
          envelope: {
            decision: 'merge_into_capability',
            targetCapabilityHandle: target!.handle,
            sourceCapabilityHandle: source!.handle,
          },
        };
      }
      if (outcome === 'retire') {
        const target = related[0]!;
        return {
          body: `Retire legacy reassessment for ${candidate.capabilityId}`,
          envelope: {
            decision: 'retire_capability',
            targetCapabilityHandle: target.handle,
          },
        };
      }
      return {
        body: `Legacy reassessment for ${candidate.capabilityId}`,
        envelope: {
          decision: 'create_current_skill',
          routingName: `legacy-${safeName}-workflow`,
          description: `Legacy bootstrap guidance for ${candidate.capabilityId}`,
        },
      };
    },
    verifierFixture: ({ bundle }) => {
      const candidate = bundle.episode as { capabilityId: string };
      switch (outcomes[candidate.capabilityId]) {
        case 'improve':
          return acceptedTransition('replace_current_skill');
        case 'merge':
          return acceptedTransition('merge_into_capability');
        case 'retire':
          return acceptedTransition('retire_capability');
        case 'defer':
          return {
            decision: 'defer',
            issues: [{ code: 'awaiting-evidence', message: 'Waiting for stronger evidence', severity: 'warning' }],
            rationale: 'Synthetic defer for bootstrap coverage.',
          };
        case 'operational':
          throw new Error(`Synthetic operational failure for ${candidate.capabilityId}`);
        case 'reject':
          return {
            decision: 'reject',
            issues: [{ code: 'rejected', message: 'Synthetic reject for bootstrap coverage.' }],
            rationale: 'Synthetic reject for bootstrap coverage.',
          };
        default:
          return acceptedTransition('create_current_skill');
      }
    },
  });
}

function acceptedTransition(
  transition: 'create_current_skill' | 'replace_current_skill' | 'merge_into_capability' | 'retire_capability',
) {
  return {
    decision: 'accept' as const,
    transition,
    issues: [],
    rationale: `Synthetic ${transition} for bootstrap coverage.`,
  };
}

function writeLegacyDistilledArtifact(baseDir: string, capabilityId: string, snapshotId: string): string {
  const sourceFilePath = path.join(baseDir, 'session.jsonl');
  const filePath = path.join(baseDir, capabilityId, snapshotId, 'SKILL.md');
  const sourceLog = [
    `problem-action evidence: ${'x'.repeat(36)}`,
    `verification evidence: ${'y'.repeat(48)}`,
  ].join('\n');
  const markdown = `---
name: "distilled-${snapshotId}"
description: "Legacy capability for ${capabilityId}"
user-invocable: true
capability_id: "${capabilityId}"
snapshot_id: "${snapshotId}"
distilled: true
kind: "capability"
schema_version: 1
generated_at: "2026-07-10T00:00:00.000Z"
source_file_path: "${sourceFilePath}"
source_byte_range_start: 0
source_byte_range_end: 120
source_unit_generated_at: "2026-07-10T00:00:00.000Z"
review_reviewed_at: "2026-07-10T00:00:00.100Z"
---
# Capability: ${capabilityId}

## Capability Guidance

**Applicability**

Use the deterministic legacy capability for bootstrap coverage.

**Action Pattern**

Apply the legacy capability when the user asks about the same known problem.

## Boundaries

- Apply this capability only to equivalent conditions.

## Risks

- Legacy snapshot context may be stale.

## Traceability Contract

This is synthetic test data for bootstrap reassessment.

## Provenance Refs

- "${sourceFilePath}" turn 1 (problem-action) — byte range 0-60
- "${sourceFilePath}" turn 2 (verification) — byte range 61-120
`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(sourceFilePath, sourceLog, { encoding: 'utf-8' });
  fs.writeFileSync(filePath, markdown, { encoding: 'utf-8' });
  return filePath;
}
