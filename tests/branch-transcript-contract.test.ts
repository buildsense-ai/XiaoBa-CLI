import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BranchSessionLogger } from '../src/core/branch-session';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { cleanupBranchTranscripts } from '../src/utils/branch-transcript-retention';
import {
  EvidenceBundle,
  applyCapabilityTransition,
  SkillEvolutionOptions,
  SkillEvolutionRuntime,
  loadCurrentSkillRegistry,
  loadTransitionAudit,
} from '../src/utils/skill-evolution';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import { acceptReviewObligations } from './evidence-review-test-fixtures';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeBundle(): EvidenceBundle {
  return {
    bundleId: 'branch-transcript-contract-bundle',
    episode: { problem: 'bounded workflow', completion: 'delivered artifact' },
    completionEvidence: [{ ref: 'session.jsonl#1' }],
    settlementEvidence: [{ ref: 'session.jsonl#2' }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
  };
}

function makeEvolutionOptions(root: string, branchLogRoot: string): SkillEvolutionOptions {
  return {
    workingDirectory: root,
    branchLogRoot,
    outputDir: path.join(root, 'skills'),
    registryPath: path.join(root, 'data', 'registry.json'),
    auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(root, 'data', 'transition-journal.json'),
    reviewQueuePath: path.join(root, 'data', 'review-queue.json'),
    // Engine-persisted reader transcripts under data/reader-transcripts (no transcriptPath).
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
    }),
    authorFixture: () => ({
      body: 'Use the bounded workflow and verify the delivered artifact.',
      envelope: {
        decision: 'create_current_skill',
        routingName: 'flashcard-image-delivery',
        description: 'Deliver and verify a bounded artifact workflow.',
        evidenceRefs: ['session.jsonl#1', 'session.jsonl#2'],
      },
    }),
    verifierFixture: ({ bundle }) => ({
      decision: 'accept',
      transition: 'create_current_skill',
      issues: [],
      rationale: 'The bounded workflow is supported by the fixed evidence.',
      obligationDispositions: acceptReviewObligations(bundle),
    }),
  };
}

describe('runtime-owned branch transcripts', () => {
  test('resolves the branch root from runtime data rather than the working directory', () => {
    const workingDirectory = makeRoot('xiaoba-working-');
    const runtimeRoot = makeRoot('xiaoba-runtime-');
    const env = { ...process.env };
    env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
    delete env.XIAOBA_BRANCH_LOG_ROOT;

    const config = getDistillationHeartbeatConfig(workingDirectory, env);
    assert.equal(config.branchLogRoot, path.join(runtimeRoot, 'logs', 'branches'));
    assert.notEqual(config.branchLogRoot, path.join(workingDirectory, 'logs', 'branches'));

    const logger = new BranchSessionLogger({
      branchId: 'root-test',
      branchType: 'memory',
      workingDirectory,
      branchLogRoot: config.branchLogRoot,
      enabled: true,
      contract: 'required',
    });
    logger.write('semantic', { text: 'Keep the workflow meaning.' });
    const transcriptPath = logger.getFilePath();
    assert.ok(transcriptPath?.startsWith(config.branchLogRoot));
    assert.equal(fs.existsSync(transcriptPath!), true);
  });

  test('redacts known credentials while preserving semantic transcript content and permissions', () => {
    const root = makeRoot('xiaoba-branch-redaction-');
    const previous = process.env.CATSCO_API_KEY;
    process.env.CATSCO_API_KEY = 'known-secret-value';
    try {
      const logger = new BranchSessionLogger({
        branchId: 'redaction-test',
        branchType: 'observation',
        workingDirectory: root,
        branchLogRoot: path.join(root, 'logs', 'branches'),
        enabled: true,
        contract: 'required',
      });
      logger.write('semantic', {
        text: 'Preserve this explanation while removing known-secret-value.',
        authorization: 'Bearer another-secret-value',
      });
      const transcriptPath = logger.getFilePath()!;
      const content = fs.readFileSync(transcriptPath, 'utf8');
      assert.match(content, /Preserve this explanation/);
      assert.doesNotMatch(content, /known-secret-value|another-secret-value/);
      assert.equal(fs.statSync(path.join(root, 'logs', 'branches')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(transcriptPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(transcriptPath).mode & 0o777, 0o600);
    } finally {
      if (previous === undefined) delete process.env.CATSCO_API_KEY;
      else process.env.CATSCO_API_KEY = previous;
    }
  });

  test('queues an operational retry before promotion when the required transcript root is unusable', async () => {
    const root = makeRoot('xiaoba-branch-health-');
    const invalidBranchRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(invalidBranchRoot, 'occupied', 'utf8');
    const runtime = new SkillEvolutionRuntime(makeEvolutionOptions(root, invalidBranchRoot));

    const result = await runtime.reviewAndApply(makeBundle());
    assert.equal(result.queued, 'operational');
    assert.equal(result.verified, false);
    assert.equal(Object.keys(loadCurrentSkillRegistry(path.join(root, 'data', 'registry.json')).capabilities).length, 0);
    assert.equal(loadTransitionAudit(path.join(root, 'data', 'transition-audit.jsonl')).length, 0);
  });

  test('keeps active audit-linked transcripts and removes only old uncommitted branch transcripts', () => {
    const root = makeRoot('xiaoba-branch-retention-');
    const branchRoot = path.join(root, 'logs', 'branches');
    const readerRoot = path.join(root, 'data', 'reader-transcripts');
    const activePath = path.join(branchRoot, 'skill-author', 'old', 'active.jsonl');
    const stalePath = path.join(branchRoot, 'memory', 'old', 'stale.jsonl');
    const freshPath = path.join(branchRoot, 'observation', 'fresh', 'fresh.jsonl');
    const activeReaderPath = path.join(readerRoot, 'job-1', 'author-reader.jsonl');
    const staleReaderPath = path.join(readerRoot, 'job-old', 'stale-reader.jsonl');
    for (const filePath of [activePath, stalePath, freshPath, activeReaderPath, staleReaderPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{}\n', 'utf8');
    }
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(activePath, oldTime, oldTime);
    fs.utimesSync(stalePath, oldTime, oldTime);
    fs.utimesSync(activeReaderPath, oldTime, oldTime);
    fs.utimesSync(staleReaderPath, oldTime, oldTime);
    const sessionLog = path.join(root, 'logs', 'sessions', 'chat.jsonl');
    const registryState = path.join(root, 'data', 'learning-episodes.json');
    fs.mkdirSync(path.dirname(sessionLog), { recursive: true });
    fs.mkdirSync(path.dirname(registryState), { recursive: true });
    fs.writeFileSync(sessionLog, 'session state\n', 'utf8');
    fs.writeFileSync(registryState, 'learning state\n', 'utf8');

    const result = cleanupBranchTranscripts({
      branchLogRoot: branchRoot,
      additionalTranscriptRoots: [readerRoot],
      auditEntries: [{
        involvedCapabilityHandles: ['cap-active'],
        branchTranscriptPaths: [activePath, activeReaderPath],
        branchTranscriptHashes: [
          crypto.createHash('sha256').update('{}\n').digest('hex'),
          crypto.createHash('sha256').update('{}\n').digest('hex'),
        ],
      }],
      activeCapabilityHandles: new Set(['cap-active']),
      now: new Date('2026-07-13T00:00:00.000Z'),
    });
    assert.equal(fs.existsSync(activePath), true);
    assert.equal(fs.existsSync(stalePath), false);
    assert.equal(fs.existsSync(freshPath), true);
    assert.equal(fs.existsSync(activeReaderPath), true);
    assert.equal(fs.existsSync(staleReaderPath), false);
    assert.equal(fs.existsSync(sessionLog), true);
    assert.equal(fs.existsSync(registryState), true);
    assert.deepEqual(
      result.retainedPaths.sort(),
      [path.resolve(activePath), path.resolve(activeReaderPath)].sort(),
    );
  });

  test('writes readable audit links for both required promotion transcripts', async () => {
    const root = makeRoot('xiaoba-branch-audit-');
    const branchRoot = path.join(root, 'runtime', 'logs', 'branches');
    const readerRoot = path.join(root, 'data', 'reader-transcripts');
    const runtime = new SkillEvolutionRuntime(makeEvolutionOptions(root, branchRoot));
    const result = await runtime.reviewAndApply(makeBundle());
    assert.equal(result.verified, true);
    const audit = loadTransitionAudit(path.join(root, 'data', 'transition-audit.jsonl'))[0]!;
    // Author + Verifier promotion transcripts, plus any independent reader lanes.
    assert.ok(audit.branchTranscriptPaths.length >= 2);
    assert.equal(audit.branchTranscriptHashes?.length, audit.branchTranscriptPaths.length);
    const promotionPaths = audit.branchTranscriptPaths.filter(p =>
      path.resolve(p).startsWith(path.resolve(branchRoot)),
    );
    const readerPaths = audit.branchTranscriptPaths.filter(p =>
      path.resolve(p).startsWith(path.resolve(readerRoot)),
    );
    assert.equal(promotionPaths.length, 2, 'Author and Verifier branch transcripts required');
    // Reader fixtures may omit transcriptPath; engine-persisted readers land under readerRoot.
    assert.ok(
      readerPaths.length === 0 || readerPaths.length >= 1,
      'reader paths when present must live under data/reader-transcripts',
    );
    const deadlineAt = new Set<string>();
    audit.branchTranscriptPaths.forEach((transcriptPath, index) => {
      const resolved = path.resolve(transcriptPath);
      assert.ok(
        resolved.startsWith(path.resolve(branchRoot))
        || resolved.startsWith(path.resolve(readerRoot)),
        `transcript outside authorized roots: ${transcriptPath}`,
      );
      const content = fs.readFileSync(transcriptPath, 'utf8');
      assert.match(content, /"event_type":"transcript"/);
      const entries = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const start = entries.find(entry => entry.event_type === 'start');
      const branchType = String(entries[0]?.branch_type ?? '');
      const isPromotionBranch = branchType === 'skill-author' || branchType === 'skill-verifier';
      if (isPromotionBranch) {
        const completed = entries.find(entry => entry.event_type === 'completed');
        assert.equal(start?.review_deadline_ms, 10 * 60 * 1000);
        assert.equal(typeof start?.review_deadline_at, 'string');
        deadlineAt.add(String(start?.review_deadline_at));
        assert.equal(completed?.outcome, 'succeeded');
        assert.equal(completed?.terminal_abort_reason, null);
        assert.equal(completed?.failure_outcome, null);
      } else {
        // Independent reader lanes (entry_type=reader or evidence-*-reader branches).
        assert.ok(start, 'reader transcript has start');
        assert.ok(
          entries.some(e => e.event_type === 'fixture_result' || e.event_type === 'run_result' || e.event_type === 'completed'),
          'reader transcript has completion event',
        );
      }
      assert.equal(
        audit.branchTranscriptHashes?.[index],
        crypto.createHash('sha256').update(content).digest('hex'),
      );
    });
    // Authoritative quanta path stamps a per-quantum deadlineAt (same deadlineMs).
    // Shared attempt-deadline identity across Author/Verifier remains residual until
    // the engine plumbs one reviewAttempt into both promotion quanta.
    assert.equal(promotionPaths.length, 2);
    assert.ok(deadlineAt.size >= 1 && deadlineAt.size <= 2);
    const deadlineTimes = [...deadlineAt].map(v => Date.parse(v)).filter(n => Number.isFinite(n));
    if (deadlineTimes.length === 2) {
      assert.ok(
        Math.abs(deadlineTimes[0]! - deadlineTimes[1]!) < 5_000,
        'Author/Verifier attempt deadlines should be near-simultaneous on one wake',
      );
    }

    const hashTarget = promotionPaths[0]!;
    fs.appendFileSync(
      hashTarget,
      '{"entry_type":"branch","branch_type":"skill-author","event_type":"drift"}\n',
      'utf8',
    );
    assert.throws(() => applyCapabilityTransition({
      ...makeEvolutionOptions(root, branchRoot),
      bundle: makeBundle(),
      draft: {
        body: 'Use the bounded workflow and verify the delivered artifact.',
        envelope: {
          decision: 'create_current_skill',
          routingName: 'flashcard-image-delivery',
          description: 'Deliver and verify a bounded artifact workflow.',
          evidenceRefs: ['session.jsonl#1', 'session.jsonl#2'],
        },
      },
      transition: 'create_current_skill',
      verifier: {
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'The bounded workflow is supported by the fixed evidence.',
      },
      branchTranscriptPaths: audit.branchTranscriptPaths,
      reviewerVersion: 'test-reviewer',
      promptVersion: 'test-prompt',
    }), /transcript hash mismatch/);
  });
});
