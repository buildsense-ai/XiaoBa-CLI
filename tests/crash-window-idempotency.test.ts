/**
 * Crash-window integration test — real restart/replay boundary.
 *
 * Phase 1: A real ExternalSessionLogSourceAdapter (continuous lane) has its
 * acknowledge() throw after durable Episode → Capsule → provenance writes.
 * Assert acknowledged=false and cursor state has not advanced.
 *
 * Phase 2: A fresh RuntimeLearning + fresh adapter replay the same page
 * through the production commit path. Assert cursor ACK succeeds and no
 * duplicate Episode, Capsule, or provenance state. Provenance is inspected
 * via a separately constructed ExternalEpisodeProvenanceStore at the known
 * production path — no test-only getter on RuntimeLearning.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { ExternalEpisodeProvenanceStore } from '../src/utils/external-episode-provenance-store';
import {
  ExternalSessionLogSourceAdapter,
  loadExternalCursorState,
} from '../src/utils/session-log-source';
import type {
  ExternalEvidencePage,
} from '../src/utils/external-admission-coordinator';
import type {
  SessionLogSourceIdentity,
  SourceEventIdentity,
  SessionLogSourceResource,
  SessionLogSourceReadResult,
} from '../src/utils/session-log-source';
import type { DistillationUnit } from '../src/utils/distillation-unit';
import type { SessionTurnLogEntry } from '../src/utils/session-log-schema';

/** Real adapter with controllable ACK failure to simulate the crash window. */
class CrashSimAdapter extends ExternalSessionLogSourceAdapter {
  shouldFailAck = false;
  acknowledgeCalls = 0;
  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    if (this.shouldFailAck) throw new Error('simulated crash: cursor ACK failed');
    this.acknowledgeCalls += 1;
    super.acknowledge(resource, result);
  }
}

const SOURCE_IDENTITY: SessionLogSourceIdentity = {
  sourceId: 'codex-thread-1', label: 'Codex Thread 1',
  category: 'external' as const, provider: 'codex', reader: 'xurl' as const,
};
const EVENT_IDENTITY: SourceEventIdentity = {
  eventId: 'evt-001', position: 0, contentHash: 'hash-crash-window-001',
};
const RESOURCE: SessionLogSourceResource = { resourceRef: 'r1', firstEventIdentity: EVENT_IDENTITY };

function makeUnit(turn: number): DistillationUnit {
  const entry: SessionTurnLogEntry = {
    entry_type: 'turn', turn, timestamp: '2026-01-01T00:00:00.000Z',
    session_id: 'session-crash-window-1', session_type: 'chat',
    user: { text: 'Please deliver the report.' },
    assistant: { text: 'The report was delivered and validated.', tool_calls: [
      { id: `t-${turn}`, name: 'send_file',
        arguments: { target: 'report.pdf' }, result: 'ok', duration_ms: 100 },
      { id: `v-${turn}`, name: 'validate_report',
        arguments: { target: 'report.pdf' }, result: 'passed', duration_ms: 50 },
    ] },
    tokens: { prompt: 10, completion: 20 },
  };
  return {
    filePath: 'external://event/codex/codex-thread-1/evt-001.jsonl',
    newTurns: [entry as never], continuityTurns: [],
    byteRange: { start: 0, end: 500 }, generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePage(
  unit: DistillationUnit,
  eventIdentity: SourceEventIdentity = EVENT_IDENTITY,
): ExternalEvidencePage {
  return {
    providerId: 'codex', sourceId: 'codex-thread-1',
    identity: SOURCE_IDENTITY,
    resource: { ...RESOURCE, firstEventIdentity: eventIdentity },
    distillationUnits: [unit], eventIdentities: [eventIdentity],
    readResult: {
      distillationUnit: unit, distillationUnits: [unit], advanced: true,
      status: 'advanced' as const,
      newCursor: { resourceRef: 'r1', position: 1, processedCount: 1 },
      eventIdentities: [eventIdentity],
      accounting: { events: 1, bytes: 500, elapsedMs: 0 },
    } as SessionLogSourceReadResult,
    lane: 'continuous' as const,
  };
}

function makeAdapter(root: string): CrashSimAdapter {
  return new CrashSimAdapter({
    sourceId: 'codex-thread-1', provider: 'codex', enabled: true,
    cursorStorePath: path.join(root, 'data', 'external-session-log', 'codex', 'codex-thread-1', 'state.json'),
  });
}

function createRuntime(root: string, adapter: CrashSimAdapter): RuntimeLearning {
  const ep = path.join(root, 'data', 'learning-episodes.json');
  const rq = path.join(root, 'data', 'review-queue.json');
  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root, outputDir: path.join(root, 'skills', 'generated'),
    registryPath: path.join(root, 'data', 'current-skill-registry.json'),
    auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(root, 'data', 'transition-journal.json'),
    reviewQueuePath: rq, settlementWindowMs: 0,
    operationalRetryMs: 1, operationalRetryMaxMs: 60_000, logEnabled: false,
  });
  const episodeStore = new LearningEpisodeStore(ep);
  const curator = new SkillUsageCurator({
    ledger: new SkillUsageLedger(path.join(root, 'data', 'skill-usage-ledger.jsonl')),
    statePath: path.join(root, 'data', 'curator-state.json'),
    intervalMs: 86_400_000, runtime: skillEvolution,
  });
  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: ep, reviewQueuePath: rq,
    curatorStatePath: path.join(root, 'data', 'curator-state.json'),
    curatorIntervalMs: 86_400_000,
    semanticReassessmentManifestPath: path.join(root, 'data', 'reassessment-manifest.json'),
  });
  return new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 }),
    learningEpisodeStore: episodeStore, skillEvolution, curator, planner,
    sessionLogSources: [adapter],
  });
}

describe('crash-window idempotency (real restart/replay)', () => {
  test('crash after durable writes but before cursor ACK — replay produces no duplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-crash-'));
    try {
      const page = makePage(makeUnit(4));

      // Phase 1: first admission — ACK fails (crash window).
      const adapter1 = makeAdapter(root);
      adapter1.shouldFailAck = true;
      const runtime1 = createRuntime(root, adapter1);
      const result1 = runtime1.getExternalAdmissionCoordinator().admitPages([page], ['codex']);
      assert.equal(result1.length, 1);
      assert.equal(result1[0]!.acknowledged, false, 'ACK must fail (crash window)');
      assert.ok(result1[0]!.admittedEpisodes > 0, 'episodes admitted before crash');

      // Durable writes survived.
      const episodes1 = Object.values(runtime1.getEpisodeStore().load().episodes);
      assert.ok(episodes1.length > 0, 'episode durably persisted');
      const episodeId = episodes1[0]!.episodeId;
      const bundleId = `v3:learning-episode:${episodeId}`;
      const capsule1 = runtime1.getEvidenceCapsuleStore().findByBundleId(bundleId);
      assert.ok(capsule1, 'capsule durably persisted before ACK');
      assert.match(capsule1!.completionEvidence[0]!.content, /Please deliver the report/);
      assert.match(capsule1!.completionEvidence[0]!.content, /delivered and validated/);
      assert.ok(capsule1!.completionEvidence.some(entry => entry.role === 'verification'));
      assert.deepEqual(capsule1!.completionEvidence[0]!.byteRange, { start: 0, end: 500 });

      // Cursor not advanced.
      assert.equal(loadExternalCursorState(adapter1.getCursorStorePath()!).cursors['r1'], undefined,
        'cursor must not advance when ACK fails');

      const epCount = episodes1.length;
      const capCount = Object.keys(runtime1.getEvidenceCapsuleStore().load().capsules).length;

      // Phase 2: restart — fresh RuntimeLearning + fresh adapter, same dir.
      const adapter2 = makeAdapter(root);
      const runtime2 = createRuntime(root, adapter2);
      const result2 = runtime2.getExternalAdmissionCoordinator().admitPages([page], ['codex']);
      assert.equal(result2.length, 1);
      assert.equal(result2[0]!.acknowledged, true, 'ACK succeeds after restart');
      assert.equal(result2[0]!.admittedEpisodes, 0, 'replay idempotent — no new episodes');

      // No duplicate episodes or capsules.
      assert.equal(Object.keys(runtime2.getEpisodeStore().load().episodes).length, epCount,
        'no duplicate episodes');
      const capsule2 = runtime2.getEvidenceCapsuleStore().findByBundleId(bundleId);
      assert.ok(capsule2, 'capsule still exists');
      assert.equal(capsule2!.capsuleId, capsule1!.capsuleId, 'same capsule');
      assert.equal(Object.keys(runtime2.getEvidenceCapsuleStore().load().capsules).length, capCount,
        'no duplicate capsules');

      // Cursor now advanced.
      assert.equal(loadExternalCursorState(adapter2.getCursorStorePath()!).cursors['r1']?.cursor.position, 1,
        'cursor advanced after ACK');

      // Provenance idempotent — inspected via separately constructed store.
      const provenance = new ExternalEpisodeProvenanceStore({
        stateFilePath: path.join(root, 'data', 'external-source-provenance.json'),
        corruptMarkerPath: path.join(root, 'data', 'external-source-provenance.json.state-corrupt'),
      });
      const ids = provenance.getEpisodeIdsForEvent(SOURCE_IDENTITY, EVENT_IDENTITY);
      assert.ok(ids.includes(episodeId), 'provenance maps event to original episode');
      assert.equal(new Set(ids).size, ids.length, 'no duplicate episode ids in provenance');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('immutable capsule conflict blocks production replay acknowledgement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-capsule-conflict-'));
    try {
      const adapter = makeAdapter(root);
      const runtime = createRuntime(root, adapter);
      const first = runtime.getExternalAdmissionCoordinator().admitPage(makePage(makeUnit(4)), ['codex']);
      assert.equal(first.acknowledged, true);
      assert.equal(adapter.acknowledgeCalls, 1);

      const conflictingIdentity: SourceEventIdentity = {
        ...EVENT_IDENTITY,
        contentHash: 'hash-crash-window-CONFLICT',
      };
      const replay = runtime.getExternalAdmissionCoordinator().admitPage(
        makePage(makeUnit(4), conflictingIdentity),
        ['codex'],
      );

      assert.equal(replay.acknowledged, false);
      assert.match(replay.error?.message ?? '', /immutable integrity conflict/);
      assert.equal(adapter.acknowledgeCalls, 1, 'conflicting replay must not reach provider ACK');
      assert.equal(
        runtime.getExternalSourceFailureState().get(SOURCE_IDENTITY.sourceId)?.failureClass,
        'integrity_conflict',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
