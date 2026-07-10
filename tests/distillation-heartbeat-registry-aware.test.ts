import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import {
  DistillationPipeline,
  defaultDistilledOutputDir,
  loadReviewOutcomesSync,
  ReviewOutcomeEntry,
} from '../src/utils/distillation-pipeline';
import {
  loadCapabilityRegistry,
  saveCapabilityRegistry,
} from '../src/utils/capability-registry';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PROBLEM = 'How do I parse a JSONL file line by line in Node?';
const ACTION = 'Use readline to stream the file.';
const ACCEPTANCE = 'Thanks, that works perfectly!';

function makeTurn(
  turn: number,
  userText: string,
  assistantText: string,
  toolCalls: SessionTurnLogEntry['assistant']['tool_calls'] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: '2026-07-10T00:00:00.000Z',
    session_id: 'heartbeat-registry-aware',
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 10 },
  };
}

function makeSessionLogContent(turns: SessionTurnLogEntry[]): string {
  return turns.map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

interface TestEnv {
  root: string;
  pipeline: DistillationPipeline;
  scheduler: DistillationHeartbeatScheduler;
  config: ReturnType<typeof getDistillationHeartbeatConfig>;
  teardown: () => void;
}

function setupEnv(existingOutcomes: ReviewOutcomeEntry[] = []): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-registry-aware-'));

  const config = getDistillationHeartbeatConfig(root, {
    ...process.env,
    DISTILLATION_HEARTBEAT_ENABLED: 'true',
  });

  if (existingOutcomes.length > 0) {
    fs.mkdirSync(path.dirname(config.reviewOutcomesPath), { recursive: true });
    fs.writeFileSync(
      config.reviewOutcomesPath,
      JSON.stringify({ schemaVersion: 1, outcomes: existingOutcomes }),
      'utf-8',
    );
  }

  const pipeline = new DistillationPipeline({
    outputDir: defaultDistilledOutputDir(path.join(root, 'skills')),
    reviewOutcomesPath: config.reviewOutcomesPath,
    capabilityRegistryPath: config.capabilityRegistryPath,
    needsReviewQueuePath: config.needsReviewQueuePath,
    workLogRoot: config.workLogRoot,
  });

  const scheduler = new DistillationHeartbeatScheduler(
    root,
    unit => pipeline.processUnit(unit),
  );

  return {
    root,
    pipeline,
    scheduler,
    config,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeFirstSessionLog(env: TestEnv): void {
  const logFile = path.join(env.config.logsRoot, 'sessions', 'chat', 'chat_cli.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const turns: SessionTurnLogEntry[] = [
    makeTurn(1, PROBLEM, ACTION, [{ id: 'tc-1', name: 'read_file', arguments: {}, result: 'ok', duration_ms: 10 }]),
    makeTurn(2, ACCEPTANCE, 'Glad it helped.'),
  ];
  fs.writeFileSync(logFile, makeSessionLogContent(turns), 'utf-8');
}

function appendSecondSessionLog(
  env: TestEnv,
  action = ACTION,
  toolCalls: SessionTurnLogEntry['assistant']['tool_calls'] = [
    { id: 'tc-2', name: 'read_file', arguments: {}, result: 'ok', duration_ms: 10 },
  ],
): void {
  const logFile = path.join(env.config.logsRoot, 'sessions', 'chat', 'chat_cli.jsonl');
  const turns: SessionTurnLogEntry[] = [
    makeTurn(3, PROBLEM, action, toolCalls),
    makeTurn(4, ACCEPTANCE, 'Glad it helped.'),
  ];
  fs.appendFileSync(logFile, makeSessionLogContent(turns), 'utf-8');
}

function findBranchLogLines(env: TestEnv): Array<Record<string, unknown>> {
  const root = env.config.workLogRoot;
  if (!fs.existsSync(root)) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const dateDir of fs.readdirSync(root)) {
    const dir = path.join(root, dateDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return lines;
}

function findEvents(lines: Array<Record<string, unknown>>, eventType: string): Array<Record<string, unknown>> {
  return lines.filter(line => line.event_type === eventType);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DistillationHeartbeat registry-aware consolidation (issue #27)', () => {
  let env: TestEnv;
  const originalRole = process.env.XIAOBA_ROLE;

  beforeEach(() => {
    delete process.env.XIAOBA_ROLE;
    env = setupEnv();
  });

  afterEach(() => {
    env.teardown();
    if (originalRole !== undefined) {
      process.env.XIAOBA_ROLE = originalRole;
    } else {
      delete process.env.XIAOBA_ROLE;
    }
  });

  test('empty registry produces new_capability and durable artifacts', async () => {
    writeFirstSessionLog(env);

    const result = await env.scheduler.runHeartbeat('manual');
    assert.equal(result.ran, true, 'heartbeat should run');
    assert.equal(result.unitsProcessed, 1, 'one distillation unit processed');
    assert.equal(result.advancedFiles, 1, 'one log file advanced');

    const registry = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    assert.equal(Object.keys(registry.capabilities).length, 1, 'registry has one entry');
    const entry = Object.values(registry.capabilities)[0];
    assert.ok(entry, 'registry entry exists');
    assert.equal(entry.status, 'active');
    assert.equal(entry.evidenceRefs.length, 2, 'initial problem-action + verification evidence');
    assert.ok(entry.relatedSnapshotIds.includes(entry.activeSnapshotId), 'active snapshot is related');
    assert.ok(entry.routingDescription, 'routing description is set');

    const skillFile = path.join(
      env.root,
      'skills',
      'generated-distilled',
      entry.capabilityId,
      entry.activeSnapshotId,
      'SKILL.md',
    );
    assert.ok(fs.existsSync(skillFile), `installed skill exists at ${skillFile}`);

    const outcomes = loadReviewOutcomesSync(env.config.reviewOutcomesPath);
    assert.equal(outcomes.length, 1, 'one review outcome recorded');
    assert.equal(outcomes[0].decision, 'new_capability');
    assert.equal(outcomes[0].capabilityId, entry.capabilityId);
    assert.equal(outcomes[0].snapshotId, entry.activeSnapshotId);
    assert.equal(outcomes[0].skillFilePath, skillFile);

    const branchLines = findBranchLogLines(env);
    assert.ok(branchLines.length > 0, 'branch log has entries');
    assert.ok(findEvents(branchLines, 'start').length > 0, 'branch log has start event');
    assert.ok(findEvents(branchLines, 'install_result').length > 0, 'branch log has install_result');
    assert.ok(
      findEvents(branchLines, 'registry_new_capability').length > 0,
      'branch log has registry_new_capability event',
    );
    assert.ok(findEvents(branchLines, 'run_result').length > 0, 'branch log has run_result');
  });

  test('matching unchanged guidance produces append_evidence and no new skill', async () => {
    writeFirstSessionLog(env);
    const first = await env.scheduler.runHeartbeat('manual');
    assert.equal(first.unitsProcessed, 1);

    const registryBefore = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryBefore = Object.values(registryBefore.capabilities)[0];
    assert.ok(entryBefore);
    const activeBefore = entryBefore.activeSnapshotId;

    appendSecondSessionLog(env);
    const second = await env.scheduler.runHeartbeat('manual');
    assert.equal(second.ran, true);
    assert.equal(second.unitsProcessed, 1, 'second unit processed');
    assert.equal(second.advancedFiles, 1, 'log file advanced on second run');

    const registryAfter = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryAfter = Object.values(registryAfter.capabilities)[0];
    assert.ok(entryAfter);
    assert.equal(entryAfter.capabilityId, entryBefore.capabilityId, 'same consolidated capability');
    assert.equal(entryAfter.activeSnapshotId, activeBefore, 'active snapshot unchanged');
    assert.equal(entryAfter.evidenceRefs.length, 4, 'two new evidence refs appended');

    const skillDirs = fs.readdirSync(path.join(env.root, 'skills', 'generated-distilled', entryAfter.capabilityId));
    assert.deepEqual(skillDirs.sort(), [activeBefore].sort(), 'only the original snapshot installed');

    const outcomes = loadReviewOutcomesSync(env.config.reviewOutcomesPath);
    const appendOutcome = outcomes.find(o => o.decision === 'append_evidence');
    assert.ok(appendOutcome, 'append_evidence outcome recorded');
    assert.equal(appendOutcome!.targetCapabilityId, entryAfter.capabilityId);
    assert.equal(appendOutcome!.snapshotId, undefined, 'append_evidence does not install a snapshot');
    assert.equal(appendOutcome!.skillFilePath, undefined, 'append_evidence does not create a skill file');

    const branchLines = findBranchLogLines(env);
    const appendEvents = findEvents(branchLines, 'registry_append_evidence');
    assert.equal(appendEvents.length, 1, 'branch log records one append_evidence');
  });

  test('legacy registry guidance and V1 outcomes remain durable during evidence append', async () => {
    env.teardown();
    const v1Outcome: ReviewOutcomeEntry = {
      capabilityId: 'legacy-v1-capability',
      decision: 'promote',
      rationale: 'Existing V1 audit record.',
      reviewedAt: '2026-07-09T00:00:00.000Z',
      snapshotId: 'legacy-snapshot',
      skillFilePath: '/legacy/SKILL.md',
      sourceUnit: { filePath: '/legacy.jsonl', byteRange: { start: 0, end: 1 } },
    };
    env = setupEnv([v1Outcome]);

    writeFirstSessionLog(env);
    await env.scheduler.runHeartbeat('manual');
    const registryBefore = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryBefore = Object.values(registryBefore.capabilities)[0];
    assert.ok(entryBefore);
    const activeBefore = entryBefore.activeSnapshotId;
    delete entryBefore.guidanceFingerprint;
    saveCapabilityRegistry(env.config.capabilityRegistryPath, registryBefore);

    appendSecondSessionLog(env);
    await env.scheduler.runHeartbeat('manual');

    const registryAfter = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryAfter = Object.values(registryAfter.capabilities)[0];
    assert.ok(entryAfter);
    assert.equal(entryAfter.activeSnapshotId, activeBefore, 'legacy entry retains its active snapshot');
    assert.equal(entryAfter.evidenceRefs.length, 4, 'legacy entry appends new evidence');

    const outcomes = loadReviewOutcomesSync(env.config.reviewOutcomesPath);
    assert.ok(
      outcomes.some(outcome => outcome.capabilityId === v1Outcome.capabilityId),
      'pre-existing V1 audit outcome remains durable',
    );
    assert.ok(
      outcomes.some(outcome => outcome.decision === 'append_evidence'),
      'legacy entry records append_evidence rather than supersede_snapshot',
    );

    const skillDirs = fs.readdirSync(path.join(env.root, 'skills', 'generated-distilled', entryAfter.capabilityId));
    assert.deepEqual(skillDirs, [activeBefore], 'legacy entry does not create a new skill snapshot');
  });

  test('matching routing with changed full guidance supersedes the active snapshot', async () => {
    writeFirstSessionLog(env);
    await env.scheduler.runHeartbeat('manual');

    const registryBefore = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryBefore = Object.values(registryBefore.capabilities)[0];
    assert.ok(entryBefore);
    const activeBefore = entryBefore.activeSnapshotId;
    const expectedGuidanceFingerprint = entryBefore.guidanceFingerprint;
    assert.ok(expectedGuidanceFingerprint, 'new capability records its full guidance fingerprint');

    appendSecondSessionLog(
      env,
      'Use the fs.createReadStream API with the split2 package to stream and split records.',
      [],
    );
    const result = await env.scheduler.runHeartbeat('manual');
    assert.equal(result.unitsProcessed, 1);

    const registryAfter = loadCapabilityRegistry(env.config.capabilityRegistryPath);
    const entryAfter = Object.values(registryAfter.capabilities)[0];
    assert.ok(entryAfter);
    assert.notEqual(entryAfter.activeSnapshotId, activeBefore, 'active snapshot is superseded');
    assert.ok(entryAfter.guidanceFingerprint, 'superseded snapshot records its guidance fingerprint');
    assert.notEqual(entryAfter.guidanceFingerprint, expectedGuidanceFingerprint);

    const skillDirs = fs.readdirSync(path.join(env.root, 'skills', 'generated-distilled', entryAfter.capabilityId));
    assert.equal(skillDirs.length, 2, 'a new immutable snapshot was installed');

    const outcomes = loadReviewOutcomesSync(env.config.reviewOutcomesPath);
    assert.ok(
      outcomes.some(outcome => outcome.decision === 'supersede_snapshot'),
      'supersede_snapshot outcome recorded',
    );
    assert.ok(
      findEvents(findBranchLogLines(env), 'registry_supersede_snapshot').length > 0,
      'branch log records supersede_snapshot',
    );
  });
});
