import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';

import {
  startRuntimeCommandSupport,
  stopRuntimeCommandSupport,
  RuntimeCommandSupportOptions,
} from '../src/utils/runtime-command-support';
import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { DistillationPipeline } from '../src/utils/distillation-pipeline';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { SkillParser } from '../src/skills/skill-parser';
import { loadCurrentSkillRegistry, loadTransitionAudit } from '../src/utils/skill-evolution';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';

// ---------------------------------------------------------------------------
// Runtime startup wiring of the full DistillationPipeline (issue #13).
//
// These tests prove `startRuntimeCommandSupport()` constructs the V3
// `DistillationPipeline` and `SkillEvolutionRuntime`, injects the async V3
// processor into the heartbeat scheduler, writes a durable Transition Audit,
// installs promoted Current Skills under `generated-distilled/`, and preserves
// the existing heartbeat runtime guards.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Synthetic session log helpers
// ---------------------------------------------------------------------------

function makeTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
  episodeId?: string,
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    ...(episodeId && { episode_id: episodeId }),
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function writeLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// An artifact-backed solved loop that V3 can admit as a Learning Episode: the
// delivery turn records deterministic write/validation tool results, followed by
// positive acceptance and no correction markers.
const PROBLEM_TURN = makeTurn(
  1,
  'cli',
  'Create a small Node script that parses a JSONL file line by line without loading it all into memory.',
  'Created a streaming JSONL parser with readline and verified its output.',
  [
    {
      id: 'write-parser',
      name: 'write_file',
      arguments: { path: 'jsonl-parser.js' },
      result: 'created the streaming parser file',
    },
    {
      id: 'validate-parser',
      name: 'validate_file',
      arguments: { path: 'jsonl-parser.js' },
      result: 'passed the JSONL parser smoke test',
    },
  ],
);
const VERIFICATION_TURN = makeTurn(
  2,
  'cli',
  'Thanks, that works perfectly!',
  'Great, glad it helped.',
);

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

interface TestEnv {
  root: string;
  skillsRoot: string;
  logFile: string;
  stateFile: string;
  recordFile: string;
  reviewOutcomesFile: string;
  workLogRoot: string;
  generatedDistilledRoot: string;
  runtimeSupportOptions: RuntimeCommandSupportOptions;
  branchFixtureCalls: { author: number; verifier: number };
  restore: () => void;
  teardown: () => void;
}

/**
 * Build a hermetic runtime root for `startRuntimeCommandSupport()`. The
 * working directory is the temp root (so the heartbeat config's contained
 * `logs/` and `data/` paths resolve under it), and `XIAOBA_SKILLS_DIR` points
 * at `<root>/skills` so the pipeline installs generated skills under
 * `<root>/skills/generated-distilled/`.
 */
function setupEnv(enableHeartbeat: boolean = true, role?: string): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-support-'));
  const skillsRoot = path.join(root, 'skills');
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-09', 'chat_cli.jsonl');
  const stateFile = path.join(root, 'data', 'distillation-cursor-state.json');
  const recordFile = path.join(root, 'data', 'distillation-heartbeat-record.json');
  const reviewOutcomesFile = path.join(root, 'data', 'distillation-review-outcomes.json');
  const workLogRoot = path.join(root, 'logs', 'branches', 'distillation');
  const generatedDistilledRoot = path.join(skillsRoot, 'generated-distilled');
  const branchFixtureCalls = { author: 0, verifier: 0 };

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE:
      process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE,
    DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE:
      process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE,
    DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE:
      process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE,
    DISTILLATION_HEARTBEAT_WORK_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_WORK_LOG_ROOT,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
    XIAOBA_SKILLS_DIR: process.env.XIAOBA_SKILLS_DIR,
    XIAOBA_USER_DATA_DIR: process.env.XIAOBA_USER_DATA_DIR,
    CATSCO_USER_DATA_DIR: process.env.CATSCO_USER_DATA_DIR,
    XIAOBA_ELECTRON_USER_DATA_DIR: process.env.XIAOBA_ELECTRON_USER_DATA_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    CATSCO_LOG_UPLOAD_ENABLED: process.env.CATSCO_LOG_UPLOAD_ENABLED,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = enableHeartbeat ? 'true' : 'false';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  // Keep the CatsCo log upload scheduler out of distillation wiring tests so
  // they stay hermetic (no network calls, no upload side effects).
  process.env.CATSCO_LOG_UPLOAD_ENABLED = 'false';
  delete process.env.DISTILLATION_HEARTBEAT_LOG_ROOT;
  delete process.env.DISTILLATION_HEARTBEAT_STATE_FILE;
  delete process.env.DISTILLATION_HEARTBEAT_RECORD_FILE;
  delete process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE;
  delete process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE;
  delete process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE;
  delete process.env.DISTILLATION_HEARTBEAT_WORK_LOG_ROOT;
  // Keep the runtime skills root hermetic: generated-distilled lands under
  // <root>/skills/generated-distilled, i.e. the current runtime skills root.
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  // BranchSession logs resolve from the runtime root, so keep V3 Author and
  // Verifier transcripts inside this hermetic fixture too.
  process.env.XIAOBA_RUNTIME_ROOT = root;
  delete process.env.XIAOBA_USER_DATA_DIR;
  delete process.env.CATSCO_USER_DATA_DIR;
  delete process.env.XIAOBA_ELECTRON_USER_DATA_DIR;
  delete process.env.XIAOBA_RUNTIME_ROOT;
  if (role) {
    process.env.XIAOBA_ROLE = role;
  } else {
    delete process.env.XIAOBA_ROLE;
  }

  return {
    root,
    skillsRoot,
    logFile,
    stateFile,
    recordFile,
    reviewOutcomesFile,
    workLogRoot,
    generatedDistilledRoot,
    runtimeSupportOptions: {
      skillEvolutionOptions: {
        authorFixture: ({ bundle }) => {
          branchFixtureCalls.author++;
          const current = bundle.relatedCurrentSkills[0];
          if (bundle.bundleId.startsWith('usage-curation:') && current) {
            return {
              body: 'Preserve the bounded generated guidance while reassessing its observed usage evidence.',
              envelope: {
                decision: 'replace_current_skill',
                targetCapabilityHandle: current.handle,
                routingName: current.routingName,
                description: current.description,
                referencedSkills: [],
                evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
              },
            };
          }
          return {
            body: 'Use readline.createInterface to stream JSONL input and validate the generated parser output.',
            envelope: {
              decision: 'create_current_skill',
              routingName: 'streaming-jsonl-parser',
              description: 'Stream JSONL input without loading the complete file into memory.',
              referencedSkills: [],
              evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            },
          };
        },
        verifierFixture: ({ draft }) => {
          branchFixtureCalls.verifier++;
          return {
            decision: 'accept',
            transition: draft.envelope.decision,
            issues: [],
            rationale: 'The bounded parser workflow is supported by the fixed artifact evidence.',
          };
        },
      },
    },
    branchFixtureCalls,
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

/** Flush the void startup heartbeat fired by `scheduler.start()`. */
function flushStartupHeartbeat(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startRuntimeCommandSupport() distillation wiring (issue #13)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv(true);
  });

  afterEach(async () => {
    await stopRuntimeCommandSupport();
    env.restore();
    env.teardown();
  });

  // AC: Runtime startup creates a DistillationPipeline and injects it as the
  // DistillationHeartbeatScheduler processor (rather than the scheduler default
  // no-op processor).
  test('startup creates a DistillationPipeline and injects it as the scheduler processor', async () => {
    const support = await startRuntimeCommandSupport(env.root, env.runtimeSupportOptions);

    // The pipeline is constructed and exposed for regression proof.
    assert.ok(
      support.distillationPipeline instanceof DistillationPipeline,
      'startup constructs a DistillationPipeline',
    );
    assert.ok(
      support.distillationHeartbeatScheduler instanceof DistillationHeartbeatScheduler,
      'startup constructs a DistillationHeartbeatScheduler',
    );

    // The pipeline's durable paths resolve under the current runtime skills
    // root (generated-distilled) and the runtime data state (review outcomes).
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.skillEvolutionEnabled, true, 'V3 remains enabled by default');
    assert.equal(
      config.reviewOutcomesPath,
      env.reviewOutcomesFile,
      'review outcomes resolve to the runtime data state file',
    );
    assert.equal(
      config.workLogRoot,
      env.workLogRoot,
      'distillation work logs resolve to branch-style runtime logs',
    );

    // Behavioral proof that the scheduler processor is the real pipeline, not
    // the default no-op: a session log append reaches the V3 Author/Verifier
    // seam and produces a durable Capability Transition.
    await flushStartupHeartbeat();
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);

    const result = await support.distillationHeartbeatScheduler!.runHeartbeat('manual');
    assert.equal(result.ran, true);
    assert.equal(result.unitsProcessed, 1, 'the wired processor extracted one unit');
    assert.equal(result.advancedFiles, 1);

    assert.equal(env.branchFixtureCalls.author, 1, 'the V3 Author fixture ran once');
    assert.equal(env.branchFixtureCalls.verifier, 1, 'the V3 Verifier fixture ran once');

    const registry = loadCurrentSkillRegistry(config.skillEvolutionRegistryPath);
    assert.equal(Object.keys(registry.capabilities).length, 1, 'one registry entry was created');
    const audit = loadTransitionAudit(config.skillEvolutionAuditPath);
    assert.equal(audit.length, 1, 'one durable V3 transition audit was written');
    assert.equal(audit[0]?.transition, 'create_current_skill');
    assert.ok(audit[0]?.branchTranscriptPaths.length === 2, 'Author and Verifier transcripts are linked');
  });

  // AC: Generated distilled skills are installed under the current runtime
  // skills root in `generated-distilled/`.
  test('generated distilled skills install under <skillsRoot>/generated-distilled/', async () => {
    const support = await startRuntimeCommandSupport(env.root, env.runtimeSupportOptions);

    await flushStartupHeartbeat();
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    assert.ok(
      fs.existsSync(env.generatedDistilledRoot),
      'generated-distilled directory was created under the runtime skills root',
    );

    // Locate the installed SKILL.md.
    const skillFiles = collectSkillFiles(env.generatedDistilledRoot);
    assert.equal(skillFiles.length, 1, 'exactly one promoted skill was installed');
    const skillPath = skillFiles[0];
    assert.ok(
      skillPath.startsWith(env.generatedDistilledRoot),
      'skill is installed under generated-distilled',
    );
    assert.ok(fs.existsSync(skillPath), 'SKILL.md exists on disk');
  });

  // AC: Review outcomes are written to a durable runtime data state file.
  test('review outcomes are written to the durable runtime data state file', async () => {
    const support = await startRuntimeCommandSupport(env.root, env.runtimeSupportOptions);

    await flushStartupHeartbeat();
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    const config = getDistillationHeartbeatConfig(env.root);
    assert.ok(fs.existsSync(config.skillEvolutionAuditPath), 'durable V3 audit state file exists');
    const audit = loadTransitionAudit(config.skillEvolutionAuditPath);
    assert.ok(audit.length > 0, 'Author/Verifier outcome was appended durably');
    assert.ok(audit.every(entry => entry.evidenceRefs.length > 0), 'audit carries evidence traceability');
  });

  // AC: Existing heartbeat runtime guards remain intact: inspector-cat guard.
  test('inspector-cat guard disables the distillation scheduler at startup', async () => {
    env.restore();
    env = setupEnv(true, 'inspector-cat');

    const support = await startRuntimeCommandSupport(env.root);
    assert.equal(
      support.distillationHeartbeatScheduler,
      null,
      'no distillation scheduler is constructed for inspector-cat runtimes',
    );
    assert.ok(
      support.distillationPipeline,
      'distillation pipeline is always constructed for API-based compatibility',
    );
  });

  // AC: Existing heartbeat runtime guards remain intact: enable/disable config.
  test('config master switch disables the distillation scheduler at startup', async () => {
    env.restore();
    env = setupEnv(false);

    const support = await startRuntimeCommandSupport(env.root);
    assert.equal(
      support.distillationHeartbeatScheduler,
      null,
      'no distillation scheduler is constructed when the heartbeat is disabled',
    );
    assert.ok(
      support.distillationPipeline,
      'distillation pipeline is always constructed for API-based compatibility',
    );
  });

  // AC: Existing heartbeat runtime guards remain intact: six-hour default
  // cadence. The startup wiring must not change the scheduler cadence.
  test('six-hour default cadence is preserved through the startup wiring', async () => {
    env.restore();
    env = setupEnv(true);
    delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;

    const support = await startRuntimeCommandSupport(env.root);
    assert.ok(support.distillationHeartbeatScheduler);

    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.intervalHours, 6, 'default cadence remains six hours');
  });

  // AC: An end-to-end runtime support test proves a session log append can
  // produce a parseable V3 Current Skill through the real startup wiring.
  test('end-to-end: a session log append through real startup wiring produces a parseable generated SKILL.md', async () => {
    // Startup wiring: constructs the pipeline + scheduler. The startup
    // heartbeat fires on an empty logs root (no-op).
    const support = await startRuntimeCommandSupport(env.root, env.runtimeSupportOptions);
    assert.ok(support.distillationPipeline instanceof DistillationPipeline);
    await flushStartupHeartbeat();

    // Append a solved loop to a session log.
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);

    // Drive one heartbeat cycle through the real startup-wired processor.
    const result = await support.distillationHeartbeatScheduler!.runHeartbeat('manual');
    assert.equal(result.ran, true);
    assert.equal(result.unitsProcessed, 1);
    assert.equal(result.advancedFiles, 1);

    // A generated SKILL.md exists under the runtime skills root.
    const skillFiles = collectSkillFiles(env.generatedDistilledRoot);
    assert.equal(skillFiles.length, 1, 'one generated SKILL.md was installed');
    const skillPath = skillFiles[0];

    // The generated V3 Current Skill is parseable and carries runtime identity.
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const parsed = matter(raw);
    assert.equal(parsed.data['user-invocable'], true);
    assert.ok(parsed.data['x-xiaoba-capability-handle'], 'frontmatter has the Capability Handle');
    assert.ok(parsed.data['x-xiaoba-transition-id'], 'frontmatter has the transition id');
    assert.ok(parsed.data['x-xiaoba-evidence-refs'], 'frontmatter has evidence refs');
    assert.ok(parsed.data.name, 'frontmatter has name for skill discovery');
    assert.ok(parsed.data.description, 'frontmatter has description for skill discovery');

    assert.match(raw, /readline\.createInterface/, 'Author guidance is present in the generated skill');
    assert.equal(env.branchFixtureCalls.author, 1, 'the E2E Author fixture ran once');
    assert.equal(env.branchFixtureCalls.verifier, 1, 'the E2E Verifier fixture ran once');

    // Skill discovery compatibility: parses via SkillParser.
    const skill = SkillParser.parse(skillPath);
    assert.ok(skill.metadata.name, 'parsed skill has a name');
    assert.ok(skill.metadata.description, 'parsed skill has a description');
    assert.equal(typeof skill.content, 'string', 'parsed skill has content');

    // V3 review outcomes are durably represented by the Transition Audit and
    // active Current Skill Registry.
    const config = getDistillationHeartbeatConfig(env.root);
    const audit = loadTransitionAudit(config.skillEvolutionAuditPath);
    assert.ok(audit.some(entry => entry.transition === 'create_current_skill'), 'audit records the create transition');

    const registry = loadCurrentSkillRegistry(config.skillEvolutionRegistryPath);
    assert.equal(Object.keys(registry.capabilities).length, 1, 'one registry entry was created');
    const entry = Object.values(registry.capabilities)[0];
    assert.equal(entry.skillFilePath, skillPath, 'registry points at the generated SKILL.md');
    assert.equal(
      entry.handle,
      parsed.data['x-xiaoba-capability-handle'],
      'registry Capability Handle matches installed skill',
    );

    // The Log Cursor advanced durably, so a repeated heartbeat with no new
    // appends does not install a duplicate skill.
    const r2 = await support.distillationHeartbeatScheduler!.runHeartbeat('scheduled');
    assert.equal(r2.unitsProcessed, 0);
    assert.equal(r2.advancedFiles, 0);
    assert.equal(
      collectSkillFiles(env.generatedDistilledRoot).length,
      1,
      'no duplicate skill on a no-append heartbeat',
    );
  });

  test('end-to-end: canonical episode usage settles or contradicts, then curator reviews only generated skill evidence', async () => {
    const support = await startRuntimeCommandSupport(env.root, env.runtimeSupportOptions);
    await flushStartupHeartbeat();
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    const config = getDistillationHeartbeatConfig(env.root);
    const generatedFile = collectSkillFiles(env.generatedDistilledRoot)[0]!;
    const generatedRecord = Object.values(
      loadCurrentSkillRegistry(config.skillEvolutionRegistryPath).capabilities,
    ).find(record => record.skillFilePath === generatedFile)!;
    const generatedIdentity = {
      capabilityHandle: generatedRecord.handle,
      routingName: generatedRecord.routingName,
      skillFilePath: generatedRecord.skillFilePath,
      guidanceHash: generatedRecord.guidanceHash,
    };
    const usageLedger = new SkillUsageLedger(config.skillUsageLedgerPath);
    const successEpisodeId = 'episode:generated-success';
    const contradictionEpisodeId = 'episode:generated-contradiction';
    const successLoad = usageLedger.recordGeneratedSkillLoad({
      runtimeSessionId: 'cli',
      episodeId: successEpisodeId,
      skill: generatedIdentity,
    });

    fs.appendFileSync(env.logFile, [
      makeTurn(3, 'cli', 'Deliver the parser artifact.', 'Delivered and validated the parser.', [
        { id: 'deliver-success', name: 'write_file', arguments: {}, result: 'created parser artifact' },
      ], successEpisodeId),
      makeTurn(4, 'cli', 'Thanks, this works.', 'Great.', [], successEpisodeId),
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    let facts = usageLedger.listFacts();
    const successOutcome = facts.find(fact =>
      fact.kind === 'episode-outcome' && fact.loadFactId === successLoad.factId,
    );
    assert.equal(successOutcome?.kind, 'episode-outcome');
    assert.equal(successOutcome?.outcome, 'verified-success');
    assert.ok(successOutcome?.evidenceRefs.some(ref => ref.includes('#turn-3:delivery:write_file')));
    const episodeState = JSON.parse(fs.readFileSync(config.learningEpisodeStorePath, 'utf8')) as {
      episodes: Record<string, { agentTurnEpisodeId?: string; status: string }>;
    };
    assert.ok(Object.values(episodeState.episodes).some(episode =>
      episode.agentTurnEpisodeId === successEpisodeId && episode.status === 'eligible',
    ));

    const authorBeforeContradiction = env.branchFixtureCalls.author;
    const verifierBeforeContradiction = env.branchFixtureCalls.verifier;
    const contradictionLoad = usageLedger.recordGeneratedSkillLoad({
      runtimeSessionId: 'cli',
      episodeId: contradictionEpisodeId,
      skill: generatedIdentity,
    });
    fs.appendFileSync(env.logFile, [
      makeTurn(5, 'cli', 'Deliver the parser artifact again.', 'Delivered the parser.', [
        { id: 'deliver-contradiction', name: 'write_file', arguments: {}, result: 'created parser artifact' },
      ], contradictionEpisodeId),
      makeTurn(6, 'cli', 'Redo it; the result is wrong.', 'I will correct it.', [], contradictionEpisodeId),
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    facts = usageLedger.listFacts();
    const contradictionOutcome = facts.find(fact =>
      fact.kind === 'episode-outcome' && fact.loadFactId === contradictionLoad.factId,
    );
    assert.equal(contradictionOutcome?.kind, 'episode-outcome');
    assert.equal(contradictionOutcome?.outcome, 'contradicted');
    assert.ok(contradictionOutcome?.evidenceRefs.some(ref => ref.includes('#turn-6:contradiction')));
    assert.ok(env.branchFixtureCalls.author > authorBeforeContradiction, 'the expedited Curator invokes the Author seam');
    assert.ok(env.branchFixtureCalls.verifier > verifierBeforeContradiction, 'the expedited Curator invokes the Verifier seam');
    assert.equal(fs.existsSync(generatedFile), true, 'Curator never directly deletes the Current Skill');
    const usageAuditCount = loadTransitionAudit(config.skillEvolutionAuditPath)
      .filter(entry => entry.bundleId.startsWith('usage-curation:')).length;
    const curatorStateBeforeManual = fs.readFileSync(config.skillEvolutionCuratorStatePath, 'utf8');

    const manualFile = path.join(env.skillsRoot, 'manual', 'SKILL.md');
    fs.mkdirSync(path.dirname(manualFile), { recursive: true });
    fs.writeFileSync(manualFile, '---\nname: manual\ndescription: Manual\n---\n\nManual guidance.\n', 'utf8');
    assert.throws(() => usageLedger.recordGeneratedSkillLoad({
      runtimeSessionId: 'cli',
      episodeId: 'episode:manual',
      skill: {
        capabilityHandle: 'manual',
        routingName: 'manual',
        skillFilePath: manualFile,
        guidanceHash: 'manual-hash',
      },
    }), /generated Current Skills only/);
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');
    facts = usageLedger.listFacts();
    assert.equal(facts.filter(fact => fact.kind === 'generated-skill-load').length, 2, 'manual skill loads never enter the ledger');
    assert.equal(facts.filter(fact => fact.kind === 'episode-outcome').length, 2, 'manual skill loads never receive outcomes');
    assert.equal(
      loadTransitionAudit(config.skillEvolutionAuditPath).filter(entry => entry.bundleId.startsWith('usage-curation:')).length,
      usageAuditCount,
      'manual skill usage never reaches Curator review',
    );
    assert.equal(fs.readFileSync(config.skillEvolutionCuratorStatePath, 'utf8'), curatorStateBeforeManual);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectSkillFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) results.push(skillFile);
      results.push(...collectSkillFiles(fullPath));
    }
  }
  return results;
}

function collectJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}
