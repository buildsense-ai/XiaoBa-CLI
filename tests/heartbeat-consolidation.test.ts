import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';

import {
  DistillationHeartbeatScheduler,
  loadHeartbeatRecord,
} from '../src/utils/distillation-heartbeat-scheduler';
import { getCursor, loadLogCursorState } from '../src/utils/log-cursor-state';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  DistillationPipeline,
  loadReviewOutcomesSync,
} from '../src/utils/distillation-pipeline';
import {
  PromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
} from '../src/utils/promotion-reviewer';
import {
  getCapability,
  loadCapabilityRegistry,
} from '../src/utils/capability-registry';

// ---------------------------------------------------------------------------
// Heartbeat-driven Capability consolidation (issue #28).
//
// Drives the real live-heartbeat consolidation path with controlled session
// logs and the default deterministic reviewer (registry-aware). The pipeline
// is constructed with a Capability Registry path so the default reviewer
// compares a matched capability's Active Snapshot against the candidate and
// chooses new_capability, append_evidence, or supersede_snapshot.
//
// The model-facing distiller is the real heuristic distiller; only the log
// content is controlled so the test exercises the real heartbeat path.
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

// A recurring problem and an action the deterministic distiller can detect as a
// solved loop. The same user problem + the same assistant action produces an
// equivalent candidate; a different assistant action produces a material
// action-pattern change.
const PROBLEM = 'How do I parse a JSONL file line by line in Node without loading it all into memory?';
const ACCEPTANCE = 'Thanks, that works perfectly!';
const ACTION_A = 'Use readline to stream the file line by line and parse each line as JSON.';
const ACTION_A_PARAPHRASE = 'Use the Node readline interface to stream JSONL records one at a time.';
const ACTION_B = 'Use the fs.createReadStream API with the split2 package to stream and split records.';

interface TestEnv {
  root: string;
  logFile: string;
  registryFile: string;
  recordFile: string;
  reviewOutcomesFile: string;
  needsReviewQueueFile: string;
  outputDir: string;
  pipeline: DistillationPipeline;
  scheduler: DistillationHeartbeatScheduler;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(
  onReviewPacket?: (packet: PromotionPacket) => void,
): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-consolidation-'));
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-09', 'chat_cli.jsonl');
  const registryFile = path.join(root, 'data', 'capability-registry-state.json');
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
    DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE: process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE,
    DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE: process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE,
    DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE: process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = path.join(root, 'data', 'distillation-cursor-state.json');
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordFile;
  process.env.DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE = reviewOutcomesFile;
  process.env.DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE = registryFile;
  process.env.DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE = needsReviewQueueFile;
  delete process.env.XIAOBA_ROLE;

  // Default distiller + default (registry-aware) reviewer. The default reviewer
  // returns V2 consolidation decisions because capabilityRegistryPath is set.
  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: reviewOutcomesFile,
    capabilityRegistryPath: registryFile,
    needsReviewQueuePath: needsReviewQueueFile,
    reviewer: onReviewPacket
      ? (packet: PromotionPacket): PromotionReviewResult => {
        onReviewPacket(packet);
        return reviewPromotionPacket(packet);
      }
      : undefined,
  });

  const scheduler = new DistillationHeartbeatScheduler(root, unit => pipeline.processUnit(unit));

  return {
    root,
    logFile,
    registryFile,
    recordFile,
    reviewOutcomesFile,
    needsReviewQueueFile,
    outputDir,
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

function loadRegistry(env: TestEnv) {
  return loadCapabilityRegistry(env.registryFile);
}

function loadOutcomes(env: TestEnv) {
  return loadReviewOutcomesSync(env.reviewOutcomesFile);
}

describe('Heartbeat-driven capability consolidation on the real heartbeat path (issue #28)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.restore();
    env.teardown();
  });

  test('first occurrence installs a new capability with an immutable Active Snapshot', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);

    const result = await env.scheduler.runHeartbeat('manual');

    assert.equal(result.ran, true);
    assert.ok(result.unitsProcessed >= 1, 'at least one distillation unit processed');

    const outcomes = env.pipeline.getReviewOutcomes();
    const newCaps = outcomes.filter(o => o.decision === 'new_capability');
    assert.ok(newCaps.length >= 1, 'a new_capability decision was produced');

    const registry = loadRegistry(env);
    assert.ok(Object.keys(registry.capabilities).length >= 1, 'registry has a capability entry');

    const entry = Object.values(registry.capabilities)[0]!;
    assert.equal(entry.status, 'active');
    assert.ok(entry.activeSnapshotId, 'entry has an active snapshot id');
    assert.deepEqual(entry.relatedSnapshotIds, [entry.activeSnapshotId]);

    // The Active Snapshot is on disk and immutable.
    const snapshotPath = path.join(env.outputDir, entry.capabilityId, entry.activeSnapshotId, 'SKILL.md');
    assert.ok(fs.existsSync(snapshotPath), 'Active Snapshot SKILL.md exists on disk');

    // The reviewer exposes the matched capability's active snapshot only when a
    // match exists; on the first occurrence there is no match, so the decision
    // is new_capability and no target capability id is recorded.
    assert.equal(newCaps[0]!.targetCapabilityId, undefined);
  });

  test('an equivalent repeated occurrence appends evidence without superseding the Active Snapshot', async () => {
    // First occurrence → new_capability.
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');

    const registryBefore = loadRegistry(env);
    assert.ok(Object.keys(registryBefore.capabilities).length >= 1);
    const entryBefore = Object.values(registryBefore.capabilities)[0]!;
    const activeBefore = entryBefore.activeSnapshotId;
    const evidenceCountBefore = entryBefore.evidenceRefs.length;

    // Second occurrence with the same problem + same action → equivalent guidance.
    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    const result2 = await env.scheduler.runHeartbeat('scheduled');
    assert.ok(result2.unitsProcessed >= 1, 'second heartbeat processed a new unit');

    const outcomes = env.pipeline.getReviewOutcomes();
    const appends = outcomes.filter(o => o.decision === 'append_evidence');
    assert.ok(appends.length >= 1, 'an append_evidence decision was produced');

    const appendOutcome = appends[0]!;
    assert.equal(appendOutcome.snapshotId, undefined, 'append_evidence installs no snapshot');
    assert.equal(appendOutcome.skillFilePath, undefined, 'append_evidence installs no skill file');

    // The Active Snapshot must not change.
    const registryAfter = loadRegistry(env);
    const entryAfter = registryAfter.capabilities[entryBefore.capabilityId]!;
    assert.equal(entryAfter.activeSnapshotId, activeBefore, 'active snapshot unchanged by append_evidence');
    assert.ok(
      entryAfter.evidenceRefs.length > evidenceCountBefore,
      'new traceable evidence refs were appended',
    );

    // No new immutable snapshot directory was created for this capability beyond
    // the original active snapshot.
    const capSnapshotDir = path.join(env.outputDir, entryAfter.capabilityId);
    const snapshotDirs = fs.existsSync(capSnapshotDir)
      ? fs.readdirSync(capSnapshotDir).filter(d => fs.statSync(path.join(capSnapshotDir, d)).isDirectory())
      : [];
    assert.deepEqual(snapshotDirs, [activeBefore], 'no second snapshot directory was created');

    // The durable outcome records the registry target the evidence was appended to.
    assert.equal(appendOutcome.targetCapabilityId, entryAfter.capabilityId);
  });

  test('an equivalent action-pattern paraphrase appends evidence without superseding', async () => {
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');

    const entryBefore = Object.values(loadRegistry(env).capabilities)[0]!;
    const activeBefore = entryBefore.activeSnapshotId;

    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A_PARAPHRASE),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const entryAfter = loadRegistry(env).capabilities[entryBefore.capabilityId]!;
    assert.equal(entryAfter.activeSnapshotId, activeBefore, 'paraphrase leaves the Active Snapshot unchanged');
    assert.ok(
      loadOutcomes(env).some(outcome => outcome.decision === 'append_evidence'),
      'paraphrase records append_evidence rather than supersede_snapshot',
    );

    const snapshotDirs = fs.readdirSync(path.join(env.outputDir, entryAfter.capabilityId))
      .filter(dir => fs.statSync(path.join(env.outputDir, entryAfter.capabilityId, dir)).isDirectory());
    assert.deepEqual(snapshotDirs, [activeBefore], 'paraphrase creates no additional snapshot');
  });

  test('a material action-pattern change supersedes the Active Snapshot and preserves the predecessor', async () => {
    // First occurrence → new_capability.
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');

    const registryBefore = loadRegistry(env);
    const entryBefore = Object.values(registryBefore.capabilities)[0]!;
    const activeBefore = entryBefore.activeSnapshotId;
    const priorSnapshotPath = path.join(env.outputDir, entryBefore.capabilityId, activeBefore, 'SKILL.md');
    assert.ok(fs.existsSync(priorSnapshotPath));

    // Second occurrence with a materially different action pattern → supersede.
    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_B),
      makeTurn(4, 'cli', ACCEPTANCE, 'Awesome.'),
    ]);
    const result2 = await env.scheduler.runHeartbeat('scheduled');
    assert.ok(result2.unitsProcessed >= 1);

    const outcomes = env.pipeline.getReviewOutcomes();
    const supersedes = outcomes.filter(o => o.decision === 'supersede_snapshot');
    assert.ok(supersedes.length >= 1, 'a supersede_snapshot decision was produced');

    const supersedeOutcome = supersedes[0]!;
    assert.ok(supersedeOutcome.snapshotId, 'supersede installed a new snapshot id');
    assert.ok(supersedeOutcome.skillFilePath, 'supersede installed a new SKILL.md');
    assert.notEqual(supersedeOutcome.snapshotId, activeBefore, 'new snapshot differs from prior active');

    const registryAfter = loadRegistry(env);
    const entryAfter = registryAfter.capabilities[entryBefore.capabilityId]!;
    assert.equal(entryAfter.activeSnapshotId, supersedeOutcome.snapshotId, 'active snapshot updated');
    assert.ok(
      entryAfter.relatedSnapshotIds.includes(activeBefore),
      'prior active snapshot remains reachable through related snapshot history',
    );
    assert.ok(
      entryAfter.relatedSnapshotIds.includes(supersedeOutcome.snapshotId!),
      'new active snapshot is recorded in related snapshot history',
    );

    // The prior immutable snapshot remains on disk.
    assert.ok(fs.existsSync(priorSnapshotPath), 'prior Active Snapshot SKILL.md is preserved on disk');
    const priorContent = fs.readFileSync(priorSnapshotPath, 'utf-8');
    assert.match(priorContent, /readline/, 'prior snapshot still records the original action');

    // The new immutable snapshot is on disk with the material action change.
    const newSnapshotPath = path.join(env.outputDir, entryAfter.capabilityId, supersedeOutcome.snapshotId!, 'SKILL.md');
    assert.ok(fs.existsSync(newSnapshotPath), 'new Active Snapshot SKILL.md exists on disk');
    const newContent = fs.readFileSync(newSnapshotPath, 'utf-8');
    assert.match(newContent, /createReadStream|split2/, 'new snapshot records the material action change');

    // The durable outcome records the registry target that was superseded.
    assert.equal(supersedeOutcome.targetCapabilityId, entryAfter.capabilityId);
  });

  test('equivalent then material: the second append leaves the snapshot stable and the third supersedes it', async () => {
    // 1) new_capability
    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');

    const entryAfterNew = Object.values(loadRegistry(env).capabilities)[0]!;
    const activeAfterNew = entryAfterNew.activeSnapshotId;

    // 2) equivalent occurrence → append_evidence, snapshot stable.
    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const entryAfterAppend = loadRegistry(env).capabilities[entryAfterNew.capabilityId]!;
    assert.equal(entryAfterAppend.activeSnapshotId, activeAfterNew, 'append did not change the active snapshot');

    // 3) material action change → supersede_snapshot.
    appendLog(env.logFile, [
      makeTurn(5, 'cli', PROBLEM, ACTION_B),
      makeTurn(6, 'cli', ACCEPTANCE, 'Perfect.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const entryAfterSupersede = loadRegistry(env).capabilities[entryAfterNew.capabilityId]!;
    assert.notEqual(entryAfterSupersede.activeSnapshotId, activeAfterNew, 'supersede changed the active snapshot');
    assert.ok(
      entryAfterSupersede.relatedSnapshotIds.includes(activeAfterNew),
      'predecessor remains in related snapshot history',
    );

    // The durable review-outcomes log records the full sequence of decisions.
    const outcomes = loadOutcomes(env);
    const decisions = outcomes.map(o => `${o.decision}:${o.targetCapabilityId ?? ''}`).join(',');
    assert.ok(/new_capability/.test(decisions), 'new_capability decision recorded');
    assert.ok(/append_evidence/.test(decisions), 'append_evidence decision recorded');
    assert.ok(/supersede_snapshot/.test(decisions), 'supersede_snapshot decision recorded');
  });

  test('the matched capability exposes its Active Snapshot and traceable evidence to the reviewer', async () => {
    env.restore();
    env.teardown();
    const packets: PromotionPacket[] = [];
    env = setupEnv(packet => packets.push(packet));

    writeLog(env.logFile, [
      makeTurn(1, 'cli', PROBLEM, ACTION_A),
      makeTurn(2, 'cli', ACCEPTANCE, 'Glad it helped.'),
    ]);
    await env.scheduler.runHeartbeat('manual');

    const registry = loadRegistry(env);
    const entry = Object.values(registry.capabilities)[0]!;

    // The Active Snapshot is on disk and parses as a distilled capability.
    const snapshotPath = path.join(env.outputDir, entry.capabilityId, entry.activeSnapshotId, 'SKILL.md');
    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    const parsed = matter(raw);
    assert.equal(parsed.data.distilled, true);
    assert.equal(parsed.data.capability_id, entry.capabilityId);
    assert.equal(parsed.data.snapshot_id, entry.activeSnapshotId);

    // The registry entry carries traceable evidence refs to source logs.
    assert.ok(entry.evidenceRefs.length > 0, 'registry entry carries traceable evidence refs');
    for (const ref of entry.evidenceRefs) {
      assert.ok(ref.evidenceId, 'evidence ref has a stable id');
      assert.ok(ref.sourceFilePath, 'evidence ref has a source file path');
    }

    // A second equivalent occurrence appends a new traceable ref while keeping
    // the active snapshot, proving the evidence path preserves traceability.
    appendLog(env.logFile, [
      makeTurn(3, 'cli', PROBLEM, ACTION_A),
      makeTurn(4, 'cli', ACCEPTANCE, 'Great, that helped.'),
    ]);
    await env.scheduler.runHeartbeat('scheduled');

    const registryAfter = loadRegistry(env);
    const entryAfter = registryAfter.capabilities[entry.capabilityId]!;
    assert.equal(entryAfter.activeSnapshotId, entry.activeSnapshotId, 'active snapshot unchanged');
    assert.ok(entryAfter.evidenceRefs.length > entry.evidenceRefs.length, 'new traceable evidence appended');

    const matchedPacket = packets.find(
      packet => packet.registryContext?.matches.some(match => match.capabilityId === entry.capabilityId),
    );
    assert.ok(matchedPacket, 'the real heartbeat passed a matched registry context to the reviewer');
    assert.ok(
      matchedPacket.registryContext!.activeSnapshotContents[entry.capabilityId],
      'the packet exposes the matched Active Snapshot content',
    );
    assert.ok(
      matchedPacket.registryContext!.evidenceRefsByCapability[entry.capabilityId].length > 0,
      'the packet exposes traceable evidence refs for the matched capability',
    );
  });
});
