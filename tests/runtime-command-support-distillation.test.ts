import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';

import {
  startRuntimeCommandSupport,
  stopRuntimeCommandSupport,
} from '../src/utils/runtime-command-support';
import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { DistillationPipeline, loadReviewOutcomesSync } from '../src/utils/distillation-pipeline';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { SkillParser } from '../src/skills/skill-parser';

// ---------------------------------------------------------------------------
// Runtime startup wiring of the full DistillationPipeline (issue #13).
//
// These tests prove `startRuntimeCommandSupport()` constructs a
// `DistillationPipeline`, injects `pipeline.processUnit()` as the heartbeat
// scheduler processor (rather than the scheduler's default no-op), writes
// review outcomes to a durable runtime data state file, installs promoted
// distilled skills under the current runtime skills root in
// `generated-distilled/`, and preserves the existing heartbeat runtime guards
// (enable/disable config, inspector-cat guard, six-hour default cadence).
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
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
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

// A solved loop the deterministic distiller + reviewer will promote: a
// substantive user problem, a substantive assistant action (no tool calls), and
// a verification turn with positive acceptance and no correction markers.
const PROBLEM_TURN = makeTurn(
  1,
  'cli',
  'How do I parse a JSONL file line by line in Node without loading it all into memory?',
  'Use readline.createInterface to stream the file line by line instead of reading it all into memory at once.',
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
  generatedDistilledRoot: string;
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
  const generatedDistilledRoot = path.join(skillsRoot, 'generated-distilled');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE:
      process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE,
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
  // Keep the runtime skills root hermetic: generated-distilled lands under
  // <root>/skills/generated-distilled, i.e. the current runtime skills root.
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
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
    generatedDistilledRoot,
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
    const support = await startRuntimeCommandSupport(env.root);

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
    assert.equal(
      config.reviewOutcomesPath,
      env.reviewOutcomesFile,
      'review outcomes resolve to the runtime data state file',
    );

    // Behavioral proof that the scheduler processor is the real pipeline, not
    // the default no-op: a session log append produces a durable review outcome
    // (the default no-op processor never writes review outcomes).
    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);

    const result = await support.distillationHeartbeatScheduler!.runHeartbeat('manual');
    assert.equal(result.ran, true);
    assert.equal(result.unitsProcessed, 1, 'the wired processor extracted one unit');
    assert.equal(result.advancedFiles, 1);

    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesFile);
    assert.ok(outcomes.length > 0, 'the pipeline wrote durable review outcomes');
    assert.ok(
      outcomes.some(o => o.decision === 'promote'),
      'at least one promoted outcome was recorded durably',
    );
  });

  // AC: Generated distilled skills are installed under the current runtime
  // skills root in `generated-distilled/`.
  test('generated distilled skills install under <skillsRoot>/generated-distilled/', async () => {
    const support = await startRuntimeCommandSupport(env.root);

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
    const support = await startRuntimeCommandSupport(env.root);

    writeLog(env.logFile, [PROBLEM_TURN, VERIFICATION_TURN]);
    await support.distillationHeartbeatScheduler!.runHeartbeat('manual');

    assert.ok(
      fs.existsSync(env.reviewOutcomesFile),
      'durable review-outcomes data state file exists',
    );
    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesFile);
    assert.ok(outcomes.length > 0, 'review outcomes were appended durably');
    for (const o of outcomes) {
      assert.ok(o.sourceUnit.filePath, 'outcome carries source unit traceability');
      assert.ok(o.sourceUnit.byteRange, 'outcome carries source byte range');
    }
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
    assert.equal(
      support.distillationPipeline,
      null,
      'no distillation pipeline is constructed for inspector-cat runtimes',
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
    assert.equal(
      support.distillationPipeline,
      null,
      'no distillation pipeline is constructed when the heartbeat is disabled',
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
  // produce a parseable generated SKILL.md through the real startup wiring.
  test('end-to-end: a session log append through real startup wiring produces a parseable generated SKILL.md', async () => {
    // Startup wiring: constructs the pipeline + scheduler. The startup
    // heartbeat fires on an empty logs root (no-op).
    const support = await startRuntimeCommandSupport(env.root);
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

    // The generated SKILL.md is parseable and carries distilled identity.
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const parsed = matter(raw);
    assert.equal(parsed.data.distilled, true);
    assert.equal(parsed.data.kind, 'capability');
    assert.ok(parsed.data.capability_id, 'frontmatter has capability_id');
    assert.ok(parsed.data.snapshot_id, 'frontmatter has snapshot_id');
    assert.ok(parsed.data.name, 'frontmatter has name for skill discovery');
    assert.ok(parsed.data.description, 'frontmatter has description for skill discovery');

    // Traceability Contract and Provenance Refs are present.
    assert.ok(/## Traceability Contract/.test(raw), 'body has Traceability Contract heading');
    assert.ok(/## Provenance Refs/.test(raw), 'body has Provenance Refs heading');
    assert.ok(/problem-action/.test(raw), 'provenance refs include problem-action role');
    assert.ok(/verification/.test(raw), 'provenance refs include verification role');

    // Skill discovery compatibility: parses via SkillParser.
    const skill = SkillParser.parse(skillPath);
    assert.ok(skill.metadata.name, 'parsed skill has a name');
    assert.ok(skill.metadata.description, 'parsed skill has a description');
    assert.equal(typeof skill.content, 'string', 'parsed skill has content');

    // Review outcomes were durably written for every decision.
    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesFile);
    assert.ok(outcomes.length > 0, 'durable review outcomes were written');
    assert.ok(
      outcomes.some(o => o.decision === 'promote' && o.skillFilePath === skillPath),
      'the promoted outcome points at the installed skill file',
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