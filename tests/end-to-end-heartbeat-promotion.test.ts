import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';

import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { loadHeartbeatRecord } from '../src/utils/distillation-heartbeat-scheduler';
import { loadLogCursorState, getCursor } from '../src/utils/log-cursor-state';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  DistilledKnowledgeCandidate,
  CapabilityProvenanceRef,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';
import {
  PromotionPacket,
  PromotionReviewResult,
  PromotionDecision,
} from '../src/utils/promotion-reviewer';
import {
  DistillationPipeline,
  DistillerFn,
  ReviewerFn,
  loadReviewOutcomesSync,
} from '../src/utils/distillation-pipeline';
import { loadNeedsReviewQueue } from '../src/utils/needs-review-queue';
import { SkillParser } from '../src/skills/skill-parser';

// ---------------------------------------------------------------------------
// End-to-end heartbeat promotion — first-version kind=capability pipeline.
//
// This test exercises the runtime-visible behavior and durable state
// transitions of the first-version Heartbeat Log Distillation Agent. It is
// intentionally NOT the future multi-kind memory system: only kind=capability
// is exercised here. Model-facing distiller and reviewer behavior is
// controlled via fixtures so the test asserts state transitions, not prompt
// internals.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Synthetic session log helpers
// ---------------------------------------------------------------------------

function makeTurn(
  turn: number,
  session_id: string,
  userText: string,
  assistantText: string,
  tool_calls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function writeLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Controlled fixtures for model-facing distiller and reviewer behavior
// ---------------------------------------------------------------------------

/**
 * Build a valid capability candidate fixture from a Distillation Unit. This
 * simulates model-facing distiller behavior without invoking the deterministic
 * heuristic distiller, so the test controls exactly what candidates are emitted.
 */
function fixtureCandidate(
  unit: DistillationUnit,
  capabilityId: string,
  evidence: SolvedLoopEvidence,
): DistilledKnowledgeCandidate {
  const provenance: CapabilityProvenanceRef[] = [
    {
      filePath: unit.filePath,
      turn: unit.newTurns[0]?.turn ?? 1,
      role: 'problem-action',
      unitByteRange: unit.byteRange,
    },
    {
      filePath: unit.filePath,
      turn: unit.newTurns[1]?.turn ?? 2,
      role: 'verification',
      unitByteRange: unit.byteRange,
    },
  ];
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: `Capability: ${evidence.problem.slice(0, 60)}`,
    applicability: `Applies when the user raises a similar problem to: ${evidence.problem.slice(0, 100)}`,
    actionPattern: `Respond with: ${evidence.action.slice(0, 120)}`,
    boundaries: [
      'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
    ],
    risks: ['Distilled from a single solved loop; the pattern may not generalize.'],
    solvedLoop: evidence,
    provenance,
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: unit.filePath,
      byteRange: unit.byteRange,
      generatedAt: unit.generatedAt,
    },
  };
}

const PROMOTE_EVIDENCE: SolvedLoopEvidence = {
  problem: 'How do I parse a JSONL file line by line in Node without loading it all into memory?',
  action: 'Used tools [read_file] and said: Use readline to stream the file line by line.',
  verification: 'Thanks, that works perfectly!',
  noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
};

const REJECT_EVIDENCE: SolvedLoopEvidence = {
  problem: 'Help me debug a flaky CI test',
  action: 'Suggested adding a retry wrapper around the assertion.',
  verification: 'Thanks',
  noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
};

const NEEDS_REVIEW_EVIDENCE: SolvedLoopEvidence = {
  problem: 'How do I optimize a slow SQL query joining two large tables?',
  action: 'Suggested adding a composite index on the join columns.',
  verification: 'Great, that helped a lot.',
  noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
};

/**
 * Controlled distiller fixture: emits three candidates with distinct capability
 * IDs so the reviewer fixture can route each to a different decision path.
 */
function makeFixtureDistiller(): DistillerFn {
  return (unit: DistillationUnit): DistilledKnowledgeCandidate[] => {
    if (unit.newTurns.length === 0) return [];
    const firstNewTurn = unit.newTurns[0]?.turn ?? 0;
    const sourceSuffix = `${unit.byteRange.start}-${unit.byteRange.end}-t${firstNewTurn}`;
    return [
      fixtureCandidate(unit, `cap-promote-${sourceSuffix}`, PROMOTE_EVIDENCE),
      fixtureCandidate(unit, `cap-reject-${sourceSuffix}`, REJECT_EVIDENCE),
      fixtureCandidate(unit, `cap-needsreview-${sourceSuffix}`, NEEDS_REVIEW_EVIDENCE),
    ];
  };
}

/**
 * Controlled reviewer fixture: routes by capabilityId prefix to promote,
 * reject, or needs_review. This simulates model-facing reviewer behavior so the
 * test can exercise all three durable-state paths deterministically.
 */
function makeFixtureReviewer(): ReviewerFn {
  return (packet: PromotionPacket): PromotionReviewResult => {
    const id = packet.candidate.capabilityId;
    let decision: PromotionDecision;
    if (id.startsWith('cap-promote')) decision = 'promote';
    else if (id.startsWith('cap-reject')) decision = 'reject';
    else decision = 'needs_review';

    return {
      schemaVersion: 1,
      capabilityId: id,
      decision,
      rationale: `Fixture reviewer decision: ${decision}`,
      reviewRisks: [],
      rewrite: null,
      questions: decision === 'needs_review'
        ? ['What additional evidence would make this candidate safe to retry?']
        : undefined,
      reviewedAt: '2026-07-10T01:00:00.000Z',
    };
  };
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

interface TestEnv {
  root: string;
  logFile: string;
  stateFile: string;
  recordFile: string;
  reviewOutcomesFile: string;
  needsReviewQueueFile: string;
  pipeline: DistillationPipeline;
  scheduler: DistillationHeartbeatScheduler;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-e2e-heartbeat-'));
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-09', 'chat_cli.jsonl');
  const stateFile = path.join(root, 'data', 'distillation-cursor-state.json');
  const recordFile = path.join(root, 'data', 'distillation-heartbeat-record.json');
  const reviewOutcomesFile = path.join(root, 'data', 'distillation-review-outcomes.json');
  const needsReviewQueueFile = path.join(root, 'data', 'needs-review-queue-state.json');
  const outputDir = path.join(root, 'skills', 'generated-distilled');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = stateFile;
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordFile;
  delete process.env.XIAOBA_ROLE;

  const pipeline = new DistillationPipeline({
    distiller: makeFixtureDistiller(),
    reviewer: makeFixtureReviewer(),
    outputDir,
    reviewOutcomesPath: reviewOutcomesFile,
    needsReviewQueuePath: needsReviewQueueFile,
  });

  const scheduler = new DistillationHeartbeatScheduler(root, unit => pipeline.processUnit(unit));

  return {
    root,
    logFile,
    stateFile,
    recordFile,
    reviewOutcomesFile,
    needsReviewQueueFile,
    pipeline,
    scheduler,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('End-to-end heartbeat promotion (first-version kind=capability pipeline)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.restore();
    env.teardown();
  });

  // AC: A controlled runtime data root can run one complete heartbeat cycle
  // from session log append to generated distilled skill.
  test('one complete heartbeat cycle: log append → distillation unit → candidate → review → installed SKILL.md', async () => {
    // Seed a session log with a solved loop (problem + acceptance).
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check the docs.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Great, glad it helped.'),
    ]);

    const result = await env.scheduler.runHeartbeat('manual');

    // Heartbeat ran and produced one Distillation Unit from the appended turns.
    assert.equal(result.ran, true);
    assert.equal(result.unitsProcessed, 1);
    assert.equal(result.advancedFiles, 1);

    // The pipeline distilled candidates and installed the promoted one.
    const outcomes = env.pipeline.getReviewOutcomes();
    assert.equal(outcomes.length, 3, 'three candidates distilled (promote, reject, needs_review)');

    const promoted = outcomes.find(o => o.decision === 'promote');
    assert.ok(promoted, 'a promoted outcome exists');
    assert.ok(promoted!.skillFilePath, 'promoted outcome has a skill file path');

    // The SKILL.md was written to disk.
    assert.ok(fs.existsSync(promoted!.skillFilePath!), 'SKILL.md was written');

    // Heartbeat record reflects the run.
    const record = loadHeartbeatRecord(env.recordFile);
    assert.equal(record.runCount, 1);
    assert.equal(record.lastUnitsProcessed, 1);
  });

  // AC: The test verifies Log Cursor movement and no duplicate installation on
  // repeated heartbeat without new appended turns.
  test('Log Cursor advances and repeated heartbeat with no new turns installs no duplicate', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    await env.scheduler.runHeartbeat('manual');

    const cursorAfterFirst = getCursor(loadLogCursorState(env.stateFile), env.logFile);
    assert.equal(cursorAfterFirst.byteOffset, fs.statSync(env.logFile).size);
    assert.equal(cursorAfterFirst.processedTurnCount, 2);
    assert.equal(cursorAfterFirst.status, 'completed');

    const promotedAfterFirst = env.pipeline
      .getReviewOutcomes()
      .filter(o => o.decision === 'promote');
    assert.equal(promotedAfterFirst.length, 1);
    const skillPath = promotedAfterFirst[0].skillFilePath!;
    assert.ok(fs.existsSync(skillPath));
    const skillContentFirst = fs.readFileSync(skillPath, 'utf-8');

    // Re-run with no new appends.
    const r2 = await env.scheduler.runHeartbeat('scheduled');
    assert.equal(r2.unitsProcessed, 0);
    assert.equal(r2.advancedFiles, 0);

    // Cursor unchanged.
    const cursorAfterSecond = getCursor(loadLogCursorState(env.stateFile), env.logFile);
    assert.equal(cursorAfterSecond.byteOffset, cursorAfterFirst.byteOffset);
    assert.equal(cursorAfterSecond.processedTurnCount, 2);

    // No duplicate installation: same snapshot file, content unchanged.
    assert.equal(
      env.pipeline.getReviewOutcomes().filter(o => o.decision === 'promote').length,
      1,
      'no new promoted outcome on re-run',
    );
    const skillContentSecond = fs.readFileSync(skillPath, 'utf-8');
    assert.equal(skillContentSecond, skillContentFirst, 'SKILL.md content unchanged on re-run');
  });

  // AC: The test verifies newly appended turns in an existing session file are
  // processed incrementally with Continuity Context.
  test('newly appended turns in an existing session file are processed incrementally with Continuity Context', async () => {
    // First batch: turns 1–2.
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    let seenUnit: DistillationUnit | null = null;
    const capturingScheduler = new DistillationHeartbeatScheduler(env.root, unit => {
      seenUnit = unit;
      env.pipeline.processUnit(unit);
    });
    await capturingScheduler.runHeartbeat('manual');

    assert.ok(seenUnit, 'a unit was produced on the first cycle');
    assert.equal(seenUnit!.newTurns.length, 2);
    assert.equal(seenUnit!.continuityTurns.length, 0, 'no continuity on first extraction');

    const cursorAfterFirst = getCursor(loadLogCursorState(env.stateFile), env.logFile);
    const firstOffset = cursorAfterFirst.byteOffset;
    assert.equal(firstOffset, fs.statSync(env.logFile).size);
    const promotedAfterFirst = env.pipeline
      .getReviewOutcomes()
      .filter(o => o.decision === 'promote');
    assert.equal(promotedAfterFirst.length, 1, 'first cycle installs one promoted skill');
    const firstSkillPath = promotedAfterFirst[0].skillFilePath!;
    assert.ok(fs.existsSync(firstSkillPath), 'first promoted skill exists');

    // Append turns 3–4 (a second solved loop).
    appendLog(env.logFile, [
      makeTurn(3, 'cli', 'How do I optimize a slow SQL query joining two large tables?', 'Try a composite index.'),
      makeTurn(4, 'cli', 'Great, that helped a lot.', 'Awesome.'),
    ]);

    let secondUnit: DistillationUnit | null = null;
    const capturingScheduler2 = new DistillationHeartbeatScheduler(env.root, unit => {
      secondUnit = unit;
      env.pipeline.processUnit(unit);
    });
    const r2 = await capturingScheduler2.runHeartbeat('scheduled');

    assert.equal(r2.unitsProcessed, 1, 'incremental unit from new appends');
    assert.ok(secondUnit, 'a unit was produced on the second cycle');
    assert.equal(secondUnit!.newTurns.length, 2, 'only the newly appended turns');
    assert.ok(
      secondUnit!.continuityTurns.length > 0,
      'continuity context includes prior turns from the same file',
    );
    // Continuity context comes from the previously processed turns.
    assert.deepEqual(
      secondUnit!.continuityTurns.map(t => t.turn),
      [1, 2],
      'continuity context is the previous turns from the same session file',
    );

    // Cursor advanced past the new content only.
    const cursorAfterSecond = getCursor(loadLogCursorState(env.stateFile), env.logFile);
    assert.equal(cursorAfterSecond.byteOffset, fs.statSync(env.logFile).size);
    assert.equal(cursorAfterSecond.processedTurnCount, 4);
    assert.ok(cursorAfterSecond.byteOffset > firstOffset, 'cursor moved forward');

    const promotedAfterSecond = env.pipeline
      .getReviewOutcomes()
      .filter(o => o.decision === 'promote');
    assert.equal(promotedAfterSecond.length, 2, 'second appended unit installs a distinct promoted skill');
    assert.notEqual(
      promotedAfterSecond[1].skillFilePath,
      firstSkillPath,
      'second promoted skill is a separate snapshot from the first unit',
    );
    assert.ok(fs.existsSync(promotedAfterSecond[1].skillFilePath!), 'second promoted skill exists');
  });

  // AC: The test verifies promoted, rejected, and retryable/needs-review paths
  // leave durable state.
  test('promoted, rejected, and needs-review paths all leave durable state', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    await env.scheduler.runHeartbeat('manual');

    const outcomes = loadReviewOutcomesSync(env.reviewOutcomesFile);
    assert.equal(outcomes.length, 3, 'all three decisions recorded durably');

    const promoted = outcomes.find(o => o.decision === 'promote');
    const rejected = outcomes.find(o => o.decision === 'reject');
    const needsReview = outcomes.find(o => o.decision === 'needs_review');

    assert.ok(promoted, 'promoted outcome durably recorded');
    assert.ok(rejected, 'rejected outcome durably recorded');
    assert.ok(needsReview, 'needs_review outcome durably recorded');

    // Promoted: durable SKILL.md file exists.
    assert.ok(promoted!.skillFilePath, 'promoted outcome has skill file path');
    assert.ok(fs.existsSync(promoted!.skillFilePath!), 'promoted SKILL.md exists on disk');

    // Rejected: durable outcome record but no skill file.
    assert.equal(rejected!.skillFilePath, undefined, 'rejected has no skill file');
    assert.equal(rejected!.snapshotId, undefined, 'rejected has no snapshot id');

    // Needs-review: durable outcome record and durable queue entry but no skill file.
    assert.equal(needsReview!.skillFilePath, undefined, 'needs_review has no skill file');
    assert.equal(needsReview!.snapshotId, undefined, 'needs_review has no snapshot id');
    assert.ok(fs.existsSync(env.needsReviewQueueFile), 'needs_review queue file exists');

    const queue = loadNeedsReviewQueue(env.needsReviewQueueFile);
    const entries = Object.values(queue.entries);
    assert.equal(entries.length, 1, 'needs_review decision creates one queue entry');
    assert.equal(entries[0].capabilityId, needsReview!.capabilityId);
    assert.equal(entries[0].status, 'pending');
    assert.deepEqual(entries[0].questions, [
      'What additional evidence would make this candidate safe to retry?',
    ]);
    assert.ok(entries[0].evidenceFingerprint, 'queue entry stores evidence fingerprint');
    assert.ok(entries[0].registryStateFingerprint, 'queue entry stores registry-state fingerprint');
    assert.equal(entries[0].retryEligibility.eligible, false);

    // Every outcome carries source unit traceability.
    for (const o of outcomes) {
      assert.ok(o.sourceUnit.filePath, `${o.decision} outcome carries source file path`);
      assert.ok(o.sourceUnit.byteRange, `${o.decision} outcome carries source byte range`);
    }
  });

  // AC: The generated SKILL.md contains the expected Traceability Contract and
  // Provenance Refs.
  test('generated SKILL.md contains Traceability Contract and Provenance Refs and parses via SkillParser', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    await env.scheduler.runHeartbeat('manual');

    const promoted = env.pipeline
      .getReviewOutcomes()
      .find(o => o.decision === 'promote')!;
    const skillPath = promoted.skillFilePath!;
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const parsed = matter(raw);

    // Frontmatter: distilled capability identity.
    assert.equal(parsed.data.distilled, true);
    assert.equal(parsed.data.kind, 'capability');
    assert.ok(parsed.data.capability_id, 'frontmatter has capability_id');
    assert.ok(parsed.data.snapshot_id, 'frontmatter has snapshot_id');
    assert.ok(parsed.data.name, 'frontmatter has name for skill discovery');
    assert.ok(parsed.data.description, 'frontmatter has description for skill discovery');

    // Body: Traceability Contract section.
    assert.ok(/## Traceability Contract/.test(raw), 'body has Traceability Contract heading');
    assert.ok(/Capability ID/.test(raw), 'traceability contract names capability id');
    assert.ok(/Snapshot ID/.test(raw), 'traceability contract names snapshot id');
    assert.ok(/Source log/.test(raw), 'traceability contract names source log');
    assert.ok(/Review decision/.test(raw), 'traceability contract names review decision');

    // Body: Provenance Refs section.
    assert.ok(/## Provenance Refs/.test(raw), 'body has Provenance Refs heading');
    assert.ok(/problem-action/.test(raw), 'provenance refs include problem-action role');
    assert.ok(/verification/.test(raw), 'provenance refs include verification role');

    // Raw logs are not embedded in the skill body.
    assert.ok(
      !/How do I parse a JSONL file line by line in Node\?/.test(parsed.content),
      'raw user problem text is not embedded verbatim in the skill body',
    );

    // Skill discovery compatibility: the generated file parses via SkillParser.
    const skill = SkillParser.parse(skillPath);
    assert.ok(skill.metadata.name, 'parsed skill has a name');
    assert.ok(skill.metadata.description, 'parsed skill has a description');
    assert.equal(typeof skill.content, 'string', 'parsed skill has content');
  });

  // AC: The end-to-end test uses controlled fixtures for model-facing distiller
  // and reviewer behavior.
  test('uses controlled fixtures for distiller and reviewer behavior (no prompt internals)', async () => {
    // The pipeline was constructed with fixture distiller/reviewer in setupEnv.
    // Verify the fixtures control the decisions: every outcome decision matches
    // the fixture routing by capabilityId prefix.
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    await env.scheduler.runHeartbeat('manual');

    const outcomes = env.pipeline.getReviewOutcomes();
    assert.equal(outcomes.length, 3);

    const byId = new Map(outcomes.map(o => [o.capabilityId, o.decision]));
    const promoted = outcomes.find(o => o.capabilityId.startsWith('cap-promote-'));
    const rejected = outcomes.find(o => o.capabilityId.startsWith('cap-reject-'));
    const needsReview = outcomes.find(o => o.capabilityId.startsWith('cap-needsreview-'));
    assert.ok(promoted, 'fixture emitted promoted capability id');
    assert.ok(rejected, 'fixture emitted rejected capability id');
    assert.ok(needsReview, 'fixture emitted needs_review capability id');
    assert.equal(byId.get(promoted!.capabilityId), 'promote');
    assert.equal(byId.get(rejected!.capabilityId), 'reject');
    assert.equal(byId.get(needsReview!.capabilityId), 'needs_review');

    // Only the promoted candidate produced an installed skill file.
    const installedFiles = outcomes.filter(o => o.skillFilePath);
    assert.equal(installedFiles.length, 1);
    assert.equal(installedFiles[0].decision, 'promote');
  });

  // AC: Documentation or test names make clear this is the first-version
  // kind=capability pipeline and not the future multi-kind memory system.
  test('first-version kind=capability pipeline: candidates are kind=capability only', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'How do I parse a JSONL file line by line in Node?', 'Let me check.'),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
    ]);

    await env.scheduler.runHeartbeat('manual');

    const promoted = env.pipeline
      .getReviewOutcomes()
      .find(o => o.decision === 'promote')!;
    const raw = fs.readFileSync(promoted.skillFilePath!, 'utf-8');
    const parsed = matter(raw);

    assert.equal(parsed.data.kind, 'capability', 'installed skill is kind=capability');
    assert.ok(
      /## Traceability Contract/.test(raw),
      'traceability contract present (first-version capability pipeline)',
    );
  });
});

describe('DistillationPipeline durable outcome handling', () => {
  test('throws on a corrupt review-outcomes log instead of silently clearing history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pipeline-corrupt-'));
    try {
      const outcomesPath = path.join(root, 'data', 'distillation-review-outcomes.json');
      fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
      fs.writeFileSync(outcomesPath, '{not json', 'utf-8');

      assert.throws(
        () => new DistillationPipeline({
          distiller: makeFixtureDistiller(),
          reviewer: makeFixtureReviewer(),
          outputDir: path.join(root, 'skills', 'generated-distilled'),
          reviewOutcomesPath: outcomesPath,
        }),
        /Expected|JSON|Unexpected/i,
      );
      assert.equal(fs.readFileSync(outcomesPath, 'utf-8'), '{not json');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not mutate in-memory outcomes when later candidate processing fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pipeline-atomic-'));
    try {
      const outcomesPath = path.join(root, 'data', 'distillation-review-outcomes.json');
      const outputDir = path.join(root, 'skills', 'generated-distilled');
      const unit: DistillationUnit = {
        filePath: path.join(root, 'logs', 'sessions', 'chat.jsonl'),
        newTurns: [
          makeTurn(1, 'cli', 'How do I parse JSONL?', 'Use readline.'),
          makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Great.'),
        ],
        continuityTurns: [],
        byteRange: { start: 0, end: 1000 },
        generatedAt: '2026-07-10T00:00:00.000Z',
      };
      const pipeline = new DistillationPipeline({
        distiller: unitArg => [
          fixtureCandidate(unitArg, 'cap-promote-atomic', PROMOTE_EVIDENCE),
          fixtureCandidate(unitArg, 'cap-reject-atomic', REJECT_EVIDENCE),
        ],
        reviewer: packet => {
          if (packet.candidate.capabilityId === 'cap-reject-atomic') {
            throw new Error('simulated reviewer failure');
          }
          return {
            schemaVersion: 1,
            capabilityId: packet.candidate.capabilityId,
            decision: 'promote',
            rationale: 'Promote first candidate.',
            reviewRisks: [],
            rewrite: null,
            reviewedAt: '2026-07-10T01:00:00.000Z',
          };
        },
        outputDir,
        reviewOutcomesPath: outcomesPath,
      });

      assert.throws(() => pipeline.processUnit(unit), /simulated reviewer failure/);
      assert.deepEqual(pipeline.getReviewOutcomes(), []);
      assert.equal(fs.existsSync(outcomesPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
