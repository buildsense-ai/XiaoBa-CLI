import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getXurlVersion } from '../src/utils/xurl-compatibility';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { resolveExternalCursorStorePath } from '../src/utils/session-log-source';
import {
  materializeOfficialXurlSmokeFixtures,
  validateOfficialXurlSmokeFixtures,
} from './helpers/official-xurl-smoke-fixtures';

const ENABLED = /^(1|true|yes|on)$/i.test(process.env.XIAOBA_OFFICIAL_XURL_SMOKE ?? '');
const COMMAND = process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND?.trim() ?? '';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('official xurl smoke (opt-in)', () => {
  const prerequisiteFailure = resolveSmokeSkipReason();

  test('baseline, concurrent reads, serialized durable admission, and cleanup', {
    skip: prerequisiteFailure || false,
  }, async () => {
    validateOfficialXurlSmokeFixtures();

    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-official-xurl-smoke-'));
    tempRoots.push(runtimeRoot);
    const fixtureRoots = materializeOfficialXurlSmokeFixtures(runtimeRoot);
    const savedEnv = { ...process.env };
    const originalExecFile = childProcess.execFile;
    const activeChildren = new Set<childProcess.ChildProcess>();
    let maxActiveChildren = 0;

    (childProcess as typeof childProcess & {
      execFile: typeof childProcess.execFile;
    }).execFile = ((...args: Parameters<typeof childProcess.execFile>) => {
      const child = originalExecFile(...args);
      activeChildren.add(child);
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren.size);
      const cleanup = () => { activeChildren.delete(child); };
      child.once('error', cleanup);
      child.once('exit', cleanup);
      child.once('close', cleanup);
      return child;
    }) as typeof childProcess.execFile;

    try {
      const reviewQueuePath = path.join(runtimeRoot, 'data', 'review-queue.json');
      const registryPath = path.join(runtimeRoot, 'data', 'current-skill-registry.json');
      const auditPath = path.join(runtimeRoot, 'data', 'transition-audit.jsonl');
      const journalPath = path.join(runtimeRoot, 'data', 'transition-journal.json');
      const reassessmentManifestPath = path.join(runtimeRoot, 'data', 'reassessment-manifest.json');
      const curatorStatePath = path.join(runtimeRoot, 'data', 'curator-state.json');
      const ledgerPath = path.join(runtimeRoot, 'data', 'skill-usage-ledger.jsonl');
      const outputDir = defaultDistilledOutputDir(path.join(runtimeRoot, 'skills'));
      const episodeStorePath = path.join(runtimeRoot, 'data', 'learning-episodes.json');

      process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
      process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
      process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
      process.env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
      process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
      process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude,pi';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = COMMAND;
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '3';
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID;
      Object.assign(process.env, fixtureRoots.env);

      const skillEvolution = new SkillEvolutionRuntime({
        workingDirectory: runtimeRoot,
        outputDir,
        registryPath,
        auditPath,
        journalPath,
        reviewQueuePath,
        settlementWindowMs: 0,
        operationalRetryMs: 0,
        operationalRetryMaxMs: 60_000,
        logEnabled: false,
        authorFixture: ({ bundle }) => ({
          body: 'Promote an official-xurl smoke capability.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'official-xurl-smoke-delivery',
            description: 'Deliver work learned from official xurl smoke inputs.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            rationale: 'deterministic acceptance for official xurl smoke',
          },
        }),
        verifierFixture: () => ({
          decision: 'accept' as const,
          transition: 'create_current_skill' as const,
          issues: [],
          rationale: 'accepted',
          registryReadSet: [],
        }),
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
      const runtime = new RuntimeLearning({
        workingDirectory: runtimeRoot,
        evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 }),
        learningEpisodeStore: episodeStore,
        skillEvolution,
        curator,
        planner,
      });

      let activeReadCalls = 0;
      let maxConcurrentReadCalls = 0;
      for (const adapter of runtime.getSessionLogSources()) {
        if (adapter.identity.category !== 'external' || !adapter.readAsync) continue;
        const originalReadAsync = adapter.readAsync.bind(adapter);
        adapter.readAsync = async (...args) => {
          activeReadCalls++;
          maxConcurrentReadCalls = Math.max(maxConcurrentReadCalls, activeReadCalls);
          try {
            return await originalReadAsync(...args);
          } finally {
            activeReadCalls--;
          }
        };
      }

      const coordinator = runtime.getExternalAdmissionCoordinator();
      const originalAdmitPage = coordinator.admitPage.bind(coordinator);
      let activeAdmissions = 0;
      let maxConcurrentAdmissions = 0;
      const admittedProviders: string[] = [];
      coordinator.admitPage = ((page, knownProviders) => {
        activeAdmissions++;
        maxConcurrentAdmissions = Math.max(maxConcurrentAdmissions, activeAdmissions);
        admittedProviders.push(page.providerId);
        try {
          return originalAdmitPage(page, knownProviders);
        } finally {
          activeAdmissions--;
        }
      }) as typeof coordinator.admitPage;

      const baseline = await runtime.wake('startup');
      assert.equal(Object.keys(episodeStore.load().episodes).length, 0, 'baseline must not admit historical episodes');
      assert.equal(runtime.getEvidenceCapsuleStore().count(), 0, 'baseline must not persist historical capsules');
      assert.equal(baseline.discovery.sources.filter(source => source.category === 'external').length, 3);

      for (const provider of ['codex', 'claude', 'pi'] as const) {
        const state = JSON.parse(fs.readFileSync(resolveExternalCursorStorePath({
          provider,
          sourceId: `external-${provider}`,
        }), 'utf8')) as { processedEventIds?: Record<string, string> };
        assert.equal(Object.keys(state.processedEventIds ?? {}).length, 0, `baseline must not acknowledge historical events for ${provider}`);
      }

      fixtureRoots.appendStableCompletedTurn('codex');
      fixtureRoots.appendStableCompletedTurn('claude');
      fixtureRoots.appendStableCompletedTurn('pi');

      const afterAppend = await runtime.wake('scheduled');
      assert.ok(maxConcurrentReadCalls > 1 || maxActiveChildren > 1, 'external reads should overlap under concurrency > 1');
      assert.equal(maxConcurrentAdmissions, 1, 'durable admissions must remain serialized');
      assert.ok(new Set(admittedProviders).size >= 2, 'at least two providers should admit durable work');
      assert.ok(Object.keys(episodeStore.load().episodes).length >= 1, 'official smoke should create a Learning Episode');
      assert.ok(runtime.getEvidenceCapsuleStore().count() >= 1, 'official smoke should create an Evidence Capsule');
      assert.equal(afterAppend.discovery.sources.filter(source => source.category === 'external').length, 3);

      await runtime.drain(1_000);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(activeReadCalls, 0, 'no read seam should remain active after drain');
      assert.equal(activeAdmissions, 0, 'no admission should remain active after drain');
      assert.equal(activeChildren.size, 0, 'no xurl child handles should remain after drain');
    } finally {
      (childProcess as typeof childProcess & {
        execFile: typeof childProcess.execFile;
      }).execFile = originalExecFile;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

function resolveSmokeSkipReason(): string | null {
  if (!ENABLED) {
    return 'XIAOBA_OFFICIAL_XURL_SMOKE is disabled';
  }
  if (!COMMAND) {
    return 'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND is not set';
  }
  const diagnostic = getXurlVersion(COMMAND);
  if (diagnostic.source !== 'cli') {
    return `installed xurl command is unavailable: ${COMMAND}`;
  }
  try {
    validateOfficialXurlSmokeFixtures();
  } catch (error) {
    return `official xurl smoke fixtures are invalid: ${String(error)}`;
  }
  return null;
}
