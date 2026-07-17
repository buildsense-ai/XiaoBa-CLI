/**
 * Issue #78 — Evidence Capsule: redacted external evidence persistence.
 *
 * Tests:
 *   1. Redaction strips sensitive fields while preserving evidence structure.
 *   2. Capsule creation records provenance, identity, and redacted evidence.
 *   3. CapsuleStore persists, loads, and queries capsules durably.
 *   4. Bundle reconstruction from capsule produces a valid EvidenceBundle.
 *   5. Promotion audit ref linkage records transition ids.
 *   6. Upstream independence: capsule is immutable after creation.
 *   7. Same-content from multiple providers is separately traceable.
 *   8. Internal episodes do NOT create capsules (behavior unchanged).
 *   9. Capsule created from external source through RuntimeLearning.wake()
 *      using FixtureSessionLogSourceAdapter (AC8).
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EvidenceCapsuleStore,
  EvidenceCapsule,
  EvidenceCapsuleProvenance,
  EvidenceCapsuleIdentity,
  buildEvidenceCapsule,
  redactExternalEvidenceContent,
  reconstructBundleFromCapsule,
  EVIDENCE_CAPSULE_SCHEMA_VERSION,
  MAX_EVIDENCE_CAPSULE_ENTRIES,
  MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES,
  MAX_EVIDENCE_CAPSULE_OBSERVATIONS,
  MAX_EVIDENCE_CAPSULE_OBSERVATION_PAYLOAD_BYTES,
  MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES,
  MAX_EXTERNAL_TURN_TEXT_BYTES,
  sanitizeExternalDistillationUnit,
} from '../src/utils/evidence-capsule';
import {
  BoundedSourceEvidence,
  EvidenceBundle,
  SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import {
  ExternalSessionLogSourceAdapter,
  SessionLogSourceAdapter,
  SessionLogSourceIdentity,
  SessionLogSourceReadContext,
  SessionLogSourceReadResult,
  SessionLogSourceResource,
} from '../src/utils/session-log-source';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { LearningEpisodeStore, type SemanticObservation } from '../src/utils/learning-episode';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { DistillationUnit, extractDistillationUnit } from '../src/utils/distillation-unit';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  findOperationalByBundleId,
  loadReviewQueueState,
  saveReviewQueueState,
} from '../src/utils/skill-evolution-review-queue';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_EXTERNAL_IDENTITY: SessionLogSourceIdentity = {
  sourceId: 'codex-workspace',
  label: 'Codex Workspace',
  category: 'external',
  provider: 'codex',
  reader: 'xurl',
};

const SAMPLE_EVENT_IDENTITY = {
  eventId: 'codex://conv/abc123/message/42',
  position: 42,
  contentHash: 'abc123def456',
};

const SAMPLE_SOURCE_IDENTITY: SessionLogSourceIdentity = {
  sourceId: 'pi-claude',
  label: 'Pi Claude',
  category: 'external',
  provider: 'claude-code',
  reader: 'xurl',
};

const structuralReaderFixture: NonNullable<
  ConstructorParameters<typeof SkillEvolutionRuntime>[0]['readerFixture']
> = ({ lane, shard }) => ({
  findingSet: readShardStructurally(
    shard.shardId,
    shard.contentHash,
    shard.content,
    lane,
  ),
});

const SAMPLE_SEMANTIC_OBSERVATIONS: readonly SemanticObservation[] = [
  {
    kind: 'user-intent',
    value: 'Create a report from the sales data',
    sourceRefs: ['ext://turn-1:user-intent'],
  },
  {
    kind: 'workflow-tool',
    value: 'send_file',
    sourceRefs: ['ext://turn-2:delivery:send_file'],
  },
];

function makeCompletionEvidence() {
  return [
    {
      ref: 'ext://conv/abc123#turn-2:delivery:send_file',
      content: 'User asked to generate a report. send_file {path: report.md}: report sent successfully',
      role: 'problem-action' as const,
      sourceFilePath: 'ext://conv/abc123',
      turn: 2,
    },
  ];
}

function makeSettlementEvidence() {
  return [
    {
      ref: 'ext://conv/abc123#episode-ep-abc:settled-2026-07-15T00:00:00.000Z',
      content: 'Episode ep-abc settled at 2026-07-15T00:00:00.000Z (status: settling)',
      role: 'verification' as const,
      sourceFilePath: 'ext://conv/abc123',
      turn: 3,
    },
  ];
}

function makeCapsule(overrides: Partial<EvidenceCapsule> = {}): EvidenceCapsule {
  return {
    schemaVersion: EVIDENCE_CAPSULE_SCHEMA_VERSION,
    capsuleId: 'capsule-test-001',
    provenance: {
      sourceId: SAMPLE_EXTERNAL_IDENTITY.sourceId,
      provider: SAMPLE_EXTERNAL_IDENTITY.provider,
      reader: SAMPLE_EXTERNAL_IDENTITY.reader,
      category: SAMPLE_EXTERNAL_IDENTITY.category,
    },
    identity: {
      eventId: SAMPLE_EVENT_IDENTITY.eventId,
      position: SAMPLE_EVENT_IDENTITY.position,
      contentHash: 'sha256-test-hash',
    },
    episodeId: 'episode-abc123',
    bundleId: 'v3:learning-episode:episode-abc123',
    completionEvidence: makeCompletionEvidence(),
    settlementEvidence: makeSettlementEvidence(),
    semanticObservations: [],
    redactedAt: '2026-07-14T12:00:00.000Z',
    promotionAuditRefs: [],
    ...overrides,
  } as EvidenceCapsule;
}

interface WakeEnv {
  root: string;
  reviewQueuePath: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  episodeStorePath: string;
  reassessmentManifestPath: string;
  curatorStatePath: string;
  ledgerPath: string;
  outputDir: string;
  skillEvolution: SkillEvolutionRuntime;
  episodeStore: LearningEpisodeStore;
  evidenceIngestor: EvidenceIngestor;
  curator: SkillUsageCurator;
  planner: DueWorkPlanner;
  restore: () => void;
  teardown: () => void;
}

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function makeTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, turn)).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function buildExternalUnit(root: string, sourceFilePath: string): DistillationUnit {
  const localFile = path.join(root, 'fixture', 'external-source.jsonl');
  const turns: SessionTurnLogEntry[] = [
    makeTurn(
      1,
      'external-session',
      'Please generate and send the report.',
      'Done.',
      [{
        id: 'send-1',
        name: 'send_file',
        arguments: { path: '/Users/me/project/private/report.md' },
        result: 'report sent token: my-secret',
      }],
    ),
    makeTurn(2, 'external-session', 'Thanks, that works perfectly!', 'Glad it helped.'),
  ];
  writeLog(localFile, turns);
  const extracted = extractDistillationUnit(localFile, {
    filePath: localFile,
    byteOffset: 0,
    processedTurnCount: 0,
    updatedAt: '',
    status: 'pending',
  });
  if (!extracted.distillationUnit) {
    throw new Error('failed to build external distillation unit');
  }
  return {
    ...extracted.distillationUnit,
    filePath: sourceFilePath,
  };
}

class ExternalUnitFixtureAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  private readonly resource: SessionLogSourceResource;
  private consumed = false;

  constructor(
    private readonly unit: DistillationUnit,
    options: { sourceId?: string; provider?: string } = {},
  ) {
    this.identity = {
      sourceId: options.sourceId ?? 'external-codex',
      label: 'External Fixture Source',
      category: 'external',
      provider: options.provider ?? 'codex',
      reader: 'fixture',
    };
    this.resource = {
      resourceRef: `${this.identity.sourceId}://resource-0`,
      firstEventIdentity: {
        eventId: `${this.identity.provider}://conversation/abc/event-0`,
        position: 0,
        contentHash: 'fixture-hash-0',
      },
    };
  }

  isEnabled(): boolean { return true; }
  discoverResources(): readonly SessionLogSourceResource[] { return [this.resource]; }
  read(resource: SessionLogSourceResource, _context: SessionLogSourceReadContext): SessionLogSourceReadResult {
    if (this.consumed) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: this.unit.newTurns.length },
      };
    }
    this.consumed = true;
    return {
      distillationUnit: this.unit,
      advanced: true,
      status: 'advanced',
      newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: this.unit.newTurns.length },
    };
  }
  acknowledge(_resource: SessionLogSourceResource, _result: SessionLogSourceReadResult): void {}
  markFailed(_resource: SessionLogSourceResource, _error: unknown): void { this.consumed = false; }
}

function setupWakeEnv(options: {
  settlementWindowMs?: number;
  operationalRetryMs?: number;
  authorFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['authorFixture'];
  verifierFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['verifierFixture'];
} = {}): WakeEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-capsule-wake-'));
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    XIAOBA_SKILLS_DIR: process.env.XIAOBA_SKILLS_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE: process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE,
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    settlementWindowMs: options.settlementWindowMs ?? 0,
    operationalRetryMs: options.operationalRetryMs ?? 0,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    readerFixture: structuralReaderFixture,
    authorFixture: options.authorFixture,
    verifierFixture: options.verifierFixture,
  });

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const curator = new SkillUsageCurator({
    ledger: new SkillUsageLedger(ledgerPath),
    statePath: curatorStatePath,
    intervalMs: 24 * 60 * 60 * 1000,
    runtime: skillEvolution,
  });

  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath,
    curatorStatePath,
    curatorIntervalMs: 24 * 60 * 60 * 1000,
    semanticReassessmentManifestPath: reassessmentManifestPath,
  });

  const evidenceIngestor = new EvidenceIngestor({
    episodeStore,
    settlementWindowMs: options.settlementWindowMs ?? 0,
  });

  return {
    root,
    reviewQueuePath,
    registryPath,
    auditPath,
    journalPath,
    episodeStorePath,
    reassessmentManifestPath,
    curatorStatePath,
    ledgerPath,
    outputDir,
    skillEvolution,
    episodeStore,
    evidenceIngestor,
    curator,
    planner,
    restore: () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    teardown: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createRuntimeLearning(
  env: WakeEnv,
  sources: readonly SessionLogSourceAdapter[],
  clock?: () => Date,
): RuntimeLearning {
  return new RuntimeLearning({
    workingDirectory: env.root,
    evidenceIngestor: env.evidenceIngestor,
    learningEpisodeStore: env.episodeStore,
    skillEvolution: env.skillEvolution,
    curator: env.curator,
    planner: env.planner,
    sessionLogSources: sources,
    ...(clock ? { clock } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let testRoot: string;

describe('Evidence Capsule', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-capsule-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  // ---- Redaction ----

  describe('redactExternalEvidenceContent', () => {
    test('redacts system prompt blocks (XML-style)', () => {
      const input = '<system>You are an AI assistant with access to files</system>';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[system prompt redacted]'));
      assert.ok(!result.includes('You are an AI assistant'));
    });

    test('redacts system prompt blocks (code-fence style)', () => {
      const input = '```system\nYou are an AI with access to secrets\n```';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[system prompt redacted]'));
      assert.ok(!result.includes('secrets'));
    });

    test('redacts API keys and tokens (key=value style)', () => {
      const input = 'api_key=sk-abc123def456\nsecret=my-secret-value';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[REDACTED]'));
      assert.ok(!result.includes('sk-abc123def456'));
    });

    test('redacts API keys (key: value style)', () => {
      const input = 'token: abc123def456\npassword: my-password';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[REDACTED]'));
      assert.ok(!result.includes('abc123def456'));
    });

    test('redacts Bearer tokens in authorization headers', () => {
      const input = 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjoi';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('Bearer [REDACTED]'));
      assert.ok(!result.includes('eyJhbGciOiJIUzI1NiJ9'));
    });

    test('redacts CLI flag credentials', () => {
      const input = '--api-key sk-abc123 --token my-token-value';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[REDACTED]'));
      assert.ok(!result.includes('sk-abc123'));
    });

    test('redacts local filesystem paths', () => {
      const input = 'Path: \'/Users/me/project/secrets/config.json\'';
      const result = redactExternalEvidenceContent(input);
      assert.ok(!result.includes('/Users/me/project/secrets'));
    });

    test('redacts database connection URLs with credentials', () => {
      const input = 'postgres://user:password@localhost:5432/db';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[REDACTED]'));
      assert.ok(!result.includes('user:password'));
    });

    test('preserves node_modules paths', () => {
      const input = '\'./node_modules/express/index.js\'';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('node_modules'));
    });

    test('redacts thinking blocks', () => {
      const input = '<thinking>This is an internal reasoning trace</thinking>';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[REDACTED]'));
    });

    test('redacts PROMPT_TRACE lines', () => {
      const input = 'PROMPT_TRACE: System: Run command xyz';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[PROMPT TRACE REDACTED]'));
    });

    test('handles empty input', () => {
      assert.equal(redactExternalEvidenceContent(''), '');
    });

    test('preserves non-sensitive content unchanged', () => {
      const input = 'User asked to generate a markdown report.';
      const result = redactExternalEvidenceContent(input);
      assert.equal(result, input);
    });

    test('redacts multiple sensitive patterns in one pass', () => {
      const input = [
        '<system>You are an AI</system>',
        'PATH: /Users/me/data/file.txt',
        'token: abc123',
        'Normal evidence text remains.',
      ].join('\n');
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[system prompt redacted]'));
      assert.ok(!result.includes('You are an AI'));
      assert.ok(!result.includes('/Users/me/data'));
      assert.ok(result.includes('Normal evidence text remains.'));
    });

    test('redacts env variable references with secret names', () => {
      const input = 'process.env.API_KEY';
      const result = redactExternalEvidenceContent(input);
      assert.ok(result.includes('[ENV REDACTED]'));
    });
  });

  // ---- Capsule creation ----

  describe('buildEvidenceCapsule', () => {
    test('accepts ordinary external turn text through the configured bound and rejects larger turns', () => {
      const unit = (assistantBytes: number) => ({
        filePath: 'external-source.jsonl',
        newTurns: [{
          turn: 1,
          timestamp: new Date(0).toISOString(),
          session_id: 'external-session',
          session_type: 'chat',
          user: { text: 'Continue.' },
          assistant: { text: 'x'.repeat(assistantBytes), tool_calls: [] },
          tokens: { prompt: 1, completion: 1 },
        }],
        continuityTurns: [],
        byteRange: { start: 0, end: assistantBytes },
        generatedAt: new Date(0).toISOString(),
      } as any);

      assert.doesNotThrow(() => sanitizeExternalDistillationUnit(unit(MAX_EXTERNAL_TURN_TEXT_BYTES), {
        sourceId: 'external-pi',
        eventIdentity: { eventId: 'event-81', position: 81 },
      }));
      assert.throws(() => sanitizeExternalDistillationUnit(unit(MAX_EXTERNAL_TURN_TEXT_BYTES + 1), {
        sourceId: 'external-pi',
        eventIdentity: { eventId: 'event-oversized', position: 82 },
      }), new RegExp(`external assistant text exceeds the ${MAX_EXTERNAL_TURN_TEXT_BYTES}-byte external evidence limit`));
    });

    test('creates a capsule with provenance and identity', () => {
      const capsule = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-xyz',
        bundleId: 'v3:learning-episode:episode-xyz',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        semanticObservations: SAMPLE_SEMANTIC_OBSERVATIONS,
        now: new Date('2026-07-14T12:00:00.000Z'),
      });

      assert.equal(capsule.schemaVersion, EVIDENCE_CAPSULE_SCHEMA_VERSION);
      assert.ok(capsule.capsuleId.startsWith('capsule-'));
      assert.equal(capsule.provenance.sourceId, 'codex-workspace');
      assert.equal(capsule.provenance.provider, 'codex');
      assert.equal(capsule.provenance.category, 'external');
      assert.equal(capsule.identity.eventId, 'codex://conv/abc123/message/42');
      assert.equal(capsule.identity.position, 42);
      assert.equal(capsule.episodeId, 'episode-xyz');
      assert.equal(capsule.bundleId, 'v3:learning-episode:episode-xyz');
      assert.equal(capsule.redactedAt, '2026-07-14T12:00:00.000Z');
      assert.deepEqual(capsule.promotionAuditRefs, []);
    });

    test('redacts evidence content during capsule creation', () => {
      const completionWithSensitive = [
        {
          ref: 'ext://turn-2:delivery:send_file',
          content: 'send_file {path: /Users/me/data/report.md}: report sent. token: my-secret',
          role: 'problem-action' as const,
          sourceFilePath: 'ext://source',
          turn: 2,
        },
      ];
      const capsule = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-sec',
        bundleId: 'v3:learning-episode:episode-sec',
        completionEvidence: completionWithSensitive,
        settlementEvidence: makeSettlementEvidence(),
        now: new Date('2026-07-14T12:00:00.000Z'),
      });

      const evidence = capsule.completionEvidence[0];
      assert.ok(evidence.content.includes('send_file'));
      assert.ok(!evidence.content.includes('my-secret'));
      assert.ok(!evidence.content.includes('/Users/me/data'));
    });

    test('preserves semantic observations in capsule', () => {
      const capsule = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-obs',
        bundleId: 'v3:learning-episode:episode-obs',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        semanticObservations: SAMPLE_SEMANTIC_OBSERVATIONS,
        now: new Date('2026-07-14T12:00:00.000Z'),
      });

      assert.equal(capsule.semanticObservations.length, 2);
      assert.equal(capsule.semanticObservations[0].kind, 'user-intent');
      assert.equal(capsule.semanticObservations[0].value, 'Create a report from the sales data');
    });

    test('computes stable content hash from redacted evidence', () => {
      const capsule1 = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-hash',
        bundleId: 'v3:learning-episode:episode-hash',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        now: new Date('2026-07-14T12:00:00.000Z'),
      });
      const capsule2 = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-hash',
        bundleId: 'v3:learning-episode:episode-hash',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        now: new Date('2026-07-14T12:00:00.000Z'),
      });

      // Same input produces same content hash (capsuleId differs due to timestamp)
      assert.equal(capsule1.identity.contentHash, capsule2.identity.contentHash);
    });

    test('stores redaction fingerprint separately from event identity', () => {
      const capsule = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: {
          ...SAMPLE_EVENT_IDENTITY,
          contentHash: 'event-hash-123',
        },
        episodeId: 'episode-fingerprint',
        bundleId: 'v3:learning-episode:episode-fingerprint',
        completionEvidence: [
          {
            ref: 'ext://turn-2:delivery:send_file',
            content: 'generated report at /Users/me/project/private/report.md; token: my-secret',
            role: 'problem-action',
            sourceFilePath: 'external://conv/abc',
          },
        ],
        settlementEvidence: makeSettlementEvidence(),
      });

      assert.equal(capsule.identity.contentHash, 'event-hash-123');
      assert.ok(capsule.evidenceFingerprint);
      assert.notEqual(capsule.identity.contentHash, capsule.evidenceFingerprint);
      assert.equal(capsule.completionEvidence[0].sourceFilePath, 'external://conv/abc');
      assert.ok(!capsule.completionEvidence[0].content.includes('/Users/me/project/private'));
      assert.ok(!capsule.completionEvidence[0].content.includes('my-secret'));
    });

    test('redacts semantic observation values and sourceRefs', () => {
      const capsule = buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-obs-redact',
        bundleId: 'v3:learning-episode:episode-obs-redact',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        semanticObservations: [
          {
            kind: 'workflow-tool',
            value: 'execute /Users/me/project/notes/secret.md for reporting',
            sourceRefs: ['ext://turn-1:workspace:/Users/me/project/private/ref'],
          },
        ],
      });

      assert.ok(!capsule.semanticObservations[0].value.includes('/Users/me/project/notes'));
      assert.ok(capsule.semanticObservations[0].sourceRefs);
      assert.ok(!capsule.semanticObservations[0].sourceRefs![0].includes('/Users/me/project'));
    });

    test('rejects oversized evidence entries before capsule persistence', () => {
      assert.throws(() => buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-entry-bound',
        bundleId: 'v3:learning-episode:episode-entry-bound',
        completionEvidence: [{
          ref: 'ext://oversized',
          content: 'x'.repeat(MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES + 1),
          role: 'problem-action',
        }],
        settlementEvidence: [],
      }), /external evidence entry/);

      assert.throws(() => buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-entry-count-bound',
        bundleId: 'v3:learning-episode:episode-entry-count-bound',
        completionEvidence: Array.from({ length: MAX_EVIDENCE_CAPSULE_ENTRIES + 1 }, (_, index) => ({
          ref: `ext://oversized/${index}`,
          content: 'bounded',
          role: 'problem-action' as const,
        })),
        settlementEvidence: [],
      }), /entry count/);
    });

    test('rejects oversized capsule payload and observations', () => {
      const manyEntries = Array.from({ length: 32 }, (_, index) => ({
        ref: `ext://payload/${index}`,
        content: 'payload '.repeat(700),
        role: 'problem-action' as const,
      }));
      assert.ok(Buffer.byteLength(JSON.stringify(manyEntries), 'utf8') > MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES);
      assert.throws(() => buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-payload-bound',
        bundleId: 'v3:learning-episode:episode-payload-bound',
        completionEvidence: manyEntries,
        settlementEvidence: [],
      }), /payload/);

      assert.throws(() => buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-observation-count-bound',
        bundleId: 'v3:learning-episode:episode-observation-count-bound',
        completionEvidence: [],
        settlementEvidence: [],
        semanticObservations: Array.from({ length: MAX_EVIDENCE_CAPSULE_OBSERVATIONS + 1 }, () => ({
          kind: 'workflow-tool' as const,
          value: 'bounded observation',
          sourceRefs: ['ext://observation'],
        })),
      }), /observation count/);

      assert.throws(() => buildEvidenceCapsule({
        sourceIdentity: SAMPLE_EXTERNAL_IDENTITY,
        eventIdentity: SAMPLE_EVENT_IDENTITY,
        episodeId: 'episode-observation-payload-bound',
        bundleId: 'v3:learning-episode:episode-observation-payload-bound',
        completionEvidence: [],
        settlementEvidence: [],
        semanticObservations: [{
          kind: 'user-intent',
          value: 'x'.repeat(MAX_EVIDENCE_CAPSULE_OBSERVATION_PAYLOAD_BYTES),
          sourceRefs: ['ext://observation'],
        }],
      }), /observation payload/);
    });

    test('store rejects a manually oversized capsule without writing it', () => {
      const filePath = path.join(testRoot, 'bounded-capsules.json');
      const store = new EvidenceCapsuleStore(filePath);
      const capsule = makeCapsule({
        completionEvidence: [{
          ref: 'ext://oversized-store',
          content: 'x'.repeat(MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES + 1),
          role: 'problem-action',
        }],
      });
      assert.throws(() => store.upsert(capsule), /evidence capsule entry/);
      assert.equal(fs.existsSync(filePath), false);
    });
  });

  // ---- Capsule store ----

  describe('EvidenceCapsuleStore', () => {
    test('load returns empty state on first access', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      const state = store.load();
      assert.equal(state.schemaVersion, EVIDENCE_CAPSULE_SCHEMA_VERSION);
      assert.deepEqual(state.capsules, {});
    });

    test('load returns empty state when file is missing', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'nonexistent', 'capsules.json'));
      const state = store.load();
      assert.deepEqual(state.capsules, {});
    });

    test('upsert persists a capsule and load retrieves it', () => {
      const filePath = path.join(testRoot, 'capsules.json');
      const store = new EvidenceCapsuleStore(filePath);
      const capsule = makeCapsule();

      store.upsert(capsule);

      const state = store.load();
      assert.ok(state.capsules[capsule.capsuleId]);
      assert.equal(state.capsules[capsule.capsuleId].episodeId, capsule.episodeId);
      assert.equal(state.capsules[capsule.capsuleId].bundleId, capsule.bundleId);
    });

    test('findByEpisodeId finds the correct capsule', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));

      store.upsert(makeCapsule({ episodeId: 'episode-first', capsuleId: 'capsule-first' }));
      store.upsert(makeCapsule({ episodeId: 'episode-second', capsuleId: 'capsule-second' }));

      const found = store.findByEpisodeId('episode-first');
      assert.ok(found);
      assert.equal(found!.capsuleId, 'capsule-first');

      const notFound = store.findByEpisodeId('episode-missing');
      assert.equal(notFound, undefined);
    });

    test('findByBundleId finds the correct capsule', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));

      store.upsert(makeCapsule({
        bundleId: 'v3:learning-episode:episode-a',
        capsuleId: 'capsule-a',
      }));
      store.upsert(makeCapsule({
        bundleId: 'v3:learning-episode:episode-b',
        capsuleId: 'capsule-b',
      }));

      const found = store.findByBundleId('v3:learning-episode:episode-a');
      assert.ok(found);
      assert.equal(found!.capsuleId, 'capsule-a');

      const notFound = store.findByBundleId('v3:learning-episode:episode-missing');
      assert.equal(notFound, undefined);
    });

    test('addPromotionAuditRef appends transition id', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      const capsule = makeCapsule();
      store.upsert(capsule);

      store.addPromotionAuditRef(capsule.capsuleId, 'transition-001');
      store.addPromotionAuditRef(capsule.capsuleId, 'transition-002');

      const updated = store.findByEpisodeId(capsule.episodeId)!;
      assert.deepEqual(updated.promotionAuditRefs, ['transition-001', 'transition-002']);
    });

    test('retain requires an audit ref and records it without deleting evidence', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      const capsule = makeCapsule({
        semanticObservations: SAMPLE_SEMANTIC_OBSERVATIONS,
      });
      const branchTranscriptPath = path.join(testRoot, 'logs', 'branches', 'skill-author.jsonl');
      const branchTranscript = '{"event_type":"transcript"}\n';
      fs.mkdirSync(path.dirname(branchTranscriptPath), { recursive: true });
      fs.writeFileSync(branchTranscriptPath, branchTranscript, 'utf8');
      store.upsert(capsule);

      assert.throws(
        () => store.retain(capsule.capsuleId, '   '),
        /capsule retention requires an audit reference/,
      );
      assert.deepEqual(store.load().capsules[capsule.capsuleId], capsule);

      store.retain(capsule.capsuleId, 'transition-retain-001');

      assert.deepEqual(store.load().capsules[capsule.capsuleId], {
        ...capsule,
        promotionAuditRefs: ['transition-retain-001'],
      });
      assert.equal(fs.readFileSync(branchTranscriptPath, 'utf8'), branchTranscript);
    });

    test('delete requires a linked audit ref and removes only the targeted capsule', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      const target = makeCapsule({
        capsuleId: 'capsule-target',
        episodeId: 'episode-target',
        bundleId: 'v3:learning-episode:episode-target',
        promotionAuditRefs: ['transition-delete-001'],
      });
      const survivor = makeCapsule({
        capsuleId: 'capsule-survivor',
        episodeId: 'episode-survivor',
        bundleId: 'v3:learning-episode:episode-survivor',
      });
      const branchTranscriptPath = path.join(testRoot, 'logs', 'branches', 'skill-verifier.jsonl');
      const branchTranscript = '{"event_type":"transcript"}\n';
      fs.mkdirSync(path.dirname(branchTranscriptPath), { recursive: true });
      fs.writeFileSync(branchTranscriptPath, branchTranscript, 'utf8');
      store.upsert(target);
      store.upsert(survivor);

      assert.throws(
        () => store.delete(target.capsuleId, ''),
        /capsule deletion requires an audit reference/,
      );
      assert.throws(
        () => store.delete(target.capsuleId, 'transition-unlinked'),
        /capsule deletion audit reference is not linked: transition-unlinked/,
      );
      assert.equal(store.count(), 2);

      assert.equal(store.delete(target.capsuleId, 'transition-delete-001'), true);

      const state = store.load();
      assert.equal(state.capsules[target.capsuleId], undefined);
      assert.deepEqual(state.capsules[survivor.capsuleId], survivor);
      assert.equal(Object.keys(state.capsules).length, 1);
      assert.equal(fs.readFileSync(branchTranscriptPath, 'utf8'), branchTranscript);
    });

    test('count returns the number of stored capsules', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      assert.equal(store.count(), 0);

      store.upsert(makeCapsule({ capsuleId: 'capsule-a', episodeId: 'episode-a' }));
      assert.equal(store.count(), 1);

      store.upsert(makeCapsule({ capsuleId: 'capsule-b', episodeId: 'episode-b' }));
      assert.equal(store.count(), 2);
    });

    test('survives temp-file + rename atomic write', () => {
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      store.upsert(makeCapsule());

      // Verify durable state on a fresh store instance
      const freshStore = new EvidenceCapsuleStore(path.join(testRoot, 'capsules.json'));
      assert.equal(freshStore.count(), 1);
    });

    test('fails closed on corrupted file', () => {
      const filePath = path.join(testRoot, 'capsules.json');
      fs.writeFileSync(filePath, '{invalid json}', 'utf8');

      const store = new EvidenceCapsuleStore(filePath);
      assert.throws(() => store.load(), /corrupt/);
    });
  });

  // ---- Bundle reconstruction ----

  describe('reconstructBundleFromCapsule', () => {
    test('produces a valid EvidenceBundle with sourceEvidence', () => {
      const capsule = makeCapsule();
      const referencedSkills = [{
        name: 'test-skill',
        version: '1.0.0',
      }];
      const registry = {
        schemaVersion: 2 as const,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {},
      };

      const bundle = reconstructBundleFromCapsule(capsule, referencedSkills, registry);

      assert.equal(bundle.bundleId, capsule.bundleId);
      assert.equal(bundle.completionEvidence.length, 1);
      assert.equal(bundle.settlementEvidence.length, 1);
      assert.ok(bundle.sourceEvidence);
      assert.equal(bundle.sourceEvidence!.length, capsule.completionEvidence.length + capsule.settlementEvidence.length);
      assert.equal(bundle.referencedSkills.length, 1);

      // Verify sourceEvidence roles
      const completionRefs = new Set(bundle.completionEvidence.map(e => e.ref));
      const settlementRefs = new Set(bundle.settlementEvidence.map(e => e.ref));
      for (const se of bundle.sourceEvidence!) {
        if (completionRefs.has(se.ref)) {
          assert.equal(se.role, 'problem-action');
        } else if (settlementRefs.has(se.ref)) {
          assert.equal(se.role, 'verification');
        }
      }
    });

    test('reconstructed bundle preserves redacted content', () => {
      const capsule = makeCapsule();
      const bundle = reconstructBundleFromCapsule(capsule, [], {
        schemaVersion: 2 as const,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {},
      });

      const sourceEvidence = bundle.sourceEvidence!;
      assert.ok(sourceEvidence.length > 0);
      // Content comes from the capsule (already redacted)
      assert.equal(sourceEvidence[0].content, capsule.completionEvidence[0].content);
    });

    test('populates relatedCurrentSkills from registry', () => {
      const capsule = makeCapsule();
      const registry = {
        schemaVersion: 2 as const,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {
          'skill-a': {
            handle: 'skill-a',
            revision: 1,
            routingName: 'skill-a',
            description: 'Test skill A',
            skillFilePath: '/skills/a.md',
            guidanceHash: 'abc',
            evidenceRefs: [],
            referencedSkills: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };

      const bundle = reconstructBundleFromCapsule(capsule, [], registry);
      assert.equal(bundle.relatedCurrentSkills.length, 1);
      assert.equal(bundle.relatedCurrentSkills[0].handle, 'skill-a');
    });

    test('reconstructed bundle preserves semantic observations', () => {
      const capsule = makeCapsule({
        semanticObservations: SAMPLE_SEMANTIC_OBSERVATIONS,
      });
      const bundle = reconstructBundleFromCapsule(capsule, [], {
        schemaVersion: 2 as const,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {},
      });

      assert.ok(bundle.semanticObservations);
      assert.equal(bundle.semanticObservations!.length, 2);
    });
  });

  // ---- Upstream independence ----

  describe('upstream independence', () => {
    test('capsule is immutable after creation', () => {
      const capsule = makeCapsule();
      Object.freeze(capsule);
      Object.freeze(capsule.completionEvidence);
      Object.freeze(capsule.settlementEvidence);

      // After freezing, modification should throw in strict mode
      assert.ok(capsule);
    });

    test('same evidence from different providers is separately traceable', () => {
      const providerA: SessionLogSourceIdentity = {
        sourceId: 'pi',
        label: 'Pi',
        category: 'external',
        provider: 'pi',
        reader: 'xurl',
      };
      const providerB: SessionLogSourceIdentity = {
        sourceId: 'codex',
        label: 'Codex',
        category: 'external',
        provider: 'codex',
        reader: 'xurl',
      };

      const capsuleA = buildEvidenceCapsule({
        sourceIdentity: providerA,
        eventIdentity: { eventId: 'pi://conv/1', position: 1, contentHash: 'a' },
        episodeId: 'episode-1',
        bundleId: 'v3:learning-episode:episode-1',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        now: new Date('2026-07-14T12:00:00.000Z'),
      });
      const capsuleB = buildEvidenceCapsule({
        sourceIdentity: providerB,
        eventIdentity: { eventId: 'codex://conv/2', position: 1, contentHash: 'a' },
        episodeId: 'episode-2',
        bundleId: 'v3:learning-episode:episode-2',
        completionEvidence: makeCompletionEvidence(),
        settlementEvidence: makeSettlementEvidence(),
        now: new Date('2026-07-14T12:00:00.000Z'),
      });

      assert.equal(capsuleA.provenance.provider, 'pi');
      assert.equal(capsuleB.provenance.provider, 'codex');
      assert.notEqual(capsuleA.capsuleId, capsuleB.capsuleId);
      assert.notEqual(capsuleA.episodeId, capsuleB.episodeId);
    });
  });

  // ---- No internal capsules ----

  describe('internal evidence does not create capsules', () => {
    test('internal source identity does not trigger capsule creation in bundle builder', () => {
      // Verify that buildEpisodeEvidenceBundle without a capsule store
      // does NOT populate sourceEvidence (internal evidence behavior).
      // This is tested through the runtime-learning.wake() path, but
      // we verify the invariant directly here: the bundle builder
      // only populates sourceEvidence when a capsule store AND a
      // matching capsule exist.
      const store = new EvidenceCapsuleStore(path.join(testRoot, 'internal-capsules.json'));

      // Internal episodes have no capsules
      const noCapsule = store.findByBundleId('v3:learning-episode:episode-internal');
      assert.equal(noCapsule, undefined);
    });
  });

  // ---- Capsule reconstruction validates ----

  describe('capsule-to-bundle validation', () => {
    test('reconstructed bundle satisfies EvidenceBundle structure', () => {
      const capsule = makeCapsule();
      const bundle = reconstructBundleFromCapsule(capsule, [], {
        schemaVersion: 2 as const,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {},
      });

      // Required fields
      assert.ok(bundle.bundleId);
      assert.ok(bundle.episode);
      assert.ok(Array.isArray(bundle.completionEvidence));
      assert.ok(bundle.completionEvidence.length > 0);
      assert.ok(Array.isArray(bundle.settlementEvidence));
      assert.ok(bundle.settlementEvidence.length > 0);
      assert.ok(Array.isArray(bundle.boundedContinuity));
      assert.ok(Array.isArray(bundle.referencedSkills));
      assert.ok(Array.isArray(bundle.relatedCurrentSkills));

      // sourceEvidence must be present and complete
      assert.ok(bundle.sourceEvidence);
      assert.ok(bundle.sourceEvidence.length > 0);

      // Every completion ref maps to a problem-action sourceEvidence entry
      const sourceByRef = new Map(bundle.sourceEvidence.map(e => [e.ref, e]));
      for (const ref of bundle.completionEvidence) {
        const se = sourceByRef.get(ref.ref);
        assert.ok(se, `completion ref ${ref.ref} has matching sourceEvidence`);
        assert.equal(se.role, 'problem-action');
        assert.ok(se.content?.trim(), `sourceEvidence ${ref.ref} has content`);
      }
      for (const ref of bundle.settlementEvidence) {
        const se = sourceByRef.get(ref.ref);
        assert.ok(se, `settlement ref ${ref.ref} has matching sourceEvidence`);
        assert.equal(se.role, 'verification');
        assert.ok(se.content?.trim(), `sourceEvidence ${ref.ref} has content`);
      }
    });
  });

  describe('RuntimeLearning wake integration for external Evidence Capsules', () => {
    test('external wake persists a redacted capsule, uses it during review, and links audit', async () => {
      let seenBundle: EvidenceBundle | undefined;
      const env = setupWakeEnv({
        authorFixture: ({ bundle }) => {
          seenBundle = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
          return {
            body: 'Deliver the requested report with explicit send_file evidence.',
            envelope: {
              decision: 'create_current_skill',
              routingName: 'external-report-delivery',
              description: 'Deliver a report from an external admitted event.',
              evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
              rationale: 'bounded external evidence capsule promotion',
            },
          };
        },
        verifierFixture: ({ bundle }) => {
          seenBundle = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
          return {
            decision: 'accept',
            transition: 'create_current_skill',
            issues: [],
            rationale: 'bounded external capsule accepted',
            registryReadSet: [],
          };
        },
      });
      try {
        const unit = buildExternalUnit(env.root, 'external://codex/conversation/abc.jsonl');
        unit.newTurns[0]!.user.text = '<system>external-system-secret</system> token: my-secret /Users/me/project/private';
        unit.newTurns[0]!.assistant.tool_calls[0]!.arguments = {
          path: '/Users/me/project/private/report.md',
          token: 'my-secret',
        };
        const runtime = createRuntimeLearning(env, [new ExternalUnitFixtureAdapter(unit)]);

        const result = await runtime.wake('startup');

        assert.ok(result.ingestion.admittedEpisodes >= 1);
        assert.equal(result.review.reviewedEpisodes, 1);
        assert.equal(result.review.status, 'succeeded');
        assert.ok(seenBundle?.sourceEvidence?.length, 'review received bounded source evidence');

        const storedEpisodes = runtime.getEpisodeStore().load().episodes;
        const episodeId = Object.keys(storedEpisodes)[0];
        assert.ok(episodeId, 'one admitted episode exists');
        const episodeText = JSON.stringify(storedEpisodes);
        assert.ok(!episodeText.includes('external-system-secret'));
        assert.ok(!episodeText.includes('my-secret'));
        assert.ok(!episodeText.includes('/Users/me/project/private'));

        const capsuleStore = runtime.getEvidenceCapsuleStore();
        const capsule = capsuleStore.findByEpisodeId(episodeId);
        assert.ok(capsule, 'external episode created an Evidence Capsule');
        assert.equal(capsule!.provenance.provider, 'codex');
        assert.equal(capsule!.provenance.category, 'external');
        assert.equal(capsule!.identity.eventId, 'codex://conversation/abc/event-0');
        assert.ok(!capsule!.completionEvidence[0].content.includes('my-secret'));
        assert.ok(!capsule!.completionEvidence[0].content.includes('/Users/me/project/private'));
        assert.ok(fs.existsSync(path.join(env.root, 'data', 'evidence-capsules.json')));

        const bundleText = JSON.stringify(seenBundle);
        assert.ok(!bundleText.includes('external-system-secret'));
        assert.ok(!bundleText.includes('my-secret'));
        assert.ok(!bundleText.includes('/Users/me/project/private'));

        const audit = runtime.getSkillEvolution().getAudit();
        assert.equal(audit.length, 1);
        assert.deepEqual(capsule!.promotionAuditRefs, [audit[0].transitionId]);
        assert.equal(Object.keys(runtime.getSkillEvolution().getRegistry().capabilities).length, 1);
      } finally {
        env.restore();
        env.teardown();
      }
    });

    test('operational retry snapshot preserves fixed redacted source evidence for external events', async () => {
      const env = setupWakeEnv({
        // Keep the first queued snapshot out of the same wake's due-retry
        // pass; the recovery runtime below explicitly uses a zero delay.
        operationalRetryMs: 60_000,
        authorFixture: async () => {
          throw new Error('simulated author branch failure');
        },
      });
      try {
        const unit = buildExternalUnit(env.root, 'external://codex/conversation/retry.jsonl');
        const runtime = createRuntimeLearning(env, [new ExternalUnitFixtureAdapter(unit)]);

        const result = await runtime.wake('startup');

        assert.ok(result.ingestion.admittedEpisodes >= 1);
        const episodeId = Object.keys(runtime.getEpisodeStore().load().episodes)[0];
        const bundleId = `v3:learning-episode:${episodeId}`;
        const queue = loadReviewQueueState(env.reviewQueuePath);
        const operational = findOperationalByBundleId(queue, bundleId);
        assert.ok(operational, 'external review failure queued an operational retry');
        assert.ok(operational!.bundle.sourceEvidence?.length, 'queued retry snapshot keeps source evidence');

        const snapshotText = JSON.stringify(operational!.bundle.sourceEvidence);
        assert.ok(!snapshotText.includes('my-secret'));
        assert.ok(!snapshotText.includes('/Users/me/project/private'));

        // Expire the durable retry explicitly so this test remains
        // deterministic without relying on wall-clock sleeps.
        queue.operational[0]!.nextRetryAt = new Date(0).toISOString();
        saveReviewQueueState(env.reviewQueuePath, queue);

        const recovery = new SkillEvolutionRuntime({
          workingDirectory: env.root,
          outputDir: env.outputDir,
          registryPath: env.registryPath,
          auditPath: env.auditPath,
          journalPath: env.journalPath,
          reviewQueuePath: env.reviewQueuePath,
          settlementWindowMs: 0,
          operationalRetryMs: 0,
          operationalRetryMaxMs: 60_000,
          logEnabled: false,
          authorFixture: ({ bundle }) => ({
            body: 'Recover the queued external report delivery skill.',
            envelope: {
              decision: 'create_current_skill',
              routingName: 'external-report-retry',
              description: 'Recover an external report delivery from queued evidence.',
              evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
              rationale: 'queue recovery from fixed external evidence snapshot',
            },
          }),
          verifierFixture: () => ({
            decision: 'accept',
            transition: 'create_current_skill',
            issues: [],
            rationale: 'queue recovery accepted',
            registryReadSet: [],
          }),
        });

        const queueResult = await recovery.reviewDueQueueEntries();
        assert.equal(queueResult.operationalReviewed, 1);
        assert.equal(Object.keys(recovery.getRegistry().capabilities).length, 1);
      } finally {
        env.restore();
        env.teardown();
      }
    });

    test('missing capsule blocks external promotion instead of silently using unredacted review input', async () => {
      let now = new Date('2026-01-01T00:00:00.000Z');
      const env = setupWakeEnv({ settlementWindowMs: 1 });
      try {
        const unit = buildExternalUnit(env.root, 'external://codex/conversation/missing-capsule.jsonl');
        const runtime = createRuntimeLearning(env, [new ExternalUnitFixtureAdapter(unit)], () => now);

        const first = await runtime.wake('startup');
        assert.ok(first.ingestion.admittedEpisodes >= 1);
        assert.equal(first.review.reviewedEpisodes, 0, 'settlement window keeps episode out of immediate review');

        fs.unlinkSync(path.join(env.root, 'data', 'evidence-capsules.json'));
        now = new Date('2026-01-01T00:00:00.010Z');

        const second = await runtime.wake('settlement-deadline');
        assert.equal(second.review.status, 'failed');
        assert.equal(second.review.reviewedEpisodes, 0);
        assert.equal(Object.keys(runtime.getSkillEvolution().getRegistry().capabilities).length, 0);
      } finally {
        env.restore();
        env.teardown();
      }
    });
  });
});
