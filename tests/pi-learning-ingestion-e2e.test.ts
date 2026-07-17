/**
 * End-to-end Pi learning ingestion fixture.
 *
 * Proves the observed production blockers are fixed at the seams that matter:
 *   - Runtime 启动层 metadata is excluded from learning evidence
 *   - a complete Pi User→Assistant final is admitted as a durable LearningEpisode
 *   - Evidence Capsule + external-pi provenance are created (not fabricated IDs)
 *   - replay is idempotent
 *   - ordinary finals between 8KiB and the 16KiB turn bound pass capsule admission
 *   - oversize assistant text remains fail-closed / quarantine
 *   - missing active skill artifacts are detected (and restored only from history)
 */

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseRenderedTimeline } from '../src/utils/xurl-rendered-timeline';
import {
  MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES,
  MAX_EXTERNAL_TURN_TEXT_BYTES,
  sanitizeExternalDistillationUnit,
} from '../src/utils/evidence-capsule';
import {
  ExternalSessionLogBackfillSource,
  loadExternalSessionLogBackfillState,
  type ExternalSessionLogBackfillRequest,
} from '../src/utils/session-log-backfill';
import {
  emptyCurrentSkillRegistryState,
  loadCurrentSkillRegistry,
  reconcileActiveGeneratedSkillArtifacts,
  saveCurrentSkillRegistry,
} from '../src/utils/skill-evolution';
import { SkillManager } from '../src/skills/skill-manager';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { SessionLogSourceResource } from '../src/utils/session-log-source';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pi-learning-e2e-'));
  tempRoots.push(root);
  return root;
}

function piTimelineMarkdown(options: {
  thread: string;
  entries: Array<{ role: string; content: string }>;
}): string {
  const body = options.entries
    .map((entry, index) => `### ${index + 1}. ${entry.role}\n\n${entry.content}`)
    .join('\n\n');
  return [
    '---',
    `uri: agents://pi/${options.thread}`,
    'provider: pi',
    `thread: ${options.thread}`,
    `branch: ${options.thread}`,
    'queried_at: 2026-07-17T03:00:00.000Z',
    '---',
    '',
    '## Timeline',
    '',
    body,
    '',
  ].join('\n');
}

function makePiTurn(options: {
  turn: number;
  sessionId: string;
  userText: string;
  assistantText: string;
  timestamp?: string;
}): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn: options.turn,
    timestamp: options.timestamp ?? '2026-07-17T03:00:00.000Z',
    session_id: options.sessionId,
    session_type: 'external',
    user: { text: options.userText },
    assistant: {
      text: options.assistantText,
      tool_calls: [],
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

function makePiUnit(options: {
  thread: string;
  userText: string;
  assistantText: string;
  startOrdinal?: number;
  endOrdinal?: number;
}): DistillationUnit {
  const start = options.startOrdinal ?? 2;
  const end = options.endOrdinal ?? 4;
  const sessionId = `external:pi:${options.thread}:${options.thread}`;
  return {
    filePath: `xurl://pi/${options.thread}`,
    newTurns: [makePiTurn({
      turn: end,
      sessionId,
      userText: options.userText,
      assistantText: options.assistantText,
    })],
    continuityTurns: [],
    byteRange: { start, end },
    generatedAt: '2026-07-17T03:00:00.000Z',
  };
}

interface RuntimeFixture {
  readonly root: string;
  readonly runtime: RuntimeLearning;
  readonly episodeStore: LearningEpisodeStore;
  restore(): void;
}

function createPiRuntimeFixture(): RuntimeFixture {
  const root = makeRoot();
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
  const outputDir = defaultDistilledOutputDir(path.join(root, 'skills'));

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
  process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
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
    settlementWindowMs: 0,
    operationalRetryMs: 0,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    // External evidence must not get direct promotion authority in this
    // admission test; leave Author/Verifier unset so review stays gated.
  });
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
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
    settlementWindowMs: 0,
  });
  const runtime = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator,
    planner,
    sessionLogSources: [],
    clock: () => new Date('2026-07-17T03:10:00.000Z'),
  });

  return {
    root,
    runtime,
    episodeStore,
    restore() {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function createPiBackfillSource(options: {
  thread: string;
  unit: DistillationUnit;
  contentHash: string;
  eventId: string;
  position: number;
}): ExternalSessionLogBackfillSource {
  const resource: SessionLogSourceResource = {
    resourceRef: options.thread,
    firstEventIdentity: {
      eventId: options.eventId,
      position: options.position,
      contentHash: options.contentHash,
    },
  };
  return {
    identity: {
      sourceId: 'external-pi',
      label: 'Pi',
      category: 'external',
      provider: 'pi',
      reader: 'xurl',
    },
    discoverResources: () => [resource],
    read: () => ({
      events: [{
        identity: {
          eventId: options.eventId,
          position: options.position,
          contentHash: options.contentHash,
          conversationId: options.thread,
          branchId: options.thread,
        },
        distillationUnit: options.unit,
        byteLength: Buffer.byteLength(
          JSON.stringify(options.unit.newTurns[0]),
          'utf8',
        ),
      }],
      status: 'stable',
      exhausted: true,
      newCursor: {
        resourceRef: options.thread,
        position: options.position,
        processedCount: 1,
      },
    }),
  };
}

function makePiRequest(thread: string, operationId: string): ExternalSessionLogBackfillRequest {
  return {
    operationId,
    triggeredBy: 'operator:test',
    provider: 'pi',
    sourceId: 'external-pi',
    range: {
      startPosition: 0,
      endPosition: 100,
      resourceRefs: [thread],
    },
    limits: {
      maxResources: 10,
      maxBytes: 2_000_000,
      maxElapsedMs: 60_000,
    },
  };
}

test('Pi fixture: excludes Runtime 启动层, admits durable episode/capsule/provenance, idempotent replay', async () => {
  const thread = '019f50c8-e84d-7745-baea-d94b4b740751';
  const markdown = piTimelineMarkdown({
    thread,
    entries: [
      { role: 'Runtime 启动层', content: 'boot only — not learning evidence' },
      { role: 'User', content: 'Ship the weekly report.' },
      { role: 'User', content: 'Include the chart attachment.' },
      { role: 'Assistant', content: 'Report delivered with chart.' },
    ],
  });

  const parsed = parseRenderedTimeline(markdown, 'pi', thread, { allowIncompleteTail: true });
  assert.equal(parsed.events.length, 1);
  assert.deepEqual(
    parsed.events[0]!.roles.map(role => role.role),
    ['User', 'User', 'Assistant'],
  );
  assert.ok(!parsed.events[0]!.roles.some(role => role.content.includes('boot only')));

  const unit = makePiUnit({
    thread,
    userText: 'Ship the weekly report.\n\nInclude the chart attachment.',
    assistantText: 'Report delivered with chart.',
    startOrdinal: 2,
    endOrdinal: 4,
  });
  // Runtime metadata must not appear in the admitted unit.
  assert.ok(!JSON.stringify(unit).includes('boot only'));
  assert.ok(!JSON.stringify(unit).includes('Runtime 启动层'));

  const fixture = createPiRuntimeFixture();
  try {
    const eventId = `agents://pi/${thread}#2-4`;
    const source = createPiBackfillSource({
      thread,
      unit,
      contentHash: parsed.events[0]!.contentHash,
      eventId,
      position: 4,
    });
    const request = makePiRequest(thread, 'backfill-pi-e2e');

    const first = await fixture.runtime.runExternalBackfill(request, source);
    assert.equal(first.backfill.status, 'completed');
    assert.equal(first.backfill.admittedEpisodes, 1);
    assert.equal(first.backfill.state.metrics.admittedEpisodes, 1);
    assert.equal(first.backfill.state.metrics.failedResources, 0);
    assert.equal(first.backfill.state.resourceStates[thread]?.status, 'processed');

    const episodes = fixture.episodeStore.load().episodes;
    const episodeIds = Object.keys(episodes);
    assert.equal(episodeIds.length, 1, 'one durable LearningEpisode must exist');
    const episode = episodes[episodeIds[0]!]!;
    // settlementWindowMs=0 settles immediately; either settling or eligible proves admission.
    assert.ok(
      episode.status === 'settling' || episode.status === 'eligible',
      `unexpected episode status: ${episode.status}`,
    );
    assert.ok(
      episode.completionEvidence.some(item => item.kind === 'assistant-response'),
      'external final must carry assistant-response evidence',
    );
    assert.ok(
      !JSON.stringify(episode).includes('boot only'),
      'Runtime metadata must not enter the durable episode',
    );

    const capsule = fixture.runtime.getEvidenceCapsuleStore().findByEpisodeId(episode.episodeId);
    assert.ok(capsule, 'Evidence Capsule must exist for the admitted episode');
    assert.equal(capsule!.provenance.provider, 'pi');
    assert.equal(capsule!.provenance.category, 'external');
    assert.equal(capsule!.provenance.sourceId, 'external-pi');
    assert.equal(capsule!.identity.eventId, eventId);

    const provenancePath = path.join(fixture.root, 'data', 'external-source-provenance.json');
    assert.equal(fs.existsSync(provenancePath), true, 'external provenance file must be durable');
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
      episodeToEvent?: Record<string, string>;
      eventToEpisodes?: Record<string, string[]>;
    };
    const eventKeys = Object.values(provenance.episodeToEvent ?? {});
    assert.ok(eventKeys.some(key => key.includes('external-pi') || key.includes(eventId) || key.includes('pi')),
      'provenance must link episode to external-pi event');
    assert.ok(
      Object.keys(provenance.episodeToEvent ?? {}).includes(episode.episodeId)
      || Object.values(provenance.eventToEpisodes ?? {}).some(ids => ids.includes(episode.episodeId)),
      'provenance must reference the admitted episode id',
    );

    const second = await fixture.runtime.runExternalBackfill(request, source);
    assert.equal(second.backfill.status, 'completed');
    // Aggregate admittedEpisodes is cumulative across the durable operation.
    assert.equal(second.backfill.state.metrics.admittedEpisodes, 1);
    assert.ok(
      second.backfill.admittedEpisodes === 0 || second.backfill.state.metrics.duplicateEventsSkipped >= 1
        || second.backfill.ingestedEvents === 0,
      'replay must not create a second durable episode',
    );
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 1);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 1);

    const state = loadExternalSessionLogBackfillState(first.paths.stateFilePath)!;
    assert.equal(state.metrics.pendingResources, 0);
    assert.equal(state.metrics.failedResourceAttempts, 0);
  } finally {
    fixture.restore();
  }
});

test('ordinary Pi final between 8KiB and 16KiB admits through capsule path', async () => {
  assert.equal(MAX_EXTERNAL_TURN_TEXT_BYTES, MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES);

  const ordinaryBytes = 12 * 1024;
  assert.ok(ordinaryBytes > 8 * 1024);
  assert.ok(ordinaryBytes < MAX_EXTERNAL_TURN_TEXT_BYTES);

  const thread = 'pi-ordinary-12kib';
  const assistantText = 'A'.repeat(ordinaryBytes);
  const unit = makePiUnit({
    thread,
    userText: 'Summarize the long weekly notes.',
    assistantText,
    startOrdinal: 1,
    endOrdinal: 2,
  });

  // Sanitizer and unit bounds accept the ordinary final.
  const sanitized = sanitizeExternalDistillationUnit(unit, { sourceId: 'external-pi' });
  assert.equal(Buffer.byteLength(String((sanitized.newTurns[0] as any).assistant.text), 'utf8'), ordinaryBytes);

  const fixture = createPiRuntimeFixture();
  try {
    const eventId = `agents://pi/${thread}#1-2`;
    const source = createPiBackfillSource({
      thread,
      unit,
      contentHash: crypto.createHash('sha256').update(assistantText).digest('hex'),
      eventId,
      position: 2,
    });
    const request = makePiRequest(thread, 'backfill-pi-12kib');
    const result = await fixture.runtime.runExternalBackfill(request, source);
    assert.equal(result.backfill.status, 'completed');
    assert.equal(result.backfill.admittedEpisodes, 1);

    const episodeId = Object.keys(fixture.episodeStore.load().episodes)[0];
    assert.ok(episodeId);
    const capsule = fixture.runtime.getEvidenceCapsuleStore().findByEpisodeId(episodeId!);
    assert.ok(capsule, '12KiB final must form a durable capsule');
    assert.equal(capsule!.provenance.provider, 'pi');
    assert.equal(capsule!.provenance.category, 'external');
  } finally {
    fixture.restore();
  }
});

test('oversize external assistant text remains fail-closed (no silent truncation)', () => {
  const oversized = 'A'.repeat(MAX_EXTERNAL_TURN_TEXT_BYTES + 1);
  const unit: DistillationUnit = {
    filePath: 'xurl://pi/oversized',
    newTurns: [makePiTurn({
      turn: 1,
      sessionId: 'external:pi:oversized:oversized',
      userText: 'hello',
      assistantText: oversized,
    })],
    continuityTurns: [],
    byteRange: { start: 1, end: 2 },
    generatedAt: '2026-07-17T03:00:00.000Z',
  };

  assert.throws(
    () => sanitizeExternalDistillationUnit(unit, { sourceId: 'external-pi' }),
    /external assistant text exceeds the \d+-byte external evidence limit/i,
  );
});

test('missing active generated skill is detected; history-only recovery is safe', async () => {
  const root = makeRoot();
  const previousDataRoot = process.env.XIAOBA_USER_DATA_DIR;
  const previousSkillsDir = process.env.XIAOBA_SKILLS_DIR;
  const previousRegistryPath = process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE;
  process.env.XIAOBA_USER_DATA_DIR = root;
  process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
  process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE = path.join(root, 'data', 'current-skill-registry.json');
  try {
    const handle = 'cap_379a435b30cc48f4bb9f0e8165cd3bd6';
    const skillPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const content = [
      '---',
      'name: settled-artifact-delivery',
      'description: Deliver and verify a ready artifact.',
      '---',
      '',
      'Use exact-file selection and delivery.',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, content, 'utf8');
    const guidanceHash = crypto.createHash('sha256').update(content).digest('hex');
    const historyPath = path.join(path.dirname(skillPath), 'history', guidanceHash, 'SKILL.md');
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.copyFileSync(skillPath, historyPath);

    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 19,
      routingName: 'settled-artifact-delivery',
      description: 'Deliver and verify a ready artifact.',
      skillFilePath: skillPath,
      guidanceHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    // Detect missing artifact.
    fs.rmSync(skillPath);
    const loadedMissing = loadCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!);
    // With history present, reconcile restores.
    const restored = reconcileActiveGeneratedSkillArtifacts(loadedMissing);
    assert.equal(restored.repaired, true);
    assert.equal(fs.existsSync(skillPath), true);

    // Without history, fail closed.
    fs.rmSync(skillPath);
    fs.rmSync(historyPath);
    assert.throws(
      () => reconcileActiveGeneratedSkillArtifacts(loadedMissing),
      /Active generated skill invariant violated|SKILL\.md is missing/i,
    );

    // SkillManager restores from authoritative history rather than inventing guidance.
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, content, 'utf8');
    fs.rmSync(skillPath, { force: true });
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);
    const manager = new SkillManager();
    await manager.loadSkills();
    assert.equal(
      manager.getAllSkills().map(skill => skill.metadata.name).includes('settled-artifact-delivery'),
      true,
    );
    assert.equal(fs.existsSync(skillPath), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousDataRoot;
    if (previousSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = previousSkillsDir;
    if (previousRegistryPath === undefined) delete process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE;
    else process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE = previousRegistryPath;
  }
});
