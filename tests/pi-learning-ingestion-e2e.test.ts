/**
 * End-to-end Pi learning ingestion fixture.
 *
 * Proves the observed production blockers are fixed at the seams that matter:
 *   - Runtime 启动层 metadata is excluded from learning evidence
 *   - a complete Pi event is admitted with external-pi provenance
 *   - replay is idempotent
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
  MAX_EXTERNAL_TURN_TEXT_BYTES,
  sanitizeExternalDistillationUnit,
} from '../src/utils/evidence-capsule';
import {
  ExternalSessionLogBackfillService,
  loadExternalSessionLogBackfillState,
  type ExternalSessionLogBackfillSource,
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

test('Pi fixture: excludes Runtime 启动层, admits complete event, provenance, idempotent replay', () => {
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

  const root = makeRoot();
  const stateFilePath = path.join(root, 'backfill-state.json');
  const auditFilePath = path.join(root, 'backfill-audit.jsonl');
  const resource: SessionLogSourceResource = {
    resourceRef: thread,
    firstEventIdentity: {
      eventId: `agents://pi/${thread}#2-4`,
      position: 4,
      contentHash: parsed.events[0]!.contentHash,
    },
  };
  const unit: DistillationUnit = {
    filePath: `xurl://pi/${thread}`,
    newTurns: [{
      entry_type: 'turn',
      turn: 4,
      timestamp: '2026-07-17T03:00:00.000Z',
      session_id: `external:pi:${thread}:${thread}`,
      session_type: 'external',
      user: {
        text: 'Ship the weekly report.\n\nInclude the chart attachment.',
      },
      assistant: {
        text: 'Report delivered with chart.',
        tool_calls: [],
      },
      tokens: { prompt: 0, completion: 0 },
    }],
    continuityTurns: [],
    byteRange: { start: 2, end: 4 },
    generatedAt: '2026-07-17T03:00:00.000Z',
  };

  const source: ExternalSessionLogBackfillSource = {
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
          eventId: `agents://pi/${thread}#2-4`,
          position: 4,
          contentHash: parsed.events[0]!.contentHash,
          conversationId: thread,
          branchId: thread,
        },
        distillationUnit: unit,
        byteLength: 256,
      }],
      status: 'stable',
      exhausted: true,
      newCursor: {
        resourceRef: thread,
        position: 4,
        processedCount: 1,
      },
    }),
  };

  const admitted: string[] = [];
  const service = new ExternalSessionLogBackfillService({
    stateFilePath,
    auditFilePath,
    now: () => new Date('2026-07-17T03:10:00.000Z'),
  });
  const request = {
    operationId: 'backfill-pi-e2e',
    triggeredBy: 'operator:test',
    provider: 'pi',
    sourceId: 'external-pi',
    range: { startPosition: 0, endPosition: 100, resourceRefs: [thread] },
    limits: { maxResources: 10, maxBytes: 1_000_000, maxElapsedMs: 60_000 },
  };

  const first = service.run(request, source, (_unit, context) => {
    assert.equal(context.provider, 'pi');
    assert.equal(context.sourceId, 'external-pi');
    admitted.push(context.eventIdentity.eventId);
    return { admittedEpisodeIds: [`episode:pi:${context.eventIdentity.eventId}`] };
  });
  assert.equal(first.status, 'completed');
  assert.equal(first.admittedEpisodes, 1);
  assert.equal(first.state.metrics.admittedEpisodes, 1);
  assert.equal(first.state.metrics.failedResources, 0);
  assert.equal(first.state.resourceStates[thread]?.status, 'processed');

  const second = service.run(request, source, () => {
    throw new Error('replay must not re-ingest');
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.admittedEpisodes, 0);
  assert.equal(second.state.metrics.admittedEpisodes, 1);
  assert.equal(second.state.metrics.duplicateEventsSkipped, 1);
  assert.deepEqual(admitted, [`agents://pi/${thread}#2-4`]);

  const state = loadExternalSessionLogBackfillState(stateFilePath)!;
  assert.equal(state.metrics.pendingResources, 0);
  assert.equal(state.metrics.failedResourceAttempts, 0);
});

test('oversize external assistant text remains fail-closed (no silent truncation)', () => {
  const oversized = 'A'.repeat(MAX_EXTERNAL_TURN_TEXT_BYTES + 1);
  const unit: DistillationUnit = {
    filePath: 'xurl://pi/oversized',
    newTurns: [{
      entry_type: 'turn',
      turn: 1,
      timestamp: '2026-07-17T03:00:00.000Z',
      session_id: 'external:pi:oversized:oversized',
      session_type: 'external',
      user: { text: 'hello' },
      assistant: { text: oversized, tool_calls: [] },
      tokens: { prompt: 0, completion: 0 },
    }],
    continuityTurns: [],
    byteRange: { start: 1, end: 2 },
    generatedAt: '2026-07-17T03:00:00.000Z',
  };

  assert.throws(
    () => sanitizeExternalDistillationUnit(unit, { sourceId: 'external-pi' }),
    /external assistant text exceeds the \d+-byte external evidence limit/i,
  );

  // Ordinary final responses under the bound still pass.
  const ordinary: DistillationUnit = {
    ...unit,
    newTurns: [{
      ...unit.newTurns[0]!,
      assistant: { text: 'A'.repeat(Math.min(8_000, MAX_EXTERNAL_TURN_TEXT_BYTES - 10)), tool_calls: [] },
    }],
  };
  const sanitized = sanitizeExternalDistillationUnit(ordinary, { sourceId: 'external-pi' });
  assert.ok(String((sanitized.newTurns[0] as any).assistant.text).length > 0);
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
